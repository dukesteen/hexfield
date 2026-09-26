import { hashValue, toHex } from '@cp2p/codec';
import { createResourceBounds, exactResourceBounds, failure, success } from '@cp2p/engine';
import { pedersenCommit } from '@cp2p/crypto';
import type { Engine, PrivateState, Seat, SystemInput } from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import { entryHash, genesisDigest } from './genesis.js';
import type { LogContext, ValidatedEntry } from './log.js';
import { signEntry } from './genesis.js';
import type { CertifiedEntry } from './proposal.js';
import { protocolFixture } from './testing/fixtures.js';
import type { Genesis } from './types.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';
import type { CryptoContext } from './crypto-context.js';
import { emptyHandCommitments } from './hand-commitments.js';

function verifiedGenesis(): {
  engine: ReturnType<typeof protocolFixture>['engine'];
  genesis: Genesis;
  state: ReturnType<ReturnType<typeof protocolFixture>['engine']['createGame']>;
  entry: ReturnType<typeof protocolFixture>['entry'];
  identities: ReturnType<typeof protocolFixture>['identities'];
} {
  const fixture = protocolFixture();
  // Synthetic callback fixture only: these tests check local failure boundaries, not certificates.
  const genesis = { ...fixture.genesis, security: 'verified' as const };
  return { ...fixture, genesis };
}

function contextFor(
  fixture: ReturnType<typeof verifiedGenesis>,
  head = fixture.entry,
  state = fixture.state,
): LogContext {
  const hands = emptyHandCommitments(fixture.genesis.config.seats);
  if (!hands.ok) throw new Error(hands.error.message);
  // Synthetic callback fixture: its stub genesis has no verified beacon setup.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the genuine zero hand commitments are read by these local callback tests.
  const crypto = { epoch: 0, hands: hands.value, decks: { decks: [] } } as unknown as CryptoContext;
  return {
    genesis: fixture.genesis,
    engine: fixture.engine,
    head,
    state,
    lastNonces: new Map(),
    crypto,
  };
}

function syntheticCommitted(
  fixture: ReturnType<typeof verifiedGenesis>,
  before: LogContext,
  input: SystemInput,
  afterState = before.state,
): { entry: ValidatedEntry & CertifiedEntry; after: LogContext } {
  const identity = fixture.identities[0];
  if (!identity) throw new Error('Missing synthetic callback signer');
  const logEntry = signEntry(
    {
      seq: before.head.seq + 1,
      term: 1,
      prevHash: entryHash(before.head),
      payload: { kind: 'system', input, evidence: { kind: 'stub', context: 'synthetic' } },
      stateHash: toHex(hashValue(afterState)),
      sequencer: identity.peerId,
    },
    identity.secretKey,
  );
  const after = contextFor(fixture, logEntry, afterState);
  const entry = {
    entry: logEntry,
    hash: entryHash(logEntry),
    input,
    state: afterState,
    events: [],
    lastNonces: before.lastNonces,
    crypto: after.crypto,
    proof: { entry: logEntry, votes: [] },
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- synthetic callback fixture bypasses certificate verification by design.
  } as unknown as ValidatedEntry & CertifiedEntry;
  return { entry, after };
}

function driverFor(fixture: ReturnType<typeof verifiedGenesis>, seats: readonly Seat[]) {
  return new VerifiedSessionDriver(fixture.engine, fixture.genesis, seats, () => {
    throw new Error('Deck secret source should not be needed by these tests');
  });
}

function bodyFor(fixture: ReturnType<typeof verifiedGenesis>, context: LogContext) {
  return {
    gameId: fixture.genesis.gameId,
    genesisDigest: genesisDigest(fixture.genesis),
    seat: 0 as const,
    nonce: 1,
    headSeq: context.head.seq,
    headHash: entryHash(context.head),
    command: { type: 'END_TURN' as const },
  };
}

