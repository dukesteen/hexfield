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
import { afterEach, expect, test, vi } from 'vitest';
import { IndexedDbByteStore } from '@cp2p/storage';
import { OnlineVaultController } from './online-vault-controller.js';

const identityKey = 'online-credentials/device-identity/v1';

class TestLocks implements Pick<LockManager, 'request'> {
  readonly #held = new Map<string, { shared: number; exclusive: boolean }>();

  active(): number {
    return [...this.#held.values()].reduce(
      (count, held) => count + held.shared + Number(held.exclusive),
      0,
    );
  }

  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
  async request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    maybeCallback?: LockGrantedCallback<T>,
  ): Promise<T> {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (!callback) throw new Error('Missing lock callback');
    const mode = options.mode ?? 'exclusive';
    const held = this.#held.get(name) ?? { shared: 0, exclusive: false };
    if (held.exclusive || (mode === 'exclusive' && held.shared > 0)) {
      if (options.ifAvailable) return callback(null);
      throw new Error('Test lock is busy');
    }
    this.#held.set(name, held);
    if (mode === 'shared') held.shared += 1;
    else held.exclusive = true;
    try {
      return await callback({ name, mode });
    } finally {
      if (mode === 'shared') held.shared -= 1;
      else held.exclusive = false;
    }
  }
}

