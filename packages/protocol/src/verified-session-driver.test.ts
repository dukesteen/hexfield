import { hashValue, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Engine, PrivateState, Seat, SystemInput } from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import { entryHash, genesisDigest } from './genesis.js';
import type { LogContext, ValidatedEntry } from './log.js';
import { signEntry } from './genesis.js';
import type { CertifiedEntry } from './proposal.js';
import { protocolFixture } from './testing/fixtures.js';
import type { Genesis } from './types.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';

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
  return {
    genesis: fixture.genesis,
    engine: fixture.engine,
    head,
    state,
    lastNonces: new Map(),
    crypto: null,
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
    crypto: null,
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

  test('accepts synthetic hidden-steal callback without private payload when no involved seat is owned', () => {
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
    expect(driver.committedEntry(callback.entry, before, callback.after)).toEqual(
      success(undefined),
    );
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
});
