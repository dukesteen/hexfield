import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { createBaseEngine } from '@cp2p/engine';
import {
  genesisDigest,
  genesisSchema,
  logEntrySchema,
  PROTOCOL_VERSION,
  validateDeckCeremony,
  validateGenesisEntry,
  validateGenesisOnlineStart,
  verifyGameSeatBindings,
  verifyLobbyFreezeAgreement,
} from '@cp2p/protocol';
import type {
  EscrowCeremonyStore,
  Genesis,
  LobbyFreezeAgreement,
  OnlineCeremonyResult,
} from '@cp2p/protocol';
import * as v from 'valibot';
import { validateOnlineInvite } from './online-invite.js';
import type { OnlineInvite } from './online-invite.js';

const PROTOCOL = 'online-browser-game-v1';
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const MAX_GAMES = 128;
const GAME_ID = /^[A-Za-z0-9_-]{22}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const PEER_ID = /^[A-Za-z0-9_-]{43}$/;
const catalogueKey = 'online-games/catalogue-v1';
const inviteSchema = v.strictObject({
  roomId: v.pipe(v.string(), v.minLength(10), v.maxLength(10), v.regex(/^[a-z2-7]{10}$/)),
  hostPeer: v.pipe(v.string(), v.regex(PEER_ID)),
  serverUrl: v.pipe(v.string(), v.maxLength(2048)),
});
const recordSchema = v.strictObject({
  protocol: v.literal(PROTOCOL),
  invite: v.unknown(),
  agreement: v.unknown(),
  result: v.strictObject({
    entry: logEntrySchema,
    genesis: v.unknown(),
    transcripts: v.unknown(),
    bindings: v.unknown(),
  }),
});
const pointerSchema = v.strictObject({
  protocol: v.literal('online-game-pointer-v1'),
  gameId: v.pipe(v.string(), v.regex(GAME_ID)),
  digest: v.pipe(v.string(), v.regex(DIGEST)),
  invite: inviteSchema,
  genesis: v.custom<Genesis>(isGenesisSummary),
});
const catalogueSchema = v.strictObject({
  protocol: v.literal('online-games-catalogue-v1'),
  gameIds: v.pipe(v.array(v.pipe(v.string(), v.regex(GAME_ID))), v.maxLength(MAX_GAMES)),
});

export interface SavedOnlineGameRecord {
  readonly gameId: string;
  readonly genesisDigest: string;
  readonly invite: OnlineInvite;
  readonly agreement: LobbyFreezeAgreement;
  readonly result: OnlineCeremonyResult;
}

export interface OnlineGameSummary {
  readonly gameId: string;
  readonly genesisDigest: string;
  readonly invite: OnlineInvite;
  readonly genesis: Genesis;
}

export interface OnlineGameList {
  readonly games: readonly OnlineGameSummary[];
  readonly unavailableGameIds: readonly string[];
}

export interface SaveOnlineGameRecordInput {
  readonly invite: OnlineInvite;
  readonly agreement: LobbyFreezeAgreement;
  readonly result: OnlineCeremonyResult;
}

/** A saved game made by an incompatible protocol build remains untouched on this device. */
export class UnsupportedOnlineGameVersionError extends Error {
  readonly code = 'unsupported-version';

  constructor(readonly savedVersion: number) {
    super(
      `Unsupported saved game version ${savedVersion}; this build requires ${PROTOCOL_VERSION}`,
    );
    this.name = 'UnsupportedOnlineGameVersionError';
  }
}

export function assertSupportedOnlineGameVersion(genesis: unknown): void {
  if (!isObjectRecord(genesis) || typeof genesis.protocolVersion !== 'number') return;
  if (genesis.protocolVersion !== PROTOCOL_VERSION)
    throw new UnsupportedOnlineGameVersionError(genesis.protocolVersion);
}

function recordKey(digest: string): string {
  return `online-game/${digest}/start`;
}

function pointerKey(gameId: string): string {
  return `online-game/${gameId}/start-digest`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function encodeBounded(value: unknown): Uint8Array {
  const bytes = canonicalEncode(value);
  if (bytes.byteLength > MAX_RECORD_BYTES)
    throw new Error('Online game record exceeds its size limit');
  return bytes;
}

function decodeCanonical(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_RECORD_BYTES)
    throw new Error('Stored online game record exceeds its size limit');
  const value: unknown = canonicalDecode(bytes);
  if (!equalBytes(bytes, canonicalEncode(value)))
    throw new Error('Stored online game record is not canonical');
  return value;
}

