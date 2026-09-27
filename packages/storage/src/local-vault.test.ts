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
import {
  acquireVaultOwner,
  migrateLocalVault,
  readLocalVaultStatus,
  VaultRecordAccess,
} from './local-vault.js';

const identityKey = 'online-credentials/device-identity/v1';

class TestLocks implements Pick<LockManager, 'request'> {
  readonly #states = new Map<
    string,
    {
      shared: number;
      exclusive: boolean;
      queue: { mode: LockMode; grant: () => void }[];
    }
  >();

  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    maybeCallback?: LockGrantedCallback<T>,
  ): Promise<T> {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (!callback) throw new Error('Missing lock callback');
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const mode = options.mode ?? 'exclusive';
    let state = this.#states.get(name);
    if (!state) {
      state = { shared: 0, exclusive: false, queue: [] };
      this.#states.set(name, state);
    }
    const current = state;
    if (
      options.ifAvailable &&
      (current.queue.length > 0 ||
        current.exclusive ||
        (mode === 'exclusive' && current.shared > 0))
    )
      return Promise.resolve(callback(null));
    return new Promise<T>((resolve, reject) => {
      current.queue.push({
        mode,
        grant: () => {
          if (mode === 'shared') current.shared += 1;
          else current.exclusive = true;
          void (async () => {
            try {
              resolve(await callback({ name, mode }));
            } catch (error) {
              reject(error);
            } finally {
              if (mode === 'shared') current.shared -= 1;
              else current.exclusive = false;
              this.#pump(current);
            }
          })();
        },
      });
      this.#pump(current);
    });
  }

  #pump(state: {
    shared: number;
    exclusive: boolean;
    queue: { mode: LockMode; grant: () => void }[];
  }): void {
    if (state.exclusive) return;
    if (state.queue[0]?.mode === 'exclusive') {
      if (state.shared === 0) state.queue.shift()?.grant();
      return;
    }
    while (state.queue[0]?.mode === 'shared') state.queue.shift()?.grant();
  }
}

class WaitingLocks implements Pick<LockManager, 'request'> {
  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(
    _name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    _callback?: LockGrantedCallback<T>,
  ): Promise<T> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    return new Promise<T>((_resolve, reject) => {
      options.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Vault lock request aborted', 'AbortError')),
        { once: true },
      );
    });
  }
}

function installFactory(): void {
  vi.stubGlobal('indexedDB', new IDBFactory());
  for (const [name, value] of Object.entries({
    IDBCursor,
    IDBDatabase,
    IDBIndex,
    IDBKeyRange,
    IDBObjectStore,
    IDBRequest,
    IDBTransaction,
  }))
    vi.stubGlobal(name, value);
}

test('a waiting exclusive migration can be cancelled without touching stored records', async () => {
  installFactory();
  const abort = new AbortController();
  const migration = migrateLocalVault({
    newPassphrase: 'cancelled migration passphrase',
    lockManager: new WaitingLocks(),
    signal: abort.signal,
  });
  abort.abort();
  await expect(migration).rejects.toMatchObject({ name: 'AbortError' });
  expect(await readLocalVaultStatus()).toEqual({ mode: 'clear', generation: 0 });
});

afterEach(() => vi.unstubAllGlobals());

async function seed(): Promise<IndexedDbByteStore> {
  const store = new IndexedDbByteStore();
  expect(await store.putIfAbsent(identityKey, Uint8Array.of(1, 2, 3))).toBe(true);
  expect(await store.putIfAbsent('escrow-accepted/ceremony/0/1', Uint8Array.of(4, 5, 6))).toBe(
    true,
  );
  expect(await store.putIfAbsent('escrow-lifecycle/device-index-v1', Uint8Array.of(7))).toBe(true);
  return store;
}

