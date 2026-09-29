import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromBase64Url } from '@cp2p/codec';
import { comboExt, engineForConfig, knightsExt } from '@cp2p/engine';
import type { GameState, Input, Seat } from '@cp2p/engine';
import { scenarioById, scenarioConfig } from '@cp2p/maps';
import { makeReplay, readReplay, verifyReplay, writeReplay } from './replay.js';
import { runGame } from './run-game.js';
import { seafaringFeatures } from './seafaring-golden.js';

export type SeafarersKnightsGoldenFeature =
  | 'normal-completion'
  | 'ship-build'
  | 'ship-move'
  | 'setup-ship'
  | 'pirate-move'
  | 'gold-choice'
  | 'island-bonus'
  | 'barbarian-attack'
  | 'pirate-entered'
  | 'knight-build'
  | 'knight-move'
  | 'chase'
  | 'free-ship';

export interface SeafarersKnightsGoldenCase {
  /** File stem; also the scenario id. */
  name: string;
  scenario: string;
  seats: number;
  seed: number;
  /** Features the chosen game must show; the first game index that does is the fixture. */
  require: readonly SeafarersKnightsGoldenFeature[];
}

export interface SeafarersKnightsGoldenEntry {
  name: string;
  file: string;
  scenario: string;
  seats: number;
  seed: number;
  gameIndex: number;
  features: SeafarersKnightsGoldenFeature[];
  inputs: number;
  winner: Seat | null;
  engineVersion: string;
}

export const SEAFARERS_KNIGHTS_GOLDEN_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/engine/test/golden/seafarers-knights',
);

const CORE: readonly SeafarersKnightsGoldenFeature[] = [
  'normal-completion',
  'ship-build',
  'barbarian-attack',
  'pirate-entered',
  'knight-build',
];

/** One full random-bot game per combined scenario id. */
export const SEAFARERS_KNIGHTS_GOLDEN_CASES: readonly SeafarersKnightsGoldenCase[] = [
  {
    name: 'new-horizons-knights',
    scenario: 'new-horizons-knights',
    seats: 4,
    seed: 1400,
    require: [...CORE, 'ship-move', 'pirate-move', 'gold-choice', 'island-bonus', 'knight-move'],
  },
  {
    name: 'new-horizons-knights-56',
    scenario: 'new-horizons-knights-56',
    seats: 6,
    seed: 1400,
    require: [...CORE, 'ship-move', 'island-bonus'],
  },
  {
    name: 'desert-crossing-knights',
    scenario: 'desert-crossing-knights',
    seats: 4,
    seed: 1400,
    require: [...CORE, 'ship-move', 'pirate-move', 'island-bonus'],
  },
];

const MAX_SEARCH = 80;

/** The combined paths a finished game exercised, read from its inputs and final state. */
export function seafarersKnightsFeatures(
  inputs: readonly Input[],
  state: GameState,
): Set<SeafarersKnightsGoldenFeature> {
  const features = new Set<SeafarersKnightsGoldenFeature>();
  for (const feature of seafaringFeatures(inputs, state))
    if (feature !== 'fog-reveal') features.add(feature);
  const commands = new Set(
    inputs.flatMap((input) => (input.kind === 'command' ? [input.command.type] : [])),
  );
  if (knightsExt(state).lastAttack !== null) features.add('barbarian-attack');
  if (comboExt(state).pirateEntered) features.add('pirate-entered');
  if (commands.has('BUILD_KNIGHT')) features.add('knight-build');
  if (commands.has('MOVE_KNIGHT')) features.add('knight-move');
  if (commands.has('CHASE_ROBBER')) features.add('chase');
  if (commands.has('PLACE_FREE_SHIP')) features.add('free-ship');
  return features;
}

function findGame(item: SeafarersKnightsGoldenCase) {
  const scenario = scenarioById(item.scenario);
  if (!scenario) throw new Error(`Unknown golden scenario ${item.scenario}`);
  const config = scenarioConfig(scenario, item.seats);
  for (let gameIndex = 0; gameIndex < MAX_SEARCH; gameIndex++) {
    const result = runGame({ seed: item.seed, gameIndex, config });
    const features = seafarersKnightsFeatures(result.inputs, result.state);
    if (item.require.every((feature) => features.has(feature)))
      return { gameIndex, result, features };
  }
  throw new Error(
    `No game in ${MAX_SEARCH} shows ${item.require.join(', ')} for ${item.name}; relax the case`,
  );
}

/** Regenerate the combined goldens. Refuses to overwrite a fixture that regressed. */
export function updateSeafarersKnightsGoldens(
  options: {
    update?: boolean;
    outputDirectory?: string;
    cases?: readonly SeafarersKnightsGoldenCase[];
  } = {},
): { written: string[] } {
  if (options.update !== true)
    throw new Error('Golden replay updates require explicit update mode');
  const outputDirectory = resolve(options.outputDirectory ?? SEAFARERS_KNIGHTS_GOLDEN_DIRECTORY);
  const cases = options.cases ?? SEAFARERS_KNIGHTS_GOLDEN_CASES;
  const names = new Set<string>();
  for (const item of cases) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item.name) || names.has(item.name))
      throw new Error(`Golden case name is invalid or duplicated: ${item.name}`);
    names.add(item.name);
  }
  // An existing same-version baseline that no longer verifies is a rules change: bump first.
  for (const item of cases) {
    const path = join(outputDirectory, `${item.name}.replay.json`);
    if (!existsSync(path)) continue;
    const replay = readReplay(path);
    const engine = engineForConfig(replay.config);
    const version = engine.createGame(
      replay.config,
      fromBase64Url(replay.genesisSeed),
    ).engineVersion;
    if (replay.engineVersion !== version) continue;
    try {
      verifyReplay(engine, replay);
    } catch (error) {
      throw new Error(
        `Golden replay ${replay.engineVersion} no longer verifies for ${item.name}; bump engineVersion before updating baselines: ${String(error)}`,
        { cause: error },
      );
    }
  }
  const manifest: SeafarersKnightsGoldenEntry[] = [];
  const written: string[] = [];
  mkdirSync(outputDirectory, { recursive: true });
  for (const item of cases) {
    const { gameIndex, result, features } = findGame(item);
    const engine = engineForConfig(result.config);
    const replay = makeReplay(engine, result.config, result.genesisSeed, result.inputs);
    const file = `${item.name}.replay.json`;
    writeReplay(join(outputDirectory, file), replay);
    manifest.push({
      name: item.name,
      file,
      scenario: item.scenario,
      seats: item.seats,
      seed: item.seed,
      gameIndex,
      features: [...features].toSorted(),
      inputs: replay.inputs.length,
      winner: result.state.result?.winner ?? null,
      engineVersion: replay.engineVersion,
    });
    written.push(file);
  }
  const manifestPath = join(outputDirectory, 'manifest.json');
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ format: 'cp2p-golden-manifest', version: 1, fixtures: manifest }, null, 2)}\n`,
  );
  written.push(manifestPath);
  return { written };
}
