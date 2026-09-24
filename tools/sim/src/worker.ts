import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { BatchOptions } from './batch.js';
import { runBatch } from './batch.js';

if (isMainThread || !parentPort) throw new Error('Simulation worker must run in a worker thread');

function isBatchOptions(value: unknown): value is BatchOptions {
  return (
    typeof value === 'object' &&
    value !== null &&
    'seed' in value &&
    typeof value.seed === 'number' &&
    'games' in value &&
    typeof value.games === 'number'
  );
}

const options: unknown = workerData;
if (!isBatchOptions(options)) throw new Error('Malformed simulation worker options');
// Node worker_threads MessagePort has a transfer list, not a target origin.
// oxlint-disable-next-line unicorn/require-post-message-target-origin
parentPort.postMessage(runBatch(options));
