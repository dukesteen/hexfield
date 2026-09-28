import {
  FIVE_SIX_BOARD,
  STANDARD_BOARD,
  checkModuleSelection,
  moduleSelection,
} from '@cp2p/engine';
import type { BoardShapeSpec, BoardState, GameConfig, Seat } from '@cp2p/engine';
import { standardFixedBoard } from './standard-fixed.js';

/** Board shapes a scenario can generate from; slots and bags come from the engine. */
export const BOARD_SHAPES: Readonly<Record<string, BoardShapeSpec>> = Object.freeze({
  standard: STANDARD_BOARD,
  'five-six': FIVE_SIX_BOARD,
});

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
]);

export function scenarioById(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}

/** Scenarios whose seat range includes the count. */
export function scenariosForSeats(count: number): Scenario[] {
  return SCENARIOS.filter((scenario) => count >= scenario.seats.min && count <= scenario.seats.max);
}

/** Scenarios that need exactly the given module set (base implied). */
export function scenariosForModules(modules: readonly string[]): Scenario[] {
  const wanted = new Set(['base', ...modules]);
  return SCENARIOS.filter(
    (scenario) =>
      scenario.modules.length === wanted.size && scenario.modules.every((id) => wanted.has(id)),
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

/** Identify which listed scenario a genesis config was built from, if any. */
export function scenarioOfConfig(config: GameConfig): Scenario | undefined {
  const ids = config.modules.map((module) => module.id).toSorted();
  const fixed = Boolean(config.board);
  return SCENARIOS.find(
    (scenario) =>
      [...scenario.modules, ...(scenario.rulesModule ? [scenario.rulesModule] : [])]
        .toSorted()
        .join(',') === ids.join(',') && (scenario.board.kind === 'fixed') === fixed,
  );
}
