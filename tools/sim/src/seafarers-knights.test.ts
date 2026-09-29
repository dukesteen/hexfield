import { describe, expect, test } from 'vitest';
import {
  comboExt,
  knightsExt,
  seafarersKnightsConfig,
  seafaringExt,
  strandsKnight,
} from '@cp2p/engine';
import { SCENARIOS, scenarioConfig } from '@cp2p/maps';
import { runGame } from './run-game.js';

const COMBINED = SCENARIOS.filter(
  (scenario) => scenario.modules.includes('seafaring') && scenario.modules.includes('knights'),
);

describe('seafaring with knights simulation', () => {
  test('random bots finish games on the test archipelago at three to six seats', () => {
    const totals: Record<string, number> = {};
    let stranding = 0;
    for (const seats of [3, 4, 5, 6])
      for (let gameIndex = 0; gameIndex < 3; gameIndex++) {
        const result = runGame({
          seed: 5,
          gameIndex,
          config: seafarersKnightsConfig({ seats, fiveSix: seats > 4, base: { vpTarget: 15 } }),
          // Rule 6 (combos.md): no legal ship move may cut a knight off its settlements.
          onPlayerStep: (engine, state, seat) => {
            if (gameIndex > 0) return;
            for (const command of engine.getLegalCommands(state, seat).commands)
              if (command.type === 'MOVE_SHIP' && strandsKnight(state, seat, String(command.from)))
                stranding++;
          },
        });
        expect(result.state.result).not.toBeNull();
        // The pirate is on the board exactly when the barbarians have attacked.
        const attacked = knightsExt(result.state).lastAttack !== null;
        expect(comboExt(result.state).pirateEntered).toBe(attacked);
        expect(attacked || seafaringExt(result.state).pirateHex === null).toBe(true);
        for (const [type, count] of Object.entries(result.stats.commands))
          totals[type] = (totals[type] ?? 0) + count;
      }
    expect(stranding).toBe(0);
    for (const type of [
      'PLACE_SETUP_SHIP',
      'BUILD_SHIP',
      'MOVE_SHIP',
      'MOVE_PIRATE',
      'CHOOSE_GOLD',
      'BUILD_KNIGHT',
      'MOVE_KNIGHT',
      'CHASE_ROBBER',
      'BUILD_IMPROVEMENT',
      'PLAY_PROGRESS_CARD',
      'PLACE_FREE_SHIP',
      'END_SBP',
    ])
      expect({ type, count: totals[type] ?? 0 }).not.toEqual({ type, count: 0 });
  }, 300_000);

  test('the same seed replays the same game', () => {
    const options = { seed: 3, gameIndex: 1, config: seafarersKnightsConfig({ seats: 3 }) };
    expect(runGame(options).inputs).toEqual(runGame(options).inputs);
  }, 120_000);

  // Random bots on each combined scenario, at its fewest and most seats, with the public
  // invariants of all modules, private hand checks and card conservation on.
  describe.each(COMBINED.map((scenario) => [scenario.id, scenario] as const))(
    'scenario %s',
    (_id, scenario) => {
      test('random bots finish games with invariants on', () => {
        for (const seats of new Set([scenario.seats.min, scenario.seats.max]))
          for (let gameIndex = 0; gameIndex < 2; gameIndex++) {
            const result = runGame({
              seed: 29,
              gameIndex,
              config: scenarioConfig(scenario, seats),
            });
            expect(result.state.result).not.toBeNull();
            expect(result.state.board.fixtures).toHaveLength(1);
          }
      }, 300_000);
    },
  );
});
