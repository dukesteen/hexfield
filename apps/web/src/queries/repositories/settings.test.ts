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
import { afterEach, describe, expect, test, vi } from 'vitest';
import { canonicalEncode } from '@cp2p/codec';
import { IndexedDbByteStore } from '@cp2p/storage';
import { DEFAULT_NETWORK_SETTINGS } from '../network-config';
import { IndexedDbSettingsRepository } from './settings';
import { MemoryStorage } from './storage';

afterEach(() => vi.unstubAllGlobals());

function installFactory(): void {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBCursor', IDBCursor);
  vi.stubGlobal('IDBDatabase', IDBDatabase);
  vi.stubGlobal('IDBIndex', IDBIndex);
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('IDBObjectStore', IDBObjectStore);
  vi.stubGlobal('IDBRequest', IDBRequest);
  vi.stubGlobal('IDBTransaction', IDBTransaction);
}

function serializedLocks() {
  const tails = new Map<string, Promise<void>>();
  return async <T>(name: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    tails.set(name, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (tails.get(name) === tail) tails.delete(name);
    }
  };
}

function legacyStorage() {
  const storage = new MemoryStorage();
  storage.setItem(
    'hexfield:settings:v1',
    JSON.stringify({
      v: 1,
      language: 'en',
      theme: 'dark',
      hotseatCover: false,
      reducedMotion: 'reduce',
    }),
  );
  return storage;
}

describe('IndexedDbSettingsRepository', () => {
  test('migrates validated v1 settings, confirms durable v2, and reopens from IndexedDB', async () => {
    installFactory();
    const storage = legacyStorage();
    const locks = serializedLocks();
    const repository = new IndexedDbSettingsRepository({
      store: new IndexedDbByteStore({ lockProvider: locks }),
      legacyStorage: () => storage,
    });

    expect(await repository.get()).toEqual({
      v: 2,
      language: 'en',
      theme: 'dark',
      hotseatCover: false,
      reducedMotion: 'reduce',
      network: DEFAULT_NETWORK_SETTINGS,
    });
    expect(storage.getItem('hexfield:settings:v1')).toBeNull();

    const reopened = new IndexedDbSettingsRepository({
      store: new IndexedDbByteStore({ lockProvider: locks }),
      legacyStorage: () => new MemoryStorage(),
    });
    expect(await reopened.get()).toMatchObject({ theme: 'dark', hotseatCover: false });
  });

  test('preserves malformed legacy data and surfaces it instead of replacing it with defaults', async () => {
    installFactory();
    const storage = new MemoryStorage();
    storage.setItem('hexfield:settings:v1', '{"v":1,"theme":"invalid"}');
    const repository = new IndexedDbSettingsRepository({
      store: new IndexedDbByteStore({ lockProvider: serializedLocks() }),
      legacyStorage: () => storage,
    });

    await expect(repository.get()).rejects.toThrow(/Invalid/);
    expect(storage.getItem('hexfield:settings:v1')).toBe('{"v":1,"theme":"invalid"}');
  });

  test('rejects a malformed durable record without falling back to legacy settings', async () => {
    installFactory();
    const storage = legacyStorage();
    const store = new IndexedDbByteStore({ lockProvider: serializedLocks() });
    await store.putIfAbsent('web/settings/v2', canonicalEncode({ v: 2, theme: 'invalid' }));
    const repository = new IndexedDbSettingsRepository({ store, legacyStorage: () => storage });

    await expect(repository.get()).rejects.toThrow(/Invalid/);
    expect(storage.getItem('hexfield:settings:v1')).not.toBeNull();
  });

  test('serializes concurrent patches across independent repository and database connections', async () => {
    installFactory();
    const locks = serializedLocks();
    const first = new IndexedDbSettingsRepository({
      store: new IndexedDbByteStore({ lockProvider: locks }),
      legacyStorage: () => new MemoryStorage(),
    });
    const second = new IndexedDbSettingsRepository({
      store: new IndexedDbByteStore({ lockProvider: locks }),
      legacyStorage: () => new MemoryStorage(),
    });

    await Promise.all([first.update({ theme: 'dark' }), second.update({ hotseatCover: false })]);
    expect(await first.get()).toMatchObject({ theme: 'dark', hotseatCover: false });
  });

  test('keeps legacy bytes when IndexedDB cannot durably commit migration', async () => {
    installFactory();
    const storage = legacyStorage();
    const store = new IndexedDbByteStore({ lockProvider: serializedLocks() });
    vi.spyOn(store, 'putIfAbsent').mockRejectedValue(new Error('disk write failed'));
    const repository = new IndexedDbSettingsRepository({ store, legacyStorage: () => storage });

    await expect(repository.get()).rejects.toThrow('disk write failed');
    expect(storage.getItem('hexfield:settings:v1')).not.toBeNull();
  });

  test('returns confirmed settings when obsolete localStorage cleanup fails', async () => {
    installFactory();
    const storage = legacyStorage();
    vi.spyOn(storage, 'removeItem').mockImplementation(() => {
      throw new Error('localStorage is unavailable');
    });
    const repository = new IndexedDbSettingsRepository({
      store: new IndexedDbByteStore({ lockProvider: serializedLocks() }),
      legacyStorage: () => storage,
    });

    await expect(repository.get()).resolves.toMatchObject({ theme: 'dark' });
    expect(storage.getItem('hexfield:settings:v1')).not.toBeNull();
  });

  test('claims the persistence request once across independent repository connections', async () => {
    installFactory();
    const locks = serializedLocks();
    const first = new IndexedDbSettingsRepository({
      store: new IndexedDbByteStore({ lockProvider: locks }),
      legacyStorage: () => new MemoryStorage(),
    });
    const second = new IndexedDbSettingsRepository({
      store: new IndexedDbByteStore({ lockProvider: locks }),
      legacyStorage: () => new MemoryStorage(),
    });

    expect(
      await Promise.all([
        first.claimStoragePersistenceRequest(),
        second.claimStoragePersistenceRequest(),
      ]),
    ).toEqual([true, false]);
    expect(await first.claimStoragePersistenceRequest()).toBe(false);
  });

  test('fails closed on a corrupt persistence request marker', async () => {
    installFactory();
    const store = new IndexedDbByteStore({ lockProvider: serializedLocks() });
    await store.putIfAbsent(
      'web/settings/storage-persistence-requested/v1',
      canonicalEncode(false),
    );
    const repository = new IndexedDbSettingsRepository({
      store,
      legacyStorage: () => new MemoryStorage(),
    });

    await expect(repository.claimStoragePersistenceRequest()).rejects.toThrow(/marker is invalid/);
  });
});
