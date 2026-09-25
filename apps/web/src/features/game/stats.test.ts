import { expect, test } from 'vitest';
import type { GameEvent } from '@cp2p/engine';
import { diceHistogram, productionBySeat } from './stats';

test('game-over dice and production statistics reflect only recorded events', () => {
  const events: GameEvent[] = [
    { type: 'diceRolled', roll: 8, dice: [3, 5] },
    { type: 'resourcesProduced', bySeat: { '0': { brick: 2, grain: 1 }, '1': { ore: 1 } } },
    { type: 'diceRolled', roll: 8, dice: [2, 6] },
    { type: 'diceRolled', roll: 5, dice: [2, 3] },
    { type: 'maritimeTrade', seat: 0 },
  ];
  expect(diceHistogram(events).find((entry) => entry.roll === 8)?.count).toBe(2);
  expect(diceHistogram(events).find((entry) => entry.roll === 5)?.count).toBe(1);
  expect(productionBySeat(events, 0)).toBe(3);
  expect(productionBySeat(events, 1)).toBe(1);
  expect(productionBySeat(events, 2)).toBe(0);
});
