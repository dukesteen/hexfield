import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { genesisDigest, genesisSchema, logEntrySchema } from '@cp2p/protocol';
import * as v from 'valibot';
import type { IDBPTransaction } from 'idb';
import { IndexedDbByteStore } from './indexed-db-byte-store.js';
import type { CP2PDatabase } from './database.js';
import {
  BYTE_STORE,
  CONSENSUS_STORE,
  DELETED_GAME_STORE,
  ENTRY_STORE,
  GAME_STORE,
  openDatabase,
  strictWriteTransaction,
} from './database.js';
import { acquireActiveGameWriterLease } from './game-writer.js';
import type { GameWriterLockManager } from './game-writer.js';

const GAME_ID = /^[A-Za-z0-9_-]{22}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const TOMBSTONE_PROTOCOL = 'online-game-deletion-v1';
const CATALOGUE_KEY = 'online-games/catalogue-v1';
const TOMBSTONE_KEY_PREFIX = 'online-game-deleted/';
const tombstoneSchema = v.strictObject({
  protocol: v.literal(TOMBSTONE_PROTOCOL),
  gameId: v.pipe(v.string(), v.regex(GAME_ID)),
  genesisDigest: v.pipe(v.string(), v.regex(DIGEST)),
  deletedAt: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER)),
});
const startSchema = v.strictObject({
  protocol: v.literal('online-browser-game-v1'),
  invite: v.strictObject({
    roomId: v.string(),
    hostPeer: v.string(),
    serverUrl: v.string(),
  }),
  agreement: v.unknown(),
  result: v.strictObject({
    entry: logEntrySchema,
    genesis: genesisSchema,
    transcripts: v.unknown(),
    bindings: v.unknown(),
  }),
});
const catalogueSchema = v.strictObject({
  protocol: v.literal('online-games-catalogue-v1'),
  gameIds: v.pipe(v.array(v.pipe(v.string(), v.regex(GAME_ID))), v.maxLength(128)),
});
type DeletionTransaction = IDBPTransaction<
  CP2PDatabase,
  readonly ['deletedGames', 'games', 'entries', 'consensus', 'bytes'],
  'readwrite'
>;
type CP2PStoreName = 'bytes' | 'games' | 'entries' | 'consensus' | 'deletedGames';

export interface OnlineGameTombstone {
  readonly protocol: typeof TOMBSTONE_PROTOCOL;
  readonly gameId: string;
  readonly genesisDigest: string;
  readonly deletedAt: number;
}

export function onlineGameTombstoneKey(gameId: string): string {
  validateGameId(gameId);
  return `${TOMBSTONE_KEY_PREFIX}${gameId}`;
}

export function decodeOnlineGameTombstone(bytes: Uint8Array, gameId: string): OnlineGameTombstone {
  validateGameId(gameId);
  return parseTombstone(bytes, gameId);
}

export interface DeleteOnlineGameDataOptions {
  /** Test seam. Production uses the same-origin Web Locks manager. */
  readonly lockManager?: GameWriterLockManager;
  readonly now?: () => number;
}

export type DeleteOnlineGameDataResult = 'deleted' | 'already-deleted' | 'busy';

/**
 * Read the permanent local non-revival marker. The marker contains no keys and
 * is intentionally retained after game data is removed.
 */
export async function readOnlineGameTombstone(gameId: string): Promise<OnlineGameTombstone | null> {
  validateGameId(gameId);
  const database = await openDatabase(
    () => undefined,
    () => undefined,
  );
  try {
    const bytes = await database.get(DELETED_GAME_STORE, gameId);
    if (!bytes) return null;
    return parseTombstone(bytes, gameId);
  } finally {
    database.close();
  }
}

/** Check deletion in the caller's journal transaction to close check/write races. */
export async function assertOnlineGameNotDeleted<
  Stores extends readonly CP2PStoreName[],
  Mode extends 'readonly' | 'readwrite',
