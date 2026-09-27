import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase, IDBPTransaction } from 'idb';

export const DATABASE_NAME = 'cp2p';
export const DATABASE_VERSION = 2;
export const BYTE_STORE = 'bytes';
export const GAME_STORE = 'games';
export const ENTRY_STORE = 'entries';
export const CONSENSUS_STORE = 'consensus';

export const MAX_RECORD_BYTES = 16 * 1024 * 1024;

export interface CP2PDatabase extends DBSchema {
  bytes: { key: string; value: Uint8Array };
  games: { key: string; value: Uint8Array };
  entries: { key: [string, number]; value: Uint8Array };
  consensus: { key: string; value: Uint8Array };
}

export function openDatabase(
  blocked: () => void,
  reset: () => void,
): Promise<IDBPDatabase<CP2PDatabase>> {
  const factory = globalThis.indexedDB;
  if (!factory) return Promise.reject(new Error('IndexedDB is unavailable'));

  let opening: Promise<IDBPDatabase<CP2PDatabase>>;
  opening = openDB<CP2PDatabase>(DATABASE_NAME, DATABASE_VERSION, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) database.createObjectStore(BYTE_STORE);
      if (oldVersion < 2) {
        database.createObjectStore(GAME_STORE);
        database.createObjectStore(ENTRY_STORE);
        database.createObjectStore(CONSENSUS_STORE);
      }
    },
    blocking: () => {
      blocked();
      opening.then((database) => database.close()).catch(() => undefined);
    },
    terminated: reset,
  });
  return opening;
}

export function strictWriteTransaction<
  Stores extends readonly ('bytes' | 'games' | 'entries' | 'consensus')[],
>(
  database: IDBPDatabase<CP2PDatabase>,
  stores: Stores,
): IDBPTransaction<CP2PDatabase, Stores, 'readwrite'> {
  try {
    return database.transaction(stores, 'readwrite', { durability: 'strict' });
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return database.transaction(stores, 'readwrite');
  }
}
