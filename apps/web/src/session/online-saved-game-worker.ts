import { entryHash } from '@cp2p/protocol';
import type { EscrowCeremonyStore, ProtocolJournal } from '@cp2p/protocol';
import { IndexedDbByteStore, IndexedDbProtocolJournal } from '@cp2p/storage';
import type { DeleteOnlineGameDataResult } from '@cp2p/storage';
import {
  encodeOnlinePublicArchive,
  MAX_ONLINE_PUBLIC_ARCHIVE_BYTES,
} from './online-public-archive.js';
import { deleteOnlineGameRecord, loadOnlineGameRecord } from './online-game-records.js';
import { loadRevealedMasters } from './online-replay-masters.js';
import type { RevealedMaster } from './online-replay-masters.js';

export type OnlineSavedGameWorkerRequest =
  | { readonly id: number; readonly kind: 'export'; readonly gameId: string }
  /** The public archive plus the audit's revealed masters, for a full-information replay. */
  | { readonly id: number; readonly kind: 'replay'; readonly gameId: string }
  | {
      readonly id: number;
      readonly kind: 'delete';
      readonly gameId: string;
      readonly genesisDigest: string;
    };

export type OnlineSavedGameWorkerResponse =
  | { readonly id: number; readonly kind: 'exported'; readonly bytes: Uint8Array }
  | {
      readonly id: number;
      readonly kind: 'replayed';
      readonly bytes: Uint8Array;
      readonly masters: readonly RevealedMaster[];
    }
  | { readonly id: number; readonly kind: 'deleted'; readonly result: DeleteOnlineGameDataResult }
  | { readonly id: number; readonly kind: 'error'; readonly error: string };

type SavedHistoryStore = EscrowCeremonyStore & { close(): Promise<void> };
type JournalReader = Pick<ProtocolJournal, 'load'> & { close(): Promise<void> };

export interface OnlineSavedGameWorkerDependencies {
  readonly createStore?: () => SavedHistoryStore;
  readonly createJournal?: (gameId: string) => JournalReader;
  readonly deleteRecord?: (
    store: EscrowCeremonyStore,
    gameId: string,
    genesisDigest: string,
  ) => Promise<DeleteOnlineGameDataResult>;
}

const GAME_ID = /^[A-Za-z0-9_-]{22}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;

function validRequest(value: unknown): value is OnlineSavedGameWorkerRequest {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const id = Reflect.get(value, 'id');
    const kind = Reflect.get(value, 'kind');
    const gameId: unknown = Reflect.get(value, 'gameId');
    if (
      typeof id !== 'number' ||
      !Number.isSafeInteger(id) ||
      id < 1 ||
      typeof gameId !== 'string' ||
      !GAME_ID.test(gameId)
    )
      return false;
    if (kind === 'export' || kind === 'replay') return Object.keys(value).length === 3;
    const genesisDigest: unknown = Reflect.get(value, 'genesisDigest');
    return (
      kind === 'delete' &&
      Object.keys(value).length === 4 &&
      typeof genesisDigest === 'string' &&
      DIGEST.test(genesisDigest)
    );
  } catch {
    return false;
  }
}

/** One-shot saved-history job; journal safety is read only long enough to validate then wiped. */
export async function runOnlineSavedGameWorkerRequest(
  supplied: unknown,
  dependencies: OnlineSavedGameWorkerDependencies = {},
): Promise<OnlineSavedGameWorkerResponse> {
  let id = 0;
  try {
    const rawId =
      typeof supplied === 'object' && supplied !== null ? Reflect.get(supplied, 'id') : 0;
    if (typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0) id = rawId;
  } catch {
    // Malformed structured input is rejected without touching storage.
  }
  if (!validRequest(supplied)) return { id, kind: 'error', error: 'Saved-game request is invalid' };

  const store = (dependencies.createStore ?? (() => new IndexedDbByteStore()))();
  let journal: JournalReader | null = null;
  let safetyBytes: Uint8Array | undefined;
  try {
    if (supplied.kind === 'delete') {
      const result = await (dependencies.deleteRecord ?? deleteOnlineGameRecord)(
        store,
        supplied.gameId,
        supplied.genesisDigest,
      );
      return { id, kind: 'deleted', result };
    }

    const start = await loadOnlineGameRecord(store, supplied.gameId);
    if (!start) throw new Error('Saved game is missing');
    journal = (dependencies.createJournal ?? ((gameId) => new IndexedDbProtocolJournal(gameId)))(
      supplied.gameId,
    );
    const snapshot = await journal.load();
    if (!snapshot) throw new Error('Saved certified history is missing');
    safetyBytes = snapshot.safety.bytes;
    if (entryHash(snapshot.genesis) !== entryHash(start.result.entry))
      throw new Error('Saved history differs from its signed start');
    const encoded = encodeOnlinePublicArchive({ start, entries: snapshot.entries });
    if (!encoded.ok) throw new Error('Saved certified history could not be verified');
    if (encoded.value.byteLength > MAX_ONLINE_PUBLIC_ARCHIVE_BYTES)
      throw new Error('Saved replay exceeds its size limit');
    if (supplied.kind === 'export') return { id, kind: 'exported', bytes: encoded.value };
    // A missing or unverified audit leaves the replay public; it never fails the export.
    const masters = await loadRevealedMasters(store, start).catch(() => []);
    return { id, kind: 'replayed', bytes: encoded.value, masters };
  } catch {
    return { id, kind: 'error', error: 'Saved game could not be verified or changed' };
  } finally {
    safetyBytes?.fill(0);
    try {
      await journal?.close();
    } finally {
      await store.close();
    }
  }
}
