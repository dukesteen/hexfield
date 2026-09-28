import { describe, expect, test } from 'vitest';
import { boardShapeProblems, engineForConfig } from '@cp2p/engine';
import {
  BOARD_SHAPES,
  SCENARIOS,
  defaultScenario,
  scenarioById,
  scenarioConfig,
  scenarioOfConfig,
  scenariosForModules,
  scenariosForSeats,
} from './index.js';

describe('scenarios', () => {
  test('every board shape passes the fixture and harbor slot rules', () => {
    for (const shape of Object.values(BOARD_SHAPES)) expect(boardShapeProblems(shape)).toEqual([]);
  });

  test('every scenario starts a game at each supported seat count', () => {
    for (const scenario of SCENARIOS)
      for (let seats = scenario.seats.min; seats <= scenario.seats.max; seats++) {
        const config = scenarioConfig(scenario, seats, { base: { vpTarget: 7 } });
        const state = engineForConfig(config).createGame(config, new Uint8Array(32));
        expect(state.config.seats).toHaveLength(seats);
        expect(state.board.hexes).toHaveLength(
          BOARD_SHAPES[scenario.board.shape]?.hexes.length ?? -1,
        );
        expect(state.config.options.base).toMatchObject({ vpTarget: 7 });
        expect(scenarioConfig(scenario, seats).options.base).toMatchObject({
          vpTarget: scenario.vpTarget,
        });
        expect(scenarioOfConfig(config)?.id).toBe(scenario.id);
      }
  });

  test('scenarios are listed by seats and by the modules they need', () => {
    expect(scenariosForSeats(4).map((scenario) => scenario.id)).toEqual([
      'standard',
      'standard-fixed',
    ]);
    expect(scenariosForSeats(6).map((scenario) => scenario.id)).toEqual(['five-six']);
    expect(scenariosForModules(['five-six']).map((scenario) => scenario.id)).toEqual(['five-six']);
    expect(defaultScenario(5).id).toBe('five-six');
    expect(defaultScenario(3).id).toBe('standard');
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
