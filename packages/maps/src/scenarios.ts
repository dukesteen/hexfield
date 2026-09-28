import {
  FIVE_SIX_BOARD,
  MODULE_CATALOGUE,
  STANDARD_BOARD,
  checkModuleSelection,
  moduleSelection,
} from '@cp2p/engine';
import type { BoardShapeSpec, BoardState, GameConfig, Seat } from '@cp2p/engine';
import {
  DESERT_CROSSING,
  FIXED_SEAFARING,
  FOGBOUND,
  FOUR_ISLES,
  FOUR_ISLES_56,
  NEW_HORIZONS,
  NEW_HORIZONS_56,
  OPEN_SEA_OPTIONS,
} from './scenarios/seafaring/index.js';
import { standardFixedBoard } from './standard-fixed.js';

/** Board shapes a scenario can generate from; slots and bags come from the engine. */
export const BOARD_SHAPES: Readonly<Record<string, BoardShapeSpec>> = Object.freeze({
  standard: STANDARD_BOARD,
  'five-six': FIVE_SIX_BOARD,
  ...Object.fromEntries(FIXED_SEAFARING.map((data) => [data.id, data.shape])),
});

/**
 * A generator scenario names a shape in `BOARD_SHAPES`, or a procedural layout the rules module
 * builds at genesis (`archipelago`, see the seafaring module), which has no fixed shape.
 */
export type ScenarioBoard =
  | { readonly kind: 'generator'; readonly shape: string }
  | { readonly kind: 'fixed'; readonly shape: string; readonly board: () => BoardState };

/**
 * A playable setup: modules, a board, option overrides, an optional rules module
 * (`scenario:<id>`) and the victory target. The lobby lists scenarios by the modules they need.
 */
export interface Scenario {
  readonly id: string;
  /** i18n key under the `lobby` namespace. */
  readonly titleKey: string;
  readonly aboutKey: string;
  readonly modules: readonly string[];
  readonly rulesModule?: string;
  readonly seats: { readonly min: number; readonly max: number };
  readonly board: ScenarioBoard;
  readonly options: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly vpTarget: number;
}

export const SCENARIOS: readonly Scenario[] = Object.freeze([
  {
    id: 'standard',
    titleKey: 'scenarioStandard',
    aboutKey: 'scenarioStandardAbout',
    modules: ['base'],
    seats: { min: 2, max: 4 },
    board: { kind: 'generator', shape: 'standard' },
    options: {},
    vpTarget: 10,
  },
  {
    id: 'standard-fixed',
    titleKey: 'scenarioStandardFixed',
    aboutKey: 'scenarioStandardFixedAbout',
    modules: ['base'],
    seats: { min: 2, max: 4 },
    board: { kind: 'fixed', shape: 'standard', board: standardFixedBoard },
    options: { base: { mapLayout: 'standard-fixed' } },
    vpTarget: 10,
  },
  {
    id: 'five-six',
    titleKey: 'scenarioFiveSix',
    aboutKey: 'scenarioFiveSixAbout',
    modules: ['base', 'five-six'],
    seats: { min: 5, max: 6 },
    board: { kind: 'generator', shape: 'five-six' },
    options: {},
    vpTarget: 10,
  },
  {
    id: 'new-horizons',
    titleKey: 'scenarioNewHorizons',
    aboutKey: 'scenarioNewHorizonsAbout',
    modules: ['base', 'seafaring'],
    seats: { min: 3, max: 4 },
    board: { kind: 'fixed', shape: NEW_HORIZONS.id, board: NEW_HORIZONS.board },
    options: { seafaring: NEW_HORIZONS.options },
    vpTarget: 14,
  },
  {
    id: 'new-horizons-56',
    titleKey: 'scenarioNewHorizonsLarge',
    aboutKey: 'scenarioNewHorizonsLargeAbout',
    modules: ['base', 'five-six', 'seafaring'],
    seats: { min: 5, max: 6 },
    board: { kind: 'fixed', shape: NEW_HORIZONS_56.id, board: NEW_HORIZONS_56.board },
    options: { seafaring: NEW_HORIZONS_56.options },
    vpTarget: 16,
  },
  {
    id: 'four-isles',
    titleKey: 'scenarioFourIsles',
    aboutKey: 'scenarioFourIslesAbout',
    modules: ['base', 'seafaring'],
    seats: { min: 3, max: 4 },
    board: { kind: 'fixed', shape: FOUR_ISLES.id, board: FOUR_ISLES.board },
    options: { seafaring: FOUR_ISLES.options },
    vpTarget: 13,
  },
  {
    id: 'four-isles-56',
    titleKey: 'scenarioFourIslesLarge',
    aboutKey: 'scenarioFourIslesLargeAbout',
    modules: ['base', 'five-six', 'seafaring'],
    seats: { min: 5, max: 6 },
    board: { kind: 'fixed', shape: FOUR_ISLES_56.id, board: FOUR_ISLES_56.board },
    options: { seafaring: FOUR_ISLES_56.options },
    vpTarget: 13,
  },
  {
    id: 'fogbound',
    titleKey: 'scenarioFogbound',
    aboutKey: 'scenarioFogboundAbout',
    modules: ['base', 'seafaring'],
    seats: { min: 3, max: 4 },
    board: { kind: 'fixed', shape: FOGBOUND.id, board: FOGBOUND.board },
    options: { seafaring: FOGBOUND.options },
    vpTarget: 12,
  },
  {
    id: 'desert-crossing',
    titleKey: 'scenarioDesertCrossing',
    aboutKey: 'scenarioDesertCrossingAbout',
    modules: ['base', 'seafaring'],
    seats: { min: 3, max: 4 },
    board: { kind: 'fixed', shape: DESERT_CROSSING.id, board: DESERT_CROSSING.board },
    options: { seafaring: DESERT_CROSSING.options },
    vpTarget: 13,
  },
  {
    id: 'open-sea',
    titleKey: 'scenarioOpenSea',
    aboutKey: 'scenarioOpenSeaAbout',
    modules: ['base', 'seafaring'],
    seats: { min: 3, max: 4 },
    board: { kind: 'generator', shape: 'archipelago' },
    options: { seafaring: OPEN_SEA_OPTIONS },
    vpTarget: 12,
  },
  {
    id: 'open-sea-56',
    titleKey: 'scenarioOpenSeaLarge',
    aboutKey: 'scenarioOpenSeaLargeAbout',
    modules: ['base', 'five-six', 'seafaring'],
    seats: { min: 5, max: 6 },
    board: { kind: 'generator', shape: 'archipelago' },
    options: { seafaring: OPEN_SEA_OPTIONS },
    vpTarget: 12,
  },
]);

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}