test('enables the local vault without plaintext fallback, authenticates records, and rotates atomically', async () => {
  installFactory();
  const locks = new TestLocks();
  const old = await seed();
  await old.close();
  expect(await readLocalVaultStatus()).toEqual({ mode: 'clear', generation: 0 });
  await migrateLocalVault({ newPassphrase: 'first passphrase', lockManager: locks });
  expect(await readLocalVaultStatus()).toEqual({ mode: 'locked', generation: 1 });
  const database = await openDB('cp2p');
  const raw = await database.get('bytes', identityKey);
  expect(raw).toBeInstanceOf(Uint8Array);
  expect(raw).not.toEqual(Uint8Array.of(1, 2, 3));
  expect(await database.get('bytes', 'escrow-lifecycle/device-index-v1')).toEqual(Uint8Array.of(7));
  database.close();

  await expect(new IndexedDbByteStore().load(identityKey)).rejects.toMatchObject({
    code: 'locked',
  });
  await expect(
    acquireVaultOwner({ passphrase: 'wrong vault passphrase', lockManager: locks }),
  ).rejects.toThrow(/invalid/);
  const owner = await acquireVaultOwner({ passphrase: 'first passphrase', lockManager: locks });
  const store = new IndexedDbByteStore({ vault: owner });
  expect(await store.load(identityKey)).toEqual(Uint8Array.of(1, 2, 3));
  const captured = await store.loadPinned(identityKey);
  expect(captured?.stored).toEqual(raw);
  captured?.plain.fill(0);
  captured?.stored.fill(0);
  expect(
    await store.compareAndSwap(
      'escrow-accepted/ceremony/0/1',
      Uint8Array.of(4, 5, 6),
      Uint8Array.of(9),
    ),
  ).toBe(true);
  const handoff = owner.handoff();
  expect(handoff?.key.extractable).toBe(false);
  if (!handoff) throw new Error('Locked owner did not provide a worker key handoff');
  const worker = await acquireVaultOwner({ handoff, lockManager: locks });
  const workerStore = new IndexedDbByteStore({ vault: worker });
  expect(await workerStore.load('escrow-accepted/ceremony/0/1')).toEqual(Uint8Array.of(9));
  await workerStore.close();
  await worker.close();
  await store.close();
  await owner.close();

  await migrateLocalVault({
    oldPassphrase: 'first passphrase',
    newPassphrase: 'second passphrase',
    lockManager: locks,
  });
  await expect(acquireVaultOwner({ handoff, lockManager: locks })).rejects.toThrow(/handoff/);
  await expect(
    acquireVaultOwner({ passphrase: 'first passphrase', lockManager: locks }),
  ).rejects.toThrow(/invalid/);
  const rotated = await acquireVaultOwner({ passphrase: 'second passphrase', lockManager: locks });
  const rotatedStore = new IndexedDbByteStore({ vault: rotated });
  expect(await rotatedStore.load('escrow-accepted/ceremony/0/1')).toEqual(Uint8Array.of(9));
  await rotatedStore.close();
  await rotated.close();
  await migrateLocalVault({ oldPassphrase: 'second passphrase', lockManager: locks });
  expect(await readLocalVaultStatus()).toEqual({ mode: 'clear', generation: 3 });
  const clear = new IndexedDbByteStore();
  expect(await clear.load('escrow-accepted/ceremony/0/1')).toEqual(Uint8Array.of(9));
  await clear.close();
});

test('rejects enabling without an existing reserved device identity', async () => {
  installFactory();
  const store = new IndexedDbByteStore();
  await store.putIfAbsent('private/unrelated', Uint8Array.of(4));
  await store.close();
  await expect(
    migrateLocalVault({ newPassphrase: 'locked vault passphrase', lockManager: new TestLocks() }),
  ).rejects.toThrow(/identity/);
  const fresh = new IndexedDbByteStore();
  expect(await fresh.load('private/unrelated')).toEqual(Uint8Array.of(4));
  await fresh.close();
});

test('a deleted pinned identity is corruption and cannot be silently recreated', async () => {
  installFactory();
  const locks = new TestLocks();
  const initial = await seed();
  await initial.close();
  await migrateLocalVault({ newPassphrase: 'locked vault passphrase', lockManager: locks });
  const database = await openDB('cp2p');
  await database.delete('bytes', identityKey);
  database.close();
  const owner = await acquireVaultOwner({
    passphrase: 'locked vault passphrase',
    lockManager: locks,
  });
  const store = new IndexedDbByteStore({ vault: owner });
  await expect(store.load(identityKey)).rejects.toThrow(/Reserved device identity is missing/);
  await expect(store.putIfAbsent(identityKey, Uint8Array.of(1, 2, 3))).rejects.toThrow(
    /Reserved device identity is missing/,
  );
  await store.close();
  await owner.close();
});

test('an inserted key after migration scan aborts the whole mode change', async () => {
  installFactory();
  const initial = await seed();
  await initial.close();
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  let inserted = false;
  const spy = vi
    .spyOn(crypto.subtle, 'encrypt')
    .mockImplementation(async (algorithm, key, data) => {
      const result = await encrypt(algorithm, key, data);
      if (!inserted) {
        inserted = true;
        const database = await openDB('cp2p');
        await database.put('bytes', Uint8Array.of(8), 'private/inserted-after-scan');
        database.close();
      }
      return result;
    });
  try {
    await expect(
      migrateLocalVault({ newPassphrase: 'locked vault passphrase', lockManager: new TestLocks() }),
    ).rejects.toThrow(/changed during migration/);
  } finally {
    spy.mockRestore();
  }
  const clear = new IndexedDbByteStore();
  expect(await clear.load(identityKey)).toEqual(Uint8Array.of(1, 2, 3));
  expect(await clear.load('private/inserted-after-scan')).toEqual(Uint8Array.of(8));
  await clear.close();
});

