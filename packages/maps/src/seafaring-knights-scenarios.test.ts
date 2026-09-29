import { describe, expect, test } from 'vitest';
import { COMBO_ID, comboExt, engineForConfig, seafaringExt } from '@cp2p/engine';
import type { BoardState } from '@cp2p/engine';
import { SCENARIOS, scenarioById, scenarioConfig, scenarioOfConfig } from './index.js';

const COMBINED = SCENARIOS.filter(
  (scenario) => scenario.modules.includes('seafaring') && scenario.modules.includes('knights'),
);

/** Hexes a two-hex fixture covers, as ids. */
function footprint(board: BoardState): string[] {
  return (board.fixtures ?? []).flatMap((fixture) =>
    fixture.footprint.map(({ q, r }) => `h:${q},${r}`),
  );
}

describe('seafaring with knights scenarios', () => {
  test('three scenarios, each with the rules module and the Seafarers target plus 2', () => {
    expect(COMBINED.map((scenario) => [scenario.id, scenario.seats, scenario.vpTarget])).toEqual([
      ['new-horizons-knights', { min: 3, max: 4 }, 16],
      ['new-horizons-knights-56', { min: 5, max: 6 }, 18],
      ['desert-crossing-knights', { min: 3, max: 4 }, 15],
    ]);
    for (const scenario of COMBINED) {
      expect(scenario.rulesModule).toBe(COMBO_ID);
      const plain = scenarioById(scenario.id.replace('-knights', ''));
      expect(plain?.vpTarget).toBe(scenario.vpTarget - 2);
      expect(scenario.options).toEqual(plain?.options);
    }
  });

  test.each(COMBINED.map((scenario) => [scenario.id, scenario] as const))(
    '%s puts the barbarian track outside the explicit board',
    (_id, scenario) => {
      const config = scenarioConfig(scenario, scenario.seats.min);
      const engine = engineForConfig(config);
      const state = engine.createGame(config, new Uint8Array(32));
      expect(state.board.fixtures).toHaveLength(1);
      expect(state.board.fixtures?.[0]).toMatchObject({ id: 'barbarian-track', slot: 'perimeter' });
      const onBoard = new Set(state.board.hexes.map((hex) => hex.id));
      for (const hex of footprint(state.board)) expect(onBoard.has(hex)).toBe(false);
      // The slot is a function of the board only, not of the genesis seed.
      const again = engine.createGame(config, new Uint8Array(32).fill(7));
      expect(again.board.fixtures).toEqual(state.board.fixtures);
      // The pirate waits for the first attack.
      expect(seafaringExt(state).pirateHex).toBeNull();
      expect(comboExt(state).pirateStart).toBe(scenario.options.seafaring?.pirateHex);
      expect(scenarioOfConfig(config)?.id).toBe(scenario.id);
      expect(engine.checkInvariants(state)).toEqual([]);
    },
  );
});
