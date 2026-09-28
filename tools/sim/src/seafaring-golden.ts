import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromBase64Url } from '@cp2p/codec';
import { engineForConfig } from '@cp2p/engine';
import type { GameState, Input, Seat } from '@cp2p/engine';
import { scenarioById, scenarioConfig } from '@cp2p/maps';
import { makeReplay, readReplay, verifyReplay, writeReplay } from './replay.js';
import { runGame } from './run-game.js';

export type SeafaringGoldenFeature =
  | 'normal-completion'
  | 'ship-build'
  | 'ship-move'
  | 'pirate-move'
  | 'gold-choice'
  | 'island-bonus'
  | 'fog-reveal'
  | 'setup-ship';

export interface SeafaringGoldenCase {
  /** File stem; also the scenario id. */
  name: string;
  scenario: string;
  seats: number;
  seed: number;
  /** Features the chosen game must show; the first game index that does is the fixture. */
  require: readonly SeafaringGoldenFeature[];
}

export interface SeafaringGoldenEntry {
  name: string;
  file: string;
  scenario: string;
  seats: number;
  seed: number;
  gameIndex: number;
  features: SeafaringGoldenFeature[];
  inputs: number;
  winner: Seat | null;
  engineVersion: string;
}

export const SEAFARING_GOLDEN_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/engine/test/golden/seafaring',
);

const CORE: readonly SeafaringGoldenFeature[] = ['normal-completion', 'ship-build'];

/** One full random-bot game per seafaring scenario id, chosen to exercise the module's paths. */
export const SEAFARING_GOLDEN_CASES: readonly SeafaringGoldenCase[] = [
  {
    name: 'new-horizons',
    scenario: 'new-horizons',
    seats: 4,
    seed: 1200,
    require: [...CORE, 'ship-move', 'pirate-move', 'gold-choice', 'island-bonus'],
  },
  {
    name: 'new-horizons-56',
    scenario: 'new-horizons-56',
    seats: 6,
    seed: 1200,
    require: [...CORE, 'ship-move', 'island-bonus'],
  },
  {
    name: 'four-isles',
    scenario: 'four-isles',
    seats: 4,
    seed: 1200,
    require: [...CORE, 'ship-move', 'island-bonus'],
  },
  {
    name: 'four-isles-56',
    scenario: 'four-isles-56',
    seats: 6,
    seed: 1200,
    require: [...CORE, 'island-bonus'],
  },
  {
    name: 'fogbound',
    scenario: 'fogbound',
    seats: 4,
    seed: 1200,
    require: [...CORE, 'fog-reveal', 'ship-move', 'pirate-move', 'gold-choice'],
  },
  {
    name: 'desert-crossing',
    scenario: 'desert-crossing',
    seats: 4,
    seed: 1200,
    require: [...CORE, 'ship-move', 'island-bonus'],
  },
  {
    name: 'open-sea',
    scenario: 'open-sea',
    seats: 4,
    seed: 1200,
    require: [...CORE, 'ship-move', 'pirate-move', 'island-bonus'],
  },
  {
    name: 'open-sea-56',
    scenario: 'open-sea-56',
    seats: 6,
    seed: 1200,
    require: [...CORE, 'island-bonus'],
  },
];

const MAX_SEARCH = 60;

function commandTypes(inputs: readonly Input[]): Set<string> {
  return new Set(inputs.flatMap((input) => (input.kind === 'command' ? [input.command.type] : [])));
}

/** The seafaring paths a finished game exercised, read from its inputs and final state. */
export function seafaringFeatures(
  inputs: readonly Input[],
  state: GameState,
): Set<SeafaringGoldenFeature> {
  const commands = commandTypes(inputs);
  const features = new Set<SeafaringGoldenFeature>();
  if (state.result) features.add('normal-completion');
  if (commands.has('BUILD_SHIP')) features.add('ship-build');
  if (commands.has('PLACE_SETUP_SHIP')) features.add('setup-ship');
  if (commands.has('MOVE_SHIP')) features.add('ship-move');
  if (commands.has('MOVE_PIRATE')) features.add('pirate-move');
  if (commands.has('CHOOSE_GOLD')) features.add('gold-choice');
  if (inputs.some((input) => input.kind === 'system' && input.type === 'FOG_REVEALED'))
    features.add('fog-reveal');
  const ext = state.ext.seafaring;
  if (typeof ext === 'object' && ext !== null && 'bonus' in ext) {
    const bonus: unknown = ext.bonus;
    if (Array.isArray(bonus) && bonus.length > 0) features.add('island-bonus');
  }
  return features;
}

function findGame(item: SeafaringGoldenCase) {
  const scenario = scenarioById(item.scenario);
  if (!scenario) throw new Error(`Unknown seafaring golden scenario ${item.scenario}`);
  const config = scenarioConfig(scenario, item.seats);
  for (let gameIndex = 0; gameIndex < MAX_SEARCH; gameIndex++) {
    const result = runGame({ seed: item.seed, gameIndex, config });
    const features = seafaringFeatures(result.inputs, result.state);
    if (item.require.every((feature) => features.has(feature)))
      return { gameIndex, result, features };
  }
  throw new Error(
    `No game in ${MAX_SEARCH} shows ${item.require.join(', ')} for ${item.name}; relax the case`,
  );
}

/** Regenerate the per-scenario seafaring goldens. Refuses to overwrite a fixture that regressed. */
export function updateSeafaringGoldens(
  options: {
    update?: boolean;
    outputDirectory?: string;
    cases?: readonly SeafaringGoldenCase[];
  } = {},
): { written: string[] } {
  if (options.update !== true)
    throw new Error('Golden replay updates require explicit update mode');
  const outputDirectory = resolve(options.outputDirectory ?? SEAFARING_GOLDEN_DIRECTORY);
  const cases = options.cases ?? SEAFARING_GOLDEN_CASES;
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
  const manifest: SeafaringGoldenEntry[] = [];
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
