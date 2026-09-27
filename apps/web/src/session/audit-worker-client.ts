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

export interface AuditWorkerOptions {
  /** Must be between 1 ms and 5 minutes. Defaults to 60 seconds. */
  deadlineMs?: number;
}

const DEFAULT_DEADLINE_MS = 60_000;
const MAX_DEADLINE_MS = 5 * 60_000;

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
  const ok = Reflect.get(value, 'ok');
  const complete = Reflect.get(value, 'complete');
  const finalHiddenVictoryPoints = Reflect.get(value, 'finalHiddenVictoryPoints');
  const historyError = Reflect.get(value, 'historyError');
  const auditError = Reflect.get(value, 'auditError');
  const validFinalScores =
    finalHiddenVictoryPoints === null ||
    (typeof finalHiddenVictoryPoints === 'object' &&
      finalHiddenVictoryPoints !== null &&
      !Array.isArray(finalHiddenVictoryPoints) &&
      Object.entries(finalHiddenVictoryPoints).every(
        ([seat, count]) =>
          ['0', '1', '2', '3', '4', '5'].includes(seat) &&
          Number.isSafeInteger(count) &&
          Number(count) >= 0,
      ));
  const successHasScores =
    ok === true &&
    complete === true &&
    finalHiddenVictoryPoints !== null &&
    typeof finalHiddenVictoryPoints === 'object';
  const failedAuditHidesScores =
    (ok !== true || complete !== true) && finalHiddenVictoryPoints === null;
  return (
    typeof ok === 'boolean' &&
    typeof complete === 'boolean' &&
    Array.isArray(Reflect.get(value, 'missingSeats')) &&
    Array.isArray(Reflect.get(value, 'violations')) &&
    Array.isArray(Reflect.get(value, 'inputErrors')) &&
    Array.isArray(Reflect.get(value, 'cheatFindings')) &&
    isAuditReference(Reflect.get(value, 'terminal')) &&
    isAuditReference(Reflect.get(value, 'finalHead')) &&
    (historyError === null ||
      (typeof historyError === 'object' &&
        historyError !== null &&
        typeof Reflect.get(historyError, 'code') === 'string')) &&
    (auditError === null ||
      (typeof auditError === 'object' &&
        auditError !== null &&
        Number.isSafeInteger(Reflect.get(auditError, 'seq')) &&
        typeof Reflect.get(auditError, 'code') === 'string')) &&
    validFinalScores &&
    (successHasScores || failedAuditHidesScores)
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
  options: AuditWorkerOptions = {},
): SessionAuditJob {
  const id = nextRequestId++;
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DEADLINE_MS) {
    wipeMasters(input.masters);
    return {
      result: Promise.reject(new RangeError('Audit deadline must be between 1 ms and 5 minutes')),
      cancel() {},
    };
  }
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
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const callbacks: {
    resolve?: (report: AuditReport) => void;
    reject?: (error: Error) => void;
  } = {};
  const cleanup = () => {
    worker.removeEventListener('message', onMessage);
    worker.removeEventListener('error', onError);
    worker.removeEventListener('messageerror', onMessageError);
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
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
  deadlineTimer = setTimeout(() => {
    finish(() => callbacks.reject?.(new Error(`Audit worker timed out after ${deadlineMs} ms`)));
  }, deadlineMs);
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
  options: AuditWorkerOptions = {},
): SessionAuditRunner {
  return (input) => createSessionAuditJob(input, workerFactory, options);
}
