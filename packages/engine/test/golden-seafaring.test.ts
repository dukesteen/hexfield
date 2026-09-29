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

const directory = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'seafaring');
const SCENARIOS = [
  'new-horizons',
  'new-horizons-56',
  'four-isles',
  'four-isles-56',
  'fogbound',
  'fogbound-56',
  'desert-crossing',
  'desert-crossing-56',
  'open-sea',
  'open-sea-56',
];

// The fixtures are written by `pnpm sim golden --update --seafaring`, which validated their shape.
function read(file: string): unknown {
  return JSON.parse(readFileSync(join(directory, file), 'utf8'));
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const entries = (read('manifest.json') as { fixtures: Entry[] }).fixtures;

const commandTypes = (inputs: readonly Input[]): Set<string> =>
  new Set(inputs.flatMap((input) => (input.kind === 'command' ? [input.command.type] : [])));

describe('seafaring golden replays', () => {
  test('there is exactly one golden per seafaring scenario id', () => {
    expect(entries.map((entry) => entry.scenario)).toEqual(SCENARIOS);
    expect(new Set(entries.map((entry) => entry.file)).size).toBe(entries.length);
  });

  test('together they cover fog reveals, ship moves, the pirate, gold and island bonuses', () => {
    const features = new Set(entries.flatMap((entry) => entry.features));
    for (const feature of [
      'normal-completion',
      'ship-build',
      'setup-ship',
      'ship-move',
      'pirate-move',
      'gold-choice',
      'island-bonus',
      'fog-reveal',
    ])
      expect(features.has(feature), `missing ${feature}`).toBe(true);
    // Fog belongs to Fogbound alone, and both its goldens show it.
    expect(entries.filter((entry) => entry.features.includes('fog-reveal'))).toMatchObject([
      { scenario: 'fogbound' },
      { scenario: 'fogbound-56' },
    ]);
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
  const checks: [string, boolean][] = [
    ['ship-build', commands.has('BUILD_SHIP')],
    ['setup-ship', commands.has('PLACE_SETUP_SHIP')],
    ['ship-move', commands.has('MOVE_SHIP')],
    ['pirate-move', commands.has('MOVE_PIRATE')],
    ['gold-choice', commands.has('CHOOSE_GOLD')],
    [
      'fog-reveal',
      replay.inputs.some((input) => input.kind === 'system' && input.type === 'FOG_REVEALED'),
    ],
    ['normal-completion', state.result !== null],
  ];
  for (const [feature, happened] of checks) expect(shown.has(feature)).toBe(happened);
  const ext = state.ext.seafaring;
  const bonus = typeof ext === 'object' && ext !== null && 'bonus' in ext ? ext.bonus : [];
  expect(shown.has('island-bonus')).toBe(Array.isArray(bonus) && bonus.length > 0);
}
