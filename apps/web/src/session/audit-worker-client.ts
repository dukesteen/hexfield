import type {
  AuditReport,
  SessionAuditInput,
  SessionAuditJob,
  SessionAuditRunner,
} from '@cp2p/protocol';
import type { AuditWorkerRequest, AuditWorkerResponse } from './audit-worker-job.js';

interface AuditWorkerPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
  terminate(): void;
}

export type AuditWorkerFactory = () => AuditWorkerPort;

let nextRequestId = 1;

function createWorker(): AuditWorkerPort {
  return new Worker(new URL('./audit-worker.ts', import.meta.url), { type: 'module' });
}

function isAuditReference(reference: unknown): boolean {
  return (
    reference === null ||
    (typeof reference === 'object' &&
      reference !== null &&
      Number.isSafeInteger(Reflect.get(reference, 'seq')) &&
      typeof Reflect.get(reference, 'hash') === 'string')
  );
}

function isAuditReport(value: unknown): value is AuditReport {
  if (typeof value !== 'object' || value === null) return false;
  const historyError = Reflect.get(value, 'historyError');
  return (
    typeof Reflect.get(value, 'ok') === 'boolean' &&
    typeof Reflect.get(value, 'complete') === 'boolean' &&
    Array.isArray(Reflect.get(value, 'missingSeats')) &&
    Array.isArray(Reflect.get(value, 'violations')) &&
    Array.isArray(Reflect.get(value, 'inputErrors')) &&
    Array.isArray(Reflect.get(value, 'cheatFindings')) &&
    isAuditReference(Reflect.get(value, 'terminal')) &&
    isAuditReference(Reflect.get(value, 'finalHead')) &&
    (historyError === null ||
      (typeof historyError === 'object' &&
        historyError !== null &&
        typeof Reflect.get(historyError, 'code') === 'string'))
  );
}

function isAuditWorkerResponse(value: unknown): value is AuditWorkerResponse {
  if (typeof value !== 'object' || value === null) return false;
  const id = Reflect.get(value, 'id');
  return (
    Number.isSafeInteger(id) &&
    (typeof Reflect.get(value, 'error') === 'string' || isAuditReport(Reflect.get(value, 'report')))
  );
}

function wipeMasters(masters: readonly { master: Uint8Array }[]): void {
  for (const { master } of masters) if (master.byteLength > 0) master.fill(0);
}

function abortError(): Error {
  return new DOMException('Audit was cancelled', 'AbortError');
}

/** Starts a disposable worker for one verified base-engine audit. */
export function createSessionAuditJob(
  input: SessionAuditInput,
  workerFactory: AuditWorkerFactory = createWorker,
): SessionAuditJob {
  const id = nextRequestId++;
  const masters: { seat: SessionAuditInput['masters'][number]['seat']; master: Uint8Array }[] = [];
  try {
    for (const { seat, master } of input.masters)
      masters.push({ seat, master: new Uint8Array(master) });
  } catch (error) {
    wipeMasters(input.masters);
    wipeMasters(masters);
    return { result: Promise.reject(error), cancel() {} };
  }
  wipeMasters(input.masters);
  let worker: AuditWorkerPort;
  try {
    worker = workerFactory();
  } catch (error) {
    wipeMasters(masters);
    return { result: Promise.reject(error), cancel() {} };
  }
  const request: AuditWorkerRequest = {
    id,
    genesisEntry: input.genesisEntry,
    entries: input.entries,
    masters,
  };

  let settled = false;
  const callbacks: {
    resolve?: (report: AuditReport) => void;
    reject?: (error: Error) => void;
  } = {};
  const cleanup = () => {
    worker.removeEventListener('message', onMessage);
    worker.removeEventListener('error', onError);
    worker.removeEventListener('messageerror', onMessageError);
    worker.terminate();
    wipeMasters(masters);
  };
  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    callback();
  };
  const onMessage: EventListener = (event) => {
    if (!(event instanceof MessageEvent) || !isAuditWorkerResponse(event.data)) return;
    if (event.data.id !== id) return;
    finish(() => {
      if ('error' in event.data) callbacks.reject?.(new Error(event.data.error));
      else callbacks.resolve?.(event.data.report);
    });
  };
  const onError: EventListener = (event) => {
    const message = event instanceof ErrorEvent ? event.message : 'Audit worker failed';
    finish(() => callbacks.reject?.(new Error(message || 'Audit worker failed')));
  };
  const onMessageError: EventListener = () => {
    finish(() => callbacks.reject?.(new Error('Audit worker returned an unreadable response')));
  };
  const result = new Promise<AuditReport>((resolve, reject) => {
    callbacks.resolve = resolve;
    callbacks.reject = reject;
  });

  worker.addEventListener('message', onMessage);
  worker.addEventListener('error', onError);
  worker.addEventListener('messageerror', onMessageError);
  try {
    worker.postMessage(
      request,
      masters.map(({ master }) => master.buffer),
    );
  } catch (error) {
    finish(() => callbacks.reject?.(error instanceof Error ? error : new Error(String(error))));
  }

  return {
    result,
    cancel() {
      finish(() => callbacks.reject?.(abortError()));
    },
  };
}

export function createSessionAuditRunner(
  workerFactory: AuditWorkerFactory = createWorker,
): SessionAuditRunner {
  return (input) => createSessionAuditJob(input, workerFactory);
}