>(transaction: IDBPTransaction<CP2PDatabase, Stores, Mode>, gameId: string): Promise<void> {
  const bytes = await transaction.objectStore(DELETED_GAME_STORE).get(gameId);
  if (bytes === undefined) return;
  try {
    parseTombstone(bytes, gameId);
  } finally {
    bytes.fill(0);
  }
  throw new Error('Online game was deleted locally');
}

/**
 * Locally forget one game while retaining an irreversible gameId tombstone.
 * The full start record should be cryptographically validated by the app before
 * calling this storage transaction.
 */
export async function deleteOnlineGameData(
  gameId: string,
  expectedGenesisDigest: string,
  options: DeleteOnlineGameDataOptions = {},
): Promise<DeleteOnlineGameDataResult> {
  validateGameId(gameId);
  if (!DIGEST.test(expectedGenesisDigest)) throw new TypeError('Invalid online game digest');
  const lease = await acquireActiveGameWriterLease(
    gameId,
    options.lockManager ? { lockManager: options.lockManager } : {},
  );
  if (!lease) return 'busy';

  const lockManager = options.lockManager;
  const byteStore = lockManager
    ? new IndexedDbByteStore({
        lockProvider: <T>(name: string, task: () => Promise<T>) =>
          lockManager
            .request<Promise<T>>(name, { mode: 'exclusive' }, () => task())
            .then((result) => result),
      })
    : new IndexedDbByteStore();
  try {
    return await byteStore.withCeremonyLock('online-games/catalogue-lock-v1', () =>
      lease.run(() =>
        deleteTransaction(gameId, expectedGenesisDigest, options.now?.() ?? Date.now()),
      ),
    );
  } finally {
    try {
      await lease.close();
    } finally {
      await byteStore.close();
    }
  }
}

async function deleteTransaction(
  gameId: string,
  expectedGenesisDigest: string,
  deletedAt: number,
): Promise<DeleteOnlineGameDataResult> {
  if (!Number.isSafeInteger(deletedAt) || deletedAt < 0)
    throw new RangeError('Deletion time is invalid');
  const database = await openDatabase(
    () => undefined,
    () => undefined,
  );
  const transaction = strictWriteTransaction(database, [
    DELETED_GAME_STORE,
    GAME_STORE,
    ENTRY_STORE,
    CONSENSUS_STORE,
    BYTE_STORE,
  ]);
  let markerBytes: Uint8Array | undefined;
  let startBytes: Uint8Array | undefined;
  let pointerBytes: Uint8Array | undefined;
  let genesisBytes: Uint8Array | undefined;
  let catalogueBytes: Uint8Array | undefined;
  try {
    const deletedStore = transaction.objectStore(DELETED_GAME_STORE);
    const bytes = transaction.objectStore(BYTE_STORE);
    markerBytes = await deletedStore.get(gameId);
    if (markerBytes) {
      const marker = parseTombstone(markerBytes, gameId);
      if (marker.genesisDigest !== expectedGenesisDigest)
        throw new TypeError('Deleted gameId is permanently bound to another genesis');
      const byteMarker = await bytes.get(onlineGameTombstoneKey(gameId));
      if (byteMarker === undefined)
        await bytes.add(markerBytes.slice(), onlineGameTombstoneKey(gameId));
      else {
        const parsedByteMarker = parseTombstone(byteMarker, gameId);
        byteMarker.fill(0);
        if (parsedByteMarker.genesisDigest !== expectedGenesisDigest)
          throw new Error('Deletion markers disagree; refusing to modify game data');
      }
      await transaction.done;
      return 'already-deleted';
    }

    const gameStore = transaction.objectStore(GAME_STORE);
    startBytes = await bytes.get(`online-game/${expectedGenesisDigest}/start`);
    pointerBytes = await bytes.get(`online-game/${gameId}/start-digest`);
    genesisBytes = await gameStore.get(gameId);
    const identifiers = verifyStoredGameIdentity(
      gameId,
      expectedGenesisDigest,
      startBytes,
      pointerBytes,
      genesisBytes,
    );
    catalogueBytes = await bytes.get(CATALOGUE_KEY);
    const marker = canonicalEncode({
      protocol: TOMBSTONE_PROTOCOL,
      gameId,
      genesisDigest: expectedGenesisDigest,
      deletedAt,
    } satisfies OnlineGameTombstone);
    const byteTombstoneKey = onlineGameTombstoneKey(gameId);
    const existingByteMarker = await bytes.get(byteTombstoneKey);
    if (existingByteMarker !== undefined) {
      const existing = parseTombstone(existingByteMarker, gameId);
      existingByteMarker.fill(0);
      if (existing.genesisDigest !== expectedGenesisDigest)
        throw new TypeError('Deleted gameId is permanently bound to another genesis');
      throw new Error('Deletion markers disagree; refusing to modify game data');
    }
    await deletedStore.add(marker, gameId);
    await bytes.add(marker.slice(), byteTombstoneKey);

    if (catalogueBytes) {
      const catalogue = v.parse(catalogueSchema, canonicalDecode(catalogueBytes));
      if (new Set(catalogue.gameIds).size !== catalogue.gameIds.length)
        throw new TypeError('Saved game catalogue contains duplicate identifiers');
      const gameIds = catalogue.gameIds.filter((id) => id !== gameId);
      if (gameIds.length !== catalogue.gameIds.length)
        await bytes.put(canonicalEncode({ protocol: catalogue.protocol, gameIds }), CATALOGUE_KEY);
    }

    await deleteJournalRecords(transaction, gameId);
    await deleteKnownByteRecords(transaction, gameId, expectedGenesisDigest, identifiers);
    await transaction.done;
    return 'deleted';
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // Preserve the original failure if the transaction already completed or aborted.
    }
    await transaction.done.catch(() => undefined);
    throw error;
  } finally {
    markerBytes?.fill(0);
    startBytes?.fill(0);
    pointerBytes?.fill(0);
    genesisBytes?.fill(0);
    catalogueBytes?.fill(0);
    database.close();
  }
}

