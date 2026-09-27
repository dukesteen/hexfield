import { canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { createSimulationGenesis } from '@cp2p/protocol/testing';
import { deckCeremonyId, entryHash, genesisDigest, signEntry } from '@cp2p/protocol';
import {
  IDBCursor,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBRequest,
  IDBTransaction,
} from 'fake-indexeddb';
import { openDB } from 'idb';
import { afterEach, expect, test, vi } from 'vitest';
import { IndexedDbByteStore } from './indexed-db-byte-store.js';
import { acquireVaultOwner, migrateLocalVault } from './local-vault.js';
import { IndexedDbProtocolJournal } from './indexed-db-protocol-journal.js';
import { deleteOnlineGameData, readOnlineGameTombstone } from './online-game-deletion.js';

interface TestDatabase {
  bytes: { key: string; value: Uint8Array };
  games: { key: string; value: Uint8Array };
  entries: { key: [string, number]; value: Uint8Array };
  consensus: { key: string; value: Uint8Array };
  deletedGames: { key: string; value: Uint8Array };
  snapshots: { key: [string, number]; value: Uint8Array };
}

class TestLocks implements Pick<LockManager, 'request'> {
  readonly held = new Set<string>();

  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
  async request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    maybeCallback?: LockGrantedCallback<T>,
  ): Promise<T> {
    const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (!callback) throw new Error('Missing lock callback');
    if (this.held.has(name)) {
      if (options?.ifAvailable) return callback(null);
      throw new Error('Test lock is already held');
    }
    this.held.add(name);
    try {
      return await callback({ name, mode: options?.mode ?? 'exclusive' });
    } finally {
      this.held.delete(name);
    }
  }
}

afterEach(() => vi.unstubAllGlobals());

function installFactory(): IDBFactory {
  const factory = new IDBFactory();
  vi.stubGlobal('indexedDB', factory);
  vi.stubGlobal('IDBCursor', IDBCursor);
  vi.stubGlobal('IDBDatabase', IDBDatabase);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('IDBIndex', IDBIndex);
  vi.stubGlobal('IDBObjectStore', IDBObjectStore);
  vi.stubGlobal('IDBRequest', IDBRequest);
  vi.stubGlobal('IDBTransaction', IDBTransaction);
  return factory;
}

function byteStoreWithLocks(locks: TestLocks): IndexedDbByteStore {
  return new IndexedDbByteStore({
    lockProvider: <T>(name: string, task: () => Promise<T>) =>
      locks.request<Promise<T>>(name, { mode: 'exclusive' }, () => task()).then((result) => result),
  });
}

function fixture() {
  const simulation = createSimulationGenesis({ seed: 41 });
  const digest = genesisDigest(simulation.genesis);
  const start = {
    protocol: 'online-browser-game-v1',
    invite: { roomId: 'abcdefghij', hostPeer: 'h'.repeat(43), serverUrl: 'wss://example.test' },
    agreement: { state: { ceremonyNonce: simulation.genesis.ceremonyNonce } },
    result: {
      entry: simulation.entry,
      genesis: simulation.genesis,
      transcripts: [],
      bindings: [],
    },
  };
  const pointer = {
    protocol: 'online-game-pointer-v1',
    gameId: simulation.genesis.gameId,
    digest,
    invite: start.invite,
    genesis: simulation.genesis,
  };
  const freezeHash = toHex(hashValue(start.agreement.state));
  const attemptId = toHex(
    hashValue({
      domain: 'cp2p/v1/online-attempt',
      freezeHash,
      nonce: simulation.genesis.ceremonyNonce,
    }),
  );
  return {
    ...simulation,
    digest,
    start,
    pointer,
    gameId: simulation.genesis.gameId,
    attemptId,
    deckId: deckCeremonyId(simulation.genesis),
  };
}

