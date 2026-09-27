import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { identityFromSecret, scalarToBytes } from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import { beforeAll, describe, expect, test } from 'vitest';
import { entryHash } from './genesis.js';
import { MemoryGenesisConsentStore } from './genesis-outbox.js';
import { MemoryProtocolJournal } from './journal.js';
import type { ProtocolJournal } from './journal.js';
import { loadRecoveredHost } from './recovered-host.js';
import { persistRecoveryPrivate } from './recovery-private.js';
import { prepareRecoveryReadiness } from './recovery-readiness.js';
import type { ProposalContext } from './proposal.js';
import {
  advanceRecoveryFixture,
  certifyRecoveryFixtureEntry,
  createRecoveryFixture,
  recoveryFixtureKey,
  recoveryFixtureReadiness,
  recoveryFixtureReplacement,
  recoveryFixtureRef,
  signRecoveryFixtureActivation,
  signRecoveryFixtureEntry,
} from './testing/recovery-fixture.js';
import type { RecoveryFixture } from './testing/recovery-fixture.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing recovered host fixture');
  return item;
}

describe('recovered host restore', () => {
  let fixture: RecoveryFixture;
  let active: ProposalContext;
  let authorized: ProposalContext;
  let replacementKey: Uint8Array;
  let store: MemoryGenesisConsentStore;
  let journal: MemoryProtocolJournal;

  beforeAll(async () => {
    fixture = createRecoveryFixture({ masterBackedBeacon: true, chainLength: 1 });
    const replacement = recoveryFixtureReplacement(121);
    replacementKey = replacement.secretKey.slice();
    store = new MemoryGenesisConsentStore();
    const statement = recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId);
    const authorization = value(
      await prepareRecoveryReadiness(
        statement,
        fixture.ready.log,
        recoveryFixtureKey(fixture, 1),
        [{ seat: 0, secretKey: replacement.secretKey }],
        store,
      ),
    );
    const authEntry = signRecoveryFixtureEntry(
      fixture,
      fixture.ready,
      { kind: 'membership', change: authorization },
      fixture.ready.log.head.stateHash,
    );
    const certifiedAuth = certifyRecoveryFixtureEntry(fixture, fixture.ready, authEntry, [1, 2, 3]);
    authorized = advanceRecoveryFixture(fixture.ready, certifiedAuth);
    const activation = signRecoveryFixtureActivation(fixture, authorized, authEntry);
    const takeover = value(
      fixture.source.engine.apply(authorized.log.state, {
        kind: 'system',
        type: 'SEAT_STATUS',
        seat: 0,
        status: 'bot',
      }),
    );
    const activatedEntry = signRecoveryFixtureEntry(
      fixture,
      authorized,
      { kind: 'membership', change: activation },
      // Certified activation must commit the deterministic bot takeover state.
      toHex(hashValue(takeover.state)),
    );
    const certifiedActivation = certifyRecoveryFixtureEntry(
      fixture,
      authorized,
      activatedEntry,
      [1, 2, 3],
    );
    active = advanceRecoveryFixture(authorized, certifiedActivation);
    journal = new MemoryProtocolJournal();
    if (!(await journal.initialize(fixture.genesisEntry, new Uint8Array([1]))))
      throw new Error('Could not initialize recovery journal');
    for (const certified of [...fixture.deckEntries, certifiedAuth, certifiedActivation]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Commits depend on the preceding certified entry.
      if (!(await journal.commit(certified.entry.seq, 0, certified, new Uint8Array([1]))))
        throw new Error('Could not commit recovery entry');
    }
    value(
      await persistRecoveryPrivate(
        active.log,
        recoveryFixtureRef(authEntry),
        1,
        [{ seat: 0, master: scalarToBytes(17n) }],
        store,
      ),
    );
    replacement.secretKey.fill(0);
  }, 30_000);

  function input(localJournal: ProtocolJournal = journal, localStore = store) {
    return {
      journal: localJournal,
      engine: fixture.source.engine,
      policy: fixture.policy,
      hostSeat: 1 as const,
      privateStore: localStore,
      readinessStore: localStore,
      seats: [0] as const,
    };
  }

  test('restores an active hosted bot at the exact certified parent and wipes owned keys', async () => {
    const restored = value(await loadRecoveredHost(input()));
    try {
      expect(entryHash(restored.context.log.head)).toBe(entryHash(active.log.head));
      expect([...restored.keys.keys()]).toEqual([0]);
      const signingKey = required(restored.keys.get(0));
      const identity = identityFromSecret(signingKey);
      try {
        expect(identity.peerId).toBe(
          required(active.log.authority?.controllers.find((item) => item.seat === 0)).publicKey,
        );
      } finally {
        identity.secretKey.fill(0);
      }
      expect(signingKey).toEqual(replacementKey);
      expect(restored.driver.privateState(0)).not.toBeNull();
      expect(toBase64Url(required(restored.beaconSources.get(0)).link(0, 1))).toBe(
        toBase64Url(required(required(fixture.chains[0])[1])),
      );
      const deckId = required(active.log.crypto?.decks.decks[0]).commitment.definition.deckId;
      const source = restored.createDeckSource(deckId, 0);
      expect(source.lock(0)).toBeTypeOf('bigint');
      source.dispose();
      restored.releaseSeat(0);
      expect(signingKey).toEqual(new Uint8Array(32));
      expect(restored.keys.size).toBe(0);
      expect(restored.beaconSources.size).toBe(0);
      expect(restored.driver.privateState(0)).toBeNull();
      expect(() => restored.createDeckSource(deckId, 0)).toThrow(
        'Recovered deck source is unavailable',
      );
    } finally {
      restored.dispose();
    }
  }, 20_000);

  test('pending seats and another host cannot restore recovered ownership', async () => {
    const pendingJournal: ProtocolJournal = {
      load: async () => {
        const record = required(await journal.load());
        return { ...record, entries: record.entries.slice(0, -1), height: record.height - 1 };
      },
      initialize: (genesis, safety) => journal.initialize(genesis, safety),
      loadSafety: (height) => journal.loadSafety(height),
      saveSafety: (height, revision, bytes) => journal.saveSafety(height, revision, bytes),
      commit: (height, revision, certified, bytes) =>
        journal.commit(height, revision, certified, bytes),
    };
    expect(await loadRecoveredHost(input(pendingJournal))).toMatchObject({
      ok: false,
      error: { code: 'recovered-host-seats' },
    });
    expect(await loadRecoveredHost({ ...input(), hostSeat: 2 })).toMatchObject({
      ok: false,
      error: { code: 'recovered-host-seats' },
    });
  }, 20_000);

  test('missing private record and advanced journal head release no keys', async () => {
    const missing = {
      load: (id: string) =>
        id.startsWith('recovery-private/') ? Promise.resolve(null) : store.load(id),
      putIfAbsent: (id: string, bytes: Uint8Array) => store.putIfAbsent(id, bytes),
    };
    expect(await loadRecoveredHost({ ...input(), privateStore: missing })).toMatchObject({
      ok: false,
      error: { code: 'recovery-private-storage' },
    });
    let reads = 0;
    const advanced: ProtocolJournal = {
      load: async () => {
        const record = required(await journal.load());
        reads++;
        return reads === 2 ? { ...record, height: record.height + 1 } : record;
      },
      initialize: (genesis, safety) => journal.initialize(genesis, safety),
      loadSafety: (height) => journal.loadSafety(height),
      saveSafety: (height, revision, bytes) => journal.saveSafety(height, revision, bytes),
      commit: (height, revision, certified, bytes) =>
        journal.commit(height, revision, certified, bytes),
    };
    expect(await loadRecoveredHost(input(advanced))).toMatchObject({
      ok: false,
      error: { code: 'recovered-host-stale' },
    });
    expect(reads).toBe(2);
  }, 20_000);

  test('copies requested seats before journal I/O', async () => {
    const seats = [0 as const] as (0 | 1)[];
    const changingJournal: ProtocolJournal = {
      load: async () => {
        seats[0] = 1;
        return journal.load();
      },
      initialize: (genesis, safety) => journal.initialize(genesis, safety),
      loadSafety: (height) => journal.loadSafety(height),
      saveSafety: (height, revision, bytes) => journal.saveSafety(height, revision, bytes),
      commit: (height, revision, certified, bytes) =>
        journal.commit(height, revision, certified, bytes),
    };
    const restored = value(await loadRecoveredHost({ ...input(changingJournal), seats }));
    try {
      expect([...restored.keys.keys()]).toEqual([0]);
      expect(seats).toEqual([1]);
    } finally {
      restored.dispose();
    }
  }, 20_000);
});
