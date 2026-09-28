import { describe, expect, test } from 'vitest';
import { boardShapeProblems, engineForConfig } from '@cp2p/engine';
import {
  BOARD_SHAPES,
  SCENARIOS,
  defaultScenario,
  scenarioById,
  scenarioConfig,
  scenarioIsPlayable,
  scenarioOfConfig,
  scenariosForModules,
  scenariosForSeats,
} from './index.js';

/** Ids of the scenarios that use only the base and five-six modules, for a seat count. */
const plain = (count: number): string[] =>
  scenariosForSeats(count)
    .filter((scenario) => !scenario.modules.some((id) => id === 'seafaring' || id === 'knights'))
    .map((scenario) => scenario.id);

describe('scenarios', () => {
  test('every board shape passes the fixture and harbor slot rules', () => {
    for (const shape of Object.values(BOARD_SHAPES)) expect(boardShapeProblems(shape)).toEqual([]);
  });

  test('every playable scenario starts a game at each supported seat count', () => {
    for (const scenario of SCENARIOS.filter(scenarioIsPlayable))
      for (let seats = scenario.seats.min; seats <= scenario.seats.max; seats++) {
        const config = scenarioConfig(scenario, seats, { base: { vpTarget: 7 } });
        const state = engineForConfig(config).createGame(config, new Uint8Array(32));
        expect(state.config.seats).toHaveLength(seats);
        // A procedural layout (the archipelago) has no fixed shape to compare against.
        const shape = BOARD_SHAPES[scenario.board.shape];
        expect(shape === undefined || state.board.hexes.length === shape.hexes.length).toBe(true);
        expect(state.config.options.base).toMatchObject({ vpTarget: 7 });
        expect(scenarioConfig(scenario, seats).options.base).toMatchObject({
          vpTarget: scenario.vpTarget,
        });
        expect(scenarioOfConfig(config)?.id).toBe(scenario.id);
      }
  });

  test('scenarios are listed by seats and by the modules they need', () => {
    expect(plain(4)).toEqual(['standard', 'standard-fixed']);
    expect(plain(6)).toEqual(['five-six']);
    expect(scenariosForModules(['five-six']).map((scenario) => scenario.id)).toEqual(['five-six']);
    expect(defaultScenario(5).id).toBe('five-six');
    expect(defaultScenario(3).id).toBe('standard');
  });

  test('scenarios that need an unregistered module stay out of the lobby lists', () => {
    const missing = SCENARIOS.filter((scenario) => !scenarioIsPlayable(scenario));
    for (const scenario of missing) {
      expect(scenariosForSeats(scenario.seats.min)).not.toContain(scenario);
      expect(scenariosForModules(scenario.modules.slice(1))).not.toContain(scenario);
    }
  });

  test('seat counts outside a scenario are rejected', () => {
    const standard = scenarioById('standard');
    const fiveSix = scenarioById('five-six');
    if (!standard || !fiveSix) throw new Error('Missing scenario');
    expect(() => scenarioConfig(standard, 5)).toThrow(/2–4 seats/);
    expect(() => scenarioConfig(fiveSix, 4)).toThrow(/5–6 seats/);
  });

  test('a generator scenario never carries a fixed layout choice', () => {
    const standard = scenarioById('standard');
    if (!standard) throw new Error('Missing scenario');
    expect(
      scenarioConfig(standard, 3, { base: { mapLayout: 'standard-fixed' } }).options.base,
    ).toMatchObject({ mapLayout: 'balanced-random' });
  });
});