/** True when every module the scenario selects is in the engine catalogue. */
export function scenarioIsPlayable(scenario: Scenario): boolean {
  return [...scenario.modules, ...(scenario.rulesModule ? [scenario.rulesModule] : [])].every(
    (id) => Object.hasOwn(MODULE_CATALOGUE, id),
  );
}

/** Playable scenarios whose seat range includes the count. */
export function scenariosForSeats(count: number): Scenario[] {
  return SCENARIOS.filter(
    (scenario) =>
      scenarioIsPlayable(scenario) && count >= scenario.seats.min && count <= scenario.seats.max,
  );
}

/** Playable scenarios that need exactly the given module set (base implied). */
export function scenariosForModules(modules: readonly string[]): Scenario[] {
  const wanted = new Set(['base', ...modules]);
  return SCENARIOS.filter(
    (scenario) =>
      scenarioIsPlayable(scenario) &&
      scenario.modules.length === wanted.size &&
      scenario.modules.every((id) => wanted.has(id)),
  );
}

/** The default scenario for a seat count: the first generator scenario that fits. */
export function defaultScenario(count: number): Scenario {
  const found = scenariosForSeats(count).find((scenario) => scenario.board.kind === 'generator');
  if (!found) throw new Error(`No scenario supports ${count} seats`);
  return found;
}

/**
 * Build a genesis config. The scenario's victory target is the default, player choices come
 * next, and the scenario's own option overrides win, so a fixed map stays fixed.
 */
export function scenarioConfig(
  scenario: Scenario,
  seatCount: number,
  choices: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
): GameConfig {
  if (seatCount < scenario.seats.min || seatCount > scenario.seats.max)
    throw new RangeError(`${scenario.id} needs ${scenario.seats.min}–${scenario.seats.max} seats`);
  const ids = scenario.rulesModule
    ? [...scenario.modules, scenario.rulesModule]
    : [...scenario.modules];
  const modules = moduleSelection(ids);
  const checked = checkModuleSelection(modules);
  if (!checked.ok) throw new Error(checked.error.message);
  const options: Record<string, Record<string, unknown>> = {};
  for (const id of ids) {
    const merged = {
      ...(id === 'base' ? { vpTarget: scenario.vpTarget } : {}),
      ...choices[id],
      ...scenario.options[id],
    };
    if (Object.keys(merged).length) options[id] = merged;
  }
  if (scenario.board.kind === 'generator' && options.base?.mapLayout === 'standard-fixed')
    options.base = { ...options.base, mapLayout: 'balanced-random' };
  const seats: Seat[] = ([0, 1, 2, 3, 4, 5] as const).slice(0, seatCount);
  return {
    modules,
    seats,
    options,
    ...(scenario.board.kind === 'fixed' ? { board: scenario.board.board() } : {}),
  };
}

const boardKey = (board: BoardState): string =>
  JSON.stringify(board.hexes.map((hex) => [hex.id, hex.terrain, hex.token]));

/** True when a config's fixed board is the scenario's own board (hexes, terrains and tokens). */
function sameBoard(config: GameConfig, scenario: Scenario): boolean {
  if (scenario.board.kind !== 'fixed' || !config.board) return false;
  return boardKey(config.board) === boardKey(scenario.board.board());
}

/** Identify which listed scenario a genesis config was built from, if any. */
export function scenarioOfConfig(config: GameConfig): Scenario | undefined {
  const ids = config.modules.map((module) => module.id).toSorted();
  const fixed = Boolean(config.board);
  const matches = SCENARIOS.filter(
    (scenario) =>
      [...scenario.modules, ...(scenario.rulesModule ? [scenario.rulesModule] : [])]
        .toSorted()
        .join(',') === ids.join(',') && (scenario.board.kind === 'fixed') === fixed,
  );
  // Several fixed maps can share a module set, so tell them apart by their board.
  return matches.length > 1 && fixed
    ? (matches.find((scenario) => sameBoard(config, scenario)) ?? matches[0])
    : matches[0];
}
