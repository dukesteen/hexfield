import { MAX_ONLINE_FULL_SAVE_BYTES } from './online-full-save.js';
import type { ImportedOnlineFullSaveSummary } from './online-full-save-catalogue.js';
import type {
  OnlineFullSaveDisplay,
  OnlineFullSaveWorkerRequest,
  OnlineFullSaveWorkerResponse,
} from './online-full-save-worker.js';

interface WorkerPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: EventListener): void;
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: EventListener): void;
  terminate(): void;
}

export type OnlineFullSaveWorkerFactory = () => WorkerPort;
export type { ImportedOnlineFullSaveSummary, OnlineFullSaveDisplay };

const GAME_ID = /^[A-Za-z0-9_-]{22}$/;
const ID = /^[0-9a-f]{64}$/;
const DEADLINE_MS = 120_000;
let nextId = 1;

export class OnlineFullSaveClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function defaultWorker(): WorkerPort {
  return new Worker(new URL('./online-full-save-worker-entry.ts', import.meta.url), {
    type: 'module',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validPassphrase(value: string): boolean {
  return value.length >= 12 && value.length <= 1024;
}

function validSummary(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).toSorted().join(',') ===
      'createdAt,gameId,headSeq,id,names,privateCapsule' &&
    typeof value.id === 'string' &&
    ID.test(value.id) &&
    typeof value.gameId === 'string' &&
    GAME_ID.test(value.gameId) &&
    Array.isArray(value.names) &&
    value.names.length >= 2 &&
    value.names.length <= 6 &&
    value.names.every(
      (name: unknown) => typeof name === 'string' && name.length > 0 && name.length <= 40,
    ) &&
    typeof value.createdAt === 'number' &&
    Number.isSafeInteger(value.createdAt) &&
    value.createdAt >= 0 &&
    typeof value.headSeq === 'number' &&
    Number.isSafeInteger(value.headSeq) &&
    value.headSeq >= 0 &&
    value.headSeq <= 8192 &&
    (value.privateCapsule === 'none' || value.privateCapsule === 'encrypted')
  );
}

function validResponse(value: unknown, id: number): value is OnlineFullSaveWorkerResponse {
  if (!isRecord(value)) return false;
  const record = value;
  if (record.id !== id) return false;
  const keys = Object.keys(record).toSorted().join(',');
  if (record.kind === 'error')
    return (
      keys === 'code,id,kind,message' &&
      typeof record.code === 'string' &&
      typeof record.message === 'string'
    );
  if (record.kind === 'exported')
    return (
      keys === 'bytes,id,kind' &&
      record.bytes instanceof Uint8Array &&
      record.bytes.byteLength > 0 &&
      record.bytes.byteLength <= MAX_ONLINE_FULL_SAVE_BYTES
    );
  if (record.kind === 'imported')
    return (
      keys === 'archiveId,gameId,id,kind' &&
      typeof record.archiveId === 'string' &&
      ID.test(record.archiveId) &&
      typeof record.gameId === 'string' &&
      GAME_ID.test(record.gameId)
    );
  if (record.kind === 'listed')
    return (
      keys === 'id,kind,saves' &&
      Array.isArray(record.saves) &&
      record.saves.length <= 32 &&
      record.saves.every(validSummary)
    );
  if (record.kind !== 'opened' || keys !== 'id,kind,save') return false;
  const save = record.save;
  if (save === null) return true;
  if (!isRecord(save)) return false;
  const display = save;
  return (
    Object.keys(display).toSorted().join(',') ===
      'events,gameId,head,id,mode,players,privateCapsule,state' &&
    display.mode === 'read-only-paused' &&
    (display.privateCapsule === 'none' || display.privateCapsule === 'encrypted') &&
    typeof display.id === 'string' &&
    ID.test(display.id) &&
    typeof display.gameId === 'string' &&
    GAME_ID.test(display.gameId) &&
    Array.isArray(display.players) &&
    Array.isArray(display.events) &&
    typeof display.state === 'object' &&
    display.state !== null
  );
}

type Body =
  | Omit<Extract<OnlineFullSaveWorkerRequest, { kind: 'export' }>, 'id'>
  | Omit<Extract<OnlineFullSaveWorkerRequest, { kind: 'import' }>, 'id'>
  | Omit<Extract<OnlineFullSaveWorkerRequest, { kind: 'list' }>, 'id'>
  | Omit<Extract<OnlineFullSaveWorkerRequest, { kind: 'open' }>, 'id'>;

function runJob(
  body: Body,
  factory: OnlineFullSaveWorkerFactory,
  transfer: Transferable[] = [],
  signal?: AbortSignal,
): Promise<OnlineFullSaveWorkerResponse> {
  if (signal?.aborted)
    return Promise.reject(new DOMException('Full-save operation cancelled', 'AbortError'));
  let worker: WorkerPort;
  try {
    worker = factory();
  } catch {
    return Promise.reject(
      new OnlineFullSaveClientError('full-save-worker', 'Full-save worker could not start'),
    );
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome: OnlineFullSaveWorkerResponse | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onFailure);
      worker.removeEventListener('messageerror', onFailure);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      if (outcome instanceof Error) reject(outcome);
      else if (outcome.kind === 'error')
        reject(new OnlineFullSaveClientError(outcome.code, outcome.message));
      else resolve(outcome);
    };
    const onMessage: EventListener = (event) => {
      try {
        const value: unknown = Reflect.get(event, 'data');
        finish(
          validResponse(value, id)
            ? value
            : new OnlineFullSaveClientError(
                'full-save-worker',
                'Full-save worker returned an invalid response',
              ),
        );
      } catch {
        finish(
          new OnlineFullSaveClientError(
            'full-save-worker',
            'Full-save worker returned an invalid response',
          ),
        );
      }
    };
    const onFailure: EventListener = () =>
      finish(new OnlineFullSaveClientError('full-save-worker', 'Full-save worker failed'));
    const onAbort = () => finish(new DOMException('Full-save operation cancelled', 'AbortError'));
    const deadline = setTimeout(
      () =>
        finish(new OnlineFullSaveClientError('full-save-timeout', 'Full-save operation timed out')),
      DEADLINE_MS,
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
      worker.postMessage({ ...body, id }, transfer);
    } catch {
      finish(
        new OnlineFullSaveClientError('full-save-worker', 'Full-save request could not be sent'),
      );
    }
  });
}

