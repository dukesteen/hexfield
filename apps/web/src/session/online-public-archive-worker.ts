import { IndexedDbByteStore } from '@cp2p/storage';
import { createCatalogueEngine } from '@cp2p/engine';
import type { GameConfig, GameEvent, GameState, Input, PrivateInputData, Seat } from '@cp2p/engine';
import { auditCertifiedGame } from '@cp2p/protocol';
import type { EscrowCeremonyStore } from '@cp2p/protocol';
import {
  importOnlinePublicArchive,
  listOnlinePublicArchiveSummaries,
  loadOnlineArchiveMasters,
  openOnlinePublicArchive,
  peekStoredOnlinePublicArchiveVersion,
  saveOnlineArchiveMasters,
} from './online-public-archive-store.js';
import type { ArchiveMasters, PublicArchiveSummary } from './online-public-archive-store.js';
import type { VerifiedPublicOnlineArchive } from './online-public-archive.js';
import { baseAuditPolicy } from './audit-worker-job.js';
import { MAX_ONLINE_PUBLIC_ARCHIVE_BYTES } from './online-public-archive.js';
import {
  encodeOnlinePublicArchive,
  peekOnlinePublicArchiveVersion,
} from './online-public-archive.js';
import type { PublicArchiveVersion } from './online-public-archive.js';
import { loadOnlineGameRecord } from './online-game-records.js';
import { canonicalEncode, fromBase64Url, toBase64Url } from '@cp2p/codec';
import { certifiedEntrySchema, logEntrySchema } from '@cp2p/protocol';
import * as v from 'valibot';

export type PublicArchiveWorkerRequest =
  | {
      readonly id: number;
      readonly kind: 'import';
      readonly bytes: Uint8Array;
      /** The audit's revealed masters, kept beside the archive for a full-information replay. */
      readonly masters?: readonly { readonly seat: number; readonly master: Uint8Array }[];
    }
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

/** An opened archive with what the replay viewer needs to step through it. */
export interface PublicArchiveReplay extends PublicArchiveDisplay {
  /** The replay transcript: the signed genesis rules and seed, and every certified input. */
  readonly config: GameConfig;
  readonly genesisSeed: string;
  readonly inputs: readonly Input[];
  /**
   * Each input's private data from a passing audit of the revealed masters, or null when the
   * game has no complete, verified audit (the replay is then public only).
   */
  readonly privateData: readonly (Partial<Record<Seat, PrivateInputData>> | null)[] | null;
  /** The exact archive file and, when the audit passed, the masters it used. */
  readonly bytes: Uint8Array;
  readonly masters: ArchiveMasters | null;
}

export type PublicArchiveWorkerResponse =
  | { readonly id: number; readonly kind: 'imported'; readonly archiveId: string }
  | { readonly id: number; readonly kind: 'opened'; readonly archive: PublicArchiveReplay | null }
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
  if (kind === 'import') {
    const masters: unknown = Reflect.get(value, 'masters');
    return (
      Object.keys(value).length === (masters === undefined ? 3 : 4) &&
      Reflect.get(value, 'bytes') instanceof Uint8Array &&
      Reflect.get(value, 'bytes').length <= MAX_ONLINE_PUBLIC_ARCHIVE_BYTES &&
      (masters === undefined || validMasters(masters))
    );
  }
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

function validMasters(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= 6 &&
    value.every(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        Object.keys(item).length === 2 &&
        displaySeat(Number(Reflect.get(item, 'seat'))) &&
        Reflect.get(item, 'master') instanceof Uint8Array &&
        Reflect.get(item, 'master').length === 32,
    )
  );
}

/**
 * Reconstructs every hand with the end-of-game audit. The transcript is used only when the
 * audit passes completely and its inputs are exactly the archive's certified inputs.
 */
function omniscientTranscript(
  archive: VerifiedPublicOnlineArchive,
  masters: ArchiveMasters,
): (Partial<Record<Seat, PrivateInputData>> | null)[] | null {
  if (!archive.state.result) return null;
  const observed: { input: Input; data: Partial<Record<Seat, PrivateInputData>> }[] = [];
  const secrets = masters.map((item) => ({ seat: item.seat, master: fromBase64Url(item.master) }));
  try {
    const report = auditCertifiedGame({
      genesisEntry: archive.start.result.entry,
      entries: archive.entries,
      masters: secrets,
      engine: createCatalogueEngine(),
      policy: baseAuditPolicy,
      onPrivateInput: (input, data) => observed.push({ input, data }),
    });
    if (!report.ok || !report.complete || observed.length !== archive.inputs.length) return null;
    for (const [index, item] of observed.entries())
      if (!sameBytes(canonicalEncode(item.input), canonicalEncode(archive.inputs[index])))
        return null;
    return observed.map(({ data }) => (Object.keys(data).length ? data : null));
  } catch {
    return null;
  } finally {
    for (const item of secrets) item.master.fill(0);
  }
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
      if (supplied.masters) {
        const saved = await saveOnlineArchiveMasters(
          store,
          result.value.id,
          supplied.masters.flatMap((item) =>
            displaySeat(item.seat) ? [{ seat: item.seat, master: toBase64Url(item.master) }] : [],
          ),
        );
        if (!saved.ok) throw new Error(saved.error.message);
      }
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
    const masters = await loadOnlineArchiveMasters(store, archive.id);
    const privateData = masters ? omniscientTranscript(archive, masters) : null;
    const { genesis } = archive.start.result;
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
        config: genesis.config,
        genesisSeed: genesis.genesisSeed,
        inputs: archive.inputs,
        privateData,
        bytes: archive.bytes,
        masters: privateData ? masters : null,
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
