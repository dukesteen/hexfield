import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { fromBase64Url, hashValue, toHex } from '@cp2p/codec';
import { engineForConfig, knightsExt } from '../src/index.js';
import type { GameConfig, GameState, Input, Seat } from '../src/index.js';

interface Replay {
  format: 'cp2p-replay';
  version: 1;
  engineVersion: string;
  config: GameConfig;
  genesisSeed: string;
  inputs: Input[];
  checkpoints: { index: number; stateHash: string }[];
}

interface Entry {
  name: string;
  file: string;
  scenario: string;
  seats: number;
  features: string[];
  progressPlays: number;
  inputs: number;
  winner: Seat | null;
  engineVersion: string;
}

const directory = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'knights');
// Mirrors PROGRESS_HEAVY_PLAYS in tools/sim/src/knights-golden.ts.
const PROGRESS_HEAVY_PLAYS = 100;
const NAMES = ['knights-3p', 'knights-4p', 'knights-4p-progress', 'knights-56-5p', 'knights-56-6p'];

// The fixtures are written by `pnpm sim golden --update --knights`, which validated their shape.
function read(file: string): unknown {
  return JSON.parse(readFileSync(join(directory, file), 'utf8'));
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const entries = (read('manifest.json') as { fixtures: Entry[] }).fixtures;

const count = (inputs: readonly Input[], type: string): number =>
  inputs.filter((input) => input.kind === 'command' && input.command.type === type).length;

describe('knights golden replays', () => {
  test('there are five goldens: 3, 4 and 4 (progress-heavy) seats on knights, 5 and 6 on knights-56', () => {
    expect(entries.map((entry) => entry.name)).toEqual(NAMES);
    expect(entries.map((entry) => entry.seats)).toEqual([3, 4, 4, 5, 6]);
    expect(entries.map((entry) => entry.scenario)).toEqual([
      'knights',
      'knights',
      'knights',
      'knights-56',
      'knights-56',
    ]);
    expect(new Set(entries.map((entry) => entry.file)).size).toBe(entries.length);
  });

  test('together they cover attacks, pillage, defenders, metropolises, chases, displacement and progress', () => {
    const features = new Set(entries.flatMap((entry) => entry.features));
    for (const feature of [
      'normal-completion',
      'barbarian-attack',
      'pillage',
      'defender-card',
      'metropolis',
      'knight-displace',
      'chase-robber',
      'progress-heavy',
    ])
      expect(features.has(feature), `missing ${feature}`).toBe(true);
  });

  test.each(entries)(
    '$name replays, matches every checkpoint and keeps its invariants',
    (entry) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const replay = read(entry.file) as Replay;
      expect(replay.engineVersion).toBe(entry.engineVersion);
      expect(replay.inputs).toHaveLength(entry.inputs);
      expect(replay.config.seats).toHaveLength(entry.seats);
      const engine = engineForConfig(replay.config);
      let state = engine.createGame(replay.config, fromBase64Url(replay.genesisSeed));
      expect(state.engineVersion).toBe(entry.engineVersion);
      let privates = new Map(
        replay.config.seats.map((seat) => [seat, engine.createPrivateState(seat, replay.config)]),
      );
      const checkpoints = new Map(replay.checkpoints.map((item) => [item.index, item.stateHash]));
      expect(checkpoints.get(0)).toBe(toHex(hashValue(state)));
      for (const [index, input] of replay.inputs.entries()) {
        const applied = engine.apply(state, input);
        if (!applied.ok)
          throw new Error(`${entry.file} input ${index} rejected: ${applied.error.message}`);
        const nextPrivates = new Map(privates);
        for (const seat of replay.config.seats) {
          const previous = privates.get(seat);
          if (!previous) throw new Error(`Missing private state for seat ${seat}`);
          const next = engine.applyPrivate(previous, state, input);
          if (!next.ok)
            throw new Error(`${entry.file} private input ${index} rejected: ${next.error.message}`);
          nextPrivates.set(seat, next.value);
        }
        state = applied.value.state;
        privates = nextPrivates;
        expect(engine.checkInvariants(state)).toEqual([]);
        expect(engine.checkPrivateInvariants(state, privates)).toEqual([]);
        const expected = checkpoints.get(index + 1);
        expect(expected === undefined || toHex(hashValue(state)) === expected).toBe(true);
      }
      expect(state.result?.winner ?? null).toBe(entry.winner);
      expect(state.result).not.toBeNull();
      assertFeatures(entry, replay, state);
    },
    120_000,
  );
});

function assertFeatures(entry: Entry, replay: Replay, state: GameState): void {
  const ext = knightsExt(state);
  const plays = count(replay.inputs, 'PLAY_PROGRESS_CARD');
  expect(plays).toBe(entry.progressPlays);
  const checks: [string, boolean][] = [
    ['normal-completion', state.result !== null],
    ['barbarian-attack', !ext.robberLocked],
    ['pillage', count(replay.inputs, 'CHOOSE_PILLAGE') > 0],
    ['defender-card', ext.defenders.some((defenders) => defenders > 0)],
    ['metropolis', count(replay.inputs, 'PLACE_METROPOLIS') > 0],
    ['knight-displace', count(replay.inputs, 'DISPLACE_KNIGHT') > 0],
    ['chase-robber', count(replay.inputs, 'CHASE_ROBBER') > 0],
    ['progress-heavy', plays >= PROGRESS_HEAVY_PLAYS],
  ];
  const shown = new Set(entry.features);
  for (const [feature, happened] of checks) expect(shown.has(feature)).toBe(happened);
}
