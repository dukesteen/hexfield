import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createUpdateStore } from './update-store.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('a waiting version is reported, never applied, until the player confirms', async () => {
  const reload = vi.fn<() => void>();
  const activate = vi.fn<() => Promise<void>>(async () => undefined);
  const store = createUpdateStore({ reload });
  const seen: string[] = [];
  store.subscribe(() => seen.push(store.getSnapshot().status));

  store.needRefresh(activate);
  expect(store.getSnapshot().status).toBe('waiting');
  vi.advanceTimersByTime(60_000);
  expect(activate).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();

  await store.applyUpdate();
  expect(activate).toHaveBeenCalledOnce();
  expect(store.getSnapshot().status).toBe('updating');
  store.controllerChanged();
  expect(reload).toHaveBeenCalledOnce();
  expect(seen).toEqual(['waiting', 'updating']);
});

test('another tab activating the update does not reload this one', () => {
  const reload = vi.fn<() => void>();
  const store = createUpdateStore({ reload });
  store.needRefresh(async () => undefined);
  store.controllerChanged();
  expect(reload).not.toHaveBeenCalled();
  expect(store.getSnapshot().status).toBe('waiting');
});

test('a controller change without any waiting version offers a reload instead of forcing one', async () => {
  const reload = vi.fn<() => void>();
  const store = createUpdateStore({ reload });
  store.controllerChanged();
  expect(reload).not.toHaveBeenCalled();
  expect(store.getSnapshot().status).toBe('waiting');
  await store.applyUpdate();
  expect(reload).toHaveBeenCalledOnce();
});

test('a confirmed update reloads even if the new worker never takes control', async () => {
  const reload = vi.fn<() => void>();
  const store = createUpdateStore({ reload, takeoverMs: 1000 });
  store.needRefresh(async () => undefined);
  await store.applyUpdate();
  expect(reload).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(reload).toHaveBeenCalledOnce();
});

test('"Update now" installs a newer version and applies it once it is waiting', async () => {
  const reload = vi.fn<() => void>();
  const activate = vi.fn<() => Promise<void>>(async () => undefined);
  const store = createUpdateStore({ reload });
  store.setChecker(async () => 'found');
  await store.updateNow();
  expect(store.getSnapshot().status).toBe('updating');
  // The new worker finishes installing; the explicit request applies it without a second prompt.
  store.needRefresh(activate);
  await Promise.resolve();
  expect(activate).toHaveBeenCalledOnce();
  store.controllerChanged();
  expect(reload).toHaveBeenCalledOnce();
});

test('"Update now" on the newest version reports it instead of reloading', async () => {
  const reload = vi.fn<() => void>();
  const store = createUpdateStore({ reload });
  store.setChecker(async () => 'none');
  await store.updateNow();
  expect(store.getSnapshot().status).toBe('latest');
  expect(reload).not.toHaveBeenCalled();
  // A later update from another tab still waits for confirmation here.
  store.controllerChanged();
  expect(reload).not.toHaveBeenCalled();
});

test('"Update now" without a service worker reloads from the network', async () => {
  const reload = vi.fn<() => void>();
  const store = createUpdateStore({ reload });
  await store.updateNow();
  expect(reload).toHaveBeenCalledOnce();
});

test('"Update now" with a version already waiting applies it', async () => {
  const reload = vi.fn<() => void>();
  const activate = vi.fn<() => Promise<void>>(async () => undefined);
  const store = createUpdateStore({ reload });
  const check = vi.fn<() => Promise<'found' | 'none'>>(async () => 'none');
  store.setChecker(check);
  store.needRefresh(activate);
  await store.updateNow();
  expect(check).not.toHaveBeenCalled();
  expect(activate).toHaveBeenCalledOnce();
});

test('offline readiness is tracked separately from updates', () => {
  const store = createUpdateStore({ reload: vi.fn<() => void>() });
  store.offlineReady();
  expect(store.getSnapshot()).toEqual({ status: 'idle', offlineReady: true });
});
