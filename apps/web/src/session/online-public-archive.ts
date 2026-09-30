import { canonicalDecode, canonicalEncode, sha256, toHex } from '@cp2p/codec';
import { ENGINE_VERSION, failure, success } from '@cp2p/engine';
import type { GameEvent, GameState, Input, Result } from '@cp2p/engine';
import { entryHash, PROTOCOL_VERSION } from '@cp2p/protocol';
import type { CertifiedEntry } from '@cp2p/protocol';
import * as v from 'valibot';
import type { SavedOnlineGameRecord } from './online-game-records.js';
import { MAX_ONLINE_PUBLIC_ARCHIVE_BYTES } from './online-public-archive-format.js';
export { MAX_ONLINE_PUBLIC_ARCHIVE_BYTES } from './online-public-archive-format.js';
import {
  encodeOnlineTransferBootstrap,
  validateOnlineTransferBootstrap,
} from './online-transfer-bootstrap.js';

/** A public replay is never a voting save, even when its source is the latest head. */
const FORMAT = 'online-public-archive-v1';
const MAGIC = Uint8Array.of(0x48, 0x58, 0x41, 0x52, 0x31); // HXAR1
const HEADER_LIMIT = 256;

const headerSchema = v.strictObject({
  format: v.literal(FORMAT),
  gameId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/)),
  genesisDigest: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/)),
});

export interface PublicOnlineArchiveInput {
  readonly start: SavedOnlineGameRecord;
  readonly entries: readonly CertifiedEntry[];
}

export interface VerifiedPublicOnlineArchive {
  /** SHA-256 of the exact archive file, used only in the replay namespace. */
  readonly id: string;
  readonly gameId: string;
  readonly genesisDigest: string;
  readonly head: { readonly seq: number; readonly hash: string };
  readonly start: SavedOnlineGameRecord;
  readonly entries: readonly CertifiedEntry[];
  readonly state: Readonly<GameState>;
  readonly inputs: readonly Input[];
  readonly events: readonly GameEvent[];
  /** The exact archive file, so a viewer can export what it opened. */
  readonly bytes: Uint8Array;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function archiveHeader(bytes: Uint8Array): Result<{
  gameId: string;
  genesisDigest: string;
  bootstrap: Uint8Array;
}> {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length > MAX_ONLINE_PUBLIC_ARCHIVE_BYTES ||
    bytes.length < MAGIC.length + 3 ||
    !MAGIC.every((byte, index) => bytes[index] === byte)
  )
    return failure('public-archive-format', 'Public replay archive has an invalid header or size');
  const headerLength = (Number(bytes[MAGIC.length]) << 8) | Number(bytes[MAGIC.length + 1]);
  const contentAt = MAGIC.length + 2 + headerLength;
  if (headerLength < 1 || headerLength > HEADER_LIMIT || contentAt >= bytes.length)
    return failure('public-archive-format', 'Public replay archive header is out of bounds');
  try {
    const headerBytes = bytes.subarray(MAGIC.length + 2, contentAt);
    const decoded: unknown = canonicalDecode(headerBytes);
    const checked = v.safeParse(headerSchema, decoded);
    if (!checked.success || !equalBytes(headerBytes, canonicalEncode(checked.output)))
      return failure('public-archive-header', 'Public replay archive header is not canonical');
    return success({
      gameId: checked.output.gameId,
      genesisDigest: checked.output.genesisDigest,
      bootstrap: bytes.subarray(contentAt),
    });
  } catch {
    return failure('public-archive-header', 'Public replay archive header is malformed');
  }
}

/** The versions an archive's genesis declares, when they differ from this build's. */
export interface PublicArchiveVersion {
  readonly relation: 'older' | 'newer';
  /** The differing version as shown to players, e.g. `engine 0.1.0` or `protocol 5`. */
  readonly version: string;
}

const declaredVersionSchema = v.object({
  start: v.object({
    result: v.object({
      genesis: v.object({
        protocolVersion: v.pipe(v.number(), v.integer(), v.minValue(0)),
        engineVersion: v.pipe(v.string(), v.maxLength(32)),
      }),
    }),
  }),
});