describe('VerifiedSessionDriver safety boundaries', () => {
  test('rejects skipped or repeated private callbacks even when the supplied public pair matches', () => {
    const fixture = verifiedGenesis();
    const engine = { ...fixture.engine, applyPrivate: (priv: PrivateState) => success(priv) };
    const driver = new VerifiedSessionDriver(engine, fixture.genesis, [0], () => {
      throw new Error('This callback does not use a deck source');
    });
    const before = contextFor(fixture);
    const input: SystemInput = { kind: 'system', type: 'SEAT_STATUS', seat: 3, status: 'departed' };
    const first = syntheticCommitted(fixture, before, input);
    const second = syntheticCommitted(fixture, first.after, input);
    const third = syntheticCommitted(fixture, second.after, input);
    expect(driver.committedEntry(second.entry, first.after, second.after)).toMatchObject({
      ok: false,
      error: { code: 'verified-entry-context' },
    });
    expect(driver.committedEntry(first.entry, before, first.after)).toEqual(success(undefined));
    expect(driver.committedEntry(third.entry, second.after, third.after)).toMatchObject({
      ok: false,
      error: { code: 'verified-entry-context' },
    });
    expect(driver.committedEntry(second.entry, first.after, second.after)).toEqual(
      success(undefined),
    );
    expect(driver.committedEntry(second.entry, first.after, second.after)).toMatchObject({
      ok: false,
      error: { code: 'verified-entry-context' },
    });
  });

  test('rejects proof preparation when the context belongs to another genesis', () => {
    const local = verifiedGenesis();
    const foreign = verifiedGenesis();
    foreign.genesis = { ...foreign.genesis, createdAt: foreign.genesis.createdAt + 1 };
    const driver = driverFor(local, [0]);
    const context = contextFor(foreign);
    const result = driver.prepareCommand(
      {
        gameId: foreign.genesis.gameId,
        genesisDigest: genesisDigest(foreign.genesis),
        seat: 0,
        nonce: 1,
        headSeq: context.head.seq,
        headHash: entryHash(context.head),
        command: { type: 'END_TURN' },
      },
      context,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'verified-command-context' } });
  });

  test('retains only owned private states, returns detached copies, and clears them on dispose', () => {
    const fixture = verifiedGenesis();
    const driver = driverFor(fixture, [0, 2]);
    const snapshot = driver.privateState(0);
    expect(snapshot).not.toBeNull();
    expect(driver.privateState(1)).toBeNull();
    if (!snapshot) throw new Error('Missing owned private state');
    snapshot.hand.ore = 99;
    snapshot.slots['forged'] = 'knight';
    snapshot.ext['detached'] = true;
    expect(driver.privateState(0)).toEqual(fixture.engine.createPrivateState(0));
    driver.dispose();
    expect(driver.privateState(0)).toBeNull();
    expect(driver.privateState(2)).toBeNull();
  });

  test('fails closed for hidden steals involving an owned seat and preserves its hand', () => {
    const fixture = verifiedGenesis();
    const driver = driverFor(fixture, [0]);
    const before = contextFor(fixture);
    const beforePrivate = driver.privateState(0);
    for (const [thief, victim] of [
      [0, 1],
      [1, 0],
    ] as const) {
      const callback = syntheticCommitted(fixture, before, {
        kind: 'system',
        type: 'STEAL_RESULT',
        thief,
        victim,
        resource: 'hidden',
      });
      expect(driver.committedEntry(callback.entry, before, callback.after)).toMatchObject({
        ok: false,
        error: { code: 'verified-hidden-steal' },
      });
      expect(driver.privateState(0)).toEqual(beforePrivate);
    }
  });

  test('rejects synthetic hidden-steal callback even when no involved seat is owned', () => {
    const fixture = verifiedGenesis();
    // The permissive callback isolates this private-update boundary from game-phase validation.
    const engine = {
      ...fixture.engine,
      applyPrivate: (priv: PrivateState) => success(priv),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- isolate applyPrivate from system-phase validation.
    } as unknown as Engine;
    const driver = new VerifiedSessionDriver(engine, fixture.genesis, [0], () => {
      throw new Error('Deck secret source should not be needed by this test');
    });
    const before = contextFor(fixture);
    const callback = syntheticCommitted(fixture, before, {
      kind: 'system',
      type: 'STEAL_RESULT',
      thief: 1,
      victim: 2,
      resource: 'hidden',
    });
    expect(driver.committedEntry(callback.entry, before, callback.after)).toMatchObject({
      ok: false,
      error: { code: 'verified-hidden-steal' },
    });
  });

  test('does not partially replace owned private states when a later owned-seat apply fails', () => {
    const fixture = verifiedGenesis();
    const calls: Seat[] = [];
    const engine = {
      ...fixture.engine,
      applyPrivate: vi.fn<(priv: PrivateState) => ReturnType<Engine['applyPrivate']>>((priv) => {
        calls.push(priv.seat);
        return priv.seat === 2
          ? failure('synthetic-private-failure', 'Synthetic callback fixture failure')
          : success({ ...priv, ext: { ...priv.ext, atomicityProbe: true } });
      }),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- inject a synthetic failing private updater for atomicity.
    } as unknown as Engine;
    const driver = new VerifiedSessionDriver(engine, fixture.genesis, [0, 2], () => {
      throw new Error('Deck secret source should not be needed by this test');
    });
    const before = contextFor(fixture);
    const callback = syntheticCommitted(fixture, before, {
      kind: 'system',
      type: 'SEAT_STATUS',
      seat: 3,
      status: 'departed',
    });
    const privateBefore = [driver.privateState(0), driver.privateState(2)];
    expect(driver.committedEntry(callback.entry, before, callback.after)).toMatchObject({
      ok: false,
      error: { code: 'synthetic-private-failure' },
    });
    expect(calls).toEqual([0, 2]);
    expect([driver.privateState(0), driver.privateState(2)]).toEqual(privateBefore);
  });

  test('proof-free commands need no hand source but still reject a wrong parent opening', () => {
    const fixture = verifiedGenesis();
    const emptyTransition = {
      state: fixture.state,
      events: [],
      effects: [],
    };
    const engine = {
      ...fixture.engine,
      apply: () => success(emptyTransition),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- local preview fixture isolates proof preparation.
    } as unknown as Engine;
    const source = vi.fn<() => never>(() => {
      throw new Error('No hand proof should be needed');
    });
    const driver = new VerifiedSessionDriver(
      engine,
      fixture.genesis,
      [0],
      () => {
        throw new Error('No deck proof should be needed');
      },
      source,
    );
    const context = contextFor(fixture);
    expect(driver.prepareCommand(bodyFor(fixture, context), context)).toEqual(success(undefined));
    expect(source).not.toHaveBeenCalled();
    if (!context.crypto) throw new Error('Missing crypto fixture');
    const wrong: LogContext = {
      ...context,
      crypto: {
        ...context.crypto,
        hands: context.crypto.hands.map((row) =>
          row.seat === 0
            ? { ...row, commitments: { ...row.commitments, brick: pedersenCommit(1n, 0n) } }
            : row,
        ),
      },
    };
    expect(driver.prepareCommand(bodyFor(fixture, wrong), wrong)).toMatchObject({
      ok: false,
      error: { code: 'hand-opening-mismatch' },
    });
  });

  test('prepares an owned range proof and rejects replay with a wrong post opening', () => {
    const fixture = verifiedGenesis();
    const none = exactResourceBounds({ brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 });
    const uncertain = createResourceBounds(
      1,
      { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 },
      { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 1 },
    );
    if (!none.ok || !uncertain.ok) throw new Error('Missing resource bounds');
    const context = contextFor(fixture);
    if (!context.crypto) throw new Error('Missing crypto fixture');
    const beforeState = {
      ...fixture.state,
      bank: { ...fixture.state.bank, brick: (fixture.state.bank.brick ?? 0) - 1 },
      seats: fixture.state.seats.map((seat) =>
        seat.seat === 0 ? { ...seat, resources: uncertain.value } : seat,
      ),
    };
    const afterState = {
      ...beforeState,
      bank: { ...fixture.state.bank },
      seats: beforeState.seats.map((seat) =>
        seat.seat === 0 ? { ...seat, resources: none.value } : seat,
      ),
    };
    const before: LogContext = {
      ...context,
      state: beforeState,
      crypto: {
        ...context.crypto,
        hands: context.crypto.hands.map((row) =>
          row.seat === 0
            ? { ...row, commitments: { ...row.commitments, brick: pedersenCommit(1n, 0n) } }
            : row,
        ),
      },
    };
    const engine = {
      ...fixture.engine,
      createPrivateState: (seat: Seat) => ({
        ...fixture.engine.createPrivateState(seat),
        hand: { ...fixture.engine.createPrivateState(seat).hand, brick: seat === 0 ? 1 : 0 },
      }),
      apply: () =>
        success({
          state: afterState,
          events: [],
          effects: [
            {
              type: 'resource-transfer' as const,
              from: { kind: 'seat' as const, seat: 0 },
              to: { kind: 'bank' as const },
              resource: 'brick' as const,
              count: 1,
            },
          ],
        }),
      applyPrivate: (priv: PrivateState) => success({ ...priv, hand: { ...priv.hand, brick: 0 } }),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- local preview fixture isolates the exact proof obligation.
    } as unknown as Engine;
    const withoutSource = new VerifiedSessionDriver(engine, fixture.genesis, [0], () => {
      throw new Error('No deck proof should be needed');
    });
    expect(withoutSource.prepareCommand(bodyFor(fixture, before), before)).toMatchObject({
      ok: false,
      error: { code: 'hand-proof-source' },
    });
    const seed = new Uint8Array(32).fill(7);
    const disposed = vi.fn<() => void>();
    const source = vi.fn<(seat: Seat) => { proofSeed: () => Uint8Array; dispose: () => void }>(
      (_seat) => ({ proofSeed: () => seed.slice(), dispose: disposed }),
    );
    const driver = new VerifiedSessionDriver(
      engine,
      fixture.genesis,
      [0],
      () => {
        throw new Error('No deck proof should be needed');
      },
      source,
    );
    const prepared = driver.prepareCommand(bodyFor(fixture, before), before);
    if (!prepared.ok) throw new Error(`${prepared.error.code}: ${prepared.error.message}`);
    expect(prepared).toMatchObject({
      ok: true,
      value: { protocol: 'command-proofs-v1', data: { deck: [], hands: [{ kind: 'range' }] } },
    });
    expect(source).toHaveBeenCalledOnce();
    expect(disposed).toHaveBeenCalledOnce();
    const input: SystemInput = { kind: 'system', type: 'SEAT_STATUS', seat: 3, status: 'departed' };
    const callback = syntheticCommitted(fixture, before, input, afterState);
    callback.after.crypto = before.crypto;
    expect(driver.committedEntry(callback.entry, before, callback.after)).toMatchObject({
      ok: false,
      error: { code: 'hand-opening-mismatch' },
    });
    expect(driver.privateState(0)?.hand.brick).toBe(1);
  });
});
