import type { IDBPDatabase } from 'idb';
import {
  BYTE_STORE,
  MAX_RECORD_BYTES,
  openDatabase,
  strictWriteTransaction,
  VAULT_STORE,
} from './database.js';
import type { CP2PDatabase } from './database.js';
import { MAX_VAULT_STORED_BYTES, VaultError, VaultRecordAccess } from './local-vault.js';
import type { VaultOwnerLease } from './local-vault.js';

const MAX_KEY_LENGTH = 512;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const LOCK_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._:/-]*$/;

export type CeremonyLockProvider = <T>(name: string, task: () => Promise<T>) => Promise<T>;

export interface IndexedDbByteStoreOptions {
  /** A smaller application limit may be selected; the hard limit is 16 MiB. */
  readonly maxRecordBytes?: number;
  /** Override only for tests; production uses same-origin Web Locks. */
  readonly lockProvider?: CeremonyLockProvider;
  /** A lifetime owner lease acquired before ceremony or game-writer locks. */
  readonly vault?: VaultOwnerLease;
}

/**
 * Versioned cp2p IndexedDB foundation. Each method is a bounded atomic byte
 * record operation shared by every tab and connection on this origin. It does
 * not reset or replace an existing database after an error.
 */
export class IndexedDbByteStore {
  readonly #maxRecordBytes: number;
  readonly #lockProvider: CeremonyLockProvider | undefined;
  readonly #vault: VaultRecordAccess;
  #databasePromise: Promise<IDBPDatabase<CP2PDatabase>> | null = null;

  constructor(options: IndexedDbByteStoreOptions = {}) {
    this.#maxRecordBytes = options.maxRecordBytes ?? MAX_RECORD_BYTES;
    this.#lockProvider = options.lockProvider;
    this.#vault = options.vault?.access() ?? new VaultRecordAccess(true);
    if (
      !Number.isSafeInteger(this.#maxRecordBytes) ||
      this.#maxRecordBytes < 0 ||
      this.#maxRecordBytes > MAX_RECORD_BYTES
    )
      throw new RangeError('maxRecordBytes must be between zero and 16 MiB');
  }

  get maxRecordBytes(): number {
    return this.#maxRecordBytes;
  }

  /** Internal direct-IDB callers share the same pinned generation and record codec. */
  recordAccess(): VaultRecordAccess {
    return this.#vault;
  }

  async load(id: string): Promise<Uint8Array | null> {
    const captured = await this.loadPinned(id);
    if (!captured) return null;
    captured.stored.fill(0);
    return captured.plain;
  }

  /** Returns detached plaintext plus the exact stored bytes needed for transaction CAS. */
  async loadPinned(id: string): Promise<{ plain: Uint8Array; stored: Uint8Array } | null> {
    const key = validateKey(id);
    await this.#vault.pin();
    const database = await this.#database();
    const transaction = database.transaction([BYTE_STORE, VAULT_STORE], 'readonly');
    let value: Uint8Array | undefined;
    try {
      await this.#vault.assertGeneration(transaction.objectStore(VAULT_STORE));
      value = await transaction.objectStore(BYTE_STORE).get(key);
      await transaction.done;
    } catch (error) {
      await transaction.done.catch(() => undefined);
      throw error;
    }
    if (value === undefined) {
      if (key === 'online-credentials/device-identity/v1' && this.#vault.hasMetadata)
        throw new VaultError('identity-missing', 'Reserved device identity is missing');
      return null;
    }
    try {
      validateStoredBytes(value, MAX_VAULT_STORED_BYTES);
      const plain = await this.#vault.decode(key, value);
      if (plain.length > this.#maxRecordBytes) {
        plain.fill(0);
        throw new TypeError('Stored IndexedDB record is malformed or oversized');
      }
      return { plain, stored: value.slice() };
    } finally {
      if (value instanceof Uint8Array) value.fill(0);
    }
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    const key = validateKey(id);
    const value = copyBytes(bytes, this.#maxRecordBytes);
    let stored: Uint8Array | undefined;
    try {
      stored = await this.#vault.encode(key, value);
      const database = await this.#database();
      const transaction = strictWriteTransaction(database, [BYTE_STORE, VAULT_STORE]);
      try {
        await this.#vault.assertGeneration(transaction.objectStore(VAULT_STORE));
        const store = transaction.objectStore(BYTE_STORE);
        const existing = await store.get(key);
        if (existing !== undefined) {
          await transaction.done;
          try {
            validateStoredBytes(existing, MAX_VAULT_STORED_BYTES);
          } finally {
            if (existing instanceof Uint8Array) existing.fill(0);
          }
          return false;
        }
        if (key === 'online-credentials/device-identity/v1' && this.#vault.hasMetadata)
          throw new VaultError('identity-missing', 'Reserved device identity is missing');
        await store.add(stored, key);
        await transaction.done;
        return true;
      } catch (error) {
        await transaction.done.catch(() => undefined);
        throw error;
      }
    } finally {
      value.fill(0);
      stored?.fill(0);
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
    let replacementCopy: Uint8Array;
    try {
      replacementCopy = copyBytes(replacement, this.#maxRecordBytes);
    } catch (error) {
      expectedCopy.fill(0);
      throw error;
    }
    let pinned: { plain: Uint8Array; stored: Uint8Array } | null = null;
    let storedReplacement: Uint8Array | undefined;
    try {
      pinned = await this.loadPinned(key);
      if (!pinned || !equalBytes(pinned.plain, expectedCopy)) return false;
      storedReplacement = await this.#vault.encode(key, replacementCopy);
      const database = await this.#database();
      const transaction = strictWriteTransaction(database, [BYTE_STORE, VAULT_STORE]);
      let existing: Uint8Array | undefined;
      try {
        await this.#vault.assertGeneration(transaction.objectStore(VAULT_STORE));
        const store = transaction.objectStore(BYTE_STORE);
        existing = await store.get(key);
        if (existing === undefined) {
          await transaction.done;
          return false;
        }
        const current = validateStoredBytes(existing, MAX_VAULT_STORED_BYTES);
        if (!equalBytes(current, pinned.stored)) {
          await transaction.done;
          return false;
        }
        await store.put(storedReplacement, key);
        await transaction.done;
        return true;
      } catch (error) {
        await transaction.done.catch(() => undefined);
        throw error;
      } finally {
        if (existing instanceof Uint8Array) existing.fill(0);
      }
    } finally {
      expectedCopy.fill(0);
      replacementCopy.fill(0);
      pinned?.plain.fill(0);
      pinned?.stored.fill(0);
      storedReplacement?.fill(0);
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
