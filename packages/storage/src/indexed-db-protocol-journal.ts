import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import {
  certifiedEntrySchema,
  createConsensusState,
  entryHash,
  genesisDigest,
  logEntrySchema,
  replayCertifiedPrefix,
  restoreRetiredSafety,
  validateRetiredTransferBinding,
  validateTransferOwnedMaterial,
} from '@cp2p/protocol';
import type {
  CertifiedEntry,
  LogContext,
  LogEntry,
  ProtocolJournal,
  ReplayPolicy,
} from '@cp2p/protocol';
import type { IDBPDatabase } from 'idb';
import * as v from 'valibot';
import type { CP2PDatabase } from './database.js';
import {
  CONSENSUS_STORE,
  ENTRY_STORE,
  BYTE_STORE,
  GAME_STORE,
  MAX_RECORD_BYTES,
  openDatabase,
  strictWriteTransaction,
} from './database.js';
import { acquireActiveGameWriterLease } from './game-writer.js';
import type { GameWriterLeaseOptions } from './game-writer.js';
import {
  deleteAuthorizationStages,
  readinessKey,
  transferImportFinalKey,
  TransferImportStore,
} from './transfer-import-store.js';
import type { TransferReplayEngine } from './transfer-import-store.js';

export interface TransferPromotionOptions {
  readonly stageKey: string;
  readonly activation: CertifiedEntry;
  readonly engine: Parameters<typeof replayCertifiedPrefix>[2];
  readonly policy: ReplayPolicy;
  /** Null requires a wholly absent active journal and binding on this device. */
  readonly expectedActive: {
    readonly head: { readonly seq: number; readonly hash: string };
    readonly bindingBytes: Uint8Array;
  } | null;
  readonly leaseOptions?: GameWriterLeaseOptions;
}

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
  /**
   * Bind a separately persisted voting-key record to this journal. The record
   * and initial journal safety data are installed in one transaction.
   */
  readonly keyBinding?: { readonly recordKey: string; readonly bytes: Uint8Array };
}

/** Stores each certified entry once and updates next-height safety in the same transaction. */
export class IndexedDbProtocolJournal implements ProtocolJournal {
  readonly #gameId: string;
  readonly #maxRecordBytes: number;
  readonly #keyBinding: { readonly recordKey: string; readonly bytes: Uint8Array } | undefined;
  #databasePromise: Promise<IDBPDatabase<CP2PDatabase>> | null = null;
  #closePromise: Promise<void> | null = null;
  #closed = false;
  #activeOperations = 0;
  #drainOperations: (() => void) | null = null;

