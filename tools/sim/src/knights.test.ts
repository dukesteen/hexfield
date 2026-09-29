import { describe, expect, test } from 'vitest';
import { knightsConfig, knightsExt } from '@cp2p/engine';
import { runGame } from './run-game.js';
import type { RunGameResult } from './run-game.js';

/**
 * The regular run plays a handful of games per check. `CP2P_HEAVY_TESTS=1` plays the full sweeps
 * (15, 40 and 60 games), which also require every progress card and knight action to appear.
 */
const HEAVY = process.env.CP2P_HEAVY_TESTS === '1';

/** A macrotask between games keeps the test worker responsive during long synchronous sweeps. */
const yieldTask = () => new Promise<void>((resolve) => setImmediate(resolve));

async function sweep(
  games: readonly Parameters<typeof runGame>[0][],
  each: (result: RunGameResult) => void,
): Promise<void> {
  for (const options of games) {
    each(runGame(options));
    // oxlint-disable-next-line no-await-in-loop -- Games run one at a time, yielding in between.
    await yieldTask();
  }
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

describe('knights simulation', () => {
  test('random bots finish knights games at every seat count with invariants and conservation on', async () => {
    const totals: Record<string, number> = {};
    // Seed 21 hits a saturated six-seat board that stalls below 13 points: with player trades
    // working, bots finish every improvement before K3 to K5 add other ways to score.
    const games = [2, 3, 4, 5, 6].flatMap((seats) =>
      range(HEAVY ? 3 : 1).map((gameIndex) => ({
        seed: 23,
        gameIndex,
        config: knightsConfig({ seats, fiveSix: seats > 4 }),
      })),
    );
    await sweep(games, (result) => {
      expect(result.state.result).not.toBeNull();
      expect(result.state.result?.reason).toBe('public-vp');
      // Every public and private check ran on each input; metropolises stay unique.
      const held = Object.values(knightsExt(result.state).metropolises).flatMap((holder) =>
        holder ? [holder.vertex] : [],
      );
      expect(new Set(held).size).toBe(held.length);
      for (const [type, count] of Object.entries(result.stats.commands))
        totals[type] = (totals[type] ?? 0) + count;
    });
    for (const type of ['BUILD_IMPROVEMENT', 'PLACE_METROPOLIS', 'CHOOSE_AQUEDUCT', 'DISCARD'])
      expect({ type, count: totals[type] ?? 0 }).not.toEqual({ type, count: 0 });
    expect(totals.BUY_DEV_CARD).toBeUndefined();
  }, 240_000);

  test('bots recruit, activate, promote, move and wall knights, and the barbarians pillage', async () => {
    const totals: Record<string, number> = {};
    let attacks = 0;
    const games = range(HEAVY ? 40 : 8).map((gameIndex) => ({
      seed: 37,
      gameIndex,
      config: knightsConfig({ seats: 4 }),
    }));
    await sweep(games, (result) => {
      expect(result.state.result).not.toBeNull();
      const ext = knightsExt(result.state);
      // The knight and wall counts respect the piece limits at the end, as they did all game long.
      for (const seat of [0, 1, 2, 3])
        for (const level of [1, 2, 3])
          expect(
            ext.knights.filter((knight) => knight.seat === seat && knight.level === level).length,
          ).toBeLessThanOrEqual(2);
      if (ext.lastAttack) attacks++;
      for (const [type, count] of Object.entries(result.stats.commands))
        totals[type] = (totals[type] ?? 0) + count;
    });
    expect(attacks).toBeGreaterThan(0);
    const everyGame = ['BUILD_KNIGHT', 'ACTIVATE_KNIGHT', 'PROMOTE_KNIGHT', 'BUILD_CITY_WALL'];
    const rare = ['MOVE_KNIGHT', 'CHASE_ROBBER', 'CHOOSE_PILLAGE', 'DISPLACE_KNIGHT'];
    for (const type of HEAVY ? [...everyGame, ...rare] : everyGame)
      expect({ type, count: totals[type] ?? 0 }).not.toEqual({ type, count: 0 });
  }, 240_000);

  test('bots draw, play and answer progress cards, and the victory cards are shown', async () => {
    const played: Record<string, number> = {};
    const shown = new Set<string>();
    const totals: Record<string, number> = {};
    const games = [3, 4].flatMap((seats) =>
      range(HEAVY ? 30 : 4).map((gameIndex) => ({
        seed: 52,
        gameIndex,
        config: knightsConfig({ seats }),
      })),
    );
    await sweep(games, (result) => {
      expect(result.state.result).not.toBeNull();
      for (const input of result.inputs) {
        if (input.kind === 'command' && input.command.type === 'PLAY_PROGRESS_CARD') {
          const card = String(input.command.card);
          played[card] = (played[card] ?? 0) + 1;
        }
        if (input.kind === 'system' && input.type === 'REVEAL_PROGRESS' && input.card !== 'none')
          shown.add(String(input.card));
      }
      for (const [type, count] of Object.entries(result.stats.commands))
        totals[type] = (totals[type] ?? 0) + count;
    });
    expect(totals.CHOOSE_PROGRESS_DECK ?? 0).toBeGreaterThan(0);
    expect(Object.keys(played).length).toBeGreaterThan(0);
    if (!HEAVY) return;
    const cards = [
      'alchemist',
      'crane',
      'engineer',
      'inventor',
      'irrigation',
      'medicine',
      'mining',
      'roadBuilding',
      'smith',
      'commercialHarbor',
      'masterMerchant',
      'merchant',
      'merchantFleet',
      'resourceMonopoly',
      'tradeMonopoly',
      'bishop',
      'deserter',
      'diplomat',
      'intrigue',
      'saboteur',
      'spy',
      'warlord',
      'wedding',
    ];
    for (const card of cards)
      expect({ card, count: played[card] ?? 0 }).not.toEqual({ card, count: 0 });
    expect([...shown].toSorted()).toEqual(['constitution', 'printer']);
    for (const type of [
      'CHOOSE_PROGRESS_DECK',
      'DISCARD_PROGRESS',
      'HARBOR_OFFER',
      'HARBOR_REPLY',
      'WEDDING_GIVE',
      'SABOTEUR_DISCARD',
      'DESERTER_REMOVE',
      'DESERTER_PLACE',
      'DESERTER_SKIP',
    ])
      expect({ type, count: totals[type] ?? 0 }).not.toEqual({ type, count: 0 });
  }, 600_000);

  test('the same seed replays the same game', () => {
    const options = { seed: 4, gameIndex: 1, players: 3, knights: true };
    expect(runGame(options).inputs).toEqual(runGame(options).inputs);
  }, 60_000);
});