test('ciphertext is bound to the exact record key and a queued migration does not block owner work', async () => {
  installFactory();
  const locks = new TestLocks();
  const initial = await seed();
  await initial.close();
  await migrateLocalVault({ newPassphrase: 'locked vault passphrase', lockManager: locks });
  const owner = await acquireVaultOwner({
    passphrase: 'locked vault passphrase',
    lockManager: locks,
  });
  const store = new IndexedDbByteStore({ vault: owner });
  const migrating = migrateLocalVault({
    oldPassphrase: 'locked vault passphrase',
    newPassphrase: 'new vault passphrase',
    lockManager: locks,
  });
  // The owner already holds its shared lock. Its byte-store operation must not reacquire it.
  expect(await store.load(identityKey)).toEqual(Uint8Array.of(1, 2, 3));
  const database = await openDB('cp2p');
  const stolen = await database.get('bytes', identityKey);
  if (!stolen) throw new Error('Encrypted identity is missing');
  await database.put('bytes', stolen, 'private/swapped-key');
  database.close();
  await expect(store.load('private/swapped-key')).rejects.toThrow(/authentication/);
  await store.close();
  await owner.close();
  await expect(migrating).rejects.toThrow(/authentication/);
});

test('a queued exclusive migration makes a new worker handoff fail fast without blocking the live owner', async () => {
  installFactory();
  const locks = new TestLocks();
  const initial = await seed();
  await initial.close();
  await migrateLocalVault({ newPassphrase: 'handoff passphrase', lockManager: locks });
  const owner = await acquireVaultOwner({ passphrase: 'handoff passphrase', lockManager: locks });
  const handoff = owner.handoff();
  if (!handoff) throw new Error('Locked owner did not provide a worker key handoff');
  const migrating = migrateLocalVault({
    oldPassphrase: 'handoff passphrase',
    newPassphrase: 'rotated passphrase',
    lockManager: locks,
  });
  await expect(acquireVaultOwner({ handoff, lockManager: locks })).rejects.toMatchObject({
    code: 'busy',
  });
  const store = new IndexedDbByteStore({ vault: owner });
  expect(await store.load(identityKey)).toEqual(Uint8Array.of(1, 2, 3));
  await store.close();
  await owner.close();
  await migrating;
});

test('closing during worker unlock cannot repopulate the key or restart access', async () => {
  installFactory();
  const initial = await seed();
  await initial.close();
  await migrateLocalVault({
    newPassphrase: 'close race passphrase',
    lockManager: new TestLocks(),
  });
  const original = crypto.subtle.deriveKey.bind(crypto.subtle);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(crypto.subtle, 'deriveKey')
    .mockImplementation(async (algorithm, baseKey, derivedKeyType, extractable, usages) => {
      entered();
      await held;
      return original(algorithm, baseKey, derivedKeyType, extractable, usages);
    });
  const access = new VaultRecordAccess();
  try {
    const pending = access.pin({ passphrase: 'close race passphrase' });
    await started;
    access.close();
    release();
    await expect(pending).rejects.toThrow(/closed during unlock/);
    expect(() => access.handoff()).toThrow(/closed/);
    await expect(access.pin({ passphrase: 'close race passphrase' })).rejects.toThrow(/closed/);
  } finally {
    spy.mockRestore();
  }
});

test('closing during record decryption wipes the result and fails closed', async () => {
  installFactory();
  const initial = await seed();
  await initial.close();
  const locks = new TestLocks();
  await migrateLocalVault({ newPassphrase: 'decrypt race passphrase', lockManager: locks });
  const owner = await acquireVaultOwner({
    passphrase: 'decrypt race passphrase',
    lockManager: locks,
  });
  const store = new IndexedDbByteStore({ vault: owner });
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(crypto.subtle, 'decrypt')
    .mockImplementation(async (algorithm, key, data) => {
      entered();
      await held;
      return decrypt(algorithm, key, data);
    });
  try {
    const pending = store.load('escrow-accepted/ceremony/0/1');
    await started;
    await owner.close();
    release();
    await expect(pending).rejects.toMatchObject({ code: 'closed' });
  } finally {
    release();
    spy.mockRestore();
    await store.close();
  }
});

test('corrupt metadata fails with a distinct vault error before private access', async () => {
  installFactory();
  const initial = await seed();
  await initial.close();
  const database = await openDB('cp2p');
  await database.put('vault', Uint8Array.of(0xff), 'state');
  database.close();
  await expect(new IndexedDbByteStore().load(identityKey)).rejects.toMatchObject({
    code: 'corrupt',
  });
});
