import { describe, expect, test } from 'vitest';
import { seafaringConfig } from '@cp2p/engine';
import { SCENARIOS, scenarioConfig } from '@cp2p/maps';
import { runGame } from './run-game.js';

const SEAFARING_SCENARIOS = SCENARIOS.filter((scenario) => scenario.modules.includes('seafaring'));

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

  test('every seafaring scenario is covered by the smoke run', () => {
    expect(SEAFARING_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      'new-horizons',
      'new-horizons-56',
      'four-isles',
      'four-isles-56',
      'fogbound',
      'desert-crossing',
      'open-sea',
      'open-sea-56',
    ]);
  });

  // Random bots on every scenario, at its fewest and most seats, with public invariants, private
  // hand checks and card conservation on. Fogbound also draws its hidden public fog stacks.
  describe.each(SEAFARING_SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    'scenario %s',
    (_id, scenario) => {
      test('random bots finish games with invariants on', () => {
        const revealed: string[] = [];
        for (const seats of new Set([scenario.seats.min, scenario.seats.max]))
          for (let gameIndex = 0; gameIndex < 2; gameIndex++) {
            const result = runGame({
              seed: 29,
              gameIndex,
              config: scenarioConfig(scenario, seats),
            });
            expect(result.state.result).not.toBeNull();
            for (const input of result.inputs)
              if (input.kind === 'system' && input.type === 'FOG_REVEALED')
                revealed.push(`${String(input.deck)}:${String(input.card)}`);
          }
        // Only Fogbound has fog: its terrain and token stacks were both drawn from.
        const decks = new Set(revealed.map((entry) => entry.split(':')[0]));
        expect([...decks].toSorted()).toEqual(
          scenario.id === 'fogbound' ? ['fog-terrain', 'fog-token'] : [],
        );
      }, 240_000);
    },
  );
});
