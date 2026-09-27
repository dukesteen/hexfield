import type { PublicArchiveSummary } from './online-public-archive-store.js';
import { getOnlineVaultController } from './online-vault-controller.js';
import { MAX_ONLINE_PUBLIC_ARCHIVE_BYTES } from './online-public-archive-format.js';
import type {
  PublicArchiveDisplay,
  PublicArchiveWorkerResponse,
} from './online-public-archive-worker.js';

interface WorkerPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: EventListener): void;
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: EventListener): void;
  terminate(): void;
}

export type PublicArchiveWorkerFactory = () => WorkerPort;

const WORKER_DEADLINE_MS = 120_000;
let nextRequestId = 1;

function defaultWorker(): WorkerPort {
  return new Worker(new URL('./online-public-archive-worker-entry.ts', import.meta.url), {
    type: 'module',
  });
}

function validResponse(value: unknown, id: number): value is PublicArchiveWorkerResponse {
  if (typeof value !== 'object' || value === null || Reflect.get(value, 'id') !== id) return false;
  const kind = Reflect.get(value, 'kind');
  if (kind === 'error') return typeof Reflect.get(value, 'error') === 'string';
  if (kind === 'imported') return /^[0-9a-f]{64}$/.test(String(Reflect.get(value, 'archiveId')));
  if (kind === 'encoded')
    return (
      Reflect.get(value, 'bytes') instanceof Uint8Array &&
      Reflect.get(value, 'bytes').length <= MAX_ONLINE_PUBLIC_ARCHIVE_BYTES
    );
  if (kind === 'listed') return Array.isArray(Reflect.get(value, 'archives'));
  if (kind !== 'opened') return false;
  const archive = Reflect.get(value, 'archive');
  return (
    archive === null ||
    (typeof archive === 'object' &&
      archive !== null &&
      /^[0-9a-f]{64}$/.test(String(Reflect.get(archive, 'id'))) &&
      Array.isArray(Reflect.get(archive, 'events')) &&
      Array.isArray(Reflect.get(archive, 'players')) &&
      typeof Reflect.get(archive, 'state') === 'object')
  );
}

async function runJob(
  body:
    | { readonly kind: 'import'; readonly bytes: Uint8Array }
    | {
        readonly kind: 'open';
        readonly archiveId: string;
      }
    | { readonly kind: 'encode'; readonly gameId: string; readonly history: unknown }
    | { readonly kind: 'list' },
  factory: PublicArchiveWorkerFactory,
  transfer: Transferable[] = [],
  signal?: AbortSignal,
): Promise<PublicArchiveWorkerResponse> {
  if (signal?.aborted)
    return Promise.reject(new DOMException('Replay opening cancelled', 'AbortError'));
  const id = nextRequestId++;
  let worker: WorkerPort | null = null;
  let cancelJob: (() => void) | null = null;
  const vault = factory === defaultWorker ? getOnlineVaultController() : null;
  const scope = vault
    ? await vault.acquireScope(async () => {
        cancelJob?.();
        worker?.terminate();
      })
    : null;
  try {
    scope?.assertActive();
    worker = factory();
    const activeWorker = worker;
    return await new Promise((resolve, reject) => {
      let done = false;
      const finish = (outcome: PublicArchiveWorkerResponse | Error) => {
        if (done) return;
        done = true;
        clearTimeout(deadline);
        activeWorker.removeEventListener('message', onMessage);
        activeWorker.removeEventListener('error', onFailure);
        activeWorker.removeEventListener('messageerror', onFailure);
        signal?.removeEventListener('abort', onAbort);
        activeWorker.terminate();
        if (outcome instanceof Error) reject(outcome);
        else if (outcome.kind === 'error') reject(new Error(outcome.error));
        else resolve(outcome);
      };
      const onMessage: EventListener = (event) => {
        const value: unknown = Reflect.get(event, 'data');
        finish(
          validResponse(value, id)
            ? value
            : new Error('Public replay worker returned an invalid response'),
        );
      };
      const onFailure: EventListener = () => finish(new Error('Public replay worker failed'));
      const onAbort = () => finish(new DOMException('Replay opening cancelled', 'AbortError'));
      cancelJob = onAbort;
      const deadline = setTimeout(
        () => finish(new Error('Public replay verification timed out')),
        WORKER_DEADLINE_MS,
      );
      activeWorker.addEventListener('message', onMessage);
      activeWorker.addEventListener('error', onFailure);
      activeWorker.addEventListener('messageerror', onFailure);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        activeWorker.postMessage(
          scope ? { request: { ...body, id }, handoff: scope.handoff() } : { ...body, id },
          transfer,
        );
      } catch {
        finish(new Error('Public replay could not be sent to its worker'));
      }
    });
  } finally {
    if (scope) await vault?.releaseScope(scope);
  }
}

/** The caller must check File.size before reading; this repeats the byte-level bound. */
export async function importPublicReplay(
  supplied: Uint8Array,
  factory: PublicArchiveWorkerFactory = defaultWorker,
): Promise<string> {
  if (!(supplied instanceof Uint8Array) || supplied.length > MAX_ONLINE_PUBLIC_ARCHIVE_BYTES)
    throw new Error('Public replay exceeds its size limit');
  const bytes = new Uint8Array(supplied);
  const response = await runJob({ kind: 'import', bytes }, factory, [bytes.buffer]);
  if (response.kind !== 'imported')
    throw new Error('Public replay worker returned the wrong result');
  return response.archiveId;
}

export async function openPublicReplay(
  id: string,
  factory: PublicArchiveWorkerFactory = defaultWorker,
  signal?: AbortSignal,
): Promise<PublicArchiveDisplay | null> {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error('Invalid public replay identifier');
  const response = await runJob({ kind: 'open', archiveId: id }, factory, [], signal);
  if (response.kind !== 'opened') throw new Error('Public replay worker returned the wrong result');
  if (response.archive && response.archive.id !== id)
    throw new Error('Public replay worker returned another archive');
  return response.archive;
}

/** Encodes only public certified history, with signed start loaded inside the worker. */
export async function encodePublicReplay(
  gameId: string,
  history: unknown,
  factory: PublicArchiveWorkerFactory = defaultWorker,
): Promise<Uint8Array> {
  if (!/^[A-Za-z0-9_-]{22}$/.test(gameId)) throw new Error('Invalid online game identifier');
  const response = await runJob({ kind: 'encode', gameId, history }, factory);
  if (response.kind !== 'encoded')
    throw new Error('Public replay worker returned the wrong result');
  return response.bytes;
}

/** Catalogue IDs are unverified locators; opening performs full replay in a worker. */
export async function listPublicReplays(): Promise<readonly PublicArchiveSummary[]> {
  const response = await runJob({ kind: 'list' }, defaultWorker);
  if (response.kind !== 'listed') throw new Error('Public replay worker returned the wrong result');
  return response.archives;
}