function versionParts(value: string): number[] {
  return value.split(/[.-]/).map((part) => Number.parseInt(part, 10));
}

function compareEngineVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (Number.isNaN(difference)) return left < right ? -1 : 1;
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Reads, without verifying anything, the versions an archive claims. It only chooses which
 * message explains a failed verification ("created with an older version"); it never lets an
 * archive open. Returns null when the archive is unreadable or declares this build's versions.
 */
export function peekOnlinePublicArchiveVersion(bytes: Uint8Array): PublicArchiveVersion | null {
  const header = archiveHeader(bytes);
  if (!header.ok) return null;
  try {
    const declared = v.safeParse(declaredVersionSchema, canonicalDecode(header.value.bootstrap));
    if (!declared.success) return null;
    const { protocolVersion, engineVersion } = declared.output.start.result.genesis;
    if (protocolVersion !== PROTOCOL_VERSION)
      return {
        relation: protocolVersion < PROTOCOL_VERSION ? 'older' : 'newer',
        version: `protocol ${protocolVersion}`,
      };
    if (engineVersion !== ENGINE_VERSION)
      return {
        relation: compareEngineVersions(engineVersion, ENGINE_VERSION) < 0 ? 'older' : 'newer',
        version: `engine ${engineVersion}`,
      };
    return null;
  } catch {
    return null;
  }
}

/** Parses and fully replays signed public evidence without consulting local keys or a journal. */
export function validateOnlinePublicArchive(
  bytes: Uint8Array,
): Result<VerifiedPublicOnlineArchive> {
  const header = archiveHeader(bytes);
  if (!header.ok) return header;
  const checked = validateOnlineTransferBootstrap(header.value.bootstrap, {
    gameId: header.value.gameId,
    genesisDigest: header.value.genesisDigest,
  });
  if (!checked.ok) return checked;
  const { record, replay } = checked.value;
  return success({
    id: toHex(sha256(bytes)),
    gameId: record.gameId,
    genesisDigest: record.genesisDigest,
    head: { seq: replay.context.log.head.seq, hash: entryHash(replay.context.log.head) },
    start: record,
    entries: replay.entries,
    state: replay.context.log.state,
    inputs: replay.inputs,
    events: replay.events,
    bytes,
  });
}

/** Exports only the signed start, deck transcripts, and certified public prefix. */
export function encodeOnlinePublicArchive(input: PublicOnlineArchiveInput): Result<Uint8Array> {
  try {
    // The signaling origin is local resume metadata, not signed replay evidence.
    const publicStart = {
      ...input.start,
      invite: { ...input.start.invite, serverUrl: '' },
    };
    const bootstrap = encodeOnlineTransferBootstrap({ start: publicStart, entries: input.entries });
    if (!bootstrap.ok) return bootstrap;
    const checkedHeader = v.safeParse(headerSchema, {
      format: FORMAT,
      gameId: input.start.gameId,
      genesisDigest: input.start.genesisDigest,
    });
    if (!checkedHeader.success)
      return failure('public-archive-header', 'Public replay archive has an invalid game binding');
    const header = canonicalEncode(checkedHeader.output);
    const length = MAGIC.length + 2 + header.length + bootstrap.value.length;
    if (header.length > HEADER_LIMIT || length > MAX_ONLINE_PUBLIC_ARCHIVE_BYTES)
      return failure('public-archive-size', 'Public replay archive exceeds its size limit');
    const bytes = new Uint8Array(length);
    bytes.set(MAGIC);
    bytes[MAGIC.length] = header.length >>> 8;
    bytes[MAGIC.length + 1] = header.length & 0xff;
    bytes.set(header, MAGIC.length + 2);
    bytes.set(bootstrap.value, MAGIC.length + 2 + header.length);
    const verified = validateOnlinePublicArchive(bytes);
    return verified.ok ? success(bytes) : verified;
  } catch {
    return failure('public-archive-encode', 'Public replay archive could not be encoded');
  }
}
