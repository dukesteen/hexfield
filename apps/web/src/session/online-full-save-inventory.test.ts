import { canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { identityFromSecret, scalarToBytes } from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import {
  createConsensusState,
  entryHash,
  genesisDigest,
  prepareRecoveryReadiness,
  validateGenesisOnlineStart,
} from '@cp2p/protocol';
import {
  advanceRecoveryFixture,
  certifyRecoveryFixtureEntry,
  createRecoveryFixture,
  persistRecoveryPrivate,
  recoveryFixtureKey,
  recoveryFixtureReadiness,
  signRecoveryFixtureActivation,
  signRecoveryFixtureEntry,
} from '@cp2p/protocol/testing';
import { IndexedDbByteStore, IndexedDbProtocolJournal } from '@cp2p/storage';
import 'fake-indexeddb/auto';
import { expect, test } from 'vitest';
import { saveOnlineGameRecord } from './online-game-records.js';
import { loadStoredOnlineMasterInventory } from './online-full-save-inventory.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

test('private export inventory loads only a certified active recovered bot master', async () => {
  const fixture = createRecoveryFixture({
    seed: 174,
    lobbyId: 'fullsavekc',
    masterBackedBeacon: true,
    chainLength: 1,
  });
  const online = value(validateGenesisOnlineStart(fixture.genesis));
  const agreement = online.bindings.agreement;
  const host = fixture.source.identities.get(1);
  if (!host) throw new Error('Missing original host');
  const device = identityFromSecret(
    hashValue({ domain: 'cp2p/test/online-device/v1', gamePeer: host.peerId }),
  );
  const replacement = identityFromSecret(new Uint8Array(32).fill(121));
  const store = new IndexedDbByteStore({ lockProvider: async (_name, task) => task() });
  const digest = genesisDigest(fixture.genesis);
  const start = {
    invite: { roomId: agreement.state.lobbyId, hostPeer: agreement.state.hostPeer, serverUrl: '' },
    agreement,
    result: {
      entry: fixture.genesisEntry,
      genesis: fixture.genesis,
      transcripts: fixture.deck.transcripts,
      bindings: online.bindings.bindings,
    },
  };
  const keyBinding = {
    recordKey: `online-game/${digest}/keys`,
    bytes: canonicalEncode({
      protocol: 'online-game-keys-v1',
      genesisDigest: digest,
      devicePeer: device.peerId,
      humanSeat: 1,
      seats: [
        {
          seat: 1,
          kind: 'human',
          peerId: host.peerId,
          signingKey: host.secretKey,
          master: scalarToBytes(18n),
        },
      ],
    }),
  };
  const journal = new IndexedDbProtocolJournal(fixture.genesis.gameId, { keyBinding });
  try {
    await saveOnlineGameRecord(store, start);
    expect(
      await store.putIfAbsent(
        'online-credentials/device-identity/v1',
        canonicalEncode({
          protocol: 'cp2p/online-device-identity/v1',
          peerId: device.peerId,
          secretKey: device.secretKey,
        }),
      ),
    ).toBe(true);
    expect(
      await journal.initialize(
        fixture.genesisEntry,
        canonicalEncode(value(createConsensusState(fixture.beforeSetup, 1))),
      ),
    ).toBe(true);
    const readySafety = canonicalEncode(value(createConsensusState(fixture.ready, 1)));
    for (const certified of fixture.deckEntries) {
      // oxlint-disable-next-line no-await-in-loop -- The journal commits one certified height at a time.
      expect(await journal.commit(certified.entry.seq, 0, certified, readySafety)).toBe(true);
    }
    const readiness = recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId);
    const authorization = value(
      await prepareRecoveryReadiness(
        readiness,
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
    const authorized = advanceRecoveryFixture(fixture.ready, certifiedAuth);
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
      toHex(hashValue(takeover.state)),
    );
    const certifiedActivation = certifyRecoveryFixtureEntry(
      fixture,
      authorized,
      activatedEntry,
      [1, 2, 3],
    );
    const active = advanceRecoveryFixture(authorized, certifiedActivation);
    const activeSafety = canonicalEncode(value(createConsensusState(active, 1)));
    for (const certified of [certifiedAuth, certifiedActivation]) {
      // oxlint-disable-next-line no-await-in-loop -- The recovery authorization precedes activation.
      expect(await journal.commit(certified.entry.seq, 0, certified, activeSafety)).toBe(true);
    }
    value(
      await persistRecoveryPrivate(
        active.log,
        { seq: authEntry.seq, hash: entryHash(authEntry) },
        1,
        [{ seat: 0, master: scalarToBytes(17n) }],
        store,
      ),
    );
    const savedStart = { gameId: fixture.genesis.gameId, genesisDigest: digest, ...start };
    const loaded = await loadStoredOnlineMasterInventory({ start: savedStart, journal, store });
    try {
      expect(await loaded.loadOwnedMaster(0)).toEqual(scalarToBytes(17n));
      expect(await loaded.loadOwnedMaster(1)).toEqual(scalarToBytes(18n));
      expect(await loaded.loadOwnedMaster(2)).toBeNull();
    } finally {
      loaded.dispose();
    }
    const missingRecovery = {
      load: (key: string) =>
        key.startsWith('recovery-private/') ? Promise.resolve(null) : store.load(key),
      putIfAbsent: (key: string, bytes: Uint8Array) => store.putIfAbsent(key, bytes),
      compareAndSwap: (key: string, old: Uint8Array, next: Uint8Array) =>
        store.compareAndSwap(key, old, next),
      withCeremonyLock: <T>(key: string, task: () => Promise<T>) =>
        store.withCeremonyLock(key, task),
    };
    await expect(
      loadStoredOnlineMasterInventory({ start: savedStart, journal, store: missingRecovery }),
    ).rejects.toThrow('Recovered private record is missing or oversized');
  } finally {
    await journal.close();
    await store.close();
    keyBinding.bytes.fill(0);
    device.secretKey.fill(0);
    replacement.secretKey.fill(0);
  }
}, 40_000);
