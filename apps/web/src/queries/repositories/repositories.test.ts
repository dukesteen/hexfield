// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { LocalSavedGameRepository, SaveConflictError, type SaveInput } from './saved-games';
import { LocalSettingsRepository } from './settings';
import { MemoryStorage } from './storage';

const presentation = {
  players: [
    { seat: 0, name: 'Ada', color: 'blue', shape: 'circle' },
    { seat: 1, name: 'Lin', color: 'orange', shape: 'triangle' },
  ],
  botDelayMs: 120,
} as const;

function snapshot(revision: number): SaveInput {
  return {
    id: 'local-1',
    revision,
    presentation: { players: [...presentation.players], botDelayMs: presentation.botDelayMs },
    save: { v: 1, revision },
  };
}

describe('settings repository', () => {
  test('retains concurrent patches and validates stored data', async () => {
    const storage = new MemoryStorage();
    const repository = new LocalSettingsRepository(() => storage);
    const [theme, privacy] = await Promise.all([
      repository.update({ theme: 'dark' }),
      repository.update({ hotseatCover: false }),
    ]);
    expect(theme.theme).toBe('dark');
    expect(privacy.hotseatCover).toBe(false);
    expect(await repository.get()).toMatchObject({ theme: 'dark', hotseatCover: false });
    storage.setItem('hexfield:settings:v1', '{"v":1,"theme":"bad"}');
    await expect(repository.get()).rejects.toThrow(/Invalid/);
  });
});

describe('saved game repository', () => {
  test('lists, loads and rejects stale or divergent revisions', async () => {
    const storage = new MemoryStorage();
    const repository = new LocalSavedGameRepository(
      () => storage,
      async (_name, work) => work(),
    );
    const first = await repository.save(snapshot(5));
    expect(first.revision).toBe(5);
    expect((await repository.list()).map((game) => game.id)).toEqual(['local-1']);
    expect((await repository.get('local-1'))?.save).toEqual({ v: 1, revision: 5 });
    await expect(repository.save(snapshot(4))).rejects.toBeInstanceOf(SaveConflictError);
    await expect(
      repository.save({ ...snapshot(5), save: { v: 1, revision: 5, changed: true } }),
    ).rejects.toBeInstanceOf(SaveConflictError);
    expect((await repository.save(snapshot(5))).updatedAt).toBe(first.updatedAt);
    expect((await repository.save(snapshot(6))).revision).toBe(6);
    await expect(repository.remove('local-1', 5)).rejects.toBeInstanceOf(SaveConflictError);
    await repository.remove('local-1', 6);
    expect(await repository.get('local-1')).toBeNull();
    repository.dispose();
  });

  test('a synchronous pagehide flush wins over an older queued write', async () => {
    const storage = new MemoryStorage();
    let release: (() => void) | undefined;
    const lock = async <T>(_name: string, work: () => T | Promise<T>): Promise<T> => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return work();
    };
    const repository = new LocalSavedGameRepository(() => storage, lock);
    const older = repository.save(snapshot(5));
    await Promise.resolve();
    expect(repository.flushSync(snapshot(6)).revision).toBe(6);
    release?.();
    await expect(older).rejects.toBeInstanceOf(SaveConflictError);
    expect((await repository.get('local-1'))?.revision).toBe(6);
    repository.dispose();
  });

  test('deletion waits for queued saves and checks the resulting revision', async () => {
    const storage = new MemoryStorage();
    const repository = new LocalSavedGameRepository(
      () => storage,
      async (_name, work) => work(),
    );
    await repository.save(snapshot(1));
    const next = repository.save(snapshot(2));
    const deletion = repository.remove('local-1', 1);
    await next;
    await expect(deletion).rejects.toBeInstanceOf(SaveConflictError);
    expect((await repository.get('local-1'))?.revision).toBe(2);
    repository.dispose();
  });

  test('external changes stop the next local write', async () => {
    const storage = new MemoryStorage();
    const repository = new LocalSavedGameRepository(
      () => storage,
      async (_name, work) => work(),
    );
    await repository.save(snapshot(1));
    // This is the same browser storage event the repository receives from another tab.
    const event = new StorageEvent('storage', {
      key: 'hexfield:save:v1:local-1',
      newValue: JSON.stringify({ ...snapshot(2), v: 1, updatedAt: 1 }),
    });
    const notified: string[] = [];
    repository.subscribeExternal((id) => notified.push(id));
    window.dispatchEvent(event);
    expect(notified).toEqual(['local-1']);
    await expect(repository.save(snapshot(3))).rejects.toBeInstanceOf(SaveConflictError);
    repository.dispose();
  });
});
