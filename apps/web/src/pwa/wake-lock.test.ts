import { expect, test, vi } from 'vitest';
import { watchBackgrounding } from './background-watch.js';
import { isActiveGamePath, isOnlineGamePath, isWakeLockPath } from './game-paths.js';
import { holdScreenWakeLock } from './wake-lock.js';
import type { VisibilityDocument, WakeLockLike, WakeLockSentinelLike } from './wake-lock.js';

class FakeDocument implements VisibilityDocument {
  visibilityState: DocumentVisibilityState = 'visible';
  private readonly listeners = new Set<() => void>();
  addEventListener(_type: 'visibilitychange', listener: () => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'visibilitychange', listener: () => void) {
    this.listeners.delete(listener);
  }
  get listenerCount() {
    return this.listeners.size;
  }
  set(state: DocumentVisibilityState) {
    this.visibilityState = state;
    for (const listener of this.listeners) listener();
  }
}

class FakeWakeLock implements WakeLockLike {
  readonly sentinels: (WakeLockSentinelLike & { released: boolean })[] = [];
  fail = false;
  async request(): Promise<WakeLockSentinelLike> {
    if (this.fail) throw new DOMException('Not allowed', 'NotAllowedError');
    const sentinel = {
      released: false,
      release: vi.fn<() => Promise<void>>(async () => {
        sentinel.released = true;
      }),
    };
    this.sentinels.push(sentinel);
    return sentinel;
  }
  /** What a browser does when the page is hidden. */
  releaseAll() {
    for (const sentinel of this.sentinels) sentinel.released = true;
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the wake lock is held while visible, re-acquired after hiding, and released on leave', async () => {
  const doc = new FakeDocument();
  const lock = new FakeWakeLock();
  const stop = holdScreenWakeLock(lock, doc);
  await flush();
  expect(lock.sentinels).toHaveLength(1);

  doc.set('hidden');
  lock.releaseAll();
  await flush();
  expect(lock.sentinels).toHaveLength(1);
  doc.set('visible');
  await flush();
  expect(lock.sentinels).toHaveLength(2);
  expect(lock.sentinels[1]?.released).toBe(false);

  stop();
  expect(lock.sentinels[1]?.release).toHaveBeenCalledOnce();
  expect(doc.listenerCount).toBe(0);
  doc.set('hidden');
  doc.set('visible');
  await flush();
  expect(lock.sentinels).toHaveLength(2);
});

test('a lock granted after leaving the game is released at once', async () => {
  const doc = new FakeDocument();
  const lock = new FakeWakeLock();
  const stop = holdScreenWakeLock(lock, doc);
  stop();
  await flush();
  expect(lock.sentinels[0]?.released).toBe(true);
});

test('missing or refused wake locks are harmless', async () => {
  const doc = new FakeDocument();
  expect(() => holdScreenWakeLock(undefined, doc)()).not.toThrow();
  const lock = new FakeWakeLock();
  lock.fail = true;
  const stop = holdScreenWakeLock(lock, doc);
  await flush();
  lock.fail = false;
  doc.set('hidden');
  doc.set('visible');
  await flush();
  expect(lock.sentinels).toHaveLength(1);
  stop();
});

test('a hidden page does not request a lock until it is visible', async () => {
  const doc = new FakeDocument();
  doc.visibilityState = 'hidden';
  const lock = new FakeWakeLock();
  const stop = holdScreenWakeLock(lock, doc);
  await flush();
  expect(lock.sentinels).toHaveLength(0);
  doc.set('visible');
  await flush();
  expect(lock.sentinels).toHaveLength(1);
  stop();
});

test('returning from a long background trip triggers the online warning', () => {
  const doc = new FakeDocument();
  let clock = 0;
  const onReturn = vi.fn<(hiddenMs: number) => void>();
  const stop = watchBackgrounding(doc, onReturn, () => clock, 3000);
  doc.set('hidden');
  clock = 1000;
  doc.set('visible');
  expect(onReturn).not.toHaveBeenCalled();
  doc.set('hidden');
  clock = 9000;
  doc.set('visible');
  expect(onReturn).toHaveBeenCalledWith(8000);
  stop();
  expect(doc.listenerCount).toBe(0);
});

test('game paths decide where prompts wait, the screen stays awake and the warning applies', () => {
  expect(isActiveGamePath('/local/abc')).toBe(true);
  expect(isActiveGamePath('/local/new')).toBe(false);
  expect(isActiveGamePath('/game/abc')).toBe(true);
  expect(isActiveGamePath('/lobby/abc')).toBe(true);
  expect(isActiveGamePath('/')).toBe(false);
  expect(isActiveGamePath('/settings')).toBe(false);
  expect(isActiveGamePath('/replay/abc')).toBe(false);
  expect(isWakeLockPath('/local/abc')).toBe(true);
  expect(isWakeLockPath('/game/abc')).toBe(true);
  expect(isWakeLockPath('/lobby/abc')).toBe(false);
  expect(isOnlineGamePath('/game/abc')).toBe(true);
  expect(isOnlineGamePath('/local/abc')).toBe(false);
});
