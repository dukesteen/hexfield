import { describe, expect, test } from 'vitest';
import {
  comboExt,
  knightsExt,
  seafarersKnightsConfig,
  seafaringExt,
  strandsKnight,
} from '@cp2p/engine';
import type { Engine, GameState, Seat } from '@cp2p/engine';
import { SCENARIOS, scenarioConfig } from '@cp2p/maps';
import { runGame } from './run-game.js';
import type { RunGameResult } from './run-game.js';

/**
 * The regular run plays one game per seat count and scenario. `CP2P_HEAVY_TESTS=1` plays three per
 * seat count and both seat counts of each scenario, and requires the rarer flows to appear.
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

const COMBINED = SCENARIOS.filter(
  (scenario) => scenario.modules.includes('seafaring') && scenario.modules.includes('knights'),
);

/** Flows every sweep shows; the heavy sweep also needs the rarer ones. */
const COMMON = [
  'BUILD_SHIP',
  'MOVE_SHIP',
  'MOVE_PIRATE',
  'BUILD_KNIGHT',
  'BUILD_IMPROVEMENT',
  'PLAY_PROGRESS_CARD',
  'END_SBP',
];
const RARE = ['PLACE_SETUP_SHIP', 'CHOOSE_GOLD', 'MOVE_KNIGHT', 'CHASE_ROBBER', 'PLACE_FREE_SHIP'];

describe('seafaring with knights simulation', () => {
  test('random bots finish games on the test archipelago at three to six seats', async () => {
    const totals: Record<string, number> = {};
    let stranding = 0;
    // Rule 6 (combos.md): no legal ship move may cut a knight off its settlements.
    const checkShipMoves = (engine: Engine, state: GameState, seat: Seat): void => {
      for (const command of engine.getLegalCommands(state, seat).commands)
        if (command.type === 'MOVE_SHIP' && strandsKnight(state, seat, String(command.from)))
          stranding++;
    };
    const games = [3, 4, 5, 6].flatMap((seats) =>
      Array.from({ length: HEAVY ? 3 : 1 }, (_, gameIndex) => ({
        seed: 5,
        gameIndex,
        config: seafarersKnightsConfig({ seats, fiveSix: seats > 4, base: { vpTarget: 15 } }),
        ...(gameIndex === 0 ? { onPlayerStep: checkShipMoves } : {}),
      })),
    );
    await sweep(games, (result) => {
      expect(result.state.result).not.toBeNull();
      // The pirate is on the board exactly when the barbarians have attacked.
      const attacked = knightsExt(result.state).lastAttack !== null;
      expect(comboExt(result.state).pirateEntered).toBe(attacked);
      expect(attacked || seafaringExt(result.state).pirateHex === null).toBe(true);
      for (const [type, count] of Object.entries(result.stats.commands))
        totals[type] = (totals[type] ?? 0) + count;
    });
    expect(stranding).toBe(0);
    for (const type of HEAVY ? [...COMMON, ...RARE] : COMMON)
      expect({ type, count: totals[type] ?? 0 }).not.toEqual({ type, count: 0 });
  }, 300_000);

  test('the same seed replays the same game', () => {
    const options = { seed: 3, gameIndex: 1, config: seafarersKnightsConfig({ seats: 3 }) };
    expect(runGame(options).inputs).toEqual(runGame(options).inputs);
  }, 120_000);

  test('every Seafarers map has a combined scenario in the smoke run', () => {
    expect(COMBINED.map((scenario) => scenario.id)).toEqual([
      'new-horizons-knights',
      'new-horizons-knights-56',
      'four-isles-knights',
      'four-isles-knights-56',
      'fogbound-knights',
      'fogbound-knights-56',
      'desert-crossing-knights',
      'desert-crossing-knights-56',
      'open-sea-knights',
      'open-sea-knights-56',
    ]);
  });

  // Random bots on each combined scenario, with the public invariants of all modules (a knight
  // never beside unrevealed fog among them), private hand checks and card conservation on.
  describe.each(COMBINED.map((scenario) => [scenario.id, scenario] as const))(
    'scenario %s',
    (_id, scenario) => {
      test('random bots finish games with invariants on', async () => {
        const seatCounts = HEAVY ? [scenario.seats.min, scenario.seats.max] : [scenario.seats.min];
        const drawn = new Set<string>();
        // Random bots do not always sail into the fog, so Fogbound plays a few more games.
        const fogbound = scenario.id.startsWith('fogbound');
        const length = HEAVY ? 2 : fogbound ? 3 : 1;
        const games = [...new Set(seatCounts)].flatMap((seats) =>
          Array.from({ length }, (_, gameIndex) => ({
            seed: 29,
            gameIndex,
            config: scenarioConfig(scenario, seats),
          })),
        );
        await sweep(games, (result) => {
          expect(result.state.result).not.toBeNull();
          expect(result.state.board.fixtures).toHaveLength(1);
          // The track stays off the board, generated archipelagos included.
          const onBoard = new Set(result.state.board.hexes.map((hex) => hex.id));
          for (const { q, r } of result.state.board.fixtures?.[0]?.footprint ?? [])
            expect(onBoard.has(`h:${q},${r}`)).toBe(false);
          for (const [deck, stack] of Object.entries(result.state.decks))
            if (stack.drawn.length > 0) drawn.add(deck.startsWith('progress') ? 'progress' : deck);
        });
        // Fogbound draws from its public fog stacks and the private progress decks in one run.
        expect([...drawn].toSorted()).toEqual(
          fogbound ? ['fog-terrain', 'fog-token', 'progress'] : ['progress'],
        );
      }, 300_000);
    },
  );
});
