import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import {
  certifiedEntrySchema,
  entryHash,
  genesisDigest,
  logEntrySchema,
  snapshotFromContext,
} from '@cp2p/protocol';
import type { ProposalContext } from '@cp2p/protocol';
import * as v from 'valibot';
import type { IDBPDatabase } from 'idb';
import {
  DELETED_GAME_STORE,
  ENTRY_STORE,
  GAME_STORE,
  MAX_RECORD_BYTES,
  SNAPSHOT_STORE,
  openDatabase,
  strictWriteTransaction,
} from './database.js';
import type { CP2PDatabase } from './database.js';
import { assertOnlineGameNotDeleted } from './online-game-deletion.js';

const INTERVAL = 100;
const RETAIN = 3;
const headerSchema = v.object({
  genesisDigest: v.string(),
  seq: v.pipe(v.number(), v.integer(), v.minValue(INTERVAL)),
  hash: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});

/** An optional display cache. It never supplies replay, membership, or voting state. */
export class IndexedDbPublicSnapshotStore {
  readonly #gameId: string;
  #databasePromise: Promise<IDBPDatabase<CP2PDatabase>> | null = null;
  #closePromise: Promise<void> | null = null;
  #closed = false;
  #active = 0;
  #drain: (() => void) | null = null;

  constructor(gameId: string) {
    if (!/^[A-Za-z0-9_-]{22}$/.test(gameId)) throw new TypeError('Snapshot gameId is invalid');
    this.#gameId = gameId;
  }

  /** Called only after the certified journal commit succeeds. A failure is cache-only. */
  saveCommitted(snapshot: unknown): Promise<void> {
    const { seq, hash, genesisDigest: digest } = v.parse(headerSchema, snapshot);
    if (seq % INTERVAL !== 0)
      return Promise.reject(new TypeError('Snapshot is not a scheduled head for this game'));
    const bytes = canonicalEncode(snapshot);
    if (bytes.length > MAX_RECORD_BYTES)
      return Promise.reject(new RangeError('Public snapshot exceeds the record limit'));
    return this.#run(async () => {
      const database = await this.#database();
      const transaction = strictWriteTransaction(database, [
        DELETED_GAME_STORE,
        GAME_STORE,
        ENTRY_STORE,
        SNAPSHOT_STORE,
      ]);
      try {
        await assertOnlineGameNotDeleted(transaction, this.#gameId);
        const genesisBytes = await transaction.objectStore(GAME_STORE).get(this.#gameId);
        if (!genesisBytes || genesisBytes.length > MAX_RECORD_BYTES)
          throw new TypeError('Snapshot genesis is missing or oversized');
        const genesis = v.parse(logEntrySchema, canonicalDecode(genesisBytes));
        if (
          genesis.payload.kind !== 'genesis' ||
          genesis.payload.genesis.gameId !== this.#gameId ||
          genesisDigest(genesis.payload.genesis) !== digest
        )
          throw new TypeError('Snapshot genesis differs from the journal');
        const committed = await transaction.objectStore(ENTRY_STORE).get([this.#gameId, seq]);
        if (!committed || committed.length > MAX_RECORD_BYTES)
          throw new TypeError('Certified snapshot head is missing or oversized');
        const certified = v.parse(certifiedEntrySchema, canonicalDecode(committed));
        if (entryHash(certified.entry) !== hash)
          throw new TypeError('Certified snapshot head differs from the journal');
        const snapshots = transaction.objectStore(SNAPSHOT_STORE);
        await snapshots.put(bytes, [this.#gameId, seq]);
        const range = IDBKeyRange.bound([this.#gameId, 0], [this.#gameId, Number.MAX_SAFE_INTEGER]);
        const keys = await snapshots.getAllKeys(range);
        for (const key of keys.slice(0, -RETAIN)) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Deletes share one strict transaction.
          await snapshots.delete(key);
        }
        await transaction.done;
      } catch (error) {
        await transaction.done.catch(() => undefined);
        throw error;
      }
    });
  }

  /** `context` must come from independent full certificate replay, never this cache. */
  loadVerified(context: ProposalContext): Promise<unknown> {
    const seq = context.log.head.seq;
    if (context.log.genesis.gameId !== this.#gameId || seq % INTERVAL !== 0)
      return Promise.reject(new TypeError('Snapshot replay context differs from the game'));
    const expected = snapshotFromContext(context);
    const expectedBytes = canonicalEncode(expected);
    return this.#run(async () => {
      const database = await this.#database();
      const transaction = database.transaction([DELETED_GAME_STORE, SNAPSHOT_STORE], 'readonly');
      try {
        await assertOnlineGameNotDeleted(transaction, this.#gameId);
        const bytes = await transaction.objectStore(SNAPSHOT_STORE).get([this.#gameId, seq]);
        await transaction.done;
        if (!bytes) return null;
        if (bytes.length > MAX_RECORD_BYTES)
          throw new TypeError('Stored public snapshot exceeds the record limit');
        if (!equalBytes(bytes, expectedBytes))
          throw new TypeError('Stored public snapshot differs from certified replay');
        return expected;
      } catch (error) {
        await transaction.done.catch(() => undefined);
        throw error;
      }
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#closeAfterOperations();
    return this.#closePromise;
  }

  async #closeAfterOperations(): Promise<void> {
    if (this.#active) await new Promise<void>((resolve) => (this.#drain = resolve));
    const pending = this.#databasePromise;
    this.#databasePromise = null;
    if (pending) (await pending).close();
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

  #run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('Snapshot store is closed'));
    this.#active += 1;
    return (async () => {
      try {
        return await operation();
      } finally {
        this.#active -= 1;
        if (this.#active === 0) this.#drain?.();
      }
    })();
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