function verifyStoredGameIdentity(
  gameId: string,
  expectedDigest: string,
  startBytes: Uint8Array | undefined,
  pointerBytes: Uint8Array | undefined,
  journalGenesisBytes: Uint8Array | undefined,
): { readonly prefixes: readonly string[] } {
  const digests: string[] = [];
  let ceremonyNonce: string | null = null;

  if (startBytes) {
    const start = v.parse(startSchema, canonicalDecode(startBytes));
    const genesis = start.result.genesis;
    if (
      start.result.entry.payload.kind !== 'genesis' ||
      start.result.entry.payload.genesis.gameId !== gameId ||
      genesis.gameId !== gameId
    )
      throw new TypeError('Saved start record differs from the requested game');
    const digest = genesisDigest(genesis);
    if (digest !== expectedDigest) throw new TypeError('Saved start record has another digest');
    digests.push(digest);
    if (typeof genesis.ceremonyNonce === 'string') ceremonyNonce = genesis.ceremonyNonce;
  }

  if (pointerBytes) {
    const pointer = v.parse(
      v.strictObject({
        protocol: v.literal('online-game-pointer-v1'),
        gameId: v.pipe(v.string(), v.regex(GAME_ID)),
        digest: v.pipe(v.string(), v.regex(DIGEST)),
        invite: v.strictObject({ roomId: v.string(), hostPeer: v.string(), serverUrl: v.string() }),
        genesis: genesisSchema,
      }),
      canonicalDecode(pointerBytes),
    );
    if (pointer.gameId !== gameId || pointer.digest !== expectedDigest)
      throw new TypeError('Saved game pointer differs from the requested game');
    if (pointer.genesis.gameId !== gameId || genesisDigest(pointer.genesis) !== expectedDigest)
      throw new TypeError('Saved game pointer has another genesis');
    digests.push(pointer.digest);
    if (!ceremonyNonce && typeof pointer.genesis.ceremonyNonce === 'string')
      ceremonyNonce = pointer.genesis.ceremonyNonce;
  }

  if (journalGenesisBytes) {
    const genesisEntry = v.parse(logEntrySchema, canonicalDecode(journalGenesisBytes));
    if (
      genesisEntry.seq !== 0 ||
      genesisEntry.payload.kind !== 'genesis' ||
      genesisEntry.payload.genesis.gameId !== gameId
    )
      throw new TypeError('Stored journal genesis differs from the requested game');
    const digest = genesisDigest(genesisEntry.payload.genesis);
    if (digest !== expectedDigest) throw new TypeError('Stored journal genesis has another digest');
    digests.push(digest);
    if (!ceremonyNonce && typeof genesisEntry.payload.genesis.ceremonyNonce === 'string')
      ceremonyNonce = genesisEntry.payload.genesis.ceremonyNonce;
  }

  if (digests.length === 0 && !pointerBytes)
    throw new Error('Online game data is missing; refusing to create a deletion marker');
  if (digests.some((digest) => digest !== expectedDigest))
    throw new TypeError('Online game records disagree about their genesis');

  const prefixes = [
    `online-game/${gameId}/`,
    `online-game/${expectedDigest}/`,
    `recovery-private/${expectedDigest}/`,
    `recovery-readiness/${expectedDigest}/`,
    `recovery-check/${gameId}/`,
    `transfer-import/${gameId}/`,
    `transfer-import-final/${gameId}/`,
    `transfer-private/import/${expectedDigest}/`,
    `online-transfer-credentials/v1/${expectedDigest}/`,
  ];
  if (ceremonyNonce) prefixes.push(`online-credentials/ceremony/${ceremonyNonce}/`);
  // Ceremony reservations and signed consent are permanent anti-equivocation records.
  return { prefixes };
}

