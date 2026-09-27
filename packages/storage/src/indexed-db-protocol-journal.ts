import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { certifiedEntrySchema, entryHash, logEntrySchema } from '@cp2p/protocol';
import type { CertifiedEntry, LogEntry, ProtocolJournal } from '@cp2p/protocol';
import type { IDBPDatabase } from 'idb';
import * as v from 'valibot';
import type { CP2PDatabase } from './database.js';
import {
  CONSENSUS_STORE,
  ENTRY_STORE,
  GAME_STORE,
  MAX_RECORD_BYTES,
  openDatabase,
  strictWriteTransaction,
} from './database.js';

const consensusRecordSchema = v.strictObject({
  height: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)),
  revision: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
  safety: v.custom<Uint8Array>((value) => value instanceof Uint8Array),
});

interface ConsensusRecord {
  height: number;
  revision: number;
  safety: Uint8Array;
}

export interface IndexedDbProtocolJournalOptions {
  readonly maxRecordBytes?: number;
}

/** Stores each certified entry once and updates next-height safety in the same transaction. */
export class IndexedDbProtocolJournal implements ProtocolJournal {
  readonly #gameId: string;
  readonly #maxRecordBytes: number;
  #databasePromise: Promise<IDBPDatabase<CP2PDatabase>> | null = null;

  constructor(gameId: string, options: IndexedDbProtocolJournalOptions = {}) {
    if (
      typeof gameId !== 'string' ||
      gameId.length === 0 ||
      gameId.length > 512 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(gameId)
    )
      throw new TypeError('Journal gameId is invalid');
    const maxRecordBytes = options.maxRecordBytes ?? MAX_RECORD_BYTES;
    if (
      !Number.isSafeInteger(maxRecordBytes) ||
      maxRecordBytes < 0 ||
      maxRecordBytes > MAX_RECORD_BYTES
    )
      throw new RangeError('maxRecordBytes must be between zero and 16 MiB');
    this.#gameId = gameId;
    this.#maxRecordBytes = maxRecordBytes;
  }

