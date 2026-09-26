import { encodeScalar, pedersenCommit } from '@cp2p/crypto';
import { RESOURCES, createResourceBounds, failure, success, zeroCounts } from '@cp2p/engine';
import type { CommandShape, Engine, GameState, Result, Seat } from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import type { CryptoContext } from './crypto-context.js';
import { genesisDigest } from './genesis.js';
import { emptyHandCommitments } from './hand-commitments.js';
import { proveHandObligation } from './hand-transition.js';
import { P2PSession } from './p2p-session.js';
import type { P2PSessionOptions, SessionDriver } from './p2p-session.js';
import type { ProposalContext } from './proposal.js';
import type { ReplicatedLog } from './replicated-log.js';
import { protocolFixture } from './testing/fixtures.js';
import { VirtualClock } from './testing/virtual-clock.js';
import {
  authorizeTradeProof,
  signTradeProofResponse,
  tradeProofRequestId,
} from './trade-proof-delivery.js';
import type { SignedTradeProofRequest, SignedTradeProofResponse } from './trade-proof-delivery.js';
import type { CommandBody, SignedCommand } from './types.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const confirm: CommandShape = { type: 'CONFIRM_TRADE', offerId: 0, withSeat: 1 };

/**
 * The replica below stands at the authenticated callback boundary. These tests
 * exercise session waiting, cancellation and admission; trade-replica tests
 * exercise the real wire validator, consensus and private proof sources.
 */