/** Loads journal and optional private material by ID inside a one-shot worker. */
export async function exportStoredOnlineFullSave(
  gameId: string,
  options: { readonly includePrivate: boolean; readonly passphrase?: string },
  factory: OnlineFullSaveWorkerFactory = defaultWorker,
): Promise<Uint8Array> {
  if (!GAME_ID.test(gameId))
    throw new OnlineFullSaveClientError('full-save-id', 'Invalid online game identifier');
  if (options.includePrivate && (!options.passphrase || !validPassphrase(options.passphrase)))
    throw new OnlineFullSaveClientError(
      'full-save-passphrase',
      'Private export requires a 12–1024 character passphrase',
    );
  if (!options.includePrivate && options.passphrase !== undefined)
    throw new OnlineFullSaveClientError(
      'full-save-passphrase',
      'A passphrase requires private material',
    );
  const response = await runJob({ kind: 'export', gameId, ...options }, factory);
  if (response.kind !== 'exported')
    throw new OnlineFullSaveClientError(
      'full-save-worker',
      'Full-save worker returned the wrong result',
    );
  return new Uint8Array(response.bytes);
}

export async function importOnlineFullSaveFile(
  supplied: Uint8Array,
  passphrase?: string,
  factory: OnlineFullSaveWorkerFactory = defaultWorker,
): Promise<{ readonly id: string; readonly gameId: string }> {
  if (
    !(supplied instanceof Uint8Array) ||
    supplied.length < 1 ||
    supplied.length > MAX_ONLINE_FULL_SAVE_BYTES
  )
    throw new OnlineFullSaveClientError('full-save-size', 'Full save exceeds its size limit');
  if (passphrase !== undefined && !validPassphrase(passphrase))
    throw new OnlineFullSaveClientError(
      'full-save-passphrase',
      'Private import requires a 12–1024 character passphrase',
    );
  const bytes = new Uint8Array(supplied);
  const response = await runJob(
    { kind: 'import', bytes, ...(passphrase === undefined ? {} : { passphrase }) },
    factory,
    [bytes.buffer],
  );
  if (response.kind !== 'imported')
    throw new OnlineFullSaveClientError(
      'full-save-worker',
      'Full-save worker returned the wrong result',
    );
  return { id: response.archiveId, gameId: response.gameId };
}

export async function listImportedOnlineFullSaves(
  factory: OnlineFullSaveWorkerFactory = defaultWorker,
): Promise<readonly ImportedOnlineFullSaveSummary[]> {
  const response = await runJob({ kind: 'list' }, factory);
  if (response.kind !== 'listed')
    throw new OnlineFullSaveClientError(
      'full-save-worker',
      'Full-save worker returned the wrong result',
    );
  return response.saves;
}

export async function openImportedOnlineFullSave(
  id: string,
  signal?: AbortSignal,
  factory: OnlineFullSaveWorkerFactory = defaultWorker,
): Promise<OnlineFullSaveDisplay | null> {
  if (!ID.test(id))
    throw new OnlineFullSaveClientError('full-save-id', 'Invalid full-save identifier');
  const response = await runJob({ kind: 'open', archiveId: id }, factory, [], signal);
  if (response.kind !== 'opened')
    throw new OnlineFullSaveClientError(
      'full-save-worker',
      'Full-save worker returned the wrong result',
    );
  if (response.save && response.save.id !== id)
    throw new OnlineFullSaveClientError('full-save-id', 'Full-save worker opened another file');
  return response.save;
}
