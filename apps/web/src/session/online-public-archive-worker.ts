import { IndexedDbByteStore } from '@cp2p/storage';
import type { GameEvent, GameState } from '@cp2p/engine';
import type { EscrowCeremonyStore } from '@cp2p/protocol';
import {
  importOnlinePublicArchive,
  listOnlinePublicArchiveSummaries,
  openOnlinePublicArchive,
  peekStoredOnlinePublicArchiveVersion,
} from './online-public-archive-store.js';
import type { PublicArchiveSummary } from './online-public-archive-store.js';
import { MAX_ONLINE_PUBLIC_ARCHIVE_BYTES } from './online-public-archive.js';
import {
  encodeOnlinePublicArchive,
  peekOnlinePublicArchiveVersion,
} from './online-public-archive.js';
import type { PublicArchiveVersion } from './online-public-archive.js';
import { loadOnlineGameRecord } from './online-game-records.js';
import { canonicalEncode } from '@cp2p/codec';
import { certifiedEntrySchema, logEntrySchema } from '@cp2p/protocol';
import * as v from 'valibot';

export type PublicArchiveWorkerRequest =
  | { readonly id: number; readonly kind: 'import'; readonly bytes: Uint8Array }
  | { readonly id: number; readonly kind: 'open'; readonly archiveId: string }
  | { readonly id: number; readonly kind: 'list' }
  | {
      readonly id: number;
      readonly kind: 'encode';
      readonly gameId: string;
      readonly history: unknown;
    };

const historySchema = v.strictObject({
  mode: v.literal('p2p'),
  genesis: logEntrySchema,
  entries: v.pipe(v.array(certifiedEntrySchema), v.maxLength(8192)),
});

export interface PublicArchiveDisplay {
  readonly id: string;
  readonly gameId: string;
  readonly head: { readonly seq: number; readonly hash: string };
  readonly state: Readonly<GameState>;
  readonly events: readonly GameEvent[];
  readonly players: readonly {
    seat: 0 | 1 | 2 | 3 | 4 | 5;
    name: string;
    color: 'blue' | 'orange' | 'green' | 'magenta' | 'yellow' | 'red';
  }[];
}

export type PublicArchiveWorkerResponse =
  | { readonly id: number; readonly kind: 'imported'; readonly archiveId: string }
  | { readonly id: number; readonly kind: 'opened'; readonly archive: PublicArchiveDisplay | null }
  | {
      readonly id: number;
      readonly kind: 'listed';
      readonly archives: readonly PublicArchiveSummary[];
    }
  | { readonly id: number; readonly kind: 'encoded'; readonly bytes: Uint8Array }
  | {
      readonly id: number;
      readonly kind: 'error';
      readonly error: string;
      /** Set when the archive declares another version: the viewer explains that instead. */
      readonly version?: PublicArchiveVersion;
    };

function validRequest(value: unknown): value is PublicArchiveWorkerRequest {
  if (typeof value !== 'object' || value === null) return false;
  const id = Reflect.get(value, 'id');
  const kind = Reflect.get(value, 'kind');
  if (!Number.isSafeInteger(id) || Number(id) < 1) return false;
  if (kind === 'import')
    return (
      Object.keys(value).length === 3 &&
      Reflect.get(value, 'bytes') instanceof Uint8Array &&
      Reflect.get(value, 'bytes').length <= MAX_ONLINE_PUBLIC_ARCHIVE_BYTES
    );
  if (kind === 'open')
    return (
      Object.keys(value).length === 3 &&
      typeof Reflect.get(value, 'archiveId') === 'string' &&
      /^[0-9a-f]{64}$/.test(Reflect.get(value, 'archiveId'))
    );
  if (kind === 'list') return Object.keys(value).length === 2;
  return (
    kind === 'encode' &&
    Object.keys(value).length === 4 &&
    typeof Reflect.get(value, 'gameId') === 'string' &&
    /^[A-Za-z0-9_-]{22}$/.test(Reflect.get(value, 'gameId'))
  );
}

function displaySeat(seat: number): seat is 0 | 1 | 2 | 3 | 4 | 5 {
  return seat === 0 || seat === 1 || seat === 2 || seat === 3 || seat === 4 || seat === 5;
}

/** One isolated, bounded replay job. It has no journal, identity, or voting key access. */
export async function runPublicArchiveWorkerRequest(
  supplied: unknown,
  store: EscrowCeremonyStore & { close(): Promise<void> } = new IndexedDbByteStore(),
): Promise<PublicArchiveWorkerResponse> {
  const rawId = typeof supplied === 'object' && supplied !== null ? Reflect.get(supplied, 'id') : 0;
  const id = Number.isSafeInteger(rawId) && Number(rawId) > 0 ? Number(rawId) : 0;
  try {
    if (!validRequest(supplied)) throw new Error('Invalid public replay request');
    if (supplied.kind === 'import') {
      const result = await importOnlinePublicArchive(store, supplied.bytes);
      if (!result.ok) throw new Error(result.error.message);
      return { id, kind: 'imported', archiveId: result.value.id };
    }
    if (supplied.kind === 'encode') {
      const history = v.safeParse(historySchema, supplied.history);
      if (!history.success) throw new Error('Certified history is invalid');
      const start = await loadOnlineGameRecord(store, supplied.gameId);
      if (
        !start ||
        !sameBytes(canonicalEncode(start.result.entry), canonicalEncode(history.output.genesis))
      )
        throw new Error('Certified history differs from its signed start');
      const encoded = encodeOnlinePublicArchive({ start, entries: history.output.entries });
      if (!encoded.ok) throw new Error(encoded.error.message);
      return { id, kind: 'encoded', bytes: encoded.value };
    }
    if (supplied.kind === 'list') {
      const listed = await listOnlinePublicArchiveSummaries(store);
      if (!listed.ok) throw new Error(listed.error.message);
      return { id, kind: 'listed', archives: listed.value };
    }
    const result = await openOnlinePublicArchive(store, supplied.archiveId);
    if (!result.ok) throw new Error(result.error.message);
    const archive = result.value;
    if (!archive) return { id, kind: 'opened', archive: null };
    const players = archive.start.agreement.state.seats.map((seat) => {
      if (seat.kind === 'open' || !displaySeat(seat.seat))
        throw new Error('Public replay has an unsupported roster');
      return { seat: seat.seat, name: seat.name, color: seat.colour };
    });
    return {
      id,
      kind: 'opened',
      archive: {
        id: archive.id,
        gameId: archive.gameId,
        head: archive.head,
        state: archive.state,
        events: archive.events,
        players,
      },
    };
  } catch {
    const version = await declaredVersion(supplied, store);
    return {
      id,
      kind: 'error',
      error: 'Public replay could not be verified or opened',
      ...(version ? { version } : {}),
    };
  } finally {
    await store.close();
  }
}

/** Only for choosing the failure message; a differing version never makes an archive open. */
async function declaredVersion(
  supplied: unknown,
  store: EscrowCeremonyStore,
): Promise<PublicArchiveVersion | null> {
  if (!validRequest(supplied)) return null;
  if (supplied.kind === 'import') return peekOnlinePublicArchiveVersion(supplied.bytes);
  if (supplied.kind === 'open')
    return peekStoredOnlinePublicArchiveVersion(store, supplied.archiveId);
  return null;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
