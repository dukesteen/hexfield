import { afterEach, describe, expect, test, vi } from 'vitest';
import { acquireGameWriterLease } from './game-writer.js';

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
