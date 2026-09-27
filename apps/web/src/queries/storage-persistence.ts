import { useMutation } from '@tanstack/react-query';
import { getWebRepositories } from './hooks';
import type { SettingsRepository } from './repositories/settings';

export type StoragePersistenceOutcome =
  | 'granted'
  | 'denied'
  | 'unsupported'
  | 'already-requested'
  | 'error';

export interface StoragePersistenceApi {
  persist(): Promise<boolean>;
}

export interface StoragePersistenceOptions {
  readonly repository?: SettingsRepository;
  /** `null` models a browser with no StorageManager.persist support. */
  readonly storage?: StoragePersistenceApi | null;
}

const requests = new WeakMap<SettingsRepository, Promise<StoragePersistenceOutcome>>();

function browserStoragePersistenceApi(): StoragePersistenceApi | null {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.persist !== 'function')
    return null;
  return { persist: () => navigator.storage.persist() };
}

/** Record the one-time attempt before asking the browser; all failures are non-fatal. */
export function requestPersistentStorage(
  options: StoragePersistenceOptions = {},
): Promise<StoragePersistenceOutcome> {
  const repository = options.repository ?? getWebRepositories().settings;
  const previous = requests.get(repository);
  if (previous) return previous;

  const storage = options.storage === undefined ? browserStoragePersistenceApi() : options.storage;
  const request = (async (): Promise<StoragePersistenceOutcome> => {
    try {
      if (!(await repository.claimStoragePersistenceRequest())) return 'already-requested';
    } catch {
      return 'error';
    }
    if (!storage) return 'unsupported';
    try {
      return (await storage.persist()) ? 'granted' : 'denied';
    } catch {
      return 'error';
    }
  })();
  requests.set(repository, request);
  return request;
}

/** Query-layer mutation used by the online session mount; it never gates gameplay. */
export function useRequestPersistentStorage() {
  return useMutation({ mutationFn: () => requestPersistentStorage() });
}
