import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import {
  certifiedEntrySchema,
  entryHash,
  logEntrySchema,
  replayCertifiedPrefix,
  transferActivationStatementSchema,
  validatePendingTransferMaterial,
} from '@cp2p/protocol';
import type { CertifiedEntry, LogEntry, ReplayPolicy } from '@cp2p/protocol';
import * as v from 'valibot';
import {
  BYTE_STORE,
  DELETED_GAME_STORE,
  MAX_RECORD_BYTES,
  openDatabase,
  strictWriteTransaction,
  VAULT_STORE,
} from './database.js';
import { assertOnlineGameNotDeleted } from './online-game-deletion.js';
import { IndexedDbByteStore } from './indexed-db-byte-store.js';

const hashSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
const peerSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/));
const refSchema = v.strictObject({
  seq: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER)),
  hash: hashSchema,
});
const bytesSchema = v.custom<Uint8Array>((value) => value instanceof Uint8Array);
const stageSchema = v.strictObject({
  protocol: v.literal('seat-transfer-import-v1'),
  gameId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,128}$/)),
  authorization: refSchema,
  destinationGameKey: peerSchema,
  head: refSchema,
  bindingBytes: bytesSchema,
  sealedPackage: bytesSchema,
  privateReplayBytes: bytesSchema,
  genesis: logEntrySchema,
  entries: v.array(certifiedEntrySchema),
});
const readinessSchema = v.strictObject({
  protocol: v.literal('seat-transfer-readiness-v1'),
  statement: transferActivationStatementSchema,
  destinationCheck: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{86}$/)),
  replacementChecks: v.pipe(
    v.array(
      v.strictObject({
        seat: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)),
        sig: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{86}$/)),
      }),
    ),
    v.maxLength(6),
  ),
});
const outcomeSchema = v.variant('outcome', [
  v.strictObject({
    outcome: v.literal('cancelled'),
    authorization: refSchema,
  }),
  v.strictObject({
    outcome: v.literal('promoted'),
    authorization: refSchema,
    activation: refSchema,
  }),
]);

export type TransferImportRecord = v.InferOutput<typeof stageSchema>;
export type TransferReadinessRecord = v.InferOutput<typeof readinessSchema>;
export type TransferImportOutcome =
  | { readonly kind: 'missing' }
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'promoted';
      readonly activation: { readonly seq: number; readonly hash: string };
    };
export type TransferReplayEngine = Parameters<typeof replayCertifiedPrefix>[2];
export interface TransferImportInput {
  readonly gameId: string;
  readonly authorization: { readonly seq: number; readonly hash: string };
  readonly destinationGameKey: string;
  readonly bindingBytes: Uint8Array;
  readonly sealedPackage: Uint8Array;
  readonly privateReplayBytes: Uint8Array;
  readonly genesis: LogEntry;
  readonly entries: readonly CertifiedEntry[];
}

/** An immutable private import. Its presence never gives the destination voting authority. */
export class TransferImportStore {
  readonly #bytes: IndexedDbByteStore;

  constructor(bytes = new IndexedDbByteStore()) {
    this.#bytes = bytes;
  }

