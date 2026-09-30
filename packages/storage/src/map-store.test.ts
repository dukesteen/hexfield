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
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DATABASE_NAME, DATABASE_VERSION, MAP_STORE } from './database.js';
import { IndexedDbMapStore } from './map-store.js';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBCursor', IDBCursor);
  vi.stubGlobal('IDBDatabase', IDBDatabase);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('IDBIndex', IDBIndex);
  vi.stubGlobal('IDBObjectStore', IDBObjectStore);
  vi.stubGlobal('IDBRequest', IDBRequest);
  vi.stubGlobal('IDBTransaction', IDBTransaction);
});
afterEach(() => vi.unstubAllGlobals());

const record = (id: string, updatedAt: number) => ({
  v: 1 as const,
  id,
  name: `Map ${id}`,
  updatedAt,
  json: '{"v":1}',
});

test('version 6 adds the maps store to a version 5 database and keeps its data', async () => {
  // A database as the previous release left it: five stores and a saved byte record.
  const old = await openDB(DATABASE_NAME, 5, {
    upgrade(database) {
      for (const name of ['bytes', 'games', 'entries', 'consensus', 'deletedGames', 'snapshots'])
        database.createObjectStore(name);
      database.createObjectStore('vault');
    },
  });
  await old.put('bytes', Uint8Array.of(7, 8), 'settings');
  old.close();

  const store = new IndexedDbMapStore();
  await store.put(record('a', 1));

  expect(DATABASE_VERSION).toBe(6);
  const database = await openDB(DATABASE_NAME, DATABASE_VERSION);
  expect([...database.objectStoreNames]).toContain(MAP_STORE);
  expect(await database.get('bytes', 'settings')).toEqual(Uint8Array.of(7, 8));
  database.close();
});

test('saves, lists newest first, replaces, deletes and skips damaged records', async () => {
  const store = new IndexedDbMapStore();
  await store.put(record('a', 1));
  await store.put(record('b', 5));
  await store.put({ ...record('a', 9), name: 'Renamed' });
  expect((await store.list()).map((item) => [item.id, item.name])).toEqual([
    ['a', 'Renamed'],
    ['b', 'Map b'],
  ]);
  expect((await store.get('b'))?.updatedAt).toBe(5);

  const database = await openDB(DATABASE_NAME, DATABASE_VERSION);
  await database.put(MAP_STORE, Uint8Array.of(1, 2, 3), 'junk');
  database.close();
  expect((await store.list()).map((item) => item.id)).toEqual(['a', 'b']);
  expect(await store.get('junk')).toBeNull();

  await store.delete('a');
  expect((await store.list()).map((item) => item.id)).toEqual(['b']);
  await expect(store.put({ ...record('bad id!', 1) })).rejects.toThrow(/Invalid/);
});