  constructor(gameId: string, options: IndexedDbProtocolJournalOptions = {}) {
    if (
      typeof gameId !== 'string' ||
      gameId.length === 0 ||
      gameId.length > 512 ||
      !/^[A-Za-z0-9_-][A-Za-z0-9._:/-]*$/.test(gameId)
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
    this.#keyBinding = options.keyBinding
      ? copyKeyBinding(options.keyBinding, maxRecordBytes)
      : undefined;
  }

  load() {
    return this.#runOperation(() => this.#load());
  }

  async #load() {
    const database = await this.#database();
    const keyBinding = this.#keyBinding;
    const stores = keyBinding
      ? ([GAME_STORE, ENTRY_STORE, CONSENSUS_STORE, BYTE_STORE] as const)
      : ([GAME_STORE, ENTRY_STORE, CONSENSUS_STORE] as const);
    const transaction = database.transaction(stores, 'readonly');
    let bindingBytes: Uint8Array | undefined;
    try {
      const genesisBytes = await transaction.objectStore(GAME_STORE).get(this.#gameId);
      const consensusBytes = await transaction.objectStore(CONSENSUS_STORE).get(this.#gameId);
      const range = IDBKeyRange.bound([this.#gameId, 0], [this.#gameId, Number.MAX_SAFE_INTEGER]);
      const entryKeys = await transaction.objectStore(ENTRY_STORE).getAllKeys(range);
      const entryBytes = await transaction.objectStore(ENTRY_STORE).getAll(range);
      bindingBytes = keyBinding
        ? await transaction.objectStore(BYTE_STORE).get(keyBinding.recordKey)
        : undefined;
      await transaction.done;

      const journalAbsent =
        genesisBytes === undefined && consensusBytes === undefined && entryKeys.length === 0;
      if (journalAbsent) {
        if (bindingBytes !== undefined)
          throw new TypeError('Voting-key binding exists without its journal');
        return null;
      }
      if (
        keyBinding &&
        (bindingBytes === undefined ||
          !matchesKeyBinding(bindingBytes, keyBinding.bytes, this.#maxRecordBytes))
      )
        throw new TypeError('Journal voting-key binding is missing or mismatched');
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
    } finally {
      if (bindingBytes instanceof Uint8Array) bindingBytes.fill(0);
    }
  }

  initialize(genesis: LogEntry, safety: Uint8Array): Promise<boolean> {
    return this.#runOperation(() => this.#initialize(genesis, safety));
  }

  async #initialize(genesis: LogEntry, safety: Uint8Array): Promise<boolean> {
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
    const keyBinding = this.#keyBinding;
    const stores = keyBinding
      ? ([GAME_STORE, ENTRY_STORE, CONSENSUS_STORE, BYTE_STORE] as const)
      : ([GAME_STORE, ENTRY_STORE, CONSENSUS_STORE] as const);
    const transaction = strictWriteTransaction(database, stores);
    let bindingExists: Uint8Array | undefined;
    try {
      const genesisExists = await transaction.objectStore(GAME_STORE).get(this.#gameId);
      const consensusExists = await transaction.objectStore(CONSENSUS_STORE).get(this.#gameId);
      const entryCount = await transaction
        .objectStore(ENTRY_STORE)
        .count(IDBKeyRange.bound([this.#gameId, 0], [this.#gameId, Number.MAX_SAFE_INTEGER]));
      const journalExists =
        genesisExists !== undefined || consensusExists !== undefined || entryCount !== 0;
      bindingExists = keyBinding
        ? await transaction.objectStore(BYTE_STORE).get(keyBinding.recordKey)
        : undefined;
      if (keyBinding) {
        if (!journalExists && bindingExists !== undefined)
          throw new TypeError('Voting-key binding exists without its journal');
        if (
          journalExists &&
          (bindingExists === undefined ||
            !matchesKeyBinding(bindingExists, keyBinding.bytes, this.#maxRecordBytes))
        )
          throw new TypeError('Existing journal voting-key binding is missing or mismatched');
      }
      if (journalExists) {
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
        if (!equalBytes(canonicalEncode(existingGenesis), genesisBytes))
          throw new TypeError('Existing journal genesis differs from requested genesis');
        await transaction.done;
        return false;
      }
      if (keyBinding) {
        const bindingCopy = keyBinding.bytes.slice();
        try {
          await transaction.objectStore(BYTE_STORE).add(bindingCopy, keyBinding.recordKey);
        } finally {
          bindingCopy.fill(0);
        }
      }
      await transaction.objectStore(GAME_STORE).add(genesisBytes, this.#gameId);
      await transaction.objectStore(CONSENSUS_STORE).add(consensusBytes, this.#gameId);
      await transaction.done;
      return true;
    } catch (error) {
      await transaction.done.catch(() => undefined);
      throw error;
    } finally {
      if (bindingExists instanceof Uint8Array) bindingExists.fill(0);
    }
  }

  loadSafety(height: number) {
    return this.#runOperation(() => this.#loadSafety(height));
  }

  async #loadSafety(height: number) {
    validateHeight(height);
    const database = await this.#database();
    const keyBinding = this.#keyBinding;
    const stores = keyBinding
      ? ([GAME_STORE, ENTRY_STORE, CONSENSUS_STORE, BYTE_STORE] as const)
      : ([CONSENSUS_STORE] as const);
    const transaction = database.transaction(stores, 'readonly');
    let bindingBytes: Uint8Array | undefined;
    try {
      const bytes = await transaction.objectStore(CONSENSUS_STORE).get(this.#gameId);
      const genesisBytes = keyBinding
        ? await transaction.objectStore(GAME_STORE).get(this.#gameId)
        : undefined;
      const entryCount = keyBinding
        ? await transaction
            .objectStore(ENTRY_STORE)
            .count(IDBKeyRange.bound([this.#gameId, 0], [this.#gameId, Number.MAX_SAFE_INTEGER]))
        : 0;
      bindingBytes = keyBinding
        ? await transaction.objectStore(BYTE_STORE).get(keyBinding.recordKey)
        : undefined;
      await transaction.done;
      if (keyBinding) {
        const journalExists = genesisBytes !== undefined || bytes !== undefined || entryCount !== 0;
        if (!journalExists && bindingBytes === undefined) return null;
        if (!journalExists) throw new TypeError('Voting-key binding exists without its journal');
        if (genesisBytes === undefined || bytes === undefined || bindingBytes === undefined)
          throw new TypeError('Journal safety or voting-key binding is missing');
        if (!matchesKeyBinding(bindingBytes, keyBinding.bytes, this.#maxRecordBytes))
          throw new TypeError('Journal voting-key binding is mismatched');
      }
      if (bytes === undefined) return null;
      const consensus = decodeRecord(bytes, consensusRecordSchema, this.#maxRecordBytes);
      return consensus.height === height
        ? { revision: consensus.revision, bytes: consensus.safety.slice() }
        : null;
    } catch (error) {
      await transaction.done.catch(() => undefined);
      throw error;
    } finally {
      if (bindingBytes instanceof Uint8Array) bindingBytes.fill(0);
    }
  }

  saveSafety(height: number, revision: number, bytes: Uint8Array): Promise<boolean> {
    return this.#runOperation(() => this.#saveSafety(height, revision, bytes));
  }

  async #saveSafety(height: number, revision: number, bytes: Uint8Array): Promise<boolean> {
    validateHeight(height);
    validateRevision(revision);
    if (revision === Number.MAX_SAFE_INTEGER) return false;
    const safety = copyBytes(bytes, this.#maxRecordBytes);
    const database = await this.#database();
    const keyBinding = this.#keyBinding;
    const stores = keyBinding
      ? ([CONSENSUS_STORE, BYTE_STORE] as const)
      : ([CONSENSUS_STORE] as const);
    const transaction = strictWriteTransaction(database, stores);
    let bindingBytes: Uint8Array | undefined;
    try {
      const currentBytes = await transaction.objectStore(CONSENSUS_STORE).get(this.#gameId);
      if (currentBytes === undefined) {
        await transaction.done;
        return false;
      }
      if (keyBinding) {
        bindingBytes = await transaction.objectStore(BYTE_STORE).get(keyBinding.recordKey);
        if (
          bindingBytes === undefined ||
          !matchesKeyBinding(bindingBytes, keyBinding.bytes, this.#maxRecordBytes)
        )
          throw new TypeError('Journal voting-key binding is missing or mismatched');
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
    } finally {
      if (bindingBytes instanceof Uint8Array) bindingBytes.fill(0);
    }
  }

  commit(
    height: number,
    safetyRevision: number,
    certified: CertifiedEntry,
    nextSafety: Uint8Array,
  ): Promise<boolean> {
    return this.#runOperation(() => this.#commit(height, safetyRevision, certified, nextSafety));
  }

  async #commit(
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
    const keyBinding = this.#keyBinding;
    const stores = keyBinding
      ? ([GAME_STORE, ENTRY_STORE, CONSENSUS_STORE, BYTE_STORE] as const)
      : ([GAME_STORE, ENTRY_STORE, CONSENSUS_STORE] as const);
    const transaction = strictWriteTransaction(database, stores);
    let bindingBytes: Uint8Array | undefined;
    try {
      const consensusBytes = await transaction.objectStore(CONSENSUS_STORE).get(this.#gameId);
      if (consensusBytes === undefined) {
        await transaction.done;
        return false;
      }
      if (keyBinding) {
        bindingBytes = await transaction.objectStore(BYTE_STORE).get(keyBinding.recordKey);
        if (
          bindingBytes === undefined ||
          !matchesKeyBinding(bindingBytes, keyBinding.bytes, this.#maxRecordBytes)
        )
          throw new TypeError('Journal voting-key binding is missing or mismatched');
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
    } finally {
      if (bindingBytes instanceof Uint8Array) bindingBytes.fill(0);
    }
  }

  /**
   * Promote an authenticated, fully replayed import. No pre-activation staging
   * record can be opened as a voting journal. The Web Lock coordinates local
   * writers; the transaction remains the cross-tab compare-and-swap boundary.
   */
  promoteTransfer(options: TransferPromotionOptions): Promise<boolean> {
    if (this.#closed) return Promise.reject(new Error('Journal is closed'));
    const activation = copyCertifiedEntry(options.activation, this.#maxRecordBytes);
    const expectedActive = options.expectedActive
      ? {
          head: { ...options.expectedActive.head },
          bindingBytes: copyBytes(options.expectedActive.bindingBytes, this.#maxRecordBytes),
        }
      : null;
    return this.#runOperation(async () => {
      let lease: Awaited<ReturnType<typeof acquireActiveGameWriterLease>> = null;
      try {
        lease = await acquireActiveGameWriterLease(this.#gameId, options.leaseOptions);
        if (!lease) return false;
        return await lease.run(() =>
          this.#promoteTransfer({ ...options, activation, expectedActive }),
        );
      } finally {
        try {
          await lease?.close();
        } finally {
          expectedActive?.bindingBytes.fill(0);
        }
      }
    });
  }

  async #promoteTransfer(options: TransferPromotionOptions): Promise<boolean> {
    const keyBinding = this.#keyBinding;
    if (!keyBinding) throw new TypeError('Transfer promotion requires a destination key binding');
    const stagedStore = new TransferImportStore();
    let staged: Awaited<ReturnType<TransferImportStore['load']>> = null;
    let readiness: Awaited<ReturnType<TransferImportStore['loadReadiness']>> = null;
    try {
      staged = await stagedStore.load(options.stageKey);
      readiness = await stagedStore.loadReadiness(options.stageKey);
      if (!staged || !readiness || staged.gameId !== this.#gameId)
        throw new TypeError('Transfer import or durable readiness is missing');
      const authorization = staged.authorization;
      if (
        !equalBytes(staged.bindingBytes, keyBinding.bytes) ||
        options.activation.entry.seq !== staged.head.seq + 1 ||
        options.activation.entry.prevHash !== staged.head.hash ||
        staged.authorization.seq >= options.activation.entry.seq
      )
        throw new TypeError('Activation is not the exact next entry after staged import');
      const fullEntries = [...staged.entries, options.activation];
      const before = replayCertifiedPrefix(
        staged.genesis,
        staged.entries,
        options.engine,
        options.policy,
      );
      const after = replayCertifiedPrefix(
        staged.genesis,
        fullEntries,
        options.engine,
        options.policy,
      );
      if (!before.ok || !after.ok)
        throw new TypeError('Transfer promotion requires a fully certified valid prefix');
      const change = options.activation.entry.payload;
      if (
        change.kind !== 'membership' ||
        !isTransferActivation(change.change) ||
        change.change.statement.authorization.seq !== staged.authorization.seq ||
        change.change.statement.authorization.hash !== staged.authorization.hash ||
        change.change.statement.parent.seq !== staged.head.seq ||
        change.change.statement.parent.hash !== staged.head.hash ||
        !equalBytes(
          canonicalEncode(readiness.statement),
          canonicalEncode(change.change.statement),
        ) ||
        readiness.destinationCheck !== change.change.destinationCheck ||
        !equalBytes(
          canonicalEncode(readiness.replacementChecks),
          canonicalEncode(change.change.replacementChecks),
        ) ||
        !after.value.context.log.transfer?.completed.some(
          (item) =>
            item.outcome === 'activated' &&
            item.authorization.seq === authorization.seq &&
            item.authorization.hash === authorization.hash &&
            item.entry.seq === options.activation.entry.seq &&
            item.entry.hash === entryHash(options.activation.entry),
        )
      )
        throw new TypeError('Certified activation differs from durable import readiness');
      const digest = genesisDigest(after.value.context.log.genesis);
      if (keyBinding.recordKey !== `online-game/${digest}/keys`)
        throw new TypeError('Destination binding is outside its game namespace');
      const destinationBinding = canonicalDecode(keyBinding.bytes);
      let owned: ReturnType<typeof validateTransferOwnedMaterial>;
      try {
        owned = validateTransferOwnedMaterial(destinationBinding, after.value.context.log);
      } finally {
        wipeDecodedBytes(destinationBinding);
      }
      if (!owned.ok) throw new TypeError(`Destination material: ${owned.error.code}`);
      for (const seat of owned.value.seats) {
        seat.signingKey.fill(0);
        seat.master.fill(0);
      }
      const approved = after.value.context.log.transfer?.authorizations.find(
        (item) => item.entry.seq === authorization.seq && item.entry.hash === authorization.hash,
      );
      const destinationSeat = approved?.statement.seat;
      if (destinationSeat === undefined)
        throw new TypeError('Certified destination seat is missing');
      const fresh = createConsensusState(after.value.context, destinationSeat);
      if (!fresh.ok) throw new TypeError(`Fresh transfer safety: ${fresh.error.code}`);
      const nextConsensus = encodeRecord(
        {
          height: options.activation.entry.seq + 1,
          revision: 0,
          safety: canonicalEncode(fresh.value),
        },
        consensusRecordSchema,
        this.#maxRecordBytes,
      );
      const oldBinding = options.expectedActive?.bindingBytes;
      if (oldBinding) {
        const historical = historicalOldMaterialContext(
          staged.genesis,
          staged.entries,
          before.value.context.log.transfer,
          staged.authorization,
          options.engine,
          options.policy,
        );
        const retiredBinding = canonicalDecode(oldBinding);
        let old: ReturnType<typeof validateRetiredTransferBinding>;
        try {
          old = validateRetiredTransferBinding(
            retiredBinding,
            historical,
            before.value.context.log,
          );
        } finally {
          wipeDecodedBytes(retiredBinding);
        }
        if (!old.ok) throw new TypeError(`Retired material: ${old.error.code}`);
        for (const seat of old.value.seats) {
          seat.signingKey.fill(0);
          seat.master.fill(0);
        }
        if (
          old.value.devicePeer !== owned.value.devicePeer ||
          old.value.humanSeat !== owned.value.humanSeat ||
          !approved ||
          old.value.seats.find((seat) => seat.seat === approved.statement.seat)?.peerId !==
            oldMaterialKey(approved, before.value.context.log.transfer)
        )
          throw new TypeError('Existing binding belongs to a different device or seat');
      }
      const database = await this.#database();
      const transaction = strictWriteTransaction(database, [
        GAME_STORE,
        ENTRY_STORE,
        CONSENSUS_STORE,
        BYTE_STORE,
      ]);
      let storedStage: Uint8Array | undefined;
      let storedCheck: Uint8Array | undefined;
      try {
        const bytes = transaction.objectStore(BYTE_STORE);
        const finalKey = transferImportFinalKey(staged);
        const priorFinal = await bytes.get(finalKey);
        if (priorFinal !== undefined) {
          if (priorFinal instanceof Uint8Array) priorFinal.fill(0);
          throw new TypeError('Transfer authorization was already finalized locally');
        }
        storedStage = await bytes.get(options.stageKey);
        storedCheck = await bytes.get(readinessKey(options.stageKey));
        const stagedBytes = canonicalEncode(staged);
        const readinessBytes = canonicalEncode(readiness);
        const stageMatches = Boolean(storedStage && equalBytes(storedStage, stagedBytes));
        stagedBytes.fill(0);
        storedStage?.fill(0);
        const checkMatches = Boolean(storedCheck && equalBytes(storedCheck, readinessBytes));
        readinessBytes.fill(0);
        storedCheck?.fill(0);
        if (!stageMatches || !checkMatches)
          throw new TypeError('Transfer import changed during promotion');
        const games = transaction.objectStore(GAME_STORE);
        const entries = transaction.objectStore(ENTRY_STORE);
        const consensus = transaction.objectStore(CONSENSUS_STORE);
        const existingGenesis = await games.get(this.#gameId);
        const existingSafety = await consensus.get(this.#gameId);
        const existingBinding = await bytes.get(keyBinding.recordKey);
        const bindingMatches = Boolean(
          existingBinding &&
          options.expectedActive &&
          equalBytes(existingBinding, options.expectedActive.bindingBytes),
        );
        existingBinding?.fill(0);
        const range = IDBKeyRange.bound([this.#gameId, 0], [this.#gameId, Number.MAX_SAFE_INTEGER]);
        const existingKeys = await entries.getAllKeys(range);
        const existingEntries = await entries.getAll(range);
        if (options.expectedActive === null) {
          if (
            existingGenesis !== undefined ||
            existingSafety !== undefined ||
            existingBinding !== undefined ||
            existingKeys.length !== 0
          )
            throw new TypeError('Fresh destination already has active or partial journal state');
        } else {
          const expected = options.expectedActive;
          if (
            existingGenesis === undefined ||
            existingSafety === undefined ||
            !bindingMatches ||
            !equalBytes(existingGenesis, canonicalEncode(staged.genesis)) ||
            expected.head.seq !== existingKeys.length ||
            expected.head.seq > options.activation.entry.seq
          )
            throw new TypeError('Existing active journal binding or head changed');
          const oldSafety = decodeRecord(
            existingSafety,
            consensusRecordSchema,
            this.#maxRecordBytes,
          );
          if (oldSafety.height !== existingKeys.length + 1)
            throw new TypeError('Existing active journal safety is incomplete');
          if (existingKeys.length === options.activation.entry.seq) {
            const retiredKey = oldMaterialKey(approved, before.value.context.log.transfer);
            const markerBytes = canonicalDecode(oldSafety.safety);
            try {
              const marker = restoreRetiredSafety(
                markerBytes,
                after.value.context,
                destinationSeat,
                retiredKey,
              );
              if (!marker.ok)
                throw new TypeError(`Existing controller was not retired: ${marker.error.code}`);
            } finally {
              wipeDecodedBytes(markerBytes);
            }
          }
          const oldHead =
            existingKeys.length === 0
              ? staged.genesis
              : decodeRecord(existingEntries.at(-1), certifiedEntrySchema, this.#maxRecordBytes)
                  .entry;
          if (entryHash(oldHead) !== expected.head.hash)
            throw new TypeError('Existing active journal head is stale');
          for (const [index, stored] of existingEntries.entries()) {
            const key = existingKeys[index];
            if (
              !Array.isArray(key) ||
              key[0] !== this.#gameId ||
              key[1] !== index + 1 ||
              !equalBytes(stored, canonicalEncode(fullEntries[index]))
            )
              throw new TypeError('Existing active journal conflicts with certified import');
          }
        }
        if (existingGenesis === undefined) {
          const genesisBytes = encodeRecord(staged.genesis, logEntrySchema, this.#maxRecordBytes);
          try {
            await games.add(genesisBytes, this.#gameId);
          } finally {
            genesisBytes.fill(0);
          }
        }
        for (const [offset, entry] of fullEntries.slice(existingKeys.length).entries()) {
          const encoded = encodeRecord(entry, certifiedEntrySchema, this.#maxRecordBytes);
          try {
            // Retain canonical entry order and wipe each staged record after its IDB request.
            // eslint-disable-next-line no-await-in-loop
            await entries.add(encoded, [this.#gameId, existingKeys.length + offset + 1]);
          } finally {
            encoded.fill(0);
          }
        }
        await consensus.put(nextConsensus, this.#gameId);
        const bindingCopy = keyBinding.bytes.slice();
        try {
          await bytes.put(bindingCopy, keyBinding.recordKey);
        } finally {
          bindingCopy.fill(0);
        }
        const marker = canonicalEncode({
          outcome: 'promoted',
          authorization: staged.authorization,
          activation: {
            seq: options.activation.entry.seq,
            hash: entryHash(options.activation.entry),
          },
        });
        try {
          await bytes.add(marker, finalKey);
        } finally {
          marker.fill(0);
        }
        await deleteAuthorizationStages(bytes, staged.gameId, staged.authorization.hash);
        await transaction.done;
        return true;
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // The transaction may already have aborted after a failed request.
        }
        await transaction.done.catch(() => undefined);
        throw error;
      } finally {
        if (storedStage instanceof Uint8Array) storedStage.fill(0);
        if (storedCheck instanceof Uint8Array) storedCheck.fill(0);
      }
    } finally {
      if (staged) wipeDecodedBytes(staged);
      await stagedStore.close();
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#closeAfterOperations();
    return this.#closePromise;
  }

  async #closeAfterOperations(): Promise<void> {
    try {
      if (this.#activeOperations > 0) {
        await new Promise<void>((resolve) => {
          this.#drainOperations = resolve;
        });
      }
      const pending = this.#databasePromise;
      this.#databasePromise = null;
      if (pending) (await pending).close();
    } finally {
      this.#keyBinding?.bytes.fill(0);
    }
  }

  #database(): Promise<IDBPDatabase<CP2PDatabase>> {
    if (this.#closed) return Promise.reject(new Error('Journal is closed'));
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

  #runOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('Journal is closed'));
    this.#activeOperations += 1;
    return (async () => {
      try {
        return await operation();
      } finally {
        this.#activeOperations -= 1;
        if (this.#activeOperations === 0) {
          this.#drainOperations?.();
          this.#drainOperations = null;
        }
      }
    })();
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

function historicalOldMaterialContext(
  genesis: LogEntry,
  entries: readonly CertifiedEntry[],
  transfer: LogContext['transfer'],
  authorization: { readonly seq: number; readonly hash: string },
  engine: TransferReplayEngine,
  policy: ReplayPolicy,
): LogContext {
  const approved = transfer?.authorizations.find(
    (item) => item.entry.seq === authorization.seq && item.entry.hash === authorization.hash,
  );
  if (!approved) throw new TypeError('Historical authorization is absent');
  let generation = approved.statement.currentController.activatedAt;
  let expectedKey = approved.statement.currentController.publicKey;
  if (approved.statement.mode === 'return') {
    const retirement = approved.statement.recovery?.activation;
    const root = transfer?.returnRoots.find(
      (item) =>
        item.departedSeat === approved.statement.seat &&
        item.activation?.seq === retirement?.seq &&
        item.activation?.hash === retirement?.hash,
    );
    if (!retirement || !root) throw new TypeError('Retired source generation is not certified');
    const beforeRecovery = replayCertifiedPrefix(
      genesis,
      entries.slice(0, root.rootAuthorization.seq - 1),
      engine,
      policy,
    );
    const human = beforeRecovery.ok
      ? beforeRecovery.value.context.log.authority?.controllers.find(
          (item) => item.seat === approved.statement.seat,
        )
      : null;
    if (!human || human.kind !== 'human' || human.publicKey !== root.lastHumanGameKey)
      throw new TypeError('Retired human source generation is not certified');
    generation = human.activatedAt;
    expectedKey = human.publicKey;
  }
  const replayed = replayCertifiedPrefix(genesis, entries.slice(0, generation.seq), engine, policy);
  const installed = replayed.ok
    ? replayed.value.context.log.authority?.controllers.find(
        (item) => item.seat === approved.statement.seat,
      )
    : null;
  if (
    !installed ||
    !replayed.ok ||
    installed.kind !== 'human' ||
    installed.publicKey !== expectedKey ||
    installed.activatedAt.seq !== generation.seq ||
    installed.activatedAt.hash !== generation.hash
  )
    throw new TypeError('Stored binding has no certified installing generation');
  return replayed.value.context.log;
}

function oldMaterialKey(
  approved: NonNullable<LogContext['transfer']>['authorizations'][number] | undefined,
  transfer: LogContext['transfer'],
): string {
  if (!approved) throw new TypeError('Certified old controller is missing');
  if (approved.statement.mode === 'live') return approved.statement.currentController.publicKey;
  const root = transfer?.returnRoots.find(
    (item) =>
      item.departedSeat === approved.statement.seat &&
      item.activation?.seq === approved.statement.recovery?.activation.seq &&
      item.activation?.hash === approved.statement.recovery?.activation.hash,
  );
  if (!root) throw new TypeError('Certified retired human key is missing');
  return root.lastHumanGameKey;
}

function isTransferActivation(value: unknown): value is {
  kind: 'transfer-activate';
  statement: {
    authorization: { seq: number; hash: string };
    parent: { seq: number; hash: string };
  };
  destinationCheck: string;
  replacementChecks: readonly { seat: number; sig: string }[];
} {
  return v.safeParse(
    v.object({
      kind: v.literal('transfer-activate'),
      statement: v.object({
        authorization: v.object({ seq: v.number(), hash: v.string() }),
        parent: v.object({ seq: v.number(), hash: v.string() }),
      }),
      destinationCheck: v.string(),
      replacementChecks: v.array(v.object({ seat: v.number(), sig: v.string() })),
    }),
    value,
  ).success;
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

function copyKeyBinding(
  value: { readonly recordKey: string; readonly bytes: Uint8Array },
  maxBytes: number,
): { readonly recordKey: string; readonly bytes: Uint8Array } {
  if (
    typeof value.recordKey !== 'string' ||
    value.recordKey.length === 0 ||
    value.recordKey.length > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value.recordKey)
  )
    throw new TypeError('Journal voting-key record key is invalid');
  if (!(value.bytes instanceof Uint8Array) || value.bytes.byteLength > maxBytes)
    throw new RangeError('Journal voting-key record must be a bounded Uint8Array');
  return { recordKey: value.recordKey, bytes: new Uint8Array(value.bytes) };
}

function matchesKeyBinding(value: unknown, expected: Uint8Array, maxBytes: number): boolean {
  if (!(value instanceof Uint8Array) || value.byteLength > maxBytes)
    throw new TypeError('Stored journal voting-key binding is malformed or oversized');
  return equalBytes(value, expected);
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

function wipeDecodedBytes(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (Array.isArray(value)) value.forEach(wipeDecodedBytes);
  else if (value && typeof value === 'object') Object.values(value).forEach(wipeDecodedBytes);
}