function fixture() {
  const base = protocolFixture();
  const genesis = { ...base.genesis, security: 'verified' as const };
  const zero = zeroCounts(RESOURCES);
  const state: GameState = {
    ...base.state,
    turn: {
      ...base.state.turn,
      number: 3,
      activeSeat: 0,
      phase: [{ module: 'base', id: 'main', data: null }],
    },
    seats: base.state.seats.map((seat) => ({
      ...seat,
      resources:
        seat.seat === 0
          ? value(createResourceBounds(1, zero, { ...zero, brick: 1, wool: 1 }))
          : seat.seat === 1
            ? value(createResourceBounds(1, zero, { ...zero, ore: 1, grain: 1 }))
            : seat.resources,
    })),
  };
  const offered = value(
    base.engine.apply(state, {
      kind: 'command',
      seat: 0,
      command: { type: 'OFFER_TRADE', give: { brick: 1 }, want: { ore: 1 }, to: [1] },
    }),
  ).state;
  const ready = value(
    base.engine.apply(offered, {
      kind: 'command',
      seat: 1,
      command: { type: 'RESPOND_TRADE', offerId: 0, accept: true },
    }),
  ).state;
  const hands = value(emptyHandCommitments(genesis.config.seats)).map((row) => ({
    ...row,
    commitments: {
      ...row.commitments,
      brick: row.seat === 0 ? pedersenCommit(1n, 7n) : row.commitments.brick,
      ore: row.seat === 1 ? pedersenCommit(1n, 11n) : row.commitments.ore,
    },
  }));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- synthetic accepted-trade context supplies only the ledger read by trade planning.
  const crypto = { epoch: 0, hands, decks: { decks: [] } } as unknown as CryptoContext;
  let automatic: CommandShape | null = null;
  let timersExpired = false;
  const engine: Engine = {
    ...base.engine,
    applyPrivate: () => success(base.engine.createPrivateState(0)),
    getAutomaticInput: () =>
      automatic === null
        ? null
        : {
            kind: 'command' as const,
            seat: 0 as Seat,
            command: automatic,
          },
  };
  const context: ProposalContext = {
    log: {
      genesis,
      engine,
      head: base.entry,
      state: ready,
      lastNonces: new Map(),
      crypto,
    },
    // Only genesisDigest is read by the coordinator's command-body construction.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- synthetic proposal context isolates the session coordinator.
    membership: { genesisDigest: genesisDigest(genesis) } as ProposalContext['membership'],
    excludedProposers: [],
    policy: {},
  };
  const clock = new VirtualClock();
  const finalizer = base.identities[0];
  const owner = base.identities[1];
  if (!finalizer || !owner) throw new Error('Missing test identities');
  const ownerKey = owner.secretKey;
  const options = {
    seat: 0,
    secretKey: finalizer.secretKey,
    engine,
    clock,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- constructor test only needs options read by public submit/dispose paths.
  } as unknown as P2PSessionOptions;
  const driver = {
    next: () => null,
    committed: () => success(undefined),
    privateState: (seat: Seat) => (seat === 0 ? engine.createPrivateState(0) : null),
    getTimers: () =>
      timersExpired
        ? [
            {
              key: 'test',
              seat: 0,
              phase: 'main',
              remainingMs: 0,
              expiresAt: clock.now(),
              paused: false,
            },
          ]
        : [],
    prepareCommand: (body: Omit<CommandBody, 'evidence'>, _context: unknown, external?: unknown) =>
      body.command.type === 'CONFIRM_TRADE' && external === undefined
        ? failure('hand-proof-owner', 'Remote owner proof required')
        : success(undefined),
  } satisfies SessionDriver;
  // The private constructor and replica field are filled only at this test's
  // controlled boundary; all assertions call the public session API.
  const session = Reflect.construct(P2PSession, [
    options,
    context,
    driver,
    base.entry,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Reflect.construct returns the actual P2PSession instance.
  ]) as P2PSession;
  const requests: SignedTradeProofRequest[] = [];
  const cancels: string[] = [];
  let requestFailure: string | null = null;
  const submit = vi.fn<(command: SignedCommand) => Promise<Result<void>>>(async () =>
    success(undefined),
  );
  const replica = {
    requestTradeProof: (request: SignedTradeProofRequest) => {
      requests.push(request);
      return requestFailure === null
        ? success(undefined)
        : failure(requestFailure, 'Replica is publishing its new certified parent');
    },
    cancelTradeProofRequest: (id: string) => {
      cancels.push(id);
    },
    submit,
    dispose: vi.fn<() => void>(),
  };
  Reflect.set(session, 'replica', replica satisfies Partial<ReplicatedLog>);
  function respond(request = requests.at(-1)): void {
    if (!request) throw new Error('Missing trade proof request');
    const planned = value(authorizeTradeProof(request.body, 1, context.log));
    const blindings = {
      brick: encodeScalar(0n),
      lumber: encodeScalar(0n),
      wool: encodeScalar(0n),
      grain: encodeScalar(0n),
      ore: encodeScalar(11n),
    };
    const proofs = planned.indices.map((index) => ({
      index,
      proof: value(
        proveHandObligation(
          planned.plan,
          index,
          { ...zero, ore: 1 },
          blindings,
          new Uint8Array(32).fill(9),
          planned.binding,
        ),
      ),
    }));
    const response = signTradeProofResponse(request, 1, proofs, ownerKey);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only callback boundary of the mocked replica.
    const receive = Reflect.get(session, 'receiveTradeProof') as (
      value: SignedTradeProofResponse,
    ) => void;
    receive.call(session, response);
  }
  function changeParent(nextState = context.log.state): void {
    const next = {
      ...context,
      log: {
        ...context.log,
        head: { ...context.log.head, seq: context.log.head.seq + 1 },
        state: nextState,
      },
    };
    Reflect.set(session, 'context', next);
    context.log = next.log;
  }
  function withdrawOffer(): void {
    const withdrawn = value(
      engine.apply(context.log.state, {
        kind: 'command',
        seat: 1,
        command: { type: 'CANCEL_TRADE', offerId: 0 },
      }),
    ).state;
    changeParent(withdrawn);
  }
  return {
    session,
    clock,
    requests,
    cancels,
    submit,
    respond,
    changeParent,
    withdrawOffer,
    failRequest: (code: string | null) => {
      requestFailure = code;
    },
    setAutomatic: (command: CommandShape | null) => {
      automatic = command;
    },
    expireTimer: () => {
      timersExpired = true;
    },
  };
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('peer trade proof coordination', () => {
  test('cancellation frees the seat and a late response cannot submit', async () => {
    const f = fixture();
    try {
      const first = f.session.submit(0, confirm);
      expect(f.requests).toHaveLength(1);
      const oldRequest = f.requests[0];
      if (!oldRequest) throw new Error('Missing first trade request');
      expect(f.session.cancelPending(0)).toBe(true);
      await expect(first).resolves.toMatchObject({
        ok: false,
        error: { code: 'trade-proof-cancelled' },
      });
      expect(f.cancels).toContain(tradeProofRequestId(oldRequest.body));
      f.respond(oldRequest);
      expect(f.submit).not.toHaveBeenCalled();
      const second = f.session.submit(0, confirm);
      expect(f.requests).toHaveLength(2);
      f.respond();
      await expect(second).resolves.toMatchObject({ ok: true });
      expect(f.submit).toHaveBeenCalledOnce();
    } finally {
      f.session.dispose();
    }
  });

  test('timeout and disposal release waiting commands without submitting', async () => {
    const timed = fixture();
    const first = timed.session.submit(0, confirm);
    timed.clock.advanceBy(10_000);
    await expect(first).resolves.toMatchObject({
      ok: false,
      error: { code: 'trade-proof-timeout' },
    });
    expect(timed.session.cancelPending(0)).toBe(false);
    expect(timed.submit).not.toHaveBeenCalled();
    timed.session.dispose();

    const disposed = fixture();
    const second = disposed.session.submit(0, confirm);
    disposed.session.dispose();
    await expect(second).resolves.toMatchObject({
      ok: false,
      error: { code: 'trade-proof-cancelled' },
    });
    disposed.clock.advanceBy(10_000);
    expect(disposed.submit).not.toHaveBeenCalled();
  });

  test('automatic input preempts the trade and is admitted', async () => {
    const f = fixture();
    try {
      const pending = f.session.submit(0, confirm);
      f.setAutomatic({ type: 'END_TURN' });
      f.clock.advanceBy(250);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'trade-proof-interrupted' },
      });
      expect(f.session.cancelPending(0)).toBe(false);
      await tick();
      expect(f.submit).toHaveBeenCalledOnce();
      expect(f.submit.mock.calls[0]?.[0].body.command.type).toBe('END_TURN');
    } finally {
      f.session.dispose();
    }
  });

  test('expired timer cancels the trade and frees the seat', async () => {
    const f = fixture();
    try {
      const pending = f.session.submit(0, confirm);
      f.expireTimer();
      f.clock.advanceBy(250);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'trade-proof-interrupted' },
      });
      expect(f.session.cancelPending(0)).toBe(false);
      expect(f.submit).not.toHaveBeenCalled();
      await expect(f.session.submit(0, { type: 'END_TURN' })).resolves.toMatchObject({
        ok: true,
      });
      expect(f.submit).toHaveBeenCalledOnce();
    } finally {
      f.session.dispose();
    }
  });

  test('a response after timer expiry cannot submit before the next retry tick', async () => {
    const f = fixture();
    try {
      const pending = f.session.submit(0, confirm);
      f.clock.advanceBy(100);
      f.expireTimer();
      f.respond();
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'trade-proof-interrupted' },
      });
      expect(f.submit).not.toHaveBeenCalled();
      expect(f.session.cancelPending(0)).toBe(false);
    } finally {
      f.session.dispose();
    }
  });

  test.each(['trade-proof-stale-head', 'trade-proof-parent'])(
    'waits through replica/session publication gap (%s) without spending fresh-parent attempts',
    async (code) => {
      const f = fixture();
      try {
        const outcome: { value: Result<void> | null } = { value: null };
        const pending = f.session.submit(0, confirm).then((result) => {
          outcome.value = result;
          return result;
        });
        f.failRequest(code);
        f.clock.advanceBy(1_250);
        await tick();
        expect(outcome.value).toBeNull();
        expect(new Set(f.requests.map((request) => request.body.headHash)).size).toBe(1);
        f.changeParent();
        f.failRequest(null);
        f.clock.advanceBy(250);
        await tick();
        expect(new Set(f.requests.map((request) => request.body.headHash)).size).toBe(2);
        f.respond();
        await expect(pending).resolves.toMatchObject({ ok: true });
        expect(f.submit).toHaveBeenCalledOnce();
      } finally {
        f.session.dispose();
      }
    },
  );

  test('changed certified parent regenerates only the same selected trade, capped at three retries', async () => {
    const f = fixture();
    try {
      const pending = f.session.submit(0, confirm);
      const regenerated: { previous: SignedTradeProofRequest; fresh: SignedTradeProofRequest }[] =
        [];
      for (let attempt = 0; attempt < 4; attempt++) {
        const previous = f.requests.at(-1);
        if (!previous) throw new Error('Missing prior request');
        f.changeParent();
        f.clock.advanceBy(250);
        // oxlint-disable-next-line no-await-in-loop -- each virtual retry must settle before the next parent change.
        await tick();
        if (attempt < 3) {
          const fresh = f.requests.at(-1);
          if (!fresh) throw new Error('Missing regenerated trade request');
          regenerated.push({ previous, fresh });
        }
      }
      expect(regenerated).toHaveLength(3);
      for (const { previous, fresh } of regenerated) {
        expect(fresh.body.headSeq).toBe(previous.body.headSeq + 1);
        expect(fresh.body.command).toEqual(previous.body.command);
        expect(fresh.body.headHash).not.toBe(previous.body.headHash);
      }
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'trade-proof-stale' },
      });
      expect(f.submit).not.toHaveBeenCalled();
    } finally {
      f.session.dispose();
    }
  });

  test('withdrawn certified consent stops a fresh-parent attempt', async () => {
    const f = fixture();
    try {
      const pending = f.session.submit(0, confirm);
      f.withdrawOffer();
      f.clock.advanceBy(250);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: { code: 'unaccepted-offer' },
      });
      expect(f.requests).toHaveLength(1);
      expect(f.submit).not.toHaveBeenCalled();
    } finally {
      f.session.dispose();
    }
  });

  test('admission ends cancellability and prevents duplicate submission', async () => {
    const f = fixture();
    let finish: ((result: Result<void>) => void) | undefined;
    f.submit.mockImplementation(
      () =>
        new Promise<Result<void>>((resolve) => {
          finish = resolve;
        }),
    );
    try {
      const pending = f.session.submit(0, confirm);
      f.respond();
      await tick();
      expect(f.submit).toHaveBeenCalledOnce();
      expect(f.session.cancelPending(0)).toBe(false);
      await expect(f.session.submit(0, confirm)).resolves.toMatchObject({
        ok: false,
        error: { code: 'command-pending' },
      });
      finish?.(success(undefined));
      await expect(pending).resolves.toMatchObject({ ok: true });
      expect(f.submit).toHaveBeenCalledOnce();
    } finally {
      f.session.dispose();
    }
  });
});