async function seedGame(store: IndexedDbByteStore) {
  const data = fixture();
  await store.putIfAbsent(`online-game/${data.digest}/start`, canonicalEncode(data.start));
  await store.putIfAbsent(`online-game/${data.gameId}/start-digest`, canonicalEncode(data.pointer));
  await store.putIfAbsent(
    'online-games/catalogue-v1',
    canonicalEncode({
      protocol: 'online-games-catalogue-v1',
      gameIds: [data.gameId, 'B'.repeat(22)],
    }),
  );
  const journal = new IndexedDbProtocolJournal(data.gameId, {
    keyBinding: { recordKey: `online-game/${data.digest}/keys`, bytes: Uint8Array.of(7, 8, 9) },
  });
  await journal.initialize(data.entry, Uint8Array.of(1, 2, 3));
  await journal.close();
  const knownKeys = [
    `online-game/${data.gameId}/outcome`,
    `online-game/${data.digest}/cheat-candidates`,
    `online-transfer-credentials/v1/${data.digest}/device/seat/attempt`,
    `recovery-private/${data.digest}/2-hash/1`,
    `recovery-readiness/${data.digest}/slot`,
    `recovery-release/${data.digest}/authorization/dealer/holder/recipient`,
    `recovery-check/${data.gameId}/authorization/parent/1`,
    `transfer-import/${data.gameId}/authorization/destination/head`,
    `transfer-import-final/${data.gameId}/authorization`,
    `transfer-private/import/${data.digest}/authorization/destination`,
    `transfer-private/outbox/${data.digest}/authorization/seat`,
    `online-credentials/ceremony/${data.genesis.ceremonyNonce}/device`,
    `online-attempt/${data.attemptId}`,
    `online-manifest/${data.attemptId}`,
    `online-draft/${data.attemptId}`,
    `online-ceremony/${data.attemptId}/packet`,
    `genesis-consent/${data.deckId}/seat`,
    'online-credentials/device-identity/v1',
    'escrow-lifecycle/device-index-v1',
    'opaque-operation-outbox/not-indexed',
  ];
  await Promise.all(knownKeys.map((key) => store.putIfAbsent(key, Uint8Array.of(1, 2, 3))));
  return { ...data, knownKeys };
}

test('v3 migration preserves v2 bytes and creates an empty tombstone store', async () => {
  const factory = installFactory();
  const legacy = await openDB<{
    bytes: { key: string; value: Uint8Array };
    games: { key: string; value: Uint8Array };
    entries: { key: [string, number]; value: Uint8Array };
    consensus: { key: string; value: Uint8Array };
  }>('cp2p', 2, {
    upgrade(database) {
      database.createObjectStore('bytes');
      database.createObjectStore('games');
      database.createObjectStore('entries');
      database.createObjectStore('consensus');
    },
  });
  await legacy.put('bytes', Uint8Array.of(11, 12), 'keep/this');
  legacy.close();
  const store = new IndexedDbByteStore();
  expect(await store.load('keep/this')).toEqual(Uint8Array.of(11, 12));
  await store.close();
  const upgraded = await openDB<TestDatabase>('cp2p');
  expect([...upgraded.objectStoreNames].toSorted()).toContain('deletedGames');
  expect(await upgraded.get('bytes', 'keep/this')).toEqual(Uint8Array.of(11, 12));
  expect(await upgraded.get('deletedGames', 'any')).toBeUndefined();
  upgraded.close();
  expect(factory).toBeDefined();
});

test('locked deletion keeps the public tombstone and identity while removing encrypted game keys', async () => {
  installFactory();
  const locks = new TestLocks();
  const clear = byteStoreWithLocks(locks);
  const data = await seedGame(clear);
  await clear.close();
  await migrateLocalVault({ newPassphrase: 'deletion passphrase', lockManager: locks });
  const liveOwner = await acquireVaultOwner({
    passphrase: 'deletion passphrase',
    lockManager: locks,
  });
  expect(
    await deleteOnlineGameData(data.gameId, data.digest, {
      lockManager: locks,
      now: () => 1234,
    }),
  ).toBe('busy');
  await liveOwner.close();
  expect(
    await deleteOnlineGameData(data.gameId, data.digest, {
      lockManager: locks,
      now: () => 1234,
    }),
  ).toBe('deleted');
  expect(await readOnlineGameTombstone(data.gameId)).toMatchObject({ deletedAt: 1234 });
  const owner = await acquireVaultOwner({ passphrase: 'deletion passphrase', lockManager: locks });
  const protectedStore = new IndexedDbByteStore({ vault: owner });
  expect(await protectedStore.load(`online-game/${data.digest}/keys`)).toBeNull();
  expect(await protectedStore.load('online-credentials/device-identity/v1')).toEqual(
    Uint8Array.of(1, 2, 3),
  );
  await protectedStore.close();
  await owner.close();
});

