import { appendFileSync } from 'node:fs';

const SCENARIO_COUNT = 9;
const MAX_SEEDS = 1_000;
const SHARD_SIZE = 40;

function safeInteger(raw, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a decimal safe integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function dayNumber(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('Nightly rotation requires a valid date');
  }
  return Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 86_400_000,
  );
}

export function createNetworkMatrix({ eventName, inputs = {}, now = new Date() }) {
  let seeds;
  let startIndex;
  if (eventName === 'workflow_dispatch') {
    seeds = safeInteger(inputs.network_seeds, 'network_seeds', { min: 1, max: MAX_SEEDS });
    startIndex = safeInteger(inputs.network_start_index, 'network_start_index');
  } else if (eventName === 'schedule') {
    seeds = 20;
    startIndex = dayNumber(now) * seeds;
  } else {
    seeds = 5;
    startIndex = 0;
  }

  if (startIndex > Number.MAX_SAFE_INTEGER - (seeds - 1)) {
    throw new Error('network_start_index and network_seeds exceed the safe game-index range');
  }

  const include = [];
  for (let scenario = 1; scenario <= SCENARIO_COUNT; scenario++) {
    for (let offset = 0; offset < seeds; offset += SHARD_SIZE) {
      include.push({
        scenario,
        startIndex: startIndex + offset,
        seeds: Math.min(SHARD_SIZE, seeds - offset),
      });
    }
  }
  return { include };
}

function writeOutput(matrix, outputPath) {
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(outputPath, `matrix=${JSON.stringify(matrix)}\n`, 'utf8');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const matrix = createNetworkMatrix({
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    inputs: {
      network_seeds: process.env.NETWORK_SEEDS,
      network_start_index: process.env.NETWORK_START_INDEX,
    },
  });
  writeOutput(matrix, process.env.GITHUB_OUTPUT);
}
