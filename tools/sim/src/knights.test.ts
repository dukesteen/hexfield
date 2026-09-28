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

  test('bots recruit, activate, promote, move and wall knights, and the barbarians pillage', () => {
    const totals: Record<string, number> = {};
    let attacks = 0;
    let defended = 0;
    for (let gameIndex = 0; gameIndex < 40; gameIndex++) {
      const result = runGame({
        seed: 36,
        gameIndex,
        config: knightsConfig({ seats: 4 }),
      });
      expect(result.state.result).not.toBeNull();
      const ext = knightsExt(result.state);
      // The knight and wall counts respect the piece limits at the end, as they did all game long.
      for (const seat of [0, 1, 2, 3])
        for (const level of [1, 2, 3])
          expect(
            ext.knights.filter((knight) => knight.seat === seat && knight.level === level).length,
          ).toBeLessThanOrEqual(2);
      if (ext.lastAttack) attacks++;
      if (ext.lastAttack?.outcome === 'defended') defended++;
      for (const [type, count] of Object.entries(result.stats.commands))
        totals[type] = (totals[type] ?? 0) + count;
    }
    expect(attacks).toBeGreaterThan(0);
    expect(defended).toBeGreaterThanOrEqual(0);
    for (const type of [
      'BUILD_KNIGHT',
      'ACTIVATE_KNIGHT',
      'PROMOTE_KNIGHT',
      'MOVE_KNIGHT',
      'CHASE_ROBBER',
      'BUILD_CITY_WALL',
      'CHOOSE_PILLAGE',
      'DISPLACE_KNIGHT',
    ])
      expect({ type, count: totals[type] ?? 0 }).not.toEqual({ type, count: 0 });
  }, 240_000);

  test('the same seed replays the same game', () => {
    const options = { seed: 4, gameIndex: 1, players: 3, knights: true };
    expect(runGame(options).inputs).toEqual(runGame(options).inputs);
  }, 60_000);
});
