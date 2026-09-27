import type { Seat } from '@cp2p/engine';
import type { EscrowCeremonyStore, ProtocolJournal } from '@cp2p/protocol';
import { IndexedDbByteStore, IndexedDbProtocolJournal } from '@cp2p/storage';
import {
  catalogueImportedOnlineFullSave,
  listImportedOnlineFullSaveSummaries,
} from './online-full-save-catalogue.js';
import type { ImportedOnlineFullSaveSummary } from './online-full-save-catalogue.js';
import { loadStoredOnlineMasterInventory } from './online-full-save-inventory.js';
import { MAX_ONLINE_FULL_SAVE_BYTES, exportOnlineFullSaveFromJournal } from './online-full-save.js';
import type { VerifiedOnlineFullSave } from './online-full-save.js';
import { importOnlineFullSave, openOnlineFullSave } from './online-full-save-store.js';
import { loadOnlineGameRecord } from './online-game-records.js';
import type { PublicArchiveDisplay } from './online-public-archive-worker.js';

const GAME_ID = /^[A-Za-z0-9_-]{22}$/;
const ID = /^[0-9a-f]{64}$/;
const PRIVATE_JOB_LOCK = 'online-full-import/v1/private-job';

export type OnlineFullSaveWorkerRequest =
  | {
      readonly id: number;
      readonly kind: 'export';
      readonly gameId: string;
      readonly includePrivate: boolean;
      readonly passphrase?: string;
    }
  | {
      readonly id: number;
      readonly kind: 'import';
      readonly bytes: Uint8Array;
      readonly passphrase?: string;
    }
  | { readonly id: number; readonly kind: 'list' }
  | { readonly id: number; readonly kind: 'open'; readonly archiveId: string };

export interface OnlineFullSaveDisplay extends PublicArchiveDisplay {
  readonly mode: 'read-only-paused';
  readonly privateCapsule: 'none' | 'encrypted';
}

export type OnlineFullSaveWorkerResponse =
  | { readonly id: number; readonly kind: 'exported'; readonly bytes: Uint8Array }
  | {
      readonly id: number;
      readonly kind: 'imported';
      readonly archiveId: string;
      readonly gameId: string;
    }
  | {
      readonly id: number;
      readonly kind: 'listed';
      readonly saves: readonly ImportedOnlineFullSaveSummary[];
    }
  | { readonly id: number; readonly kind: 'opened'; readonly save: OnlineFullSaveDisplay | null }
  | {
      readonly id: number;
      readonly kind: 'error';
      readonly code: string;
      readonly message: string;
    };

type Store = EscrowCeremonyStore & { close(): Promise<void> };
type Journal = Pick<ProtocolJournal, 'load'> & { close(): Promise<void> };

export interface OnlineFullSaveWorkerDependencies {
  readonly createStore?: () => Store;
  readonly createJournal?: (gameId: string) => Journal;
  readonly loadMasterInventory?: typeof loadStoredOnlineMasterInventory;
}

