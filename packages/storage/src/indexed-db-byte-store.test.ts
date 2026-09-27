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
import { afterEach, describe, expect, test, vi } from 'vitest';
import { IndexedDbByteStore } from './indexed-db-byte-store.js';

interface SeedDatabase {
  bytes: { key: string; value: unknown };
}

interface FutureDatabase extends SeedDatabase {
  future: { key: string; value: string };
}

interface Version2Database extends SeedDatabase {
  games: { key: string; value: Uint8Array };
  entries: { key: [string, number]; value: Uint8Array };
  consensus: { key: string; value: Uint8Array };
}

afterEach(() => vi.unstubAllGlobals());

function installFactory(): IDBFactory {
  const factory = new IDBFactory();
  vi.stubGlobal('indexedDB', factory);
  vi.stubGlobal('IDBCursor', IDBCursor);
  vi.stubGlobal('IDBDatabase', IDBDatabase);
  vi.stubGlobal('IDBIndex', IDBIndex);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('IDBObjectStore', IDBObjectStore);
  vi.stubGlobal('IDBRequest', IDBRequest);
  vi.stubGlobal('IDBTransaction', IDBTransaction);
  return factory;
}

function serializedLockProvider() {
  let tail = Promise.resolve();
  return async <T>(_name: string, task: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const preceding = tail;
    tail = current;
    await preceding;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

describe('IndexedDbByteStore', () => {
  test('coordinates atomic first writes and compare-and-swap across connections', async () => {
    installFactory();
    const first = new IndexedDbByteStore();
    const second = new IndexedDbByteStore();
    const left = new Uint8Array([1, 2, 3]);
    const right = new Uint8Array([4, 5, 6]);

    const insertions = await Promise.all([
      first.putIfAbsent('escrow/ceremony/dealer/0', left),
      second.putIfAbsent('escrow/ceremony/dealer/0', right),
    ]);
    expect(insertions.filter(Boolean)).toHaveLength(1);
    const stored = await first.load('escrow/ceremony/dealer/0');
    expect([left, right]).toContainEqual(stored);

    const nextA = new Uint8Array([7]);
    const nextB = new Uint8Array([8]);
    const updates = await Promise.all([
      first.compareAndSwap('escrow/ceremony/dealer/0', stored ?? new Uint8Array(), nextA),
      second.compareAndSwap('escrow/ceremony/dealer/0', stored ?? new Uint8Array(), nextB),
    ]);
    expect(updates.filter(Boolean)).toHaveLength(1);
    expect([nextA, nextB]).toContainEqual(await first.load('escrow/ceremony/dealer/0'));
    await Promise.all([first.close(), second.close()]);
  });

  test('reopens durable values and isolates caller and returned byte arrays', async () => {
    installFactory();
    const original = new Uint8Array([10, 20, 30]);
    const first = new IndexedDbByteStore();
    expect(await first.putIfAbsent('private/game/seat/1', original)).toBe(true);
    original.fill(0);
    await first.close();

    const reopened = new IndexedDbByteStore();
    const loaded = await reopened.load('private/game/seat/1');
    expect(loaded).toEqual(new Uint8Array([10, 20, 30]));
    loaded?.fill(255);
    expect(await reopened.load('private/game/seat/1')).toEqual(new Uint8Array([10, 20, 30]));
    await reopened.close();
  });

  test('closes its connection when a later database version requests an upgrade', async () => {
    installFactory();
    const store = new IndexedDbByteStore();
    await store.putIfAbsent('settings/value', new Uint8Array([3]));

    const upgraded = await openDB<FutureDatabase>('cp2p', 3, {
      upgrade(database) {
        database.createObjectStore('future');
      },
    });
    expect(await upgraded.get('bytes', 'settings/value')).toEqual(new Uint8Array([3]));
    await expect(store.load('settings/value')).rejects.toMatchObject({ name: 'VersionError' });
    expect(await upgraded.get('bytes', 'settings/value')).toEqual(new Uint8Array([3]));
    upgraded.close();
    await store.close();
  });

  test('upgrades v1 databases while preserving byte records', async () => {
    installFactory();
    const legacy = await openDB<SeedDatabase>('cp2p', 1, {
      upgrade(database) {
        database.createObjectStore('bytes');
      },
    });
    await legacy.put('bytes', new Uint8Array([5, 6, 7]), 'settings/value');
    legacy.close();

    const store = new IndexedDbByteStore();
    expect(await store.load('settings/value')).toEqual(new Uint8Array([5, 6, 7]));
    await store.close();

    const upgraded = await openDB<Version2Database>('cp2p', 2);
    expect([...upgraded.objectStoreNames].toSorted()).toEqual([
      'bytes',
      'consensus',
      'entries',
      'games',
    ]);
    expect(await upgraded.get('bytes', 'settings/value')).toEqual(new Uint8Array([5, 6, 7]));
    upgraded.close();
  });

  test('rejects aborted writes and preserves the last committed bytes after reopen', async () => {
    installFactory();
    const store = new IndexedDbByteStore();
    // oxlint-disable-next-line typescript/unbound-method -- Keep the native IDB store receiver when intercepting it.
    const originalAdd = IDBObjectStore.prototype.add;
    const add = vi.spyOn(IDBObjectStore.prototype, 'add');
    add.mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = originalAdd.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort(), { once: true });
      return request;
    });
    try {
      await expect(
        store.putIfAbsent('escrow/uncommitted', new Uint8Array([9])),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      add.mockRestore();
    }
    await store.close();
    const afterFailedInsert = new IndexedDbByteStore();
    expect(await afterFailedInsert.load('escrow/uncommitted')).toBeNull();
    await afterFailedInsert.close();

    const before = new Uint8Array([1, 2, 3]);
    const seeded = new IndexedDbByteStore();
    expect(await seeded.putIfAbsent('private/seat/1', before)).toBe(true);
    // oxlint-disable-next-line typescript/unbound-method -- Keep the native IDB store receiver when intercepting it.
    const originalPut = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    put.mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = originalPut.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort(), { once: true });
      return request;
    });
    try {
      await expect(
        seeded.compareAndSwap('private/seat/1', before, new Uint8Array([4, 5, 6])),
      ).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      put.mockRestore();
    }
    await seeded.close();
    const afterFailedCas = new IndexedDbByteStore();
    expect(await afterFailedCas.load('private/seat/1')).toEqual(before);
    await afterFailedCas.close();
  });

  test('validates keys and record bounds without writing partial data', async () => {
    installFactory();
    const store = new IndexedDbByteStore({ maxRecordBytes: 2 });
    await expect(store.load('../private')).rejects.toThrow('record key is invalid');
    await expect(store.putIfAbsent('private/too-large', new Uint8Array([1, 2, 3]))).rejects.toThrow(
      'bounded Uint8Array',
    );
    expect(await store.load('private/too-large')).toBeNull();
    await store.close();
  });

  test('surfaces open and malformed-record failures without resetting stored data', async () => {
    const factory = installFactory();
    const store = new IndexedDbByteStore();
    const open = vi.spyOn(factory, 'open').mockImplementation(() => {
      throw new Error('simulated IndexedDB failure');
    });
    await expect(store.load('private/seat/1')).rejects.toThrow('simulated IndexedDB failure');
    open.mockRestore();
    expect(await store.load('private/seat/1')).toBeNull();

    const database = await openDB<SeedDatabase>('cp2p', 2);
    const transaction = database.transaction('bytes', 'readwrite');
    await transaction.store.put('not a byte record', 'private/corrupt');
    await transaction.done;
    await expect(store.load('private/corrupt')).rejects.toThrow('malformed or oversized');
    expect(await database.get('bytes', 'private/corrupt')).toBe('not a byte record');
    database.close();
    await store.close();
  });

  test('serializes the ceremony critical section across store instances', async () => {
    const lockProvider = serializedLockProvider();
    const first = new IndexedDbByteStore({ lockProvider });
    const second = new IndexedDbByteStore({ lockProvider });
    let active = 0;
    let maxActive = 0;
    const enter = (store: IndexedDbByteStore) =>
      store.withCeremonyLock('some-valid-canonical-id', async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
      });

    await Promise.all([enter(first), enter(second)]);
    expect(maxActive).toBe(1);
    await Promise.all([first.close(), second.close()]);
  });

  test('fails closed when same-origin Web Locks are unavailable', async () => {
    vi.stubGlobal('navigator', undefined);
    const store = new IndexedDbByteStore();
    await expect(
      store.withCeremonyLock('some-valid-canonical-id', async () => 'sent'),
    ).rejects.toThrow('Web Locks are unavailable');
  });
});
