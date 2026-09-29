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
  test('every Seafarers map, each with the rules module and the Seafarers target plus 2', () => {
    expect(COMBINED.map((scenario) => [scenario.id, scenario.seats, scenario.vpTarget])).toEqual([
      ['new-horizons-knights', { min: 3, max: 4 }, 16],
      ['new-horizons-knights-56', { min: 5, max: 6 }, 18],
      ['four-isles-knights', { min: 3, max: 4 }, 15],
      ['four-isles-knights-56', { min: 5, max: 6 }, 15],
      ['fogbound-knights', { min: 3, max: 4 }, 14],
      ['fogbound-knights-56', { min: 5, max: 6 }, 14],
      ['desert-crossing-knights', { min: 3, max: 4 }, 15],
      ['desert-crossing-knights-56', { min: 5, max: 6 }, 15],
      ['open-sea-knights', { min: 3, max: 4 }, 14],
      ['open-sea-knights-56', { min: 5, max: 6 }, 14],
    ]);
    for (const scenario of COMBINED) {
      expect(scenario.rulesModule).toBe(COMBO_ID);
      const plain = scenarioById(scenario.id.replace('-knights', ''));
      expect(plain?.vpTarget).toBe(scenario.vpTarget - 2);
      expect(plain?.seats).toEqual(scenario.seats);
      expect(scenario.board).toEqual(plain?.board);
      expect(scenario.options).toEqual(plain?.options);
      expect(scenario.modules).toEqual([...(plain?.modules ?? []), 'knights']);
    }
    // Every Seafarers scenario has a knights version.
    const seafaring = SCENARIOS.filter(
      (scenario) => scenario.modules.includes('seafaring') && !scenario.modules.includes('knights'),
    );
    expect(COMBINED.map((scenario) => scenario.id.replace('-knights', '')).toSorted()).toEqual(
      seafaring.map((scenario) => scenario.id).toSorted(),
    );
  });

  test.each(COMBINED.map((scenario) => [scenario.id, scenario] as const))(
    '%s puts the barbarian track outside the board',
    (_id, scenario) => {
      const generated = scenario.board.kind === 'generator';
      const config = scenarioConfig(scenario, scenario.seats.min);
      const engine = engineForConfig(config);
      const state = engine.createGame(config, new Uint8Array(32));
      expect(state.board.fixtures).toHaveLength(1);
      expect(state.board.fixtures?.[0]).toMatchObject({ id: 'barbarian-track', slot: 'perimeter' });
      const onBoard = new Set(state.board.hexes.map((hex) => hex.id));
      for (const hex of footprint(state.board)) expect(onBoard.has(hex)).toBe(false);
      // The slot is a function of the board only: a fixed board keeps it for every seed.
      const again = engine.createGame(config, new Uint8Array(32).fill(7));
      expect(
        generated || JSON.stringify(again.board.fixtures) === JSON.stringify(state.board.fixtures),
      ).toBe(true);
      for (const hex of footprint(again.board))
        expect(again.board.hexes.some((item) => item.id === hex)).toBe(false);
      // The pirate waits for the first attack, on the scenario's (or the generator's) start hex.
      expect(seafaringExt(state).pirateHex).toBeNull();
      const start = comboExt(state).pirateStart;
      expect(start).toBe(generated ? start : scenario.options.seafaring?.pirateHex);
      expect(start).not.toBeNull();
      expect(scenarioOfConfig(config)?.id).toBe(scenario.id);
      expect(engine.checkInvariants(state)).toEqual([]);
    },
  );
});