function installFactory(): void {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('navigator', { locks: new TestLocks() });
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

afterEach(() => vi.unstubAllGlobals());

test('idle deletion releases its own parent lock and blocks new scopes until completion', async () => {
  installFactory();
  const locks = new TestLocks();
  const controller = new OnlineVaultController({ lockManager: locks, channel: null });
  const scope = await controller.acquireScope(async () => undefined);
  await controller.releaseScope(scope);
  expect(locks.active()).toBe(1);
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const deletion = controller.withIdleVaultReleased(() =>
    locks.request('cp2p/local-vault/v1', { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      expect(lock).not.toBeNull();
      entered();
      await pending;
      return 'deleted';
    }),
  );
  await started;
  expect(controller.snapshot().state).toBe('busy');
  await expect(controller.acquireScope(async () => undefined)).rejects.toMatchObject({
    code: 'busy',
  });
  finish();
  await expect(deletion).resolves.toBe('deleted');
  expect(locks.active()).toBe(0);
  expect(controller.snapshot()).toEqual({ mode: 'clear', state: 'ready', generation: 0 });
  await controller.dispose();
});

test('deletion refuses a live scope without closing its signer', async () => {
  installFactory();
  const locks = new TestLocks();
  const controller = new OnlineVaultController({ lockManager: locks, channel: null });
  const closeSigner = vi.fn<() => Promise<void>>(async () => undefined);
  const scope = await controller.acquireScope(closeSigner);
  const task = vi.fn<() => Promise<string>>(async () => 'deleted');
  await expect(controller.withIdleVaultReleased(task)).resolves.toBeNull();
  expect(task).not.toHaveBeenCalled();
  expect(closeSigner).not.toHaveBeenCalled();
  scope.assertActive();
  await controller.releaseScope(scope);
  await controller.dispose();
});

test('deletion invalidates a scope still opening its parent lease', async () => {
  installFactory();
  const locks = new TestLocks();
  const controller = new OnlineVaultController({ lockManager: locks, channel: null });
  await controller.ready();
  const opening = controller.acquireScope(async () => undefined);
  const observed = opening.catch((error: unknown) => error);
  await expect(
    controller.withIdleVaultReleased(() =>
      locks.request('cp2p/local-vault/v1', { mode: 'exclusive', ifAvailable: true }, (lock) => {
        expect(lock).not.toBeNull();
        return 'deleted';
      }),
    ),
  ).resolves.toBe('deleted');
  expect(await observed).toMatchObject({ code: 'closed' });
  expect(locks.active()).toBe(0);
  await controller.dispose();
});

test('deletion failure drops an idle unlock key and leaves protected vault locked', async () => {
  installFactory();
  const locks = new TestLocks();
  const controller = new OnlineVaultController({ lockManager: locks, channel: null });
  await controller.enable('deletion vault passphrase');
  await controller.unlock('deletion vault passphrase');
  await expect(
    controller.withIdleVaultReleased(async () => {
      throw new Error('deletion failed');
    }),
  ).rejects.toThrow('deletion failed');
  expect(controller.snapshot()).toEqual({ mode: 'locked', state: 'locked', generation: 1 });
  expect(controller.handoff()).toBeNull();
  expect(locks.active()).toBe(0);
  await expect(controller.acquireScope(async () => undefined)).rejects.toMatchObject({
    code: 'locked',
  });
  await controller.dispose();
});

test('status refresh failure reports error without trapping the controller busy or masking deletion failure', async () => {
  installFactory();
  const factory = indexedDB;
  const controller = new OnlineVaultController({ lockManager: new TestLocks(), channel: null });
  await controller.ready();
  await expect(
    controller.withIdleVaultReleased(async () => {
      vi.stubGlobal('indexedDB', {
        open: () => {
          throw new Error('status unavailable');
        },
      });
      throw new Error('original deletion failure');
    }),
  ).rejects.toThrow('original deletion failure');
  expect(controller.snapshot().state).toBe('error');
  expect(controller.handoff()).toBeNull();
  vi.stubGlobal('indexedDB', factory);
  await controller.ready();
  expect(controller.snapshot().state).toBe('ready');
  await controller.dispose();
});

test('enables, unlocks and locks without allowing a protected identity remint', async () => {
  installFactory();
  const controller = new OnlineVaultController({ lockManager: new TestLocks(), channel: null });
  expect(await controller.ready()).toEqual({ mode: 'clear', state: 'ready', generation: 0 });
  let closed = 0;
  const scope = await controller.acquireScope(async () => {
    closed += 1;
  });
  expect(scope.mode).toBe('clear');
  await controller.enable('browser vault passphrase');
  expect(closed).toBe(1);
  expect(controller.snapshot()).toEqual({ mode: 'locked', state: 'locked', generation: 1 });
  await expect(controller.acquireScope(async () => undefined)).rejects.toMatchObject({
    code: 'locked',
  });
  await expect(controller.unlock('wrong browser passphrase')).rejects.toMatchObject({
    code: 'invalid-key',
  });
  await controller.unlock('browser vault passphrase');
  const unlocked = await controller.acquireScope(async () => undefined);
  const protectedStore = new IndexedDbByteStore({ vault: unlocked });
  expect(await protectedStore.load(identityKey)).toBeInstanceOf(Uint8Array);
  await protectedStore.close();
  await controller.lock();
  expect(controller.snapshot()).toMatchObject({ mode: 'locked', state: 'locked' });
  await controller.dispose();
});

test('lock waits for a signer closer before dropping its owner key', async () => {
  installFactory();
  const locks = new TestLocks();
  const controller = new OnlineVaultController({ lockManager: locks, channel: null });
  await controller.ready();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scope = await controller.acquireScope(async () => held);
  const closing = controller.lock();
  await Promise.resolve();
  expect(controller.snapshot().state).toBe('busy');
  expect(scope.mode).toBe('clear');
  release();
  await closing;
  expect(() => scope.assertActive()).toThrow(/closed/);
  await controller.dispose();
});

test('first enable reserves one durable identity before encrypting the empty device', async () => {
  installFactory();
  const controller = new OnlineVaultController({ lockManager: new TestLocks(), channel: null });
  const store = new IndexedDbByteStore();
  try {
    await controller.enable('first browser vault passphrase');
    expect(controller.snapshot()).toMatchObject({ mode: 'locked', state: 'locked' });
    await expect(store.load(identityKey)).rejects.toMatchObject({ code: 'locked' });
    await controller.unlock('first browser vault passphrase');
    const scope = await controller.acquireScope(async () => undefined);
    const unlocked = new IndexedDbByteStore({ vault: scope });
    try {
      expect(await unlocked.load(identityKey)).toBeInstanceOf(Uint8Array);
    } finally {
      await unlocked.close();
      await controller.releaseScope(scope);
    }
  } finally {
    await store.close();
    await controller.dispose();
  }
});

test('concurrent first scopes share one parent and both close on lock', async () => {
  installFactory();
  const locks = new TestLocks();
  const controller = new OnlineVaultController({ lockManager: locks, channel: null });
  try {
    const [first, second] = await Promise.all([
      controller.acquireScope(async () => undefined),
      controller.acquireScope(async () => undefined),
    ]);
    await controller.lock();
    expect(() => first.assertActive()).toThrow(/closed/);
    expect(() => second.assertActive()).toThrow(/closed/);
    expect(locks.active()).toBe(0);
  } finally {
    await controller.dispose();
  }
});

test('lock overtakes an opening scope without retaining its parent owner', async () => {
  installFactory();
  const locks = new TestLocks();
  const controller = new OnlineVaultController({ lockManager: locks, channel: null });
  try {
    await controller.ready();
    const opening = controller.acquireScope(async () => undefined);
    await controller.lock();
    await expect(opening).rejects.toMatchObject({ code: 'busy' });
    expect(locks.active()).toBe(0);
  } finally {
    await controller.dispose();
  }
});

test('migration blocks a listener-triggered settings scope at the lock boundary', async () => {
  installFactory();
  const controller = new OnlineVaultController({ lockManager: new TestLocks(), channel: null });
  await controller.ready();
  let migrating = false;
  let refetch: Promise<unknown> | null = null;
  const unsubscribe = controller.subscribe(() => {
    if (migrating && controller.snapshot().state === 'ready')
      refetch = controller
        .acquireScope(async () => undefined)
        .then(
          () => null,
          (error: unknown) => error,
        );
  });
  try {
    migrating = true;
    await controller.enable('migration boundary passphrase');
    expect(await Promise.resolve(refetch)).toMatchObject({ code: 'busy' });
  } finally {
    unsubscribe();
    await controller.dispose();
  }
});

test('failed signer shutdown leaves controller in an error state and forbids new scopes', async () => {
  installFactory();
  const controller = new OnlineVaultController({ lockManager: new TestLocks(), channel: null });
  const scope = await controller.acquireScope(async () => {
    throw new Error('signer did not stop');
  });
  try {
    await expect(controller.lock()).rejects.toMatchObject({ code: 'busy' });
    expect(controller.snapshot()).toMatchObject({ state: 'error', errorCode: 'busy' });
    await expect(controller.acquireScope(async () => undefined)).rejects.toMatchObject({
      code: 'busy',
    });
  } finally {
    await controller.releaseScope(scope);
    await controller.dispose();
  }
});
