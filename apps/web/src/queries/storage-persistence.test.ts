import { expect, test, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  type SettingsPatch,
  type SettingsRepository,
} from './repositories/settings';
import { requestPersistentStorage, type StoragePersistenceApi } from './storage-persistence';

function repository(claim: () => Promise<boolean>): SettingsRepository {
  return {
    get: async () => DEFAULT_SETTINGS,
    update: async (_patch: SettingsPatch) => DEFAULT_SETTINGS,
    claimStoragePersistenceRequest: claim,
  };
}

test('supported request coalesces across remounts and records the attempt first', async () => {
  let claimed = false;
  const claim = vi.fn<() => Promise<boolean>>(async () => {
    if (claimed) return false;
    claimed = true;
    return true;
  });
  let finish!: (result: boolean) => void;
  const persist = vi.fn<() => Promise<boolean>>(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const repo = repository(claim);
  const storage: StoragePersistenceApi = { persist };

  const firstMount = requestPersistentStorage({ repository: repo, storage });
  const strictModeRemount = requestPersistentStorage({ repository: repo, storage });
  expect(strictModeRemount).toBe(firstMount);
  await Promise.resolve();
  expect(claim).toHaveBeenCalledOnce();
  expect(persist).toHaveBeenCalledOnce();
  finish(true);
  await expect(firstMount).resolves.toBe('granted');
  await expect(requestPersistentStorage({ repository: repo, storage })).resolves.toBe('granted');
  expect(persist).toHaveBeenCalledOnce();
});

test('denied and unsupported browsers record one attempt without retrying', async () => {
  const deniedRepo = repository(vi.fn<() => Promise<boolean>>(async () => true));
  const deniedStorage = { persist: vi.fn<() => Promise<boolean>>(async () => false) };
  await expect(
    requestPersistentStorage({ repository: deniedRepo, storage: deniedStorage }),
  ).resolves.toBe('denied');
  await expect(
    requestPersistentStorage({ repository: deniedRepo, storage: deniedStorage }),
  ).resolves.toBe('denied');
  expect(deniedStorage.persist).toHaveBeenCalledOnce();

  const unsupportedRepo = repository(vi.fn<() => Promise<boolean>>(async () => true));
  await expect(
    requestPersistentStorage({ repository: unsupportedRepo, storage: null }),
  ).resolves.toBe('unsupported');
  await expect(
    requestPersistentStorage({ repository: unsupportedRepo, storage: null }),
  ).resolves.toBe('unsupported');
});

test('browser and repository errors remain non-fatal and do not repeat the request', async () => {
  const browserFailureRepo = repository(vi.fn<() => Promise<boolean>>(async () => true));
  const failingStorage = {
    persist: vi.fn<() => Promise<boolean>>(async () => Promise.reject(new Error('blocked'))),
  };
  await expect(
    requestPersistentStorage({ repository: browserFailureRepo, storage: failingStorage }),
  ).resolves.toBe('error');
  expect(failingStorage.persist).toHaveBeenCalledOnce();

  const repositoryFailure = repository(async () => {
    throw new Error('settings unavailable');
  });
  const unusedStorage = { persist: vi.fn<() => Promise<boolean>>(async () => true) };
  await expect(
    requestPersistentStorage({ repository: repositoryFailure, storage: unusedStorage }),
  ).resolves.toBe('error');
  expect(unusedStorage.persist).not.toHaveBeenCalled();
});

test('an already claimed request never prompts again', async () => {
  const repo = repository(vi.fn<() => Promise<boolean>>(async () => false));
  const storage = { persist: vi.fn<() => Promise<boolean>>(async () => true) };
  await expect(requestPersistentStorage({ repository: repo, storage })).resolves.toBe(
    'already-requested',
  );
  expect(storage.persist).not.toHaveBeenCalled();
});
