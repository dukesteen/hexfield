import { describe, expect, test } from 'vitest';
import type { GameState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { knightsEngine } from './testing.js';
import {
  handOf,
  hexOf,
  inDice,
  newGame,
  roll,
  setRobber,
  verticesOfHex,
  withBuildings,
  withHand,
  withTokens,
} from './support.js';

const engine = knightsEngine();

/** A board where only `hex` carries the token, with seat 0 building `kind` on one of its corners. */
function scene(terrain: string, kind: string, token = 8): { state: GameState; hex: string } {
  const base = newGame(engine);
  const hex = hexOf(base, terrain);
  const vertex = verticesOfHex(base, hex)[0] ?? '';
  const state = inDice(
    withBuildings(withTokens(setRobber(base, hexOf(base, 'desert')), { [hex]: token }), [
      { vertex, seat: 0, kind },
    ]),
  );
  return { state, hex };
}

const ROLL_FOR: Record<number, [number, number]> = { 8: [4, 4] };

describe('city production', () => {
  const table: [string, Record<string, number>, Record<string, number>][] = [
    ['forest', { lumber: 1 }, { lumber: 1, paper: 1 }],
    ['pasture', { wool: 1 }, { wool: 1, cloth: 1 }],
    ['mountains', { ore: 1 }, { ore: 1, coin: 1 }],
    ['fields', { grain: 1 }, { grain: 2 }],
    ['hills', { brick: 1 }, { brick: 2 }],
  ];
  for (const [terrain, settlement, city] of table) {
    test(`${terrain}: a settlement pays ${JSON.stringify(settlement)}, a city ${JSON.stringify(city)}`, () => {
      const one = roll(engine, scene(terrain, 'settlement').state, ROLL_FOR[8] ?? [4, 4]);
      expect(nonZero(handOf(one, 0))).toEqual(settlement);
      const two = roll(engine, scene(terrain, 'city').state, ROLL_FOR[8] ?? [4, 4]);
      expect(nonZero(handOf(two, 0))).toEqual(city);
      expect(engine.checkInvariants(two)).toEqual([]);
    });
  }

  test('the robber blocks a city, commodity included', () => {
    const { state, hex } = scene('forest', 'city');
    const after = roll(engine, setRobber(state, hex), [4, 4]);
    expect(nonZero(handOf(after, 0))).toEqual({});
  });
});

function forestCities(seats: Seat[]): GameState {
  const base = newGame(engine, { seats: 3 });
  const hex = hexOf(base, 'forest');
  const corners = verticesOfHex(base, hex);
  const state = withBuildings(
    withTokens(setRobber(base, hexOf(base, 'desert')), { [hex]: 8 }),
    seats.map((seat, index) => ({ vertex: corners[index * 2] ?? '', seat, kind: 'city' })),
  );
  return inDice(state);
}
const withBank = (state: GameState, bank: Record<string, number>): GameState => ({
  ...state,
  bank: { ...state.bank, ...bank },
});

describe('bank shortage per card kind', () => {
  test('two cities demanding the last paper both get none, but each gets its lumber', () => {
    const after = roll(engine, withBank(forestCities([0, 1]), { paper: 1 }), [4, 4]);
    expect(nonZero(handOf(after, 0))).toEqual({ lumber: 1 });
    expect(nonZero(handOf(after, 1))).toEqual({ lumber: 1 });
    expect(after.bank.paper).toBe(1);
  });

  test('a lone city gets what is left of a commodity', () => {
    const state = forestCities([0]);
    const hex = hexOf(state, 'forest');
    // A second city on the same hex doubles the demand to 2 paper.
    const corners = verticesOfHex(state, hex);
    const two = withBuildings(state, [{ vertex: corners[2] ?? '', seat: 0, kind: 'city' }]);
    const after = roll(engine, withBank(two, { paper: 1 }), [4, 4]);
    expect(nonZero(handOf(after, 0))).toEqual({ lumber: 2, paper: 1 });
  });

  test('an empty resource stock does not block the commodity', () => {
    const after = roll(engine, withBank(forestCities([0]), { lumber: 0 }), [4, 4]);
    expect(nonZero(handOf(after, 0))).toEqual({ paper: 1 });
  });

  test('the bank is conserved across a roll', () => {
    const before = forestCities([0, 1]);
    const after = roll(engine, before, [4, 4]);
    for (const kind of ['lumber', 'paper'])
      expect(
        (after.bank[kind] ?? 0) + (handOf(after, 0)[kind] ?? 0) + (handOf(after, 1)[kind] ?? 0),
      ).toBe(before.bank[kind]);
  });
});

describe('commodities in hands', () => {
  test('a hand keeps its kinds through withHand', () => {
    const state = withHand(newGame(engine), 0, { paper: 2, ore: 1 });
    expect(nonZero(handOf(state, 0))).toEqual({ paper: 2, ore: 1 });
    expect(engine.checkInvariants(state)).toEqual([]);
  });
});

function nonZero(hand: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(hand).filter(([, count]) => count > 0));
}
