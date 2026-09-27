import { canonicalEncode } from '@cp2p/codec';
import { createBaseEngine, BASE_VERSION } from '@cp2p/engine';
import type { EscrowCeremonyStore, SessionUpdate } from '@cp2p/protocol';
import { expect, test, vi } from 'vitest';
import {
  createOnlineGameActivityWriter,
  isOnlineGameAbandoned,
  loadOnlineGameActivity,
  saveOnlineGameActivity,
} from './online-game-activity.js';

function memoryStore() {
  const records = new Map<string, Uint8Array>();
  const store: EscrowCeremonyStore = {
    load: async (id) => records.get(id)?.slice() ?? null,
    putIfAbsent: async (id, bytes) => {
      if (records.has(id)) return false;
      records.set(id, bytes.slice());
      return true;
    },
    compareAndSwap: async (id, expected, replacement) => {
      const current = records.get(id);
      if (
        !current ||
        current.length !== expected.length ||
        !current.every((byte, i) => byte === expected[i])
      )
        return false;
      records.set(id, replacement.slice());
      return true;
    },
    withCeremonyLock: async (_id, task) => task(),
  };
  return { store, records };
}
const gameId = 'A'.repeat(22);
const genesisDigest = 'B'.repeat(43);
const first = {
  gameId,
  genesisDigest,
  head: { seq: 2, hash: 'a'.repeat(64) },
  lastActivityAt: 1_000,
};
const month = 30 * 24 * 60 * 60 * 1_000;

test('marks local abandonment at 30 days and never from missing metadata or a reversed clock', async () => {
  const { store } = memoryStore();
  await saveOnlineGameActivity(store, first);
  const activity = await loadOnlineGameActivity(store, gameId, genesisDigest);
  expect(isOnlineGameAbandoned(activity, first.lastActivityAt + month - 1)).toBe(false);
  expect(isOnlineGameAbandoned(activity, first.lastActivityAt + month)).toBe(true);
  expect(isOnlineGameAbandoned(activity, 0)).toBe(false);
  expect(isOnlineGameAbandoned(null, first.lastActivityAt + month)).toBe(false);
  await saveOnlineGameActivity(store, { ...first, lastActivityAt: first.lastActivityAt + month });
  expect(
    isOnlineGameAbandoned(
      await loadOnlineGameActivity(store, gameId, genesisDigest),
      first.lastActivityAt + month,
    ),
  ).toBe(false);
});

test('preserves monotone activity and refuses stale or conflicting certified heads', async () => {
  const { store } = memoryStore();
  await saveOnlineGameActivity(store, first);
  const next = { ...first, head: { seq: 3, hash: 'c'.repeat(64) }, lastActivityAt: 500 };
  await saveOnlineGameActivity(store, next);
  expect((await loadOnlineGameActivity(store, gameId, genesisDigest))?.lastActivityAt).toBe(1_000);
  await expect(saveOnlineGameActivity(store, first)).rejects.toThrow('newer or conflicting');
  await expect(
    saveOnlineGameActivity(store, { ...next, head: { ...next.head, hash: 'd'.repeat(64) } }),
  ).rejects.toThrow('newer or conflicting');
  await expect(loadOnlineGameActivity(store, gameId, 'C'.repeat(43))).rejects.toThrow(
    'match this game',
  );
});

test('validates before writing and rejects damaged or oversized metadata', async () => {
  const { store, records } = memoryStore();
  await expect(saveOnlineGameActivity(store, { ...first, lastActivityAt: NaN })).rejects.toThrow(
    'Invalid',
  );
  expect(records.size).toBe(0);
  records.set(`online-game/${gameId}/activity`, new Uint8Array(2_049));
  await expect(loadOnlineGameActivity(store, gameId, genesisDigest)).rejects.toThrow('too large');
  records.set(
    `online-game/${gameId}/activity`,
    canonicalEncode({ ...first, protocol: 'online-game-activity-v1', extra: true }),
  );
  await expect(loadOnlineGameActivity(store, gameId, genesisDigest)).rejects.toThrow('Invalid');
});

test('activity subscriber deduplicates, retries failed writes, and drains on close', async () => {
  const { store, records } = memoryStore();
  const original = store.putIfAbsent.bind(store);
  const put = vi
    .fn<typeof store.putIfAbsent>(original)
    .mockRejectedValueOnce(new Error('temporary write failure'));
  store.putIfAbsent = put;
  const onError = vi.fn<(error: Error) => void>();
  const state = createBaseEngine().createGame(
    { modules: [{ id: 'base', version: BASE_VERSION }], seats: [0, 1], options: {} },
    new Uint8Array(32).fill(9),
  );
  const update: SessionUpdate = {
    revision: 2,
    state,
    events: [],
    pending: [],
    timers: [],
    status: { kind: 'complete' },
    audit: { kind: 'not-started' },
  };
  const listeners = new Set<(update: SessionUpdate) => void>();
  let head = { ...first.head };
  let now = 1_000;
  const writer = createOnlineGameActivityWriter({
    store,
    gameId,
    genesisDigest,
    onError,
    now: () => now,
    session: {
      getCommittedHead: () => ({ ...head }),
      subscribe: (listener) => {
        listeners.add(listener);
        listener(update);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  });
  const publish = () => {
    for (const listener of listeners) listener(update);
  };
  await writer.flush();
  expect(onError).toHaveBeenCalledTimes(1);
  publish();
  await writer.flush();
  expect(records.size).toBe(1);
  const saved = [...records.values()][0]?.slice();
  now = 5_000;
  publish();
  await writer.flush();
  expect([...records.values()][0]).toEqual(saved);
  head = { seq: 3, hash: 'c'.repeat(64) };
  publish();
  writer.stop();
  await writer.flush();
  expect(listeners.size).toBe(0);
  expect((await loadOnlineGameActivity(store, gameId, genesisDigest))?.lastActivityAt).toBe(5_000);
});
