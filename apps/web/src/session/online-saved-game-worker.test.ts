import type { EscrowCeremonyStore } from '@cp2p/protocol';
import { expect, test, vi } from 'vitest';
import { runOnlineSavedGameWorkerRequest } from './online-saved-game-worker.js';

const gameId = 'a'.repeat(22);
const genesisDigest = 'b'.repeat(43);

function memoryStore(): EscrowCeremonyStore {
  return {
    async load() {
      return null;
    },
    async putIfAbsent() {
      return true;
    },
    async compareAndSwap() {
      return true;
    },
    async withCeremonyLock<T>(_key: string, task: () => Promise<T>): Promise<T> {
      return task();
    },
  };
}

type CloseableStore = EscrowCeremonyStore & { close(): Promise<void> };

test('invalid worker input is rejected before opening storage', async () => {
  const createStore = vi.fn<() => CloseableStore>(() =>
    Object.assign(memoryStore(), { close: async () => undefined }),
  );

  const response = await runOnlineSavedGameWorkerRequest(
    { id: 1, kind: 'delete', gameId: [gameId], genesisDigest },
    { createStore },
  );

  expect(response).toEqual({ id: 1, kind: 'error', error: 'Saved-game request is invalid' });
  expect(createStore).not.toHaveBeenCalled();

  const throwingGetter = Object.defineProperty({}, 'id', {
    get() {
      throw new Error('untrusted request accessor');
    },
  });
  await expect(runOnlineSavedGameWorkerRequest(throwingGetter, { createStore })).resolves.toEqual({
    id: 0,
    kind: 'error',
    error: 'Saved-game request is invalid',
  });
  expect(createStore).not.toHaveBeenCalled();
});

test('busy deletion is reported without claiming removal and closes storage', async () => {
  const close = vi.fn<() => Promise<void>>(async () => undefined);
  const store = Object.assign(memoryStore(), { close });
  const deleteRecord = vi.fn<
    (store: EscrowCeremonyStore, gameId: string, genesisDigest: string) => Promise<'busy'>
  >(async () => 'busy');

  const response = await runOnlineSavedGameWorkerRequest(
    { id: 2, kind: 'delete', gameId, genesisDigest },
    { createStore: () => store, deleteRecord },
  );

  expect(response).toEqual({ id: 2, kind: 'deleted', result: 'busy' });
  expect(deleteRecord).toHaveBeenCalledWith(store, gameId, genesisDigest);
  expect(close).toHaveBeenCalledOnce();
});
