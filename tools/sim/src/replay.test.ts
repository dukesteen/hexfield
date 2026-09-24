import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createBaseEngine } from '@cp2p/engine';
import type { GameConfig, Input } from '@cp2p/engine';
import {
  REPLAY_FORMAT,
  ReplayError,
  makeReplay,
  parseReplay,
  readReplay,
  verifyReplay,
  writeReplay,
} from './replay.js';

const engine = createBaseEngine();
const seed = new Uint8Array(32).fill(11);
const config: GameConfig = {
  modules: [{ id: 'base', version: '1.0.0' }],
  seats: [0, 1],
  options: { base: { mapLayout: 'random' } },
};
const acceptedInputs: Input[] = [{ kind: 'system', type: 'START_SEAT', seat: 1 }];
const directories: string[] = [];

function fixture() {
  return makeReplay(engine, config, seed, acceptedInputs, 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mutateReplay(change: (value: Record<string, unknown>) => void): unknown {
  const value: unknown = JSON.parse(JSON.stringify(fixture()));
  if (!isRecord(value)) throw new Error('Fixture was not a record');
  change(value);
  return value;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('replay files', () => {
  test('hashes genesis and periodic/final states, then replays the accepted input prefix', () => {
    const replay = fixture();
    expect(replay.format).toBe(REPLAY_FORMAT);
    expect(replay.checkpoints.map(({ index }) => index)).toEqual([0, 1]);
    const state = verifyReplay(engine, replay);
    expect(state.turn.activeSeat).toBe(1);
    expect(state.counters.inputSeq).toBe(1);
    expect(replay.engineVersion).toBe('0.1.0');
  });

  test('round trips a replay file through the atomic file helpers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cp2p-replay-'));
    directories.push(directory);
    const path = join(directory, 'sample.replay.json');
    const replay = fixture();
    writeReplay(path, replay);
    expect(readFileSync(path, 'utf8')).toContain('"format": "cp2p-replay"');
    expect(readReplay(path)).toEqual(replay);
    expect(verifyReplay(engine, readReplay(path))).toEqual(verifyReplay(engine, replay));
  });

  test('rejects unsupported versions, fields, and malformed input data', () => {
    expect(() =>
      parseReplay(mutateReplay((value) => Reflect.set(value, 'format', 'other'))),
    ).toThrow(/format identifier/);
    expect(() => parseReplay(mutateReplay((value) => Reflect.set(value, 'version', 2)))).toThrow(
      /not supported/,
    );
    expect(() => parseReplay(mutateReplay((value) => Reflect.set(value, 'extra', true)))).toThrow(
      /invalid shapes/,
    );
    expect(() =>
      parseReplay(
        mutateReplay((value) => {
          value.inputs = [{ kind: 'command', seat: 0, command: { type: 4 } }];
        }),
      ),
    ).toThrow(/invalid shapes/);
    expect(() =>
      parseReplay(
        mutateReplay((value) => {
          value.inputs = [
            { kind: 'command', seat: 0, command: { type: 'END_TURN', extra: undefined } },
          ];
        }),
      ),
    ).toThrow(/canonical JSON/);
    expect(() =>
      parseReplay(
        mutateReplay((value) => {
          value.inputs = [new Date(0)];
        }),
      ),
    ).toThrow(/invalid shapes/);
  });

  test('rejects noncanonical or wrong-length genesis seeds', () => {
    expect(() =>
      parseReplay(mutateReplay((value) => Reflect.set(value, 'genesisSeed', 'bad!'))),
    ).toThrow(ReplayError);
    expect(() =>
      parseReplay(mutateReplay((value) => Reflect.set(value, 'genesisSeed', 'AQ'))),
    ).toThrow(/exactly 32 bytes/);
  });

  test('requires increasing checkpoints from genesis through the final input count', () => {
    expect(() =>
      parseReplay(
        mutateReplay((value) => {
          value.checkpoints = [
            { index: 0, stateHash: '0'.repeat(64) },
            { index: 0, stateHash: '0'.repeat(64) },
          ];
        }),
      ),
    ).toThrow(/malformed/);
    expect(() =>
      parseReplay(
        mutateReplay((value) => {
          value.checkpoints = [{ index: 1, stateHash: '0'.repeat(64) }];
        }),
      ),
    ).toThrow(/include genesis/);
    expect(() =>
      parseReplay(
        mutateReplay((value) => {
          value.checkpoints = [
            { index: 0, stateHash: '0'.repeat(64) },
            { index: 2, stateHash: '0'.repeat(64) },
          ];
        }),
      ),
    ).toThrow(/malformed/);
    expect(() => makeReplay(engine, config, seed, acceptedInputs, 0)).toThrow(/positive/);
  });

  test('detects version drift, a changed checkpoint, and rejected inputs', () => {
    expect(() =>
      verifyReplay(
        engine,
        mutateReplay((value) => Reflect.set(value, 'engineVersion', '9.0.0')),
      ),
    ).toThrow(/requires engine/);
    expect(() =>
      verifyReplay(
        engine,
        mutateReplay((value) => {
          value.checkpoints = [
            { index: 0, stateHash: '0'.repeat(64) },
            { index: 1, stateHash: '0'.repeat(64) },
          ];
        }),
      ),
    ).toThrow(/Checkpoint 0 differs/);
    expect(() =>
      makeReplay(engine, config, seed, [{ kind: 'system', type: 'START_SEAT', seat: 99 }]),
    ).toThrow(/Input 0 was rejected/);
  });

  test('can preserve one final invariant-failing accepted transition for failure repros', () => {
    const brokenEngine = {
      ...engine,
      apply(before: Parameters<typeof engine.apply>[0], input: Input) {
        const applied = engine.apply(before, input);
        if (!applied.ok) return applied;
        return {
          ...applied,
          value: {
            ...applied.value,
            state: {
              ...applied.value.state,
              counters: { ...applied.value.state.counters, inputSeq: -1 },
            },
          },
        };
      },
    };
    expect(() => makeReplay(brokenEngine, config, seed, acceptedInputs, 1)).toThrow(
      /failed invariants/,
    );
    const failureReplay = makeReplay(brokenEngine, config, seed, acceptedInputs, 1, {
      allowFinalInvariantFailure: true,
    });
    expect(() => verifyReplay(brokenEngine, failureReplay)).toThrow(/failed invariants/);
    expect(
      verifyReplay(brokenEngine, failureReplay, { allowFinalInvariantFailure: true }).counters
        .inputSeq,
    ).toBe(-1);
  });

  test('reports malformed replay files with a stable error code', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cp2p-replay-'));
    directories.push(directory);
    const path = join(directory, 'broken.replay.json');
    writeFileSync(path, '{broken');
    expect(() => readReplay(path)).toThrow(ReplayError);
    expect(() => readReplay(join(directory, 'missing.json'))).toThrow(ReplayError);
  });
});
