import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import {
  RESOURCES,
  createResourceBounds,
  exactResourceBounds,
  failure,
  success,
} from '@cp2p/engine';
import {
  decodePoint,
  encodePoint,
  G,
  pedersenCommit,
  scalarToBytes,
  scalePoint,
} from '@cp2p/crypto';
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
import type { CountOperation } from './count-reveal.js';
import { signCountContribution, verifyCountContribution } from './count-reveal.js';
import { createStealSecretSource } from './steal-source.js';
import { STEAL_EVIDENCE_PROTOCOL, stealOperationId } from './steal-delivery.js';
import type { FixedSteal, StealOperation } from './steal-delivery.js';
import { beaconOperationId } from './beacon.js';
import type { BeaconOperation } from './beacon.js';
import { reconstructPrivateSeats } from './private-replay.js';
import {
  advanceRecoveryFixture,
  certifyRecoveryFixtureEntry,
  createRecoveryFixture,
  recoveryFixtureReadiness,
  recoveryFixtureReplacement,
  signRecoveryFixtureActivation,
  signRecoveryFixtureAuthorization,
  signRecoveryFixtureEntry,
} from './testing/recovery-fixture.js';

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
  // oxlint-disable typescript/no-unsafe-type-assertion -- only the genuine zero hand commitments are read by these local callback tests.
  const crypto = {
    epoch: 0,
    hands: hands.value,
    decks: { decks: [] },
    steal: null,
  } as unknown as CryptoContext;
  // oxlint-enable typescript/no-unsafe-type-assertion
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

  test('relinquishes one bot without discarding the surviving human private state', () => {
    const fixture = verifiedGenesis();
    const driver = driverFor(fixture, [0, 2]);
    const bot = driver.privateState(2);
    if (!bot) throw new Error('Missing bot private state');
    driver.relinquishSeats([2]);
    expect(driver.privateState(2)).toBeNull();
    expect(driver.privateState(0)).toEqual(fixture.engine.createPrivateState(0));
    expect(bot).toEqual(fixture.engine.createPrivateState(2));
    driver.relinquishSeats([2]);
    expect(driver.privateState(0)).not.toBeNull();
    driver.dispose();
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

  test('produces an owned zero Monopoly count proof only for the frozen pending request', () => {
    const fixture = verifiedGenesis();
    const context = contextFor(fixture);
    if (!context.crypto) throw new Error('Missing crypto fixture');
    const uncertain = createResourceBounds(
      1,
      { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 },
      { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 1 },
    );
    if (!uncertain.ok) throw new Error(uncertain.error.message);
    context.state = {
      ...context.state,
      turn: {
        ...context.state.turn,
        activeSeat: 1,
        phase: [
          { module: 'base', id: 'main', data: null },
          { module: 'base', id: 'monopoly', data: { seat: 1, resource: 'brick', remaining: [0] } },
        ],
      },
      seats: context.state.seats.map((seat) =>
        seat.seat === 0 ? { ...seat, resources: uncertain.value } : seat,
      ),
    };
    context.crypto = {
      ...context.crypto,
      hands: context.crypto.hands.map((row) =>
        row.seat === 0
          ? { ...row, commitments: { ...row.commitments, ore: pedersenCommit(1n, 0n) } }
          : row,
      ),
    };
    const victim = fixture.genesis.seats.find((item) => item.seat === 0);
    const hand = context.crypto.hands.find((item) => item.seat === 0);
    if (!victim || !hand) throw new Error('Missing victim fixture');
    const operation: CountOperation = {
      protocol: 'monopoly-count-v1',
      genesisDigest: genesisDigest(fixture.genesis),
      epoch: 0,
      anchor: { seq: context.head.seq, hash: entryHash(context.head) },
      monopolist: 1,
      resource: 'brick',
      victims: [{ seat: 0, publicKey: victim.publicKey, commitment: hand.commitments.brick }],
    };
    context.crypto = { ...context.crypto, counts: { operation, remaining: [0] } };
    const seed = new Uint8Array(32).fill(7);
    const disposed = vi.fn<() => void>();
    const source = vi.fn<(seat: Seat) => { proofSeed: () => Uint8Array; dispose: () => void }>(
      () => ({ proofSeed: () => seed.slice(), dispose: disposed }),
    );
    const engine = {
      ...fixture.engine,
      createPrivateState: (seat: Seat) => ({
        ...fixture.engine.createPrivateState(seat),
        hand: { ...fixture.engine.createPrivateState(seat).hand, ore: seat === 0 ? 1 : 0 },
      }),
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the owned starting hand differs in this synthetic pending fixture.
    } as unknown as Engine;
    const driver = new VerifiedSessionDriver(
      engine,
      fixture.genesis,
      [0],
      () => {
        throw new Error('Count proof needs no deck source');
      },
      source,
    );
    const prepared = driver.produceCountProof(operation, 0, context);
    expect(prepared).toMatchObject({ ok: true, value: { count: 0, proof: {} } });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const signer = fixture.identities[0];
    if (!signer) throw new Error('Missing victim signing key');
    const signed = signCountContribution(
      operation,
      0,
      prepared.value.count,
      prepared.value.proof,
      signer.secretKey,
    );
    expect(verifyCountContribution(signed, operation)).toEqual(success(signed));
    expect(source).toHaveBeenCalledOnce();
    expect(disposed).toHaveBeenCalledOnce();
    const staleHead: LogContext = { ...context, head: { ...context.head, seq: 1 } };
    expect(driver.produceCountProof(operation, 0, staleHead)).toMatchObject({
      ok: false,
      error: { code: 'verified-count-context' },
    });
    const wrongOpening: LogContext = {
      ...context,
      crypto: {
        ...context.crypto,
        hands: context.crypto.hands.map((row) =>
          row.seat === 0
            ? { ...row, commitments: { ...row.commitments, ore: pedersenCommit(0n, 0n) } }
            : row,
        ),
      },
    };
    expect(driver.produceCountProof(operation, 0, wrongOpening)).toMatchObject({
      ok: false,
      error: { code: 'hand-opening-mismatch' },
    });
    expect(source).toHaveBeenCalledOnce();
    expect(driver.produceCountProof(operation, 1, context)).toMatchObject({
      ok: false,
      error: { code: 'seat-not-controllable' },
    });
    expect(driver.produceCountProof({ ...operation, resource: 'ore' }, 0, context)).toMatchObject({
      ok: false,
      error: { code: 'verified-count-operation' },
    });
    const missingSource = new VerifiedSessionDriver(engine, fixture.genesis, [0], () => {
      throw new Error('Count proof needs no deck source');
    });
    expect(missingSource.produceCountProof(operation, 0, context)).toMatchObject({
      ok: false,
      error: { code: 'hand-proof-source' },
    });
    const stale: LogContext = { ...context, crypto: { ...context.crypto, counts: null } };
    expect(driver.produceCountProof(operation, 0, stale)).toMatchObject({
      ok: false,
      error: { code: 'count-context-required' },
    });
    driver.dispose();
  });

  test('prepares both steal roles and folds a certified hidden transfer atomically on replay', () => {
    const fixture = verifiedGenesis();
    const masters = fixture.genesis.config.seats.map((seat) => scalarToBytes(BigInt(seat + 5)));
    const seats = fixture.genesis.seats.map((row) => {
      const master = masters[row.seat];
      if (!master) throw new Error('Missing source master');
      const source = createStealSecretSource(
        master,
        fixture.genesis.ceremonyNonce,
        row.seat,
        row.publicKey,
      );
      try {
        return { ...row, encryptionKey: encodePoint(scalePoint(G, source.encryptionSecret())) };
      } finally {
        source.dispose();
      }
    });
    fixture.genesis = { ...fixture.genesis, seats };
    const sourceFactory = (seat: Seat) => {
      const master = masters[seat];
      const row = fixture.genesis.seats.find((item) => item.seat === seat);
      if (!master || !row) throw new Error('Missing owned steal source');
      return createStealSecretSource(master, fixture.genesis.ceremonyNonce, seat, row.publicKey);
    };
    const one = exactResourceBounds({ brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 });
    const zero = exactResourceBounds({ brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 });
    if (!one.ok || !zero.ok) throw new Error('Missing synthetic resource bounds');
    const startingState = {
      ...fixture.state,
      seats: fixture.state.seats.map((row) =>
        row.seat === 1 ? { ...row, resources: one.value } : row,
      ),
    };
    const engine = {
      ...fixture.engine,
      createPrivateState: (seat: Seat) => {
        const prior = fixture.engine.createPrivateState(seat);
        return seat === 1 ? { ...prior, hand: { ...prior.hand, brick: 1 } } : prior;
      },
      applyPrivate: (
        prior: PrivateState,
        _before: unknown,
        input: SystemInput,
        data?: { resource?: string },
      ) => {
        if (
          input.type !== 'STEAL_RESULT' ||
          (prior.seat !== input.thief && prior.seat !== input.victim)
        )
          return success(prior);
        if (data?.resource !== 'brick')
          return failure('synthetic-steal-card', 'Missing owned card');
        return success({
          ...prior,
          hand: {
            ...prior.hand,
            brick: (prior.hand.brick ?? 0) + (prior.seat === input.thief ? 1 : -1),
          },
        });
      },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- synthetic callback isolates private folding from the full robber phase.
    } as unknown as Engine;
    const before = contextFor(fixture, fixture.entry, startingState);
    if (!before.crypto) throw new Error('Missing synthetic crypto state');
    const victimHand = before.crypto.hands.map((row) =>
      row.seat === 1
        ? { ...row, commitments: { ...row.commitments, brick: pedersenCommit(1n, 0n) } }
        : row,
    );
    const beaconOperation: BeaconOperation = {
      genesisDigest: genesisDigest(fixture.genesis),
      epoch: 0,
      anchor: { seq: 0, hash: entryHash(before.head) },
      round: 1,
      pending: {
        kind: 'random',
        request: { type: 'stealIndex', thief: 0, victim: 1, handSize: 1 },
        systemType: 'STEAL_RESULT',
      },
      participants: [
        {
          seat: 0,
          publicKey: seats[0]?.publicKey ?? '',
          chainEpoch: 0,
          index: 1,
          length: 1,
          previous: toBase64Url(new Uint8Array(32).fill(7)),
        },
      ],
    };
    const beaconFixed = {
      operation: beaconOperation,
      seed: toBase64Url(new Uint8Array(32).fill(8)),
      outcome: {
        kind: 'steal-index' as const,
        thief: 0 as const,
        victim: 1 as const,
        handSize: 1,
        index: 0,
      },
      entry: { seq: before.head.seq, hash: entryHash(before.head) },
    };
    const operation: StealOperation = {
      protocol: STEAL_EVIDENCE_PROTOCOL,
      genesisDigest: genesisDigest(fixture.genesis),
      epoch: 0,
      anchor: { seq: before.head.seq, hash: entryHash(before.head) },
      beaconOperationId: beaconOperationId(beaconOperation),
      thief: {
        seat: 0,
        publicKey: seats[0]?.publicKey ?? '',
        encryptionKey: seats[0]?.encryptionKey ?? '',
      },
      victim: { seat: 1, publicKey: seats[1]?.publicKey ?? '' },
      handSize: 1,
      index: 0,
      commitments: victimHand.find((row) => row.seat === 1)?.commitments ?? {
        brick: '',
        lumber: '',
        wool: '',
        grain: '',
        ore: '',
      },
    };
    before.crypto = {
      ...before.crypto,
      hands: victimHand,
      beacon: {
        genesisDigest: genesisDigest(fixture.genesis),
        chains: [],
        round: 1,
        active: null,
        fixed: beaconFixed,
      },
      steal: { operation, fixed: null, dispute: null },
    };
    const driver = new VerifiedSessionDriver(
      engine,
      fixture.genesis,
      [0, 1],
      () => {
        throw new Error('Steal callback needs no deck source');
      },
      undefined,
      sourceFactory,
    );
    const victimKey = fixture.identities[1]?.secretKey;
    const thiefKey = fixture.identities[0]?.secretKey;
    if (!victimKey || !thiefKey) throw new Error('Missing synthetic signing key');
    const contribution = driver.produceStealContribution(operation, 1, before, victimKey);
    expect(contribution.ok).toBe(true);
    if (!contribution.ok) return;
    expect(driver.produceStealContribution(operation, 2, before, victimKey)).toMatchObject({
      ok: false,
      error: { code: 'seat-not-controllable' },
    });
    const missingSource = new VerifiedSessionDriver(engine, fixture.genesis, [1], () => {
      throw new Error('Steal callback needs no deck source');
    });
    expect(missingSource.produceStealContribution(operation, 1, before, victimKey)).toMatchObject({
      ok: false,
      error: { code: 'steal-source' },
    });
    const wrongSource = new VerifiedSessionDriver(
      engine,
      fixture.genesis,
      [1],
      () => {
        throw new Error('Steal callback needs no deck source');
      },
      undefined,
      (seat) =>
        createStealSecretSource(
          scalarToBytes(99n),
          fixture.genesis.ceremonyNonce,
          seat,
          fixture.genesis.seats.find((row) => row.seat === seat)?.publicKey ?? '',
        ),
    );
    expect(wrongSource.produceStealContribution(operation, 1, before, victimKey)).toMatchObject({
      ok: false,
      error: { code: 'steal-source-key' },
    });
    expect(
      driver.produceStealContribution({ ...operation, index: 1 }, 1, before, victimKey),
    ).toMatchObject({
      ok: false,
      error: { code: 'verified-steal-operation' },
    });
    const signer = fixture.identities[0];
    if (!signer) throw new Error('Missing synthetic signer');
    const fixedEntry = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(before.head),
        payload: { kind: 'crypto', action: 'steal-fixed', evidence: contribution.value },
        stateHash: toHex(hashValue(startingState)),
        sequencer: signer.peerId,
      },
      signer.secretKey,
    );
    const fixed: FixedSteal = {
      operation,
      contribution: contribution.value,
      entry: { seq: 1, hash: entryHash(fixedEntry) },
    };
    const fixedContext: LogContext = {
      ...before,
      head: fixedEntry,
      crypto: { ...before.crypto, steal: { operation, fixed, dispute: null } },
    };
    const fixedCallback = {
      entry: fixedEntry,
      hash: entryHash(fixedEntry),
      input: null,
      state: startingState,
      events: [],
      lastNonces: before.lastNonces,
      crypto: fixedContext.crypto,
      proof: { entry: fixedEntry, votes: [] },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- synthetic certified callback fixture.
    } as unknown as ValidatedEntry & CertifiedEntry;
    expect(driver.committedEntry(fixedCallback, before, fixedContext)).toEqual(success(undefined));
    expect(driver.produceStealResponse(fixed, 0, before, thiefKey)).toMatchObject({
      ok: false,
      error: { code: 'verified-steal-context' },
    });
    const response = driver.produceStealResponse(fixed, 0, fixedContext, thiefKey);
    expect(response).toMatchObject({ ok: true, value: { kind: 'receipt' } });
    if (!response.ok || response.value.kind !== 'receipt') return;
    const input: SystemInput = {
      kind: 'system',
      type: 'STEAL_RESULT',
      thief: 0,
      victim: 1,
      resource: 'hidden',
    };
    const resultState = {
      ...startingState,
      seats: startingState.seats.map((row) =>
        row.seat === 0
          ? { ...row, resources: one.value }
          : row.seat === 1
            ? { ...row, resources: zero.value }
            : row,
      ),
    };
    const transfer = contribution.value.body.transfer;
    const resultHands = victimHand.map((row) => {
      const moved = (resource: (typeof RESOURCES)[number]) => {
        const current = decodePoint(row.commitments[resource]);
        const transferPoint = decodePoint(transfer[RESOURCES.indexOf(resource)] ?? '');
        return encodePoint(
          row.seat === 0
            ? current.add(transferPoint)
            : row.seat === 1
              ? current.subtract(transferPoint)
              : current,
        );
      };
      return {
        ...row,
        commitments: {
          brick: moved('brick'),
          lumber: moved('lumber'),
          wool: moved('wool'),
          grain: moved('grain'),
          ore: moved('ore'),
        },
      };
    });
    const resultEntry = signEntry(
      {
        seq: 2,
        term: 1,
        prevHash: entryHash(fixedEntry),
        payload: {
          kind: 'system',
          input,
          evidence: {
            kind: 'proof',
            protocol: 'hidden-steal-v1',
            data: response.value.value,
          },
        },
        stateHash: toHex(hashValue(resultState)),
        sequencer: signer.peerId,
      },
      signer.secretKey,
    );
    if (!fixedContext.crypto) throw new Error('Missing fixed crypto context');
    const after: LogContext = {
      ...fixedContext,
      head: resultEntry,
      state: resultState,
      crypto: { ...fixedContext.crypto, hands: resultHands, steal: null },
    };
    const resultCallback = {
      entry: resultEntry,
      hash: entryHash(resultEntry),
      input,
      state: resultState,
      events: [],
      lastNonces: before.lastNonces,
      crypto: after.crypto,
      proof: { entry: resultEntry, votes: [] },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- synthetic certified callback fixture.
    } as unknown as ValidatedEntry & CertifiedEntry;
    const replay = new VerifiedSessionDriver(
      engine,
      fixture.genesis,
      [0, 1],
      () => {
        throw new Error('Steal callback needs no deck source');
      },
      undefined,
      sourceFactory,
    );
    expect(replay.committedEntry(fixedCallback, before, fixedContext)).toEqual(success(undefined));
    if (!after.crypto) throw new Error('Missing result crypto context');
    const broken: LogContext = {
      ...after,
      crypto: { ...after.crypto, hands: victimHand },
    };
    const original = [replay.privateState(0), replay.privateState(1)];
    expect(replay.committedEntry(resultCallback, fixedContext, broken).ok).toBe(false);
    expect([replay.privateState(0), replay.privateState(1)]).toEqual(original);
    expect(driver.committedEntry(resultCallback, fixedContext, after)).toEqual(success(undefined));
    expect(replay.committedEntry(resultCallback, fixedContext, after)).toEqual(success(undefined));
    expect(replay.privateState(0)).toEqual(driver.privateState(0));
    expect(replay.privateState(1)).toEqual(driver.privateState(1));
    expect(driver.privateState(0)?.hand.brick).toBe(1);
    expect(driver.privateState(1)?.hand.brick).toBe(0);
    expect(driver.committedEntry(resultCallback, fixedContext, after)).toMatchObject({
      ok: false,
      error: { code: 'verified-entry-context' },
    });
    expect(stealOperationId(operation)).toBe(contribution.value.body.operationId);
  });
  test('adopts only a nonoverlapping recovered bot at the identical verified head', () => {
    const fixture = createRecoveryFixture({ masterBackedBeacon: true, chainLength: 1 });
    const replacement = recoveryFixtureReplacement(122);
    const authorization = signRecoveryFixtureAuthorization(
      fixture,
      recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId),
      replacement.secretKey,
    );
    const authEntry = signRecoveryFixtureEntry(
      fixture,
      fixture.ready,
      { kind: 'membership', change: authorization },
      fixture.ready.log.head.stateHash,
    );
    const certifiedAuth = certifyRecoveryFixtureEntry(fixture, fixture.ready, authEntry, [1, 2, 3]);
    const authorized = advanceRecoveryFixture(fixture.ready, certifiedAuth);
    const activation = signRecoveryFixtureActivation(fixture, authorized, authEntry);
    const takeover = fixture.source.engine.apply(authorized.log.state, {
      kind: 'system',
      type: 'SEAT_STATUS',
      seat: 0,
      status: 'bot',
    });
    if (!takeover.ok) throw new Error(takeover.error.message);
    const activatedEntry = signRecoveryFixtureEntry(
      fixture,
      authorized,
      { kind: 'membership', change: activation },
      toHex(hashValue(takeover.value.state)),
    );
    const certifiedActivation = certifyRecoveryFixtureEntry(
      fixture,
      authorized,
      activatedEntry,
      [1, 2, 3],
    );
    const active = advanceRecoveryFixture(authorized, certifiedActivation);
    const entries = [...fixture.deckEntries, certifiedAuth, certifiedActivation];
    const host = reconstructPrivateSeats({
      genesisEntry: fixture.genesisEntry,
      entries,
      engine: fixture.source.engine,
      policy: fixture.policy,
      secrets: [{ seat: 1, master: scalarToBytes(18n) }],
    });
    const donor = reconstructPrivateSeats({
      genesisEntry: fixture.genesisEntry,
      entries,
      engine: fixture.source.engine,
      policy: fixture.policy,
      secrets: [{ seat: 0, master: scalarToBytes(17n) }],
    });
    if (!host.ok || !donor.ok) throw new Error('Could not reconstruct certified private seats');
    try {
      expect(host.value.driver.privateState(0)).toBeNull();
      expect(host.value.driver.adoptRecovered(donor.value.driver, authorized.log)).toMatchObject({
        ok: false,
        error: { code: 'verified-adoption-context' },
      });
      expect(host.value.driver.adoptRecovered(donor.value.driver, active.log)).toEqual(
        success(undefined),
      );
      expect(host.value.driver.privateState(0)).toEqual(donor.value.driver.privateState(0));
      expect(host.value.driver.validateSources()).toEqual(success(undefined));
      expect(host.value.driver.adoptRecovered(donor.value.driver, active.log)).toMatchObject({
        ok: false,
        error: { code: 'verified-adoption-seat' },
      });
      donor.value.dispose();
      expect(host.value.driver.privateState(0)).not.toBeNull();
      expect(host.value.driver.validateSources().ok).toBe(false);
    } finally {
      host.value.dispose();
      donor.value.dispose();
      replacement.secretKey.fill(0);
    }
  }, 30_000);
});
