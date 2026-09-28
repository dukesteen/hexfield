import { describe, expect, test } from 'vitest';
import { knightsConfig, knightsExt } from '@cp2p/engine';
import { runGame } from './run-game.js';

describe('knights simulation', () => {
  test('random bots finish knights games at every seat count with invariants and conservation on', () => {
    const totals: Record<string, number> = {};
    for (const seats of [2, 3, 4, 5, 6])
      for (let gameIndex = 0; gameIndex < 3; gameIndex++) {
        const result = runGame({
          seed: 21,
          gameIndex,
          config: knightsConfig({ seats, fiveSix: seats > 4 }),
        });
        expect(result.state.result).not.toBeNull();
        expect(result.state.result?.reason).toBe('public-vp');
        // Every public and private check ran on each input; metropolises stay unique.
        const held = Object.values(knightsExt(result.state).metropolises).flatMap((holder) =>
          holder ? [holder.vertex] : [],
        );
        expect(new Set(held).size).toBe(held.length);
        for (const [type, count] of Object.entries(result.stats.commands))
          totals[type] = (totals[type] ?? 0) + count;
      }
    for (const type of ['BUILD_IMPROVEMENT', 'PLACE_METROPOLIS', 'CHOOSE_AQUEDUCT', 'DISCARD'])
      expect({ type, count: totals[type] ?? 0 }).not.toEqual({ type, count: 0 });
    expect(totals.BUY_DEV_CARD).toBeUndefined();
  }, 240_000);

  test('the same seed replays the same game', () => {
    const options = { seed: 4, gameIndex: 1, players: 3, knights: true };
    expect(runGame(options).inputs).toEqual(runGame(options).inputs);
  }, 60_000);
});