  async stage(
    value: TransferImportInput,
    engine: TransferReplayEngine,
    policy: ReplayPolicy,
  ): Promise<string> {
    assertBoundedStageInput(value, this.#bytes.maxRecordBytes);
    const entries = value.entries;
    const last = entries.at(-1)?.entry ?? value.genesis;
    const checked = v.parse(stageSchema, {
      ...value,
      protocol: 'seat-transfer-import-v1',
      head: { seq: last.seq, hash: entryHash(last) },
    });
    const bytes = canonicalEncode(checked);
    if (bytes.byteLength > this.#bytes.maxRecordBytes) {
      bytes.fill(0);
      throw new RangeError('Transfer import exceeds the durable record limit');
    }
    try {
      if (
        checked.genesis.payload.kind !== 'genesis' ||
        checked.genesis.payload.genesis.gameId !== checked.gameId
      )
        throw new TypeError('Transfer import genesis differs from its game');
      const replayed = replayCertifiedPrefix(checked.genesis, checked.entries, engine, policy);
      if (!replayed.ok) throw new TypeError(`Transfer import prefix: ${replayed.error.code}`);
      const transfer = replayed.value.context.log.transfer;
      const authorization = transfer?.authorizations.find(
        (item) =>
          item.entry.seq === checked.authorization.seq &&
          item.entry.hash === checked.authorization.hash,
      );
      if (
        transfer?.pending?.seq !== checked.authorization.seq ||
        transfer.pending.hash !== checked.authorization.hash ||
        !authorization ||
        authorization.statement.destination.gamePeer !== checked.destinationGameKey ||
        replayed.value.context.log.head.seq !== checked.head.seq ||
        entryHash(replayed.value.context.log.head) !== checked.head.hash
      )
        throw new TypeError('Transfer import is not pinned to the certified pending authorization');
      const binding = canonicalDecode(checked.bindingBytes);
      let material: ReturnType<typeof validatePendingTransferMaterial>;
      try {
        material = validatePendingTransferMaterial(
          binding,
          replayed.value.context.log,
          checked.authorization,
        );
      } finally {
        wipeByteArrays(binding);
      }
      if (!material.ok) throw new TypeError(`Transfer import material: ${material.error.code}`);
      for (const seat of material.value.seats) {
        seat.signingKey.fill(0);
        seat.master.fill(0);
      }
      const key = transferImportKey(checked);
      const access = this.#bytes.recordAccess();
      const prior = await this.#bytes.loadPinned(key);
      let stored: Uint8Array | undefined;
      try {
        if (prior && !equalBytes(prior.plain, bytes))
          throw new TypeError('Transfer import already exists with different bytes');
        stored = await access.encode(key, bytes);
        const database = await openDatabase(
          () => undefined,
          () => undefined,
        );
        try {
          const transaction = strictWriteTransaction(database, [
            BYTE_STORE,
            DELETED_GAME_STORE,
            VAULT_STORE,
          ]);
          try {
            await access.assertGeneration(transaction.objectStore(VAULT_STORE));
            await assertOnlineGameNotDeleted(transaction, checked.gameId);
            const store = transaction.objectStore(BYTE_STORE);
            const final = await store.get(transferImportFinalKey(checked));
            if (final !== undefined) {
              final.fill(0);
              throw new TypeError('Transfer authorization is already finalized locally');
            }
            const existing = await store.get(key);
            try {
              if (existing === undefined && !prior) await store.add(stored, key);
              else if (!existing || !prior || !equalBytes(existing, prior.stored))
                throw new TypeError('Transfer import already exists with different bytes');
            } finally {
              existing?.fill(0);
            }
            await transaction.done;
          } catch (error) {
            try {
              transaction.abort();
            } catch {
              // A failed commit may have already closed the transaction.
            }
            await transaction.done.catch(() => undefined);
            throw error;
          }
        } finally {
          database.close();
        }
      } finally {
        prior?.plain.fill(0);
        prior?.stored.fill(0);
        stored?.fill(0);
      }
      return key;
    } finally {
      bytes.fill(0);
    }
  }

  async load(key: string): Promise<TransferImportRecord | null> {
    const pinned = await this.loadPinned(key);
    if (!pinned) return null;
    pinned.stored.fill(0);
    return pinned.record;
  }

  /** Exact ciphertext is retained for a later stage/readiness promotion CAS. */
  async loadPinned(
    key: string,
  ): Promise<{ record: TransferImportRecord; stored: Uint8Array } | null> {
    const pinned = await this.#bytes.loadPinned(key);
    if (!pinned) return null;
    const bytes = pinned.plain;
    let decoded: unknown;
    let accepted = false;
    try {
      decoded = canonicalDecode(bytes);
      const parsed = v.parse(stageSchema, decoded);
      const canonical = canonicalEncode(parsed);
      const exact = equalBytes(canonical, bytes);
      canonical.fill(0);
      if (!exact || transferImportKey(parsed) !== key) {
        wipeByteArrays(parsed);
        throw new TypeError('Stored transfer import is noncanonical or misplaced');
      }
      accepted = true;
      return { record: parsed, stored: pinned.stored };
    } finally {
      if (!accepted) wipeByteArrays(decoded);
      if (!accepted) pinned.stored.fill(0);
      bytes.fill(0);
    }
  }

  /** Prepared only after the full import is durable; retries use the exact same bytes. */
  async saveReadiness(key: string, readiness: TransferReadinessRecord): Promise<void> {
    const pinnedStage = await this.loadPinned(key);
    if (!pinnedStage) throw new TypeError('Transfer import is absent');
    const stage = pinnedStage.record;
    try {
      const checked = v.parse(readinessSchema, readiness);
      if (
        checked.statement.authorization.seq !== stage.authorization.seq ||
        checked.statement.authorization.hash !== stage.authorization.hash ||
        checked.statement.parent.seq !== stage.head.seq ||
        checked.statement.parent.hash !== stage.head.hash ||
        checked.statement.destinationGame !== stage.destinationGameKey
      )
        throw new TypeError('Readiness does not bind the exact staged parent and destination');
      const bytes = canonicalEncode(checked);
      try {
        if (bytes.byteLength > this.#bytes.maxRecordBytes)
          throw new RangeError('Transfer readiness exceeds the durable record limit');
        const access = this.#bytes.recordAccess();
        const slot = readinessKey(key);
        const prior = await this.#bytes.loadPinned(slot);
        let stored: Uint8Array | undefined;
        try {
          if (prior && !equalBytes(prior.plain, bytes))
            throw new TypeError('A different readiness packet is already durable');
          stored = await access.encode(slot, bytes);
          const database = await openDatabase(
            () => undefined,
            () => undefined,
          );
          try {
            const transaction = strictWriteTransaction(database, [
              BYTE_STORE,
              DELETED_GAME_STORE,
              VAULT_STORE,
            ]);
            try {
              await access.assertGeneration(transaction.objectStore(VAULT_STORE));
              await assertOnlineGameNotDeleted(transaction, stage.gameId);
              const store = transaction.objectStore(BYTE_STORE);
              const final = await store.get(transferImportFinalKey(stage));
              if (final !== undefined) {
                final.fill(0);
                throw new TypeError('Transfer authorization is already finalized locally');
              }
              const storedStage = await store.get(key);
              try {
                if (!storedStage || !equalBytes(storedStage, pinnedStage.stored))
                  throw new TypeError('Transfer import changed before readiness');
              } finally {
                storedStage?.fill(0);
              }
              const previous = await store.get(slot);
              try {
                if (previous === undefined && !prior) await store.add(stored, slot);
                else if (!previous || !prior || !equalBytes(previous, prior.stored))
                  throw new TypeError('A different readiness packet is already durable');
              } finally {
                previous?.fill(0);
              }
              await transaction.done;
            } catch (error) {
              try {
                transaction.abort();
              } catch {
                // A failed commit may have already closed the transaction.
              }
              await transaction.done.catch(() => undefined);
              throw error;
            }
          } finally {
            database.close();
          }
        } finally {
          prior?.plain.fill(0);
          prior?.stored.fill(0);
          stored?.fill(0);
        }
      } finally {
        bytes.fill(0);
      }
    } finally {
      wipeByteArrays(stage);
      pinnedStage.stored.fill(0);
    }
  }

  async loadReadiness(key: string): Promise<TransferReadinessRecord | null> {
    const pinned = await this.loadReadinessPinned(key);
    if (!pinned) return null;
    pinned.stored.fill(0);
    return pinned.record;
  }

  async loadReadinessPinned(
    key: string,
  ): Promise<{ record: TransferReadinessRecord; stored: Uint8Array } | null> {
    const pinned = await this.#bytes.loadPinned(readinessKey(key));
    if (!pinned) return null;
    const bytes = pinned.plain;
    let accepted = false;
    try {
      const parsed = v.parse(readinessSchema, canonicalDecode(bytes));
      const canonical = canonicalEncode(parsed);
      try {
        if (!equalBytes(canonical, bytes))
          throw new TypeError('Stored transfer readiness is noncanonical');
        accepted = true;
        return { record: parsed, stored: pinned.stored };
      } finally {
        canonical.fill(0);
      }
    } finally {
      // The record owns only its parsed immutable strings; no private byte fields.
      bytes.fill(0);
      if (!accepted) pinned.stored.fill(0);
    }
  }

  /**
   * Read the durable outcome marker only. Callers must match it against replayed
   * certified history and the active journal before treating it as an outcome.
   */
  async readOutcome(
    gameId: string,
    authorization: { readonly seq: number; readonly hash: string },
  ): Promise<TransferImportOutcome> {
    const scope = v.parse(
      v.strictObject({
        gameId: v.pipe(v.string(), v.minLength(1), v.maxLength(128), v.regex(/^[A-Za-z0-9_-]+$/)),
        authorization: refSchema,
      }),
      { gameId, authorization },
    );
    const key = transferImportFinalKey(scope);
    const bytes = await this.#bytes.load(key);
    if (!bytes) return { kind: 'missing' };
    try {
      if (bytes.byteLength > 1024)
        throw new RangeError('Stored transfer outcome exceeds its record limit');
      const decoded: unknown = canonicalDecode(bytes);
      const parsed = v.parse(outcomeSchema, decoded);
      const canonical = canonicalEncode(parsed);
      try {
        if (!equalBytes(canonical, bytes))
          throw new TypeError('Stored transfer outcome is noncanonical');
      } finally {
        canonical.fill(0);
      }
      if (
        parsed.authorization.seq !== scope.authorization.seq ||
        parsed.authorization.hash !== scope.authorization.hash
      )
        throw new TypeError('Stored transfer outcome belongs to another authorization');
      return parsed.outcome === 'cancelled'
        ? { kind: 'cancelled' }
        : { kind: 'promoted', activation: { ...parsed.activation } };
    } finally {
      bytes.fill(0);
    }
  }

  /** A certified cancellation closes the authorization and erases every staged parent. */
  async cancelCertified(input: {
    gameId: string;
    authorization: { seq: number; hash: string };
    genesis: LogEntry;
    entries: readonly CertifiedEntry[];
    engine: TransferReplayEngine;
    policy: ReplayPolicy;
  }): Promise<void> {
    assertBoundedStageInput({ genesis: input.genesis, entries: input.entries });
    const replayed = replayCertifiedPrefix(
      input.genesis,
      input.entries,
      input.engine,
      input.policy,
    );
    if (!replayed.ok) throw new TypeError(`Transfer cancellation prefix: ${replayed.error.code}`);
    const transfer = replayed.value.context.log.transfer;
    if (
      input.genesis.payload.kind !== 'genesis' ||
      input.genesis.payload.genesis.gameId !== input.gameId ||
      !transfer?.completed.some(
        (item) =>
          item.outcome === 'cancelled' &&
          item.authorization.seq === input.authorization.seq &&
          item.authorization.hash === input.authorization.hash,
      )
    )
      throw new TypeError('Transfer authorization has no certified cancellation');
    const finalKey = transferImportFinalKey(input);
    const marker = canonicalEncode({ outcome: 'cancelled', authorization: input.authorization });
    if (marker.byteLength > this.#bytes.maxRecordBytes) {
      marker.fill(0);
      throw new RangeError('Transfer outcome exceeds the durable record limit');
    }
    await this.#bytes.recordAccess().pin();
    const database = await openDatabase(
      () => undefined,
      () => undefined,
    );
    try {
      const transaction = strictWriteTransaction(database, [
        BYTE_STORE,
        DELETED_GAME_STORE,
        VAULT_STORE,
      ]);
      try {
        await this.#bytes.recordAccess().assertGeneration(transaction.objectStore(VAULT_STORE));
        await assertOnlineGameNotDeleted(transaction, input.gameId);
        const store = transaction.objectStore(BYTE_STORE);
        const existing = await store.get(finalKey);
        try {
          if (existing === undefined) await store.add(marker, finalKey);
          else if (!equalBytes(existing, marker))
            throw new TypeError('Transfer authorization has another durable outcome');
        } finally {
          existing?.fill(0);
        }
        await deleteAuthorizationStages(store, input.gameId, input.authorization.hash);
        await transaction.done;
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // A failed commit may have already closed the transaction.
        }
        await transaction.done.catch(() => undefined);
        throw error;
      }
    } finally {
      marker.fill(0);
      database.close();
    }
  }

  close(): Promise<void> {
    return this.#bytes.close();
  }
}

export function transferImportKey(
  record: Pick<TransferImportRecord, 'gameId' | 'authorization' | 'destinationGameKey' | 'head'>,
): string {
  return `transfer-import/${record.gameId}/${record.authorization.hash}/${record.destinationGameKey}/${record.head.hash}`;
}

export function readinessKey(stageKey: string): string {
  return `${stageKey}/readiness`;
}

export function transferImportFinalKey(
  record: Pick<TransferImportRecord, 'gameId' | 'authorization'>,
): string {
  return `transfer-import-final/${record.gameId}/${record.authorization.hash}`;
}

interface TransferStageCursor {
  delete(): Promise<void>;
  continue(): Promise<TransferStageCursor | null>;
}

export async function deleteAuthorizationStages(
  store: {
    openCursor(range: IDBKeyRange): Promise<TransferStageCursor | null>;
  },
  gameId: string,
  hash: string,
): Promise<void> {
  const prefix = `transfer-import/${gameId}/${hash}/`;
  let cursor = await store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
  while (cursor) {
    // Cursor advancement must follow each deletion within the same IDB transaction.
    // eslint-disable-next-line no-await-in-loop
    await cursor.delete();
    // eslint-disable-next-line no-await-in-loop
    cursor = await cursor.continue();
  }
}

function assertBoundedStageInput(value: unknown, maxBytes = MAX_RECORD_BYTES): void {
  let budget = maxBytes;
  const visited = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 32 || --budget < 0) throw new RangeError('Transfer import is oversized');
    if (typeof item === 'string') budget -= item.length * 3;
    else if (item instanceof Uint8Array) budget -= item.byteLength;
    else if (Array.isArray(item)) {
      if (item.length > 100_000 || visited.has(item))
        throw new RangeError('Transfer import is oversized');
      visited.add(item);
      item.forEach((child) => visit(child, depth + 1));
      visited.delete(item);
    } else if (item && typeof item === 'object') {
      if (visited.has(item)) throw new RangeError('Transfer import is cyclic');
      visited.add(item);
      for (const [key, child] of Object.entries(item)) {
        budget -= key.length * 3;
        visit(child, depth + 1);
      }
      visited.delete(item);
    }
    if (budget < 0) throw new RangeError('Transfer import is oversized');
  };
  visit(value, 0);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function wipeByteArrays(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (Array.isArray(value)) value.forEach(wipeByteArrays);
  else if (value && typeof value === 'object') Object.values(value).forEach(wipeByteArrays);
}
