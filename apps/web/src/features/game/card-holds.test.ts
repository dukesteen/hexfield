import { afterEach, expect, test } from 'vitest';
import { heldHand, heldTotal, useCardHolds, type CountHold } from './card-holds';

afterEach(() => useCardHolds.getState().clear());

const hand = { brick: 1, grain: 3, ore: 0 };

function hold(partial: Partial<CountHold> & Pick<CountHold, 'id'>): CountHold {
  return { seat: 0, kind: 'grain', delta: 1, expiresAt: 1_000, ...partial };
}

test('incoming cards are held back and outgoing cards still shown until they fly', () => {
  const holds = [
    hold({ id: 'in', kind: 'grain', delta: 2 }),
    hold({ id: 'out', kind: 'ore', delta: -1 }),
    hold({ id: 'other seat', seat: 1, kind: 'brick', delta: 1 }),
  ];
  expect(heldHand(hand, holds, 0)).toEqual({ brick: 1, grain: 1, ore: 1 });
  expect(heldTotal(4, holds, 0)).toBe(3);
  expect(heldTotal(5, holds, 1)).toBe(4);
});

test('a card back moves only the public total, and nothing drops below zero', () => {
  const holds = [hold({ id: 'back', kind: null, delta: 1 }), hold({ id: 'spent', delta: 9 })];
  expect(heldHand(hand, holds, 0)).toEqual({ brick: 1, grain: 0, ore: 0 });
  expect(heldTotal(1, holds, 0)).toBe(0);
});

test('releasing, pruning and clearing always settle on the true counts', () => {
  const store = useCardHolds.getState();
  store.add([
    hold({ id: 'a', expiresAt: 100 }),
    hold({ id: 'b', expiresAt: 200 }),
    hold({ id: 'c', expiresAt: 300 }),
  ]);
  expect(heldHand(hand, useCardHolds.getState().holds, 0).grain).toBe(0);
  useCardHolds.getState().release(['b']);
  expect(heldHand(hand, useCardHolds.getState().holds, 0).grain).toBe(1);
  useCardHolds.getState().prune(100);
  expect(useCardHolds.getState().holds.map((item) => item.id)).toEqual(['c']);
  useCardHolds.getState().clear();
  expect(heldHand(hand, useCardHolds.getState().holds, 0)).toEqual(hand);
});
