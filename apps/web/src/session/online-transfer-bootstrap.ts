import { canonicalDecode, canonicalEncode, fromBase64Url, toBase64Url } from '@cp2p/codec';
import { createCatalogueEngine, failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import {
  certifiedEntrySchema,
  genesisDigest,
  genesisSchema,
  logEntrySchema,
  replayCertifiedPrefix,
  validateDeckCeremony,
} from '@cp2p/protocol';
import type { CertifiedEntry, ReplayedPrefix } from '@cp2p/protocol';
import * as v from 'valibot';
import { boundedCanonicalJsonStructure } from './bounded-canonical-json.js';
import {
  validateOnlineGameStartRecord,
  type SavedOnlineGameRecord,
} from './online-game-records.js';

const BOOTSTRAP_PROTOCOL = 'online-transfer-bootstrap-v1';
const START_PROTOCOL = 'online-browser-game-v1';
const MAX_BOOTSTRAP_BYTES = 16 * 1024 * 1024;
const MAX_CERTIFIED_ENTRIES = 8192;
const MAX_PREFLIGHT_NODES = 200_000;
const MAX_PREFLIGHT_DEPTH = 64;
const GAME_ID = /^[A-Za-z0-9_-]{22}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;

const transcriptSchema = v.strictObject({
  deckId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  passes: v.pipe(v.array(v.unknown()), v.maxLength(12)),
});
const onlineResultSchema = v.strictObject({
  entry: logEntrySchema,
  genesis: genesisSchema,
  transcripts: v.pipe(v.array(transcriptSchema), v.maxLength(32)),
  bindings: v.unknown(),
});
const recordStartSchema = v.strictObject({
  gameId: v.pipe(v.string(), v.regex(GAME_ID)),
  genesisDigest: v.pipe(v.string(), v.regex(DIGEST)),
  invite: v.unknown(),
  agreement: v.unknown(),
  result: onlineResultSchema,
});
const encodeInputSchema = v.strictObject({
  start: recordStartSchema,
  entries: v.pipe(v.array(certifiedEntrySchema), v.maxLength(MAX_CERTIFIED_ENTRIES)),
});
const startArtifactSchema = v.strictObject({
  protocol: v.literal(START_PROTOCOL),
  invite: v.unknown(),
  agreement: v.unknown(),
  result: onlineResultSchema,
});
const bootstrapSchema = v.strictObject({
  protocol: v.literal(BOOTSTRAP_PROTOCOL),
  start: startArtifactSchema,
  entries: v.pipe(v.array(certifiedEntrySchema), v.maxLength(MAX_CERTIFIED_ENTRIES)),
});

export interface OnlineTransferBootstrapInput {
  readonly start: SavedOnlineGameRecord;
  readonly entries: readonly CertifiedEntry[];
}

export interface VerifiedOnlineTransferBootstrap {
  readonly record: SavedOnlineGameRecord;
  readonly entries: readonly CertifiedEntry[];
  readonly replay: ReplayedPrefix;
}

export interface ExpectedOnlineTransferGame {
  readonly gameId: string;
  readonly genesisDigest: string;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function withinCanonicalBounds(value: unknown): boolean {
  let nodes = 0;
  let approximateBytes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_PREFLIGHT_NODES || depth > MAX_PREFLIGHT_DEPTH) return false;
    if (item === null || typeof item === 'boolean') {
      approximateBytes += 8;
      return true;
    }
    if (typeof item === 'number') {
      approximateBytes += 16;
      return Number.isFinite(item);
    }
    if (typeof item === 'string') {
      approximateBytes += item.length * 3 + 8;
      return approximateBytes <= MAX_BOOTSTRAP_BYTES;
    }
    if (item instanceof Uint8Array) {
      approximateBytes += item.byteLength + 8;
      return approximateBytes <= MAX_BOOTSTRAP_BYTES;
    }
    if (typeof item !== 'object' || item === null || ancestors.has(item)) return false;
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (item.length > MAX_CERTIFIED_ENTRIES + 64) return false;
        if (Reflect.ownKeys(item).length !== item.length + 1) return false;
        approximateBytes += item.length * 4 + 8;
        for (let index = 0; index < item.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
          if (!visit(descriptor.value, depth + 1)) return false;
        }
        return approximateBytes <= MAX_BOOTSTRAP_BYTES;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) return false;
      const keys = Reflect.ownKeys(item);
      if (keys.some((key) => typeof key !== 'string') || keys.length > 256) return false;
      approximateBytes += keys.length * 8;
      for (const rawKey of keys) {
        if (typeof rawKey !== 'string') return false;
        const key = rawKey;
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
        approximateBytes += key.length * 3 + 8;
        if (approximateBytes > MAX_BOOTSTRAP_BYTES || !visit(descriptor.value, depth + 1))
          return false;
      }
      return true;
    } catch {
      return false;
    } finally {
      ancestors.delete(item);
    }
  };
  return visit(value, 0);
}

function wipeByteArrays(value: unknown, seen = new Set<object>()): void {
  if (value instanceof Uint8Array) {
    value.fill(0);
    return;
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) wipeByteArrays(Reflect.get(value, key), seen);
}

function validExpectedGame(expected: ExpectedOnlineTransferGame): boolean {
  if (!GAME_ID.test(expected.gameId) || !DIGEST.test(expected.genesisDigest)) return false;
  try {
    const digest = fromBase64Url(expected.genesisDigest);
    const valid = digest.length === 32 && toBase64Url(digest) === expected.genesisDigest;
    digest.fill(0);
    return valid;
  } catch {
    return false;
  }
}

