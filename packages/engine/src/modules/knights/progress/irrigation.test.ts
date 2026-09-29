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

/** Seat 0 touches the first fields hex with a settlement, and a second one through a city. */
function position() {
  const base = newGame(engine, { seats: 3 });
  const first = hexOf(base, 'fields', 0);
  const second = hexOf(base, 'fields', 1);
  const touching = (hex: string) => verticesOfHex(base, hex);
  const settlement = touching(first)[0] ?? '';
  const city = touching(second).find((vertex) => !touching(first).includes(vertex)) ?? '';
  const state = withBuildings(base, [
    { vertex: settlement, seat: 0 },
    { vertex: city, seat: 0, kind: 'city' },
  ]);
  return { state: withCards(inMain(withHand(state, 0, {})), 0, 'irrigation'), first, second };
}

describe('Irrigation', () => {
  test('pays 2 grain for each fields hex touching a building, a city not doubling it', () => {
    const { state } = position();
    const after = play(state, 0, 'irrigation');
    expect(handOf(after, 0).grain).toBe(4);
    expect(after.bank.grain).toBe((state.bank.grain ?? 0) - 4);
    expect(held(after, 0)).toEqual([]);
  });

  test('a hex touched twice counts once, and the robber does not matter', () => {
    const { state, first } = position();
    const settlement = verticesOfHex(state, first);
    const both = withBuildings(state, [{ vertex: settlement[2] ?? '', seat: 0 }]);
    const guarded = setRobber(both, first);
    const after = play(guarded, 0, 'irrigation');
    expect(handOf(after, 0).grain).toBe(4);
  });

  test('a short bank pays what remains, and an empty bank makes it unplayable', () => {
    const { state } = position();
    const short = { ...state, bank: { ...state.bank, grain: 3 } };
    expect(handOf(play(short, 0, 'irrigation'), 0).grain).toBe(3);
    const empty = { ...state, bank: { ...state.bank, grain: 0 } };
    expect(refusal(empty, 0, 'irrigation')).toBe('empty-bank');
  });

  test('it needs a building on a fields hex', () => {
    const base = newGame(engine, { seats: 3 });
    const state = withCards(inMain(base), 0, 'irrigation');
    expect(refusal(state, 0, 'irrigation')).toBe('no-hex');
    expect(refusal(position().state, 0, 'irrigation', { extra: 1 })).toBe('unknown-field');
  });

  test('other seats’ buildings do not count, and mountains pay nothing', () => {
    const { state, first } = position();
    const foreign = withBuildings(inMain(newGame(engine, { seats: 3 })), [
      { vertex: verticesOfHex(state, first)[0] ?? '', seat: 1 },
    ]);
    expect(refusal(withCards(foreign, 0, 'irrigation'), 0, 'irrigation')).toBe('no-hex');
  });
});
