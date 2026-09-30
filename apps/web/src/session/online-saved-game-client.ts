import type { DeleteOnlineGameDataResult } from '@cp2p/storage';
import { MAX_ONLINE_PUBLIC_ARCHIVE_BYTES } from './online-public-archive-format.js';
import type { OnlineSavedGameWorkerResponse } from './online-saved-game-worker.js';
import { getOnlineVaultController } from './online-vault-controller.js';

interface SavedGameWorkerPort {
  postMessage(message: unknown): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: EventListener): void;
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: EventListener): void;
  terminate(): void;
}

export type SavedGameWorkerFactory = () => SavedGameWorkerPort;

const GAME_ID = /^[A-Za-z0-9_-]{22}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;
const WORKER_DEADLINE_MS = 120_000;
let nextRequestId = 1;

function defaultWorker(): SavedGameWorkerPort {
  return new Worker(new URL('./online-saved-game-worker-entry.ts', import.meta.url), {
    type: 'module',
  });
}

function isResponse(value: unknown, id: number): value is OnlineSavedGameWorkerResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (Reflect.get(value, 'id') !== id) return false;
  const kind = Reflect.get(value, 'kind');
  const keys = Object.keys(value).toSorted().join(',');
  if (kind === 'error')
    return keys === 'error,id,kind' && typeof Reflect.get(value, 'error') === 'string';
  if (kind === 'exported') {
    const bytes: unknown = Reflect.get(value, 'bytes');
    return (
      keys === 'bytes,id,kind' &&
      bytes instanceof Uint8Array &&
      bytes.byteLength <= MAX_ONLINE_PUBLIC_ARCHIVE_BYTES
    );
  }
  if (kind === 'replayed') {
    const bytes: unknown = Reflect.get(value, 'bytes');
    const masters: unknown = Reflect.get(value, 'masters');
    return (
      keys === 'bytes,id,kind,masters' &&
      bytes instanceof Uint8Array &&
      bytes.byteLength <= MAX_ONLINE_PUBLIC_ARCHIVE_BYTES &&
      Array.isArray(masters) &&
      masters.length <= 6 &&
      masters.every(
        (item: unknown) =>
          typeof item === 'object' &&
          item !== null &&
          Object.keys(item).toSorted().join(',') === 'master,seat' &&
          Number.isInteger(Reflect.get(item, 'seat')) &&
          Reflect.get(item, 'master') instanceof Uint8Array &&
          Reflect.get(item, 'master').length === 32,
      )
    );
  }
  if (kind === 'deleted') {
    const result = Reflect.get(value, 'result');
    return (
      keys === 'id,kind,result' &&
      (result === 'deleted' || result === 'already-deleted' || result === 'busy')
    );
  }
  return false;
}

function runJob(
  request:
    | { readonly kind: 'export' | 'replay'; readonly gameId: string }
    | { readonly kind: 'delete'; readonly gameId: string; readonly genesisDigest: string },
  factory: SavedGameWorkerFactory,
  signal?: AbortSignal,
): Promise<OnlineSavedGameWorkerResponse> {
  if (signal?.aborted)
    return Promise.reject(new DOMException('Saved-game operation cancelled', 'AbortError'));
  let worker: SavedGameWorkerPort;
  try {
    worker = factory();
  } catch {
    return Promise.reject(new Error('Saved-game worker could not start'));
  }
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: OnlineSavedGameWorkerResponse | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onFailure);
      worker.removeEventListener('messageerror', onFailure);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      if (result instanceof Error) reject(result);
      else if (result.kind === 'error') reject(new Error(result.error));
      else resolve(result);
    };
    const onMessage: EventListener = (event) => {
      try {
        const value: unknown = Reflect.get(event, 'data');
        finish(
          isResponse(value, id)
            ? value
            : new Error('Saved-game worker returned an invalid response'),
        );
      } catch {
        finish(new Error('Saved-game worker returned an invalid response'));
      }
    };
    const onFailure: EventListener = () => finish(new Error('Saved-game worker failed'));
    const onAbort = () => finish(new DOMException('Saved-game operation cancelled', 'AbortError'));
    const deadline = setTimeout(
      () => finish(new Error('Saved-game operation timed out')),
      WORKER_DEADLINE_MS,
    );
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onFailure);
    worker.addEventListener('messageerror', onFailure);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Dedicated Worker messages do not take a target origin.
      worker.postMessage({ ...request, id });
    } catch {
      finish(new Error('Saved-game request could not be sent'));
    }
  });
}

/** Fully verifies and exports the stored certified history without opening a session. */
export async function exportStoredGameReplay(gameId: string): Promise<Uint8Array> {
  return exportStoredGameReplayWithSignal(gameId);
}

/** Cancellable variant for callers that own an explicit operation lifetime. */
export async function exportStoredGameReplayWithSignal(
  gameId: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!GAME_ID.test(gameId)) throw new Error('Invalid online game identifier');
  const response = await runJob({ kind: 'export', gameId }, defaultWorker, signal);
  if (response.kind !== 'exported') throw new Error('Saved-game worker returned the wrong result');
  return new Uint8Array(response.bytes);
}

/**
 * The verified public archive plus the masters every seat revealed for the audit (empty when
 * the audit did not verify), so the replay viewer can show every hand.
 */
export async function exportStoredGameReplayWithMasters(
  gameId: string,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; masters: readonly { seat: number; master: Uint8Array }[] }> {
  if (!GAME_ID.test(gameId)) throw new Error('Invalid online game identifier');
  const response = await runJob({ kind: 'replay', gameId }, defaultWorker, signal);
  if (response.kind !== 'replayed') throw new Error('Saved-game worker returned the wrong result');
  return { bytes: new Uint8Array(response.bytes), masters: response.masters };
}

/** Permanently forgets local game data; a busy result leaves the game available. */
export async function deleteStoredGame(
  gameId: string,
  genesisDigest: string,
): Promise<DeleteOnlineGameDataResult> {
  if (!GAME_ID.test(gameId) || !DIGEST.test(genesisDigest))
    throw new Error('Invalid online game identity');
  const response = await getOnlineVaultController().withIdleVaultReleased(() =>
    runJob({ kind: 'delete', gameId, genesisDigest }, defaultWorker),
  );
  if (response === null) return 'busy';
  if (response.kind !== 'deleted') throw new Error('Saved-game worker returned the wrong result');
  return response.result;
}
