import { Worker } from 'node:worker_threads';
import { runNetworkGame } from './net.js';
import type { NetworkGameResult } from './net.js';

const MAX_WORKERS = 16;

export interface NetBatchOptions {
  seeds: number;
  startIndex: number;
  seed: number;
  scenario: number;
  parallel: number;
}

export interface NetBatchFailure {
  gameIndex: number;
  message: string;
}

export interface NetBatchPart {
  results: NetworkGameResult[];
  failures: NetBatchFailure[];
}

export interface NetBatchResult extends NetBatchPart {
  options: NetBatchOptions;
  requestedSeeds: number;
  completedGames: number;
  averageTurns: number | null;
  averageInputs: number | null;
  averageVirtualMilliseconds: number | null;
  averageElapsedMilliseconds: number | null;
}

export function parseNetBatchOptions(args: readonly string[]): NetBatchOptions {
  const values = new Map<string, string>();
  const accepted = new Set(['scenario', 'seeds', 'start-index', 'seed', 'parallel']);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!flag?.startsWith('--')) throw new Error(`Unexpected network argument ${String(flag)}`);
    const name = flag.slice(2);
    if (!accepted.has(name)) throw new Error(`Unknown network option --${name}`);
    if (values.has(name)) throw new Error(`Duplicate network option --${name}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`--${name} needs an integer value`);
    if (!/^-?\d+$/.test(value)) throw new Error(`--${name} needs an integer value`);
    values.set(name, value);
    index++;
  }
  const parse = (name: string, fallback: number): number => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new Error(`--${name} needs a safe integer`);
    return value;
  };
  const options = {
    scenario: parse('scenario', 1),
    seeds: parse('seeds', 1),
    startIndex: parse('start-index', 0),
    seed: parse('seed', 42),
    parallel: parse('parallel', 1),
  };
  if (options.scenario < 1 || options.scenario > 9)
    throw new Error('--scenario must be between 1 and 9');
  if (options.seeds < 1) throw new Error('--seeds must be positive');
  if (options.startIndex < 0) throw new Error('--start-index must be non-negative');
  if (options.startIndex > Number.MAX_SAFE_INTEGER - (options.seeds - 1))
    throw new Error('--start-index and --seeds exceed the safe game-index range');
  if (options.seed < 0) throw new Error('--seed must be non-negative');
  if (options.parallel < 1 || options.parallel > MAX_WORKERS)
    throw new Error(`--parallel must be between 1 and ${MAX_WORKERS}`);
  return options;
}

/** Partition a deterministic contiguous game-index range across worker slices. */
export function partitionGameIndices(options: NetBatchOptions): number[][] {
  const workers = Math.min(options.parallel, options.seeds);
  return Array.from({ length: workers }, (_, workerIndex) =>
    Array.from(
      { length: Math.ceil((options.seeds - workerIndex) / workers) },
      (_unused, offset) => options.startIndex + workerIndex + offset * workers,
    ).filter((gameIndex) => gameIndex < options.startIndex + options.seeds),
  );
}

async function runWorker(indices: number[], options: NetBatchOptions): Promise<NetBatchPart> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./net-worker.js', import.meta.url), {
      workerData: { seed: options.seed, scenario: options.scenario, gameIndices: indices },
    });
    let settled = false;
    worker.once('message', (message: NetBatchPart) => {
      settled = true;
      resolve(message);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`Network simulation worker exited with code ${code}`));
    });
  });
}

async function runIndices(
  gameIndices: readonly number[],
  options: NetBatchOptions,
): Promise<NetBatchPart> {
  const results: NetworkGameResult[] = [];
  const failures: NetBatchFailure[] = [];
  for (const gameIndex of gameIndices) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Keep each worker's deterministic slice sequential.
      const result = await runNetworkGame({
        seed: options.seed,
        gameIndex,
        scenario: options.scenario,
      });
      results.push(result);
    } catch (error) {
      failures.push({ gameIndex, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { results, failures };
}

/** Run contiguous deterministic game indices with a hard worker limit. */
export async function runNetworkBatch(options: NetBatchOptions): Promise<NetBatchResult> {
  if (options.startIndex > Number.MAX_SAFE_INTEGER - (options.seeds - 1))
    throw new Error('Network game-index range exceeds the safe integer limit');
  const gameIndices = partitionGameIndices(options);
  const parts =
    gameIndices.length === 1
      ? [await runIndices(gameIndices[0] ?? [], options)]
      : await Promise.all(gameIndices.map((indices) => runWorker(indices, options)));
  const results = parts
    .flatMap((part) => part.results)
    .toSorted((a, b) => a.gameIndex - b.gameIndex);
  const failures = parts
    .flatMap((part) => part.failures)
    .toSorted((a, b) => a.gameIndex - b.gameIndex);
  const total = (select: (result: NetworkGameResult) => number) =>
    results.reduce((sum, result) => sum + select(result), 0);
  const completedGames = results.length;
  const average = (select: (result: NetworkGameResult) => number) =>
    completedGames ? total(select) / completedGames : null;
  return {
    options,
    requestedSeeds: options.seeds,
    completedGames,
    averageTurns: average((result) => result.turns),
    averageInputs: average((result) => result.inputs),
    averageVirtualMilliseconds: average((result) => result.virtualMilliseconds),
    averageElapsedMilliseconds: average((result) => result.elapsedMilliseconds),
    results,
    failures,
  };
}
