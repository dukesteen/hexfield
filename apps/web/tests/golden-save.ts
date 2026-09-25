import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromBase64Url, hashValue, toHex } from '@cp2p/codec';
import { createBaseEngine } from '@cp2p/engine';
import type { GameConfig, Input, Seat } from '@cp2p/engine';
import { LocalSession } from '../src/session/local-session.js';
import type { LocalSaveBatch, LocalSessionSave } from '../src/session/types.js';

const goldenDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/engine/test/golden',
);
const seats: readonly Seat[] = [0, 1, 2, 3, 4, 5];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function seat(value: unknown): value is Seat {
  return seats.some((candidate) => candidate === value);
}

function config(value: unknown): value is GameConfig {
  return (
    record(value) &&
    Array.isArray(value.modules) &&
    value.modules.every(
      (module) =>
        record(module) && typeof module.id === 'string' && typeof module.version === 'string',
    ) &&
    Array.isArray(value.seats) &&
    value.seats.every(seat) &&
    record(value.options)
  );
}

function input(value: unknown): value is Input {
  if (!record(value)) return false;
  return value.kind === 'system'
    ? typeof value.type === 'string'
    : value.kind === 'command' &&
        seat(value.seat) &&
        record(value.command) &&
        typeof value.command.type === 'string';
}

/** Build a browser-importable authority from an already verified engine golden prefix. */
export async function saveBeforeGoldenInput(
  file: string,
  stopBefore: number,
): Promise<LocalSessionSave> {
  const raw: unknown = JSON.parse(await readFile(join(goldenDirectory, file), 'utf8'));
  if (
    !record(raw) ||
    !config(raw.config) ||
    typeof raw.genesisSeed !== 'string' ||
    typeof raw.engineVersion !== 'string' ||
    !Array.isArray(raw.inputs) ||
    !raw.inputs.every(input)
  )
    throw new Error(`Malformed golden fixture ${file}`);
  if (!Number.isSafeInteger(stopBefore) || stopBefore < 1 || stopBefore > raw.inputs.length)
    throw new Error('Golden prefix is outside the replay');
  const prefix = raw.inputs.slice(0, stopBefore);
  const genesis = prefix[0];
  if (genesis?.kind !== 'system' || genesis.type !== 'START_SEAT')
    throw new Error('Golden replay does not begin with START_SEAT');
  const engine = createBaseEngine();
  let state = engine.createGame(raw.config, fromBase64Url(raw.genesisSeed));
  const batches: LocalSaveBatch[] = [];
  for (const next of prefix) {
    const applied = engine.apply(state, next);
    if (!applied.ok) throw new Error(`Golden prefix rejected: ${applied.error.code}`);
    state = applied.value.state;
    if (next === genesis) continue;
    if (next.kind === 'command') batches.push({ submitted: next, generated: [] });
    else {
      const batch = batches.at(-1);
      if (!batch) throw new Error('System outcome has no submitted command');
      batch.generated.push(next);
    }
  }
  const save: LocalSessionSave = {
    v: 1,
    mode: 'local',
    engineVersion: raw.engineVersion,
    config: raw.config,
    genesisSeed: raw.genesisSeed,
    roles: { humanSeats: [...raw.config.seats], botSeats: [] },
    genesis: [genesis],
    batches,
    finalHash: toHex(hashValue(state)),
  };
  const restored = LocalSession.restore(save, {
    entropy: { randomBytes: (target) => target.fill(1) },
  });
  if (!restored.ok) throw new Error(`Golden save did not replay: ${restored.error.message}`);
  restored.value.dispose();
  return save;
}