/** Encodes only the immutable public start and certified history; extra fields are rejected. */
export function encodeOnlineTransferBootstrap(
  input: OnlineTransferBootstrapInput,
): Result<Uint8Array> {
  if (!withinCanonicalBounds(input))
    return failure('transfer-bootstrap-size', 'Transfer bootstrap input exceeds its bounds');
  const parsed = v.safeParse(encodeInputSchema, input);
  if (!parsed.success)
    return failure('transfer-bootstrap-schema', 'Transfer bootstrap input is malformed');
  if (
    !validExpectedGame({
      gameId: parsed.output.start.gameId,
      genesisDigest: parsed.output.start.genesisDigest,
    })
  )
    return failure('transfer-bootstrap-binding', 'Start game identifier or digest is malformed');
  const suppliedStart = {
    protocol: START_PROTOCOL,
    invite: parsed.output.start.invite,
    agreement: parsed.output.start.agreement,
    result: parsed.output.start.result,
  };
  const validatedStart = validateOnlineGameStartRecord(suppliedStart, parsed.output.start.gameId);
  if (!validatedStart.ok) return validatedStart;
  if (validatedStart.value.genesisDigest !== parsed.output.start.genesisDigest)
    return failure('transfer-bootstrap-binding', 'Start digest differs from its signed genesis');
  const start = {
    protocol: START_PROTOCOL,
    invite: validatedStart.value.invite,
    agreement: validatedStart.value.agreement,
    result: validatedStart.value.result,
  };
  try {
    const startBytes = canonicalEncode(start);
    let estimate = startBytes.length + parsed.output.entries.length * 16 + 64;
    startBytes.fill(0);
    for (const entry of parsed.output.entries) {
      const entryBytes = canonicalEncode(entry);
      estimate += entryBytes.length + 1;
      entryBytes.fill(0);
      if (estimate > MAX_BOOTSTRAP_BYTES)
        return failure('transfer-bootstrap-size', 'Transfer bootstrap exceeds its size limit');
    }
    const bytes = canonicalEncode({
      protocol: BOOTSTRAP_PROTOCOL,
      start,
      entries: parsed.output.entries,
    });
    if (bytes.length > MAX_BOOTSTRAP_BYTES) {
      bytes.fill(0);
      return failure('transfer-bootstrap-size', 'Transfer bootstrap exceeds its size limit');
    }
    return success(bytes);
  } catch {
    return failure('transfer-bootstrap-invalid', 'Transfer bootstrap input cannot be encoded');
  }
}

/** Validates public transfer bootstrap evidence without installing journal or voting state. */
export function validateOnlineTransferBootstrap(
  bytes: Uint8Array,
  expected: ExpectedOnlineTransferGame,
): Result<VerifiedOnlineTransferBootstrap> {
  if (!validExpectedGame(expected))
    return failure('transfer-bootstrap-expected', 'Expected game binding is malformed');
  if (!(bytes instanceof Uint8Array) || bytes.length > MAX_BOOTSTRAP_BYTES)
    return failure('transfer-bootstrap-size', 'Transfer bootstrap is oversized or malformed');
  if (!boundedCanonicalJsonStructure(bytes, 600_000))
    return failure('transfer-bootstrap-size', 'Transfer bootstrap structure exceeds its bounds');

  let decoded: unknown;
  let canonical: Uint8Array | undefined;
  let retained = false;
  try {
    decoded = canonicalDecode(bytes);
    if (!withinCanonicalBounds(decoded))
      return failure('transfer-bootstrap-size', 'Transfer bootstrap structure exceeds its bounds');
    const parsed = v.safeParse(bootstrapSchema, decoded);
    if (!parsed.success)
      return failure('transfer-bootstrap-schema', 'Transfer bootstrap is malformed');
    canonical = canonicalEncode(parsed.output);
    if (!sameBytes(canonical, bytes))
      return failure('transfer-bootstrap-canonical', 'Transfer bootstrap is not canonical');

    const genesisEntry = parsed.output.start.result.entry;
    if (
      genesisEntry.payload.kind !== 'genesis' ||
      genesisEntry.payload.genesis.gameId !== expected.gameId ||
      genesisDigest(genesisEntry.payload.genesis) !== expected.genesisDigest
    )
      return failure('transfer-bootstrap-binding', 'Bootstrap belongs to another game genesis');
    const startEnvelope = parsed.output.start;
    const validatedStart = validateOnlineGameStartRecord(startEnvelope, expected.gameId);
    if (!validatedStart.ok) return validatedStart;
    if (validatedStart.value.genesisDigest !== expected.genesisDigest)
      return failure('transfer-bootstrap-binding', 'Bootstrap belongs to another game genesis');

    const engine = createCatalogueEngine();
    const policy = {
      genesis: {
        verifyCommitments(genesis: Parameters<typeof validateDeckCeremony>[0]) {
          const checked = validateDeckCeremony(genesis, validatedStart.value.result.transcripts);
          return checked.ok ? success(undefined) : checked;
        },
      },
      entry: {},
    };
    const replay = replayCertifiedPrefix(
      validatedStart.value.result.entry,
      parsed.output.entries,
      engine,
      policy,
    );
    if (!replay.ok) return replay;
    retained = true;
    return success({
      record: validatedStart.value,
      entries: parsed.output.entries,
      replay: replay.value,
    });
  } catch {
    return failure('transfer-bootstrap-invalid', 'Transfer bootstrap could not be validated');
  } finally {
    canonical?.fill(0);
    if (!retained) wipeByteArrays(decoded);
  }
}
