import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { fromBase64Url, hashValue, toHex } from '@cp2p/codec';
import { engineForConfig } from '../src/index.js';
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
  inputs: number;
  winner: Seat | null;
  engineVersion: string;
}

const directory = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'seafarers-knights');
const SCENARIOS = ['new-horizons-knights', 'new-horizons-knights-56', 'desert-crossing-knights'];

// The fixtures are written by `pnpm sim golden --update --seafarers-knights`, which validated them.
function read(file: string): unknown {
  return JSON.parse(readFileSync(join(directory, file), 'utf8'));
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const entries = (read('manifest.json') as { fixtures: Entry[] }).fixtures;

const commandTypes = (inputs: readonly Input[]): Set<string> =>
  new Set(inputs.flatMap((input) => (input.kind === 'command' ? [input.command.type] : [])));

describe('seafaring with knights golden replays', () => {
  test('there is exactly one golden per combined scenario id', () => {
    expect(entries.map((entry) => entry.scenario)).toEqual(SCENARIOS);
    expect(new Set(entries.map((entry) => entry.file)).size).toBe(entries.length);
  });

  test('together they cover ships, the pirate, gold, the barbarians and knights', () => {
    const features = new Set(entries.flatMap((entry) => entry.features));
    for (const feature of [
      'normal-completion',
      'ship-build',
      'ship-move',
      'pirate-move',
      'gold-choice',
      'island-bonus',
      'barbarian-attack',
      'pirate-entered',
      'knight-build',
      'knight-move',
    ])
      expect(features.has(feature), `missing ${feature}`).toBe(true);
    // Every game had its first attack, so the pirate entered in each of them.
    for (const entry of entries) expect(entry.features).toContain('pirate-entered');
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
  const commands = commandTypes(replay.inputs);
  const shown = new Set(entry.features);
  const ext = (id: string): Record<string, unknown> => {
    const value = state.ext[id];
    return typeof value === 'object' && value !== null ? { ...value } : {};
  };
  const bonus = ext('seafaring').bonus;
  const checks: [string, boolean][] = [
    ['ship-build', commands.has('BUILD_SHIP')],
    ['setup-ship', commands.has('PLACE_SETUP_SHIP')],
    ['ship-move', commands.has('MOVE_SHIP')],
    ['pirate-move', commands.has('MOVE_PIRATE')],
    ['gold-choice', commands.has('CHOOSE_GOLD')],
    ['knight-build', commands.has('BUILD_KNIGHT')],
    ['knight-move', commands.has('MOVE_KNIGHT')],
    ['chase', commands.has('CHASE_ROBBER')],
    ['free-ship', commands.has('PLACE_FREE_SHIP')],
    ['barbarian-attack', ext('knights').lastAttack !== null],
    ['pirate-entered', ext('scenario:seafarers-knights').pirateEntered === true],
    ['island-bonus', Array.isArray(bonus) && bonus.length > 0],
    ['normal-completion', state.result !== null],
  ];
  for (const [feature, happened] of checks)
    expect({ feature, shown: shown.has(feature) }).toEqual({ feature, shown: happened });
  // The barbarian track stands outside the explicit board all game long.
  expect(state.board.fixtures).toHaveLength(1);
}