  async load() {
    const database = await this.#database();
    const transaction = database.transaction(
      [GAME_STORE, ENTRY_STORE, CONSENSUS_STORE],
      'readonly',
    );
    try {
      const genesisBytes = await transaction.objectStore(GAME_STORE).get(this.#gameId);
      const consensusBytes = await transaction.objectStore(CONSENSUS_STORE).get(this.#gameId);
      const range = IDBKeyRange.bound([this.#gameId, 0], [this.#gameId, Number.MAX_SAFE_INTEGER]);
      const entryKeys = await transaction.objectStore(ENTRY_STORE).getAllKeys(range);
      const entryBytes = await transaction.objectStore(ENTRY_STORE).getAll(range);
      await transaction.done;

      if (genesisBytes === undefined && consensusBytes === undefined && entryKeys.length === 0)
        return null;
      if (genesisBytes === undefined || consensusBytes === undefined)
        throw new TypeError('Journal metadata is incomplete');
      const genesis = decodeRecord(genesisBytes, logEntrySchema, this.#maxRecordBytes);
      if (
        genesis.seq !== 0 ||
        genesis.payload.kind !== 'genesis' ||
        genesis.payload.genesis.gameId !== this.#gameId
      )
        throw new TypeError('Stored journal genesis does not match its gameId');
      const consensus = decodeRecord(consensusBytes, consensusRecordSchema, this.#maxRecordBytes);
      const entries = entryBytes.map((bytes, index) => {
        const key = entryKeys[index];
        const certified = decodeRecord(bytes, certifiedEntrySchema, this.#maxRecordBytes);
        if (
          !Array.isArray(key) ||
          key[0] !== this.#gameId ||
          key[1] !== index + 1 ||
          certified.entry.seq !== index + 1
        )
          throw new TypeError('Stored journal entries are not contiguous');
        return certified;
      });
      validateHistory(genesis, entries, consensus, this.#gameId);
      return {
        genesis: copyLogEntry(genesis, this.#maxRecordBytes),
        entries: entries.map((entry) => copyCertifiedEntry(entry, this.#maxRecordBytes)),
        height: consensus.height,
        safety: { revision: consensus.revision, bytes: consensus.safety.slice() },
      };
    } catch (error) {
      await transaction.done.catch(() => undefined);
      throw error;
    }
  }

  async initialize(genesis: LogEntry, safety: Uint8Array): Promise<boolean> {
    const checkedGenesis = copyLogEntry(genesis, this.#maxRecordBytes);
    if (
      checkedGenesis.seq !== 0 ||
      checkedGenesis.payload.kind !== 'genesis' ||
      checkedGenesis.payload.genesis.gameId !== this.#gameId
    )
      throw new TypeError('Journal genesis must be sequence zero for its pinned gameId');
    const safetyBytes = copyBytes(safety, this.#maxRecordBytes);
    const genesisBytes = canonicalEncode(checkedGenesis);
    const consensusBytes = encodeRecord(
      { height: 1, revision: 0, safety: safetyBytes },
      consensusRecordSchema,
      this.#maxRecordBytes,
    );
    const database = await this.#database();
    const transaction = strictWriteTransaction(database, [
      GAME_STORE,
      ENTRY_STORE,
      CONSENSUS_STORE,
    ]);
    try {
      const genesisExists = await transaction.objectStore(GAME_STORE).get(this.#gameId);
      const consensusExists = await transaction.objectStore(CONSENSUS_STORE).get(this.#gameId);
      const entryCount = await transaction
        .objectStore(ENTRY_STORE)
        .count(IDBKeyRange.bound([this.#gameId, 0], [this.#gameId, Number.MAX_SAFE_INTEGER]));
      if (genesisExists !== undefined || consensusExists !== undefined || entryCount !== 0) {
        if (genesisExists === undefined || consensusExists === undefined)
          throw new TypeError('Existing journal metadata is incomplete');
        const existingGenesis = decodeRecord(genesisExists, logEntrySchema, this.#maxRecordBytes);
        const existingConsensus = decodeRecord(
          consensusExists,
          consensusRecordSchema,
          this.#maxRecordBytes,
        );
        if (
          existingGenesis.seq !== 0 ||
          existingGenesis.payload.kind !== 'genesis' ||
          existingGenesis.payload.genesis.gameId !== this.#gameId ||
          existingConsensus.height !== entryCount + 1
        )
          throw new TypeError('Existing journal metadata is inconsistent');
        await transaction.done;
        return false;
      }
      await transaction.objectStore(GAME_STORE).add(genesisBytes, this.#gameId);
      await transaction.objectStore(CONSENSUS_STORE).add(consensusBytes, this.#gameId);
      await transaction.done;
      return true;
    } catch (error) {
      await transaction.done.catch(() => undefined);
      throw error;
    }
  }

  async loadSafety(height: number) {
    validateHeight(height);
    const database = await this.#database();
    const transaction = database.transaction(CONSENSUS_STORE, 'readonly');
    try {
      const bytes = await transaction.store.get(this.#gameId);
      await transaction.done;
      if (bytes === undefined) return null;
      const consensus = decodeRecord(bytes, consensusRecordSchema, this.#maxRecordBytes);
      return consensus.height === height
        ? { revision: consensus.revision, bytes: consensus.safety.slice() }
        : null;
    } catch (error) {
      await transaction.done.catch(() => undefined);
      throw error;
    }
  }

  async saveSafety(height: number, revision: number, bytes: Uint8Array): Promise<boolean> {
    validateHeight(height);
    validateRevision(revision);
    if (revision === Number.MAX_SAFE_INTEGER) return false;
    const safety = copyBytes(bytes, this.#maxRecordBytes);
    const database = await this.#database();
    const transaction = strictWriteTransaction(database, [CONSENSUS_STORE]);
    try {
      const currentBytes = await transaction.objectStore(CONSENSUS_STORE).get(this.#gameId);
      if (currentBytes === undefined) {
        await transaction.done;
        return false;
      }
      const current = decodeRecord(currentBytes, consensusRecordSchema, this.#maxRecordBytes);
      if (current.height !== height || current.revision !== revision) {
        await transaction.done;
        return false;
      }
      const replacement = encodeRecord(
        { height, revision: revision + 1, safety },
        consensusRecordSchema,
        this.#maxRecordBytes,
      );
      await transaction.objectStore(CONSENSUS_STORE).put(replacement, this.#gameId);
      await transaction.done;
      return true;
    } catch (error) {
      await transaction.done.catch(() => undefined);
      throw error;
    }
  }

  async commit(
    height: number,
    safetyRevision: number,
    certified: CertifiedEntry,
    nextSafety: Uint8Array,
  ): Promise<boolean> {
    validateHeight(height);
    validateRevision(safetyRevision);
    if (height === Number.MAX_SAFE_INTEGER) return false;
    const checkedEntry = copyCertifiedEntry(certified, this.#maxRecordBytes);
    if (checkedEntry.entry.seq !== height) return false;
    const certifiedBytes = canonicalEncode(checkedEntry);
    const safetyBytes = copyBytes(nextSafety, this.#maxRecordBytes);
    const nextConsensus = encodeRecord(
      { height: height + 1, revision: 0, safety: safetyBytes },
      consensusRecordSchema,
      this.#maxRecordBytes,
    );
    const database = await this.#database();
    const transaction = strictWriteTransaction(database, [
      GAME_STORE,
      ENTRY_STORE,
      CONSENSUS_STORE,
    ]);
    try {
      const consensusBytes = await transaction.objectStore(CONSENSUS_STORE).get(this.#gameId);
      if (consensusBytes === undefined) {
        await transaction.done;
        return false;
      }
      const current = decodeRecord(consensusBytes, consensusRecordSchema, this.#maxRecordBytes);
      if (current.height !== height || current.revision !== safetyRevision) {
        await transaction.done;
        return false;
      }
      const parent = await this.#parentEntry(transaction, height);
      if (checkedEntry.entry.prevHash !== entryHash(parent)) {
        await transaction.done;
        return false;
      }
      await transaction.objectStore(ENTRY_STORE).add(certifiedBytes, [this.#gameId, height]);
      await transaction.objectStore(CONSENSUS_STORE).put(nextConsensus, this.#gameId);
      await transaction.done;
      return true;
    } catch (error) {
      await transaction.done.catch(() => undefined);
      throw error;
    }
  }

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

  async #parentEntry(
    transaction: ReturnType<typeof strictWriteTransaction>,
    height: number,
  ): Promise<LogEntry> {
    if (height === 1) {
      const genesisBytes = await transaction.objectStore(GAME_STORE).get(this.#gameId);
      if (genesisBytes === undefined) throw new TypeError('Journal genesis is missing');
      return decodeRecord(genesisBytes, logEntrySchema, this.#maxRecordBytes);
    }
    const parentBytes = await transaction.objectStore(ENTRY_STORE).get([this.#gameId, height - 1]);
    if (parentBytes === undefined) throw new TypeError('Journal parent entry is missing');
    return decodeRecord(parentBytes, certifiedEntrySchema, this.#maxRecordBytes).entry;
  }
}

function validateHistory(
  genesis: LogEntry,
  entries: readonly CertifiedEntry[],
  consensus: ConsensusRecord,
  gameId: string,
): void {
  if (consensus.height !== entries.length + 1)
    throw new TypeError('Journal height does not follow its certified entries');
  let parent = genesis;
  for (const [index, certified] of entries.entries()) {
    if (certified.entry.seq !== index + 1 || certified.entry.prevHash !== entryHash(parent))
      throw new TypeError('Journal entry history is not contiguous');
    parent = certified.entry;
  }
  if (genesis.payload.kind !== 'genesis' || genesis.payload.genesis.gameId !== gameId)
    throw new TypeError('Journal genesis does not match its pinned gameId');
}

function copyLogEntry(value: LogEntry, maxBytes: number): LogEntry {
  return cloneRecord(value, logEntrySchema, maxBytes);
}

function copyCertifiedEntry(value: CertifiedEntry, maxBytes: number): CertifiedEntry {
  return cloneRecord(value, certifiedEntrySchema, maxBytes);
}

function cloneRecord<T>(value: unknown, schema: v.GenericSchema<T>, maxBytes: number): T {
  const bytes = canonicalEncode(value);
  if (bytes.byteLength > maxBytes) throw new RangeError('Journal record exceeds its byte limit');
  return v.parse(schema, canonicalDecode(bytes));
}

function decodeRecord<T>(bytes: unknown, schema: v.GenericSchema<T>, maxBytes: number): T {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes)
    throw new TypeError('Stored journal record is malformed or oversized');
  const decoded = canonicalDecode(bytes);
  const parsed = v.parse(schema, decoded);
  if (!equalBytes(canonicalEncode(parsed), bytes))
    throw new TypeError('Stored journal record is not canonically encoded');
  return parsed;
}

function encodeRecord<T>(value: unknown, schema: v.GenericSchema<T>, maxBytes: number): Uint8Array {
  const bytes = canonicalEncode(v.parse(schema, value));
  if (bytes.byteLength > maxBytes) throw new RangeError('Journal record exceeds its byte limit');
  return bytes;
}

function copyBytes(value: Uint8Array, maxBytes: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength > maxBytes)
    throw new RangeError('Journal safety record must be a bounded Uint8Array');
  return value.slice();
}

function validateHeight(height: number): void {
  if (!Number.isSafeInteger(height) || height < 1)
    throw new RangeError('Journal height must be a positive safe integer');
}

function validateRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new RangeError('Journal revision must be a nonnegative safe integer');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