function validateStoredRecord(value: unknown, expectedGameId?: string): SavedOnlineGameRecord {
  if (isObjectRecord(value) && isObjectRecord(value.result)) {
    assertSupportedOnlineGameVersion(value.result.genesis);
    if (isObjectRecord(value.result.entry) && isObjectRecord(value.result.entry.payload))
      assertSupportedOnlineGameVersion(value.result.entry.payload.genesis);
  }
  const parsed = v.parse(recordSchema, value);
  const invite = parseInvite(parsed.invite);
  const agreementResult = verifyLobbyFreezeAgreement(parsed.agreement);
  if (!agreementResult.ok) throw new Error('Stored online game freeze agreement is invalid');
  const agreement = agreementResult.value;
  if (agreement.state.lobbyId !== invite.roomId || agreement.state.hostPeer !== invite.hostPeer)
    throw new Error('Stored invitation differs from its signed lobby agreement');

  const entry = parsed.result.entry;
  if (entry.payload.kind !== 'genesis' || entry.seq !== 0 || entry.term !== 1)
    throw new Error('Stored online game does not begin with its genesis entry');
  const genesis = entry.payload.genesis;
  if (!equalBytes(canonicalEncode(parsed.result.genesis), canonicalEncode(genesis)))
    throw new Error('Stored result genesis differs from its signed genesis entry');
  const gameId = genesis.gameId;
  const digest = genesisDigest(genesis);
  if (
    !GAME_ID.test(gameId) ||
    !DIGEST.test(digest) ||
    (expectedGameId && expectedGameId !== gameId)
  )
    throw new Error('Stored online game identifier does not match its genesis');

  const checkedBindings = verifyGameSeatBindings(agreement, parsed.result.bindings);
  if (!checkedBindings.ok) throw new Error('Stored seat bindings do not verify');
  const start = validateGenesisOnlineStart(genesis);
  if (!start.ok) throw new Error('Stored genesis lacks valid seed and device-binding evidence');
  if (
    !equalBytes(canonicalEncode(start.value.bindings.agreement), canonicalEncode(agreement)) ||
    !equalBytes(
      canonicalEncode(start.value.bindings.bindings),
      canonicalEncode(checkedBindings.value.bindings),
    ) ||
    !equalBytes(canonicalEncode(checkedBindings.value.genesisSeats), canonicalEncode(genesis.seats))
  )
    throw new Error('Stored result differs from the evidence frozen into genesis');

  const transcripts = parseTranscripts(parsed.result.transcripts);
  const verifiedEntry = validateGenesisEntry(entry, createBaseEngine(), {
    verifyCommitments(candidate) {
      return validateDeckCeremony(candidate, transcripts);
    },
  });
  if (!verifiedEntry.ok) throw new Error('Stored genesis entry or deck transcripts do not verify');
  if (!equalBytes(canonicalEncode(verifiedEntry.value.genesis), canonicalEncode(genesis)))
    throw new Error('Stored genesis differs from its validated signed entry');

  const result: OnlineCeremonyResult = {
    entry,
    genesis,
    transcripts,
    bindings: checkedBindings.value.bindings,
  };
  return { gameId, genesisDigest: digest, invite, agreement, result };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGenesisSummary(value: unknown): value is Genesis {
  return v.safeParse(genesisSchema, value).success;
}

function parseInvite(value: unknown): OnlineInvite {
  return validateOnlineInvite(v.parse(inviteSchema, value));
}

function isTranscriptArray(value: unknown): value is OnlineCeremonyResult['transcripts'] {
  if (!Array.isArray(value) || value.length > 32) return false;
  return value.every(
    (transcript) =>
      isObjectRecord(transcript) &&
      typeof transcript.deckId === 'string' &&
      transcript.deckId.length > 0 &&
      transcript.deckId.length <= 64 &&
      Array.isArray(transcript.passes) &&
      transcript.passes.length <= 12 &&
      transcript.passes.every(
        (pass) =>
          isObjectRecord(pass) &&
          typeof pass.sig === 'string' &&
          isObjectRecord(pass.body) &&
          (pass.body.phase === 'shuffle' || pass.body.phase === 'lock'),
      ),
  );
}

function parseTranscripts(value: unknown): OnlineCeremonyResult['transcripts'] {
  if (!isTranscriptArray(value)) throw new Error('Stored deck transcripts are malformed');
  return value;
}

async function loadPointer(
  store: EscrowCeremonyStore,
  gameId: string,
): Promise<OnlineGameSummary | null> {
  const bytes = await store.load(pointerKey(gameId));
  if (bytes === null) return null;
  const decoded = decodeCanonical(bytes);
  if (isObjectRecord(decoded)) assertSupportedOnlineGameVersion(decoded.genesis);
  const parsed = v.parse(pointerSchema, decoded);
  if (
    parsed.gameId !== gameId ||
    parsed.genesis.gameId !== gameId ||
    genesisDigest(parsed.genesis) !== parsed.digest
  )
    throw new Error('Stored online game pointer is bound to another game or genesis');
  return {
    gameId,
    genesisDigest: parsed.digest,
    invite: validateOnlineInvite(parsed.invite),
    genesis: parsed.genesis,
  };
}

async function ensurePointer(
  store: EscrowCeremonyStore,
  record: SavedOnlineGameRecord,
): Promise<void> {
  const key = pointerKey(record.gameId);
  const bytes = encodeBounded({
    protocol: 'online-game-pointer-v1',
    gameId: record.gameId,
    digest: record.genesisDigest,
    invite: record.invite,
    genesis: record.result.genesis,
  });
  if (await store.putIfAbsent(key, bytes)) return;
  const existing = await store.load(key);
  if (!existing || !equalBytes(existing, bytes))
    throw new Error('Stored online game pointer conflicts with this genesis');
}

async function readCatalogue(
  store: EscrowCeremonyStore,
): Promise<{ bytes: Uint8Array | null; gameIds: string[] }> {
  const bytes = await store.load(catalogueKey);
  if (bytes === null) return { bytes: null, gameIds: [] };
  const parsed = v.parse(catalogueSchema, decodeCanonical(bytes));
  if (new Set(parsed.gameIds).size !== parsed.gameIds.length)
    throw new Error('Stored online games catalogue contains duplicate identifiers');
  return { bytes, gameIds: parsed.gameIds };
}

async function addToCatalogue(store: EscrowCeremonyStore, gameId: string): Promise<void> {
  const current = await readCatalogue(store);
  const recent = [...current.gameIds.filter((id) => id !== gameId), gameId].slice(-MAX_GAMES);
  if (
    recent.length === current.gameIds.length &&
    recent.every((id, index) => id === current.gameIds[index])
  )
    return;
  const replacement = encodeBounded({
    protocol: 'online-games-catalogue-v1',
    gameIds: recent,
  });
  const saved =
    current.bytes === null
      ? await store.putIfAbsent(catalogueKey, replacement)
      : await store.compareAndSwap(catalogueKey, current.bytes, replacement);
  if (!saved) throw new Error('Online games catalogue changed outside its device lock');
}

/** Saves the exact start record pinned by OnlineStartup, then indexes it for resume. */
export async function saveOnlineGameRecord(
  store: EscrowCeremonyStore,
  supplied: SaveOnlineGameRecordInput,
): Promise<SavedOnlineGameRecord> {
  const suppliedBytes = encodeBounded({
    protocol: PROTOCOL,
    invite: supplied.invite,
    agreement: supplied.agreement,
    result: supplied.result,
  });
  const checked = validateStoredRecord(
    decodeCanonical(suppliedBytes),
    supplied.result.genesis.gameId,
  );
  const digest = genesisDigest(checked.result.genesis);
  if (checked.genesisDigest !== digest)
    throw new Error('Online game digest changed during validation');
  const bytes = suppliedBytes;
  const id = recordKey(digest);
  const indexLock = 'online-games/catalogue-lock-v1';
  return store.withCeremonyLock(indexLock, async () => {
    if (!(await store.putIfAbsent(id, bytes))) {
      const existing = await store.load(id);
      if (!existing || !equalBytes(existing, bytes))
        throw new Error('Stored online start differs from the approved game');
    }
    await ensurePointer(store, checked);
    await addToCatalogue(store, checked.gameId);
    return checked;
  });
}

/** Loads a detached start record after verifying its signed genesis and ceremony evidence. */
export async function loadOnlineGameRecord(
  store: EscrowCeremonyStore,
  gameId: string,
): Promise<SavedOnlineGameRecord | null> {
  if (!GAME_ID.test(gameId)) throw new TypeError('Invalid online game identifier');
  const pointer = await loadPointer(store, gameId);
  if (pointer === null) return null;
  const bytes = await store.load(recordKey(pointer.genesisDigest));
  if (bytes === null) throw new Error('Online game pointer refers to a missing start record');
  const record = validateStoredRecord(decodeCanonical(bytes), gameId);
  if (record.genesisDigest !== pointer.genesisDigest)
    throw new Error('Online game pointer digest does not match its record');
  if (
    !equalBytes(canonicalEncode(record.invite), canonicalEncode(pointer.invite)) ||
    !equalBytes(canonicalEncode(record.result.genesis), canonicalEncode(pointer.genesis))
  )
    throw new Error('Online game pointer summary differs from its saved record');
  return record;
}

/** Lists bounded public locator summaries; game admission always uses loadOnlineGameRecord. */
export async function listOnlineGameRecords(store: EscrowCeremonyStore): Promise<OnlineGameList> {
  return store.withCeremonyLock('online-games/catalogue-lock-v1', async () => {
    const { gameIds } = await readCatalogue(store);
    const results = await Promise.all(
      gameIds.map(async (gameId) => {
        try {
          const summary = await loadPointer(store, gameId);
          return summary ? { gameId, summary } : { gameId, summary: null };
        } catch {
          return { gameId, summary: null };
        }
      }),
    );
    return {
      games: results.flatMap(({ summary }) => (summary ? [summary] : [])),
      unavailableGameIds: results.flatMap(({ gameId, summary }) => (summary ? [] : [gameId])),
    };
  });
}