async function deleteJournalRecords(
  transaction: DeletionTransaction,
  gameId: string,
): Promise<void> {
  await transaction.objectStore(GAME_STORE).delete(gameId);
  await transaction.objectStore(CONSENSUS_STORE).delete(gameId);
  const range = IDBKeyRange.bound([gameId, 0], [gameId, Number.MAX_SAFE_INTEGER]);
  let cursor = await transaction.objectStore(ENTRY_STORE).openCursor(range);
  while (cursor) {
    // Cursor deletion and advancement share the tombstone transaction.
    // oxlint-disable-next-line eslint/no-await-in-loop -- IndexedDB cursor methods are sequential.
    await cursor.delete();
    // oxlint-disable-next-line eslint/no-await-in-loop -- Continue is valid only after deletion settles.
    cursor = await cursor.continue();
  }
}

async function deleteKnownByteRecords(
  transaction: DeletionTransaction,
  gameId: string,
  digest: string,
  identifiers: { readonly prefixes: readonly string[] },
): Promise<void> {
  const store = transaction.objectStore(BYTE_STORE);
  const exactKeys = new Set([
    `online-game/${gameId}/start-digest`,
    `online-game/${gameId}/outcome`,
    `online-game/${digest}/start`,
    `online-game/${digest}/keys`,
    `online-game/${digest}/cheat-candidates`,
  ]);
  let cursor = await store.openCursor();
  while (cursor) {
    const key = cursor.key;
    const matches =
      typeof key === 'string' &&
      (exactKeys.has(key) || identifiers.prefixes.some((prefix) => key.startsWith(prefix)));
    if (matches) {
      if (cursor.value instanceof Uint8Array) cursor.value.fill(0);
      // oxlint-disable-next-line eslint/no-await-in-loop -- IndexedDB cursor methods are sequential.
      await cursor.delete();
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Continue is valid only after deletion settles.
    cursor = await cursor.continue();
  }
}

function parseTombstone(bytes: Uint8Array, gameId: string): OnlineGameTombstone {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1024)
    throw new TypeError('Stored online game tombstone exceeds its record limit');
  const decoded: unknown = canonicalDecode(bytes);
  const parsed = v.parse(tombstoneSchema, decoded);
  if (!equalBytes(canonicalEncode(parsed), bytes) || parsed.gameId !== gameId)
    throw new TypeError('Stored online game tombstone is malformed');
  return parsed;
}

function validateGameId(gameId: string): void {
  if (!GAME_ID.test(gameId)) throw new TypeError('Invalid online game identifier');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
