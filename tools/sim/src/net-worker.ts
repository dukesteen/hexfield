import { parentPort, workerData } from 'node:worker_threads';
import * as v from 'valibot';
import { runNetworkGame } from './net.js';
import type { NetworkGameResult } from './net.js';
import type { NetBatchFailure, NetBatchPart } from './net-batch.js';

const safeInteger = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
const workerSchema = v.strictObject({
  seed: safeInteger,
  scenario: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(9)),
  gameIndices: v.pipe(v.array(safeInteger), v.minLength(1)),
});

async function execute(): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error('Network worker has no parent port');
  const parsed = v.safeParse(workerSchema, workerData);
  if (!parsed.success) throw new Error('Network worker received invalid job data');
  const results: NetworkGameResult[] = [];
  const failures: NetBatchFailure[] = [];
  for (const gameIndex of parsed.output.gameIndices) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Keep each worker's deterministic slice sequential.
      const result = await runNetworkGame({
        seed: parsed.output.seed,
        gameIndex,
        scenario: parsed.output.scenario,
      });
      results.push(result);
    } catch (error) {
      failures.push({ gameIndex, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const result: NetBatchPart = { results, failures };
  port.postMessage(result);
}

await execute();