class FullSaveTaskError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function keysAre(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function displaySeat(seat: Seat): seat is 0 | 1 | 2 | 3 {
  return seat === 0 || seat === 1 || seat === 2 || seat === 3;
}

function validRequest(value: unknown): value is OnlineFullSaveWorkerRequest {
  try {
    if (!isRecord(value)) return false;
    const record = value;
    if (!Number.isSafeInteger(record.id) || Number(record.id) < 1) return false;
    if (record.kind === 'list') return keysAre(record, ['id', 'kind']);
    if (record.kind === 'open')
      return (
        keysAre(record, ['id', 'kind', 'archiveId']) &&
        typeof record.archiveId === 'string' &&
        ID.test(record.archiveId)
      );
    if (record.kind === 'export')
      return (
        keysAre(record, ['id', 'kind', 'gameId', 'includePrivate'], ['passphrase']) &&
        typeof record.gameId === 'string' &&
        GAME_ID.test(record.gameId) &&
        typeof record.includePrivate === 'boolean' &&
        (record.passphrase === undefined ||
          (typeof record.passphrase === 'string' && record.passphrase.length <= 1024))
      );
    if (record.kind === 'import')
      return (
        keysAre(record, ['id', 'kind', 'bytes'], ['passphrase']) &&
        record.bytes instanceof Uint8Array &&
        record.bytes.byteLength >= 1 &&
        record.bytes.byteLength <= MAX_ONLINE_FULL_SAVE_BYTES &&
        (record.passphrase === undefined ||
          (typeof record.passphrase === 'string' && record.passphrase.length <= 1024))
      );
    return false;
  } catch {
    return false;
  }
}

function display(save: VerifiedOnlineFullSave): OnlineFullSaveDisplay {
  const players = save.public.start.agreement.state.seats.map((seat) => {
    if (seat.kind === 'open' || !displaySeat(seat.seat))
      throw new FullSaveTaskError('full-save-display', 'Imported game has an unsupported roster');
    return { seat: seat.seat, name: seat.name, color: seat.colour };
  });
  return {
    id: save.id,
    gameId: save.public.gameId,
    head: { ...save.public.head },
    state: save.public.state,
    events: save.public.events,
    players,
    mode: 'read-only-paused',
    privateCapsule: save.privateLocked || save.private !== null ? 'encrypted' : 'none',
  };
}

/** One isolated job. Its response never contains decrypted masters, escrow or voting keys. */
export async function runOnlineFullSaveWorkerRequest(
  supplied: unknown,
  dependencies: OnlineFullSaveWorkerDependencies = {},
): Promise<OnlineFullSaveWorkerResponse> {
  let id = 0;
  try {
    const raw = typeof supplied === 'object' && supplied !== null ? Reflect.get(supplied, 'id') : 0;
    if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) id = raw;
  } catch {
    // Invalid accessors do not reach storage.
  }
  if (!validRequest(supplied))
    return {
      id,
      kind: 'error',
      code: 'full-save-request',
      message: 'Full-save request is invalid',
    };
  let store: Store;
  try {
    store = (dependencies.createStore ?? (() => new IndexedDbByteStore()))();
  } catch {
    if (supplied.kind === 'import') supplied.bytes.fill(0);
    return {
      id,
      kind: 'error',
      code: 'full-save-storage',
      message: 'Full-save storage could not be opened',
    };
  }
  const resources: {
    journal: Journal | null;
    inventory: Awaited<ReturnType<typeof loadStoredOnlineMasterInventory>> | null;
  } = { journal: null, inventory: null };
  try {
    if (supplied.kind === 'list') {
      const listed = await listImportedOnlineFullSaveSummaries(store);
      if (!listed.ok) throw new FullSaveTaskError(listed.error.code, listed.error.message);
      return { id, kind: 'listed', saves: listed.value };
    }
    if (supplied.kind === 'open') {
      const opened = await openOnlineFullSave(store, supplied.archiveId);
      if (!opened.ok) throw new FullSaveTaskError(opened.error.code, opened.error.message);
      if (!opened.value) return { id, kind: 'opened', save: null };
      try {
        return { id, kind: 'opened', save: display(opened.value) };
      } finally {
        opened.value.dispose();
      }
    }
    if (supplied.kind === 'import') {
      try {
        const importFile = async (): Promise<OnlineFullSaveWorkerResponse> => {
          const imported = await importOnlineFullSave(store, supplied.bytes, supplied.passphrase);
          if (!imported.ok)
            throw new FullSaveTaskError(imported.error.code, imported.error.message);
          const opened = await openOnlineFullSave(store, imported.value.id);
          if (!opened.ok) throw new FullSaveTaskError(opened.error.code, opened.error.message);
          if (!opened.value)
            throw new FullSaveTaskError('full-save-storage', 'Imported full save is missing');
          try {
            const indexed = await catalogueImportedOnlineFullSave(store, opened.value);
            if (!indexed.ok) throw new FullSaveTaskError(indexed.error.code, indexed.error.message);
          } finally {
            opened.value.dispose();
          }
          return {
            id,
            kind: 'imported',
            archiveId: imported.value.id,
            gameId: imported.value.gameId,
          };
        };
        return supplied.passphrase === undefined
          ? await importFile()
          : await store.withCeremonyLock(PRIVATE_JOB_LOCK, importFile);
      } finally {
        supplied.bytes.fill(0);
      }
    }
    if (supplied.includePrivate && (!supplied.passphrase || supplied.passphrase.length < 12))
      throw new FullSaveTaskError(
        'full-save-passphrase',
        'Private export requires a 12–1024 character passphrase',
      );
    if (!supplied.includePrivate && supplied.passphrase !== undefined)
      throw new FullSaveTaskError('full-save-passphrase', 'A passphrase requires private material');
    const exportFile = async (): Promise<OnlineFullSaveWorkerResponse> => {
      const start = await loadOnlineGameRecord(store, supplied.gameId);
      if (!start) throw new FullSaveTaskError('full-save-start', 'Saved game is missing');
      resources.journal = (
        dependencies.createJournal ?? ((gameId) => new IndexedDbProtocolJournal(gameId))
      )(supplied.gameId);
      if (supplied.includePrivate) {
        try {
          resources.inventory = await (
            dependencies.loadMasterInventory ?? loadStoredOnlineMasterInventory
          )({
            start,
            journal: resources.journal,
            store,
          });
        } catch {
          throw new FullSaveTaskError(
            'full-save-private-unavailable',
            'Current owned private material is unavailable',
          );
        }
      }
      const owned = resources.inventory;
      const encoded = await exportOnlineFullSaveFromJournal({
        start,
        journal: resources.journal,
        includePrivate: supplied.includePrivate,
        ...(supplied.passphrase === undefined ? {} : { passphrase: supplied.passphrase }),
        ...(owned
          ? { loadOwnedMaster: (seat: Seat) => owned.loadOwnedMaster(seat), escrowStore: store }
          : {}),
      });
      if (!encoded.ok) throw new FullSaveTaskError(encoded.error.code, encoded.error.message);
      return { id, kind: 'exported', bytes: encoded.value };
    };
    return supplied.includePrivate
      ? await store.withCeremonyLock(PRIVATE_JOB_LOCK, exportFile)
      : await exportFile();
  } catch (error) {
    return error instanceof FullSaveTaskError
      ? { id, kind: 'error', code: error.code, message: error.message }
      : {
          id,
          kind: 'error',
          code: 'full-save-storage',
          message: 'Full-save job could not be completed',
        };
  } finally {
    resources.inventory?.dispose();
    try {
      await resources.journal?.close();
    } finally {
      await store.close();
    }
  }
}
