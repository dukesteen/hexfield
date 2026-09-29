import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromBase64Url } from '@cp2p/codec';
import { engineForConfig, knightsExt } from '@cp2p/engine';
import type { GameState, Input, Seat } from '@cp2p/engine';
import { scenarioById, scenarioConfig } from '@cp2p/maps';
import { makeReplay, readReplay, verifyReplay, writeReplay } from './replay.js';
import { runGame } from './run-game.js';

export type KnightsGoldenFeature =
  | 'normal-completion'
  | 'barbarian-attack'
  | 'pillage'
  | 'defender-card'
  | 'metropolis'
  | 'knight-displace'
  | 'chase-robber'
  | 'progress-heavy';

/** A game that plays at least this many progress cards counts as progress-heavy. */
export const PROGRESS_HEAVY_PLAYS = 100;

export interface KnightsGoldenCase {
  /** File stem. */
  name: string;
  scenario: string;
  seats: number;
  seed: number;
  /** Features the chosen game must show; the first game index that does is the fixture. */
  require: readonly KnightsGoldenFeature[];
}

export interface KnightsGoldenEntry {
  name: string;
  file: string;
  scenario: string;
  seats: number;
  seed: number;
  gameIndex: number;
  features: KnightsGoldenFeature[];
  progressPlays: number;
  inputs: number;
  winner: Seat | null;
  engineVersion: string;
}

export const KNIGHTS_GOLDEN_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/engine/test/golden/knights',
);

const CORE: readonly KnightsGoldenFeature[] = [
  'normal-completion',
  'barbarian-attack',
  'pillage',
  'metropolis',
];

/** Five full random-bot knights games: every seat count, and one seed chosen for progress cards. */
export const KNIGHTS_GOLDEN_CASES: readonly KnightsGoldenCase[] = [
  {
    name: 'knights-3p',
    scenario: 'knights',
    seats: 3,
    seed: 1300,
    require: [...CORE, 'defender-card'],
  },
  {
    name: 'knights-4p',
    scenario: 'knights',
    seats: 4,
    seed: 1300,
    require: [...CORE, 'defender-card'],
  },
  {
    name: 'knights-4p-progress',
    scenario: 'knights',
    seats: 4,
    seed: 1310,
    require: [...CORE, 'progress-heavy', 'chase-robber'],
  },
  {
    name: 'knights-56-5p',
    scenario: 'knights-56',
    seats: 5,
    seed: 1300,
    require: [...CORE, 'defender-card'],
  },
  {
    name: 'knights-56-6p',
    scenario: 'knights-56',
    seats: 6,
    seed: 1300,
    require: [...CORE, 'defender-card', 'knight-displace'],
  },
];

const MAX_SEARCH = 60;

function commandCount(inputs: readonly Input[], type: string): number {
  return inputs.filter((input) => input.kind === 'command' && input.command.type === type).length;
}

/** The knights paths a finished game exercised, read from its inputs and final state. */
export function knightsFeatures(
  inputs: readonly Input[],
  state: GameState,
): { features: Set<KnightsGoldenFeature>; progressPlays: number } {
  const features = new Set<KnightsGoldenFeature>();
  const ext = knightsExt(state);
  const progressPlays = commandCount(inputs, 'PLAY_PROGRESS_CARD');
  if (state.result) features.add('normal-completion');
  if (!ext.robberLocked) features.add('barbarian-attack');
  if (commandCount(inputs, 'CHOOSE_PILLAGE') > 0) features.add('pillage');
  if (ext.defenders.some((count) => count > 0)) features.add('defender-card');
  if (commandCount(inputs, 'PLACE_METROPOLIS') > 0) features.add('metropolis');
  if (commandCount(inputs, 'DISPLACE_KNIGHT') > 0) features.add('knight-displace');
  if (commandCount(inputs, 'CHASE_ROBBER') > 0) features.add('chase-robber');
  if (progressPlays >= PROGRESS_HEAVY_PLAYS) features.add('progress-heavy');
  return { features, progressPlays };
}

function findGame(item: KnightsGoldenCase) {
  const scenario = scenarioById(item.scenario);
  if (!scenario) throw new Error(`Unknown knights golden scenario ${item.scenario}`);
  const config = scenarioConfig(scenario, item.seats);
  for (let gameIndex = 0; gameIndex < MAX_SEARCH; gameIndex++) {
    const result = runGame({ seed: item.seed, gameIndex, config });
    const { features, progressPlays } = knightsFeatures(result.inputs, result.state);
    if (item.require.every((feature) => features.has(feature)))
      return { gameIndex, result, features, progressPlays };
  }
  throw new Error(
    `No game in ${MAX_SEARCH} shows ${item.require.join(', ')} for ${item.name}; relax the case`,
  );
}

/** Regenerate the per-scenario knights goldens. Refuses to overwrite a fixture that regressed. */
export function updateKnightsGoldens(
  options: {
    update?: boolean;
    outputDirectory?: string;
    cases?: readonly KnightsGoldenCase[];
  } = {},
): { written: string[] } {
  if (options.update !== true)
    throw new Error('Golden replay updates require explicit update mode');
  const outputDirectory = resolve(options.outputDirectory ?? KNIGHTS_GOLDEN_DIRECTORY);
  const cases = options.cases ?? KNIGHTS_GOLDEN_CASES;
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
  const manifest: KnightsGoldenEntry[] = [];
  const written: string[] = [];
  mkdirSync(outputDirectory, { recursive: true });
  for (const item of cases) {
    const { gameIndex, result, features, progressPlays } = findGame(item);
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
      progressPlays,
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