test('deletion atomically removes known game records but retains identity, escrow registry, and tombstone', async () => {
  installFactory();
  const locks = new TestLocks();
  const store = byteStoreWithLocks(locks);
  const data = await seedGame(store);
  const before = await openDB<TestDatabase>('cp2p');
  await before.put('snapshots', Uint8Array.of(9), [data.gameId, 100]);
  before.close();
  const result = await deleteOnlineGameData(data.gameId, data.digest, {
    lockManager: locks,
    now: () => 1234,
  });
  expect(result).toBe('deleted');
  expect(await readOnlineGameTombstone(data.gameId)).toEqual({
    protocol: 'online-game-deletion-v1',
    gameId: data.gameId,
    genesisDigest: data.digest,
    deletedAt: 1234,
  });
  for (const key of data.knownKeys) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each lookup documents one cleanup class.
    expect(await store.load(key)).toEqual(
      key === 'online-credentials/device-identity/v1' ||
        key === 'escrow-lifecycle/device-index-v1' ||
        key === `recovery-release/${data.digest}/authorization/dealer/holder/recipient` ||
        key === `transfer-private/outbox/${data.digest}/authorization/seat` ||
        key === `online-attempt/${data.attemptId}` ||
        key === `online-manifest/${data.attemptId}` ||
        key === `online-draft/${data.attemptId}` ||
        key === `online-ceremony/${data.attemptId}/packet` ||
        key === `genesis-consent/${data.deckId}/seat` ||
        key === 'opaque-operation-outbox/not-indexed'
        ? Uint8Array.of(1, 2, 3)
        : null,
    );
  }
  expect(await store.load('online-games/catalogue-v1')).toEqual(
    canonicalEncode({ protocol: 'online-games-catalogue-v1', gameIds: ['B'.repeat(22)] }),
  );
  expect(await store.load(`online-game-deleted/${data.gameId}`)).toEqual(
    canonicalEncode({
      protocol: 'online-game-deletion-v1',
      gameId: data.gameId,
      genesisDigest: data.digest,
      deletedAt: 1234,
    }),
  );
  const database = await openDB<TestDatabase>('cp2p');
  expect(await database.get('games', data.gameId)).toBeUndefined();
  expect(await database.get('consensus', data.gameId)).toBeUndefined();
  expect(await database.getAllKeys('entries')).toEqual([]);
  expect(await database.getAllKeys('snapshots')).toEqual([]);
  database.close();
  expect(await deleteOnlineGameData(data.gameId, data.digest, { lockManager: locks })).toBe(
    'already-deleted',
  );
  await expect(
    deleteOnlineGameData(data.gameId, 'C'.repeat(43), { lockManager: locks }),
  ).rejects.toThrow('another genesis');
  await store.close();
});

test('active writer excludes deletion and the tombstone blocks stale journal restore and initialization', async () => {
  installFactory();
  const locks = new TestLocks();
  const store = byteStoreWithLocks(locks);
  const data = await seedGame(store);
  const active = await import('./game-writer.js').then(({ acquireActiveGameWriterLease }) =>
    acquireActiveGameWriterLease(data.gameId, { lockManager: locks }),
  );
  expect(active).not.toBeNull();
  expect(await deleteOnlineGameData(data.gameId, data.digest, { lockManager: locks })).toBe('busy');
  await active?.close();
  expect(await deleteOnlineGameData(data.gameId, data.digest, { lockManager: locks })).toBe(
    'deleted',
  );

  const stale = new IndexedDbProtocolJournal(data.gameId, {
    keyBinding: { recordKey: `online-game/${data.digest}/keys`, bytes: Uint8Array.of(7, 8, 9) },
  });
  await expect(stale.load()).rejects.toThrow('deleted locally');
  await expect(stale.initialize(data.entry, Uint8Array.of(1))).rejects.toThrow('deleted locally');
  await expect(stale.loadSafety(1)).rejects.toThrow('deleted locally');
  await expect(stale.saveSafety(1, 0, Uint8Array.of(2))).rejects.toThrow('deleted locally');
  const identity = data.identities.get(0);
  if (!identity) throw new Error('Fixture identity is missing');
  const next = {
    entry: signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(data.entry),
        payload: { kind: 'membership', change: { sequence: 1 } },
        stateHash: 'a'.repeat(64),
        sequencer: identity.peerId,
      },
      identity.secretKey,
    ),
    certificate: [],
  };
  await expect(stale.commit(1, 0, next, Uint8Array.of(3))).rejects.toThrow('deleted locally');
  await stale.close();
  await store.close();
});

test('aborted catalogue cleanup rolls back the tombstone and journal deletion', async () => {
  installFactory();
  const locks = new TestLocks();
  const store = byteStoreWithLocks(locks);
  const data = await seedGame(store);
  await store.compareAndSwap(
    'online-games/catalogue-v1',
    canonicalEncode({
      protocol: 'online-games-catalogue-v1',
      gameIds: [data.gameId, 'B'.repeat(22)],
    }),
    canonicalEncode({ malformed: true }),
  );
  await expect(
    deleteOnlineGameData(data.gameId, data.digest, { lockManager: locks }),
  ).rejects.toThrow(/./);
  expect(await readOnlineGameTombstone(data.gameId)).toBeNull();
  const journal = new IndexedDbProtocolJournal(data.gameId, {
    keyBinding: { recordKey: `online-game/${data.digest}/keys`, bytes: Uint8Array.of(7, 8, 9) },
  });
  expect(await journal.load()).not.toBeNull();
  await journal.close();
  await store.close();
});
