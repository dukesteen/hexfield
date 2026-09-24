import { QueryClient } from '@tanstack/react-query';
import { expect, test } from 'vitest';
import { loadSavedGame } from './hooks';
import { queryKeys } from './keys';
import { LocalSavedGameRepository, SaveConflictError } from './repositories/saved-games';
import { MemoryStorage } from './repositories/storage';

test('route loads cannot replace a newer cached save with an older persisted revision', async () => {
  const storage = new MemoryStorage();
  const repository = new LocalSavedGameRepository(
    () => storage,
    async (_name, work) => work(),
  );
  const client = new QueryClient();
  const presentation = {
    players: [
      { seat: 0, name: 'Ada', color: 'blue', shape: 'circle' },
      { seat: 1, name: 'Lin', color: 'orange', shape: 'triangle' },
    ],
    botDelayMs: 0,
  } as const;
  const saved = await repository.save({
    id: 'game-1',
    revision: 3,
    presentation: { players: [...presentation.players], botDelayMs: 0 },
    save: { version: 3 },
  });
  client.setQueryData(queryKeys.savedGame('game-1'), {
    ...saved,
    revision: 5,
    save: { version: 5 },
  });
  expect((await loadSavedGame(client, 'game-1', repository))?.revision).toBe(5);
  expect(client.getQueryData<{ revision: number }>(queryKeys.savedGame('game-1'))?.revision).toBe(
    5,
  );
  client.setQueryData(queryKeys.savedGame('game-1'), {
    ...saved,
    save: { version: 'different' },
  });
  await expect(loadSavedGame(client, 'game-1', repository)).rejects.toBeInstanceOf(
    SaveConflictError,
  );
  client.setQueryData(queryKeys.savedGame('game-2'), saved);
  expect(await loadSavedGame(client, 'game-2', repository)).toBeNull();
  repository.dispose();
});
