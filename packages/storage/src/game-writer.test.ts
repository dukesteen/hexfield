import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  acquireActiveGameWriterLease,
  acquireGameWriterLease,
  acquireTransferStagingLease,
} from './game-writer.js';

class TestLockManager implements Pick<LockManager, 'request'> {
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
      throw new Error('This test lock manager only supports ifAvailable requests');
    }
    this.held.add(name);
    try {
      return await callback({ name, mode: options?.mode ?? 'exclusive' });
    } finally {
      this.held.delete(name);
    }
  }
}

class ExternallyEndingLockManager implements Pick<LockManager, 'request'> {
  #failRequest: ((error: unknown) => void) | undefined;
  #endRequest: (() => void) | undefined;
  #callbackDone: Promise<void> | undefined;
  readonly held = new Set<string>();

  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    maybeCallback?: LockGrantedCallback<T>,
  ): Promise<T> {
    const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (!callback) throw new Error('Missing lock callback');
    if (this.held.has(name) && options?.ifAvailable) return Promise.resolve(callback(null));
    this.held.add(name);
    let finish!: (value: T | PromiseLike<T>) => void;
    let fail!: (error: unknown) => void;
    const request = new Promise<T>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    this.#failRequest = fail;
    this.#endRequest = () => {
      void Promise.resolve(callback(null)).then(finish, fail);
    };
    this.#callbackDone = Promise.resolve(callback({ name, mode: options?.mode ?? 'exclusive' }))
      .then(finish, fail)
      .then(
        () => undefined,
        () => undefined,
      );
    return request;
  }

  failUnexpectedly(name: string, error: unknown): void {
    this.held.delete(name);
    this.#failRequest?.(error);
  }

  endUnexpectedly(name: string): void {
    this.held.delete(name);
    this.#endRequest?.();
  }

  async waitForCallbackClose(): Promise<void> {
    await this.#callbackDone;
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browser game writer lease', () => {
  test('fences active generations while permitting authorization-scoped staging', async () => {
    const locks = new TestLockManager();
    const active = await acquireActiveGameWriterLease('game-transfer', { lockManager: locks });
    if (!active) throw new Error('Expected active lease');
    expect(await acquireActiveGameWriterLease('game-transfer', { lockManager: locks })).toBeNull();
    const staging = await acquireTransferStagingLease('game-transfer', 'auth-1', {
      lockManager: locks,
    });
    expect(staging).not.toBeNull();
    expect(
      await acquireTransferStagingLease('game-transfer', 'auth-1', { lockManager: locks }),
    ).toBeNull();
    expect(
      await acquireTransferStagingLease('game-transfer', 'auth-2', { lockManager: locks }),
    ).not.toBeNull();
    await staging?.close();
    await active.close();
    const promoted = await acquireActiveGameWriterLease('game-transfer', { lockManager: locks });
    expect(promoted).not.toBeNull();
    await promoted?.close();
  });
  test.each(['-', '_'])(
    'coordinates base64url game and voter identifiers beginning with %s',
    async (prefix) => {
      const locks = new TestLockManager();
      const gameId = prefix + 'a'.repeat(21);
      const voter = prefix + 'b'.repeat(42);
      const lease = await acquireGameWriterLease(gameId, voter, { lockManager: locks });
      expect(lease).not.toBeNull();
      expect(await acquireGameWriterLease(gameId, voter, { lockManager: locks })).toBeNull();
      await lease?.close();
      const reopened = await acquireGameWriterLease(gameId, voter, { lockManager: locks });
      expect(reopened).not.toBeNull();
      await reopened?.close();
    },
  );

  test('claims only the same game and voter identity, without waiting or stealing', async () => {
    const locks = new TestLockManager();
    const first = await acquireGameWriterLease('game-1', 'seat-2-key', { lockManager: locks });
    expect(first).not.toBeNull();
    expect(first?.lockName).toBe('cp2p/game-writer/6:game-1/10:seat-2-key');

    await expect(
      acquireGameWriterLease('game-1', 'seat-2-key', { lockManager: locks }),
    ).resolves.toBeNull();
    const otherVoter = await acquireGameWriterLease('game-1', 'seat-3-key', {
      lockManager: locks,
    });
    const otherGame = await acquireGameWriterLease('game-2', 'seat-2-key', {
      lockManager: locks,
    });
    expect(otherVoter).not.toBeNull();
    expect(otherGame).not.toBeNull();

    await Promise.all([first?.close(), otherVoter?.close(), otherGame?.close()]);
  });

  test('serializes tasks and lets a failed task reject without wedging the queue', async () => {
    const locks = new TestLockManager();
    const lease = await acquireGameWriterLease('game-3', 'voter', { lockManager: locks });
    if (!lease) throw new Error('Expected a writer lease');
    const order: string[] = [];
    const gate = deferred();
    const first = lease.run(async () => {
      order.push('first-start');
      await gate.promise;
      order.push('first-end');
      return 1;
    });
    const failed = lease.run(() => {
      order.push('second');
      throw new Error('session operation failed');
    });
    const third = lease.run(() => {
      order.push('third');
      return 3;
    });
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    gate.resolve();

    await expect(first).resolves.toBe(1);
    await expect(failed).rejects.toThrow('session operation failed');
    await expect(third).resolves.toBe(3);
    expect(order).toEqual(['first-start', 'first-end', 'second', 'third']);
    await lease.close();
  });

  test('close drains accepted work, rejects new work, then releases the lock', async () => {
    const locks = new TestLockManager();
    const lease = await acquireGameWriterLease('game-4', 'voter', { lockManager: locks });
    if (!lease) throw new Error('Expected a writer lease');
    const gate = deferred();
    let finished = false;
    const operation = lease.run(async () => {
      await gate.promise;
      finished = true;
    });

    const closing = lease.close();
    const afterClose = lease.run(() => 'must not run');
    await expect(afterClose).rejects.toMatchObject({ code: 'closed' });
    expect(locks.held.has(lease.lockName)).toBe(true);
    expect(finished).toBe(false);
    gate.resolve();
    await operation;
    await closing;
    expect(finished).toBe(true);
    expect(locks.held.has(lease.lockName)).toBe(false);
  });

  test('task failure still allows explicit close and a later writer', async () => {
    const locks = new TestLockManager();
    const lease = await acquireGameWriterLease('game-5', 'voter', { lockManager: locks });
    if (!lease) throw new Error('Expected a writer lease');
    await expect(lease.run(() => Promise.reject(new Error('failed')))).rejects.toThrow('failed');
    await lease.close();
    const next = await acquireGameWriterLease('game-5', 'voter', { lockManager: locks });
    expect(next).not.toBeNull();
    await next?.close();
  });

  test('notifies and fences immediately when the held lock request resolves unexpectedly', async () => {
    const locks = new ExternallyEndingLockManager();
    const onLost = vi.fn<() => void>();
    const lease = await acquireGameWriterLease('game-loss', 'voter', {
      lockManager: locks,
      onLost,
    });
    if (!lease) throw new Error('Expected a writer lease');

    locks.endUnexpectedly(lease.lockName);
    await vi.waitFor(() => expect(onLost).toHaveBeenCalledOnce());
    expect(onLost).toHaveBeenCalledWith(expect.objectContaining({ code: 'lost' }));
    const task = vi.fn<() => void>();
    await expect(lease.run(task)).rejects.toMatchObject({ code: 'lost' });
    expect(task).not.toHaveBeenCalled();

    await lease.close();
    await locks.waitForCallbackClose();
    expect(onLost).toHaveBeenCalledOnce();
  });

  test('unexpected request rejection notifies once and swallows callback errors', async () => {
    const locks = new ExternallyEndingLockManager();
    const onLost = vi.fn<() => void>(() => {
      throw new Error('cleanup callback failed');
    });
    const lease = await acquireGameWriterLease('game-reject', 'voter', {
      lockManager: locks,
      onLost,
    });
    if (!lease) throw new Error('Expected a writer lease');
    const requestError = new Error('lock request ended');

    locks.failUnexpectedly(lease.lockName, requestError);
    await vi.waitFor(() => expect(onLost).toHaveBeenCalledOnce());
    expect(onLost).toHaveBeenCalledWith(expect.objectContaining({ code: 'lost' }));
    await expect(lease.run(() => 'must not run')).rejects.toMatchObject({ code: 'lost' });
    await expect(lease.close()).rejects.toBe(requestError);
    await locks.waitForCallbackClose();
    expect(onLost).toHaveBeenCalledOnce();
  });

  test('explicit close does not report normal lock release as loss', async () => {
    const locks = new TestLockManager();
    const onLost = vi.fn<() => void>();
    const lease = await acquireGameWriterLease('game-normal-close', 'voter', {
      lockManager: locks,
      onLost,
    });
    if (!lease) throw new Error('Expected a writer lease');

    await lease.close();
    expect(onLost).not.toHaveBeenCalled();
  });

  test('notifies on loss while close is draining and skips queued work', async () => {
    const locks = new ExternallyEndingLockManager();
    const onLost = vi.fn<() => void>();
    const lease = await acquireGameWriterLease('game-draining-loss', 'voter', {
      lockManager: locks,
      onLost,
    });
    if (!lease) throw new Error('Expected a writer lease');

    const gate = deferred();
    const first = lease.run(() => gate.promise);
    const secondTask = vi.fn<() => void>();
    const second = lease.run(secondTask);
    const closing = lease.close();

    locks.endUnexpectedly(lease.lockName);
    await vi.waitFor(() => expect(onLost).toHaveBeenCalledOnce());
    gate.resolve();
    await first;
    await expect(second).rejects.toMatchObject({ code: 'lost' });
    await closing;
    expect(secondTask).not.toHaveBeenCalled();
    expect(onLost).toHaveBeenCalledOnce();
  });

  test('validates identifiers and fails safely when Web Locks are unavailable', async () => {
    const locks = new TestLockManager();
    await expect(acquireGameWriterLease('', 'voter', { lockManager: locks })).rejects.toThrow(
      TypeError,
    );
    vi.stubGlobal('navigator', {});
    await expect(acquireGameWriterLease('game-6', 'voter')).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});
