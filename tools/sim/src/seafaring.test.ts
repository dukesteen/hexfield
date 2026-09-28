import { describe, expect, test } from 'vitest';
import { seafaringConfig } from '@cp2p/engine';
import { runGame } from './run-game.js';

describe('seafaring simulation', () => {
  test('random bots finish games on the test archipelago at every seat count with invariants on', () => {
    const totals: Record<string, number> = {};
    for (const seats of [2, 3, 4, 5, 6])
      for (let gameIndex = 0; gameIndex < 3; gameIndex++) {
        const result = runGame({
          seed: 11,
          gameIndex,
          config: seafaringConfig({ seats, fiveSix: seats > 4, base: { vpTarget: 12 } }),
        });
        expect(result.state.result).not.toBeNull();
        for (const [type, count] of Object.entries(result.stats.commands))
          totals[type] = (totals[type] ?? 0) + count;
      }
    for (const type of [
      'BUILD_SHIP',
      'MOVE_SHIP',
      'MOVE_PIRATE',
      'CHOOSE_GOLD',
      'PLACE_SETUP_SHIP',
    ])
      expect({ type, count: totals[type] ?? 0 }).not.toEqual({ type, count: 0 });
  }, 240_000);

  test('the same seed replays the same game', () => {
    const options = {
      seed: 3,
      gameIndex: 1,
      config: seafaringConfig({ seats: 3, base: { vpTarget: 10 } }),
    };
    expect(runGame(options).inputs).toEqual(runGame(options).inputs);
  }, 60_000);
});
