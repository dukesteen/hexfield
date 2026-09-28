import { describe, expect, test } from 'vitest';
import {
  handOf,
  hexOf,
  inMain,
  newGame,
  setRobber,
  verticesOfHex,
  withBuildings,
  withHand,
} from '../support.js';
import { engine, held, play, refusal, withCards } from './testing.js';

function position() {
  const base = newGame(engine, { seats: 3 });
  const first = hexOf(base, 'mountains', 0);
  const second = hexOf(base, 'mountains', 1);
  const touching = (hex: string) => verticesOfHex(base, hex);
  const settlement = touching(first)[0] ?? '';
  const city = touching(second).find((vertex) => !touching(first).includes(vertex)) ?? '';
  const state = withBuildings(base, [
    { vertex: settlement, seat: 0 },
    { vertex: city, seat: 0, kind: 'city' },
  ]);
  return { state: withCards(inMain(withHand(state, 0, {})), 0, 'mining'), first, second };
}

describe('Mining', () => {
  test('pays 2 ore for each mountains hex touching a building, never a coin', () => {
    const { state } = position();
    const after = play(state, 0, 'mining');
    expect(handOf(after, 0).ore).toBe(4);
    expect(handOf(after, 0).coin).toBe(0);
    expect(after.bank.ore).toBe((state.bank.ore ?? 0) - 4);
    expect(held(after, 0)).toEqual([]);
  });

  test('the robber on a hex does not stop it', () => {
    const { state, first } = position();
    expect(handOf(play(setRobber(state, first), 0, 'mining'), 0).ore).toBe(4);
  });

  test('a short bank pays what remains and an empty bank refuses the play', () => {
    const { state } = position();
    const short = { ...state, bank: { ...state.bank, ore: 1 } };
    expect(handOf(play(short, 0, 'mining'), 0).ore).toBe(1);
    expect(refusal({ ...state, bank: { ...state.bank, ore: 0 } }, 0, 'mining')).toBe('empty-bank');
  });

  test('it needs a building on a mountains hex', () => {
    const state = withCards(inMain(newGame(engine, { seats: 3 })), 0, 'mining');
    expect(refusal(state, 0, 'mining')).toBe('no-hex');
  });
});
