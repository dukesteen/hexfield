import type { IDBPDatabase } from 'idb';
import { BYTE_STORE, MAX_RECORD_BYTES, openDatabase, strictWriteTransaction } from './database.js';
import type { CP2PDatabase } from './database.js';

const MAX_KEY_LENGTH = 512;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const LOCK_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._:/-]*$/;

export type CeremonyLockProvider = <T>(name: string, task: () => Promise<T>) => Promise<T>;

export interface IndexedDbByteStoreOptions {
  /** A smaller application limit may be selected; the hard limit is 16 MiB. */
  readonly maxRecordBytes?: number;
  /** Override only for tests; production uses same-origin Web Locks. */
  readonly lockProvider?: CeremonyLockProvider;
}

/**
 * Versioned cp2p IndexedDB foundation. Each method is a bounded atomic byte
 * record operation shared by every tab and connection on this origin. It does
 * not reset or replace an existing database after an error.
 */
export class IndexedDbByteStore {
  readonly #maxRecordBytes: number;
  readonly #lockProvider: CeremonyLockProvider | undefined;
  #databasePromise: Promise<IDBPDatabase<CP2PDatabase>> | null = null;

  constructor(options: IndexedDbByteStoreOptions = {}) {
    this.#maxRecordBytes = options.maxRecordBytes ?? MAX_RECORD_BYTES;
    this.#lockProvider = options.lockProvider;
    if (
      !Number.isSafeInteger(this.#maxRecordBytes) ||
      this.#maxRecordBytes < 0 ||
      this.#maxRecordBytes > MAX_RECORD_BYTES
    )
      throw new RangeError('maxRecordBytes must be between zero and 16 MiB');
  }

  async load(id: string): Promise<Uint8Array | null> {
    const key = validateKey(id);
    const database = await this.#database();
    const transaction = database.transaction(BYTE_STORE, 'readonly');
    let value: Uint8Array | undefined;
    try {
      value = await transaction.store.get(key);
      await transaction.done;
    } catch (error) {
      await transaction.done.catch(() => undefined);
      throw error;
    }
    if (value === undefined) return null;
    return validateStoredBytes(value, this.#maxRecordBytes).slice();
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    const key = validateKey(id);
    const value = copyBytes(bytes, this.#maxRecordBytes);
    const database = await this.#database();
    const transaction = strictWriteTransaction(database, [BYTE_STORE]);
    try {
      const store = transaction.objectStore(BYTE_STORE);
      const existing = await store.get(key);
      if (existing !== undefined) {
        await transaction.done;
        validateStoredBytes(existing, this.#maxRecordBytes);
        return false;
      }
      await store.add(value, key);
      await transaction.done;
      return true;
    } catch (error) {
      await transaction.done.catch(() => undefined);
      throw error;
    }
  }

  /** Byte-exact compare-and-swap in one cross-connection readwrite transaction. */
  async compareAndSwap(
    id: string,
    expected: Uint8Array,
    replacement: Uint8Array,
  ): Promise<boolean> {
    const key = validateKey(id);
    const expectedCopy = copyBytes(expected, this.#maxRecordBytes);
    const replacementCopy = copyBytes(replacement, this.#maxRecordBytes);
    const database = await this.#database();
    const transaction = strictWriteTransaction(database, [BYTE_STORE]);
    try {
      const store = transaction.objectStore(BYTE_STORE);
      const existing = await store.get(key);
      if (existing === undefined) {
        await transaction.done;
        return false;
      }
      const current = validateStoredBytes(existing, this.#maxRecordBytes);
      if (!equalBytes(current, expectedCopy)) {
        await transaction.done;
        return false;
      }
      await store.put(replacementCopy, key);
      await transaction.done;
      return true;
    } catch (error) {
      await transaction.done.catch(() => undefined);
      throw error;
    }
  }

  /**
   * Serialize escrow read/CAS/send-enqueue work across tabs. A caller should
   * keep the callback to its critical section; this lock does not replace IDB
   * transactions or make network delivery durable.
   */
  async withCeremonyLock<T>(ceremonyId: string, task: () => Promise<T>): Promise<T> {
    // Bare ceremony digests use every base64url character, including the first one.
    const id = validateKey(ceremonyId, LOCK_PATTERN);
    const lockName = `cp2p/escrow-ceremony/${id}`;
    const provider = this.#lockProvider ?? browserLockProvider;
    return provider(lockName, task);
  }

  /** Close this connection; a later operation may open a fresh connection. */
  async close(): Promise<void> {
    const pending = this.#databasePromise;
    this.#databasePromise = null;
    if (!pending) return;
    const database = await pending;
    database.close();
  }

  #database(): Promise<IDBPDatabase<CP2PDatabase>> {
    if (this.#databasePromise) return this.#databasePromise;
    let opening: Promise<IDBPDatabase<CP2PDatabase>>;
    opening = openDatabase(
      () => {
        if (this.#databasePromise === opening) this.#databasePromise = null;
      },
      () => {
        if (this.#databasePromise === opening) this.#databasePromise = null;
      },
    ).catch((error: unknown) => {
      if (this.#databasePromise === opening) this.#databasePromise = null;
      throw error;
    });
    this.#databasePromise = opening;
    return opening;
  }
}

function validateKey(id: string, pattern = KEY_PATTERN): string {
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_KEY_LENGTH || !pattern.test(id))
    throw new TypeError('IndexedDB record key is invalid');
  return id;
}

function copyBytes(value: Uint8Array, maxBytes: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > maxBytes)
    throw new RangeError('IndexedDB record must be a bounded Uint8Array');
  return value.slice();
}

function validateStoredBytes(value: unknown, maxBytes: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > maxBytes)
    throw new TypeError('Stored IndexedDB record is malformed or oversized');
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

const browserLockProvider: CeremonyLockProvider = async (name, task) => {
  if (typeof navigator === 'undefined' || !navigator.locks)
    throw new Error('Web Locks are unavailable; escrow coordination cannot proceed safely');
  return navigator.locks.request(name, { mode: 'exclusive' }, () => task());
};
