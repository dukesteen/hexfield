import { Worker } from 'node:worker_threads';
import type {
  VerifiedNetworkAuditJob,
  VerifiedNetworkAuditRequest,
  VerifiedNetworkAuditResult,
} from '@cp2p/protocol/testing';

/** Each peer receives its own worker and independent audit invocation. */
export function createVerifiedNetworkAuditJob(
  request: VerifiedNetworkAuditRequest,
  workerUrl = new URL('./node-audit-worker.js', import.meta.url),
): VerifiedNetworkAuditJob {
  const masters = request.masters.map(({ seat, master }) => ({ seat, master: master.slice() }));
  for (const item of request.masters) item.master.fill(0);
  let worker: Worker | undefined;
  let settled = false;
  let rejectJob: ((error: Error) => void) | undefined;
  const cleanup = () => {
    for (const item of masters) if (item.master.byteLength) item.master.fill(0);
    if (worker) {
      worker.removeAllListeners();
      void worker.terminate().catch(() => {});
    }
  };
  const result = new Promise<VerifiedNetworkAuditResult>((resolve, reject) => {
    rejectJob = reject;
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Verified network audit worker failed'));
    };
    try {
      // The compiled worker must use built package exports, including under Vitest's source condition.
      worker = new Worker(workerUrl, { execArgv: [] });
      worker.on('error', fail);
      worker.on('exit', () => {
        if (!settled) fail();
      });
      worker.on('message', (message: { kind?: unknown; value?: VerifiedNetworkAuditResult }) => {
        if (settled) return;
        const value = message.value;
        if (
          message.kind !== 'result' ||
          !value ||
          typeof value.report?.ok !== 'boolean' ||
          typeof value.report.complete !== 'boolean' ||
          !Array.isArray(value.report.missingSeats) ||
          !Array.isArray(value.report.violations) ||
          !Array.isArray(value.report.inputErrors) ||
          !Array.isArray(value.report.cheatFindings) ||
          !Number.isSafeInteger(value.checkedPrivateSequences) ||
          value.checkedPrivateSequences < 0 ||
          !Number.isFinite(value.privateComparisonMilliseconds) ||
          value.privateComparisonMilliseconds < 0 ||
          (value.privateStateDigest !== null && typeof value.privateStateDigest !== 'string')
        ) {
          fail();
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      });
      worker.postMessage(
        { ...request, masters },
        masters.map(({ master }) => master.buffer),
      );
    } catch {
      fail();
    }
  });
  return {
    result,
    cancel() {
      if (settled) return;
      settled = true;
      cleanup();
      const error = new Error('Verified network audit cancelled');
      error.name = 'AbortError';
      rejectJob?.(error);
    },
  };
}
