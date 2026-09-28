import { describe, expect, test } from 'vitest';
import type { Seat } from '../../../core/types/index.js';
import {
  hexOf,
  handOf,
  newGame,
  setRobber,
  submit,
  verticesOfHex,
  withBuildings,
  withHand,
} from '../support.js';
import { inMain } from '../support.js';
import { knightsExt } from '../types.js';
import { engine, held, play, playParam, refusal, withCards } from './testing.js';

/** Seat 0 has a settlement on a forest hex, seat 1 one on a hill hex. */
function position() {
  const base = newGame(engine, { seats: 3 });
  const forest = hexOf(base, 'forest');
  const hills = hexOf(base, 'hills');
  const desert = hexOf(base, 'desert');
  const vertex = verticesOfHex(base, forest)[0] ?? '';
  const other =
    verticesOfHex(base, hills).find((v) => !verticesOfHex(base, forest).includes(v)) ?? '';
  const state = withBuildings(base, [
    { vertex, seat: 0 },
    { vertex: other, seat: 1 },
  ]);
  return { state: withCards(inMain(state), 0, 'merchant'), forest, hills, desert };
}

const points = (state: ReturnType<typeof position>['state'], seat: Seat) =>
  engine.computeVictoryPoints(state, seat).public;

describe('Merchant', () => {
  test('is placed next to the player’s building and earns a point', () => {
    const { state, forest } = position();
    const after = play(state, 0, 'merchant', { hex: forest });
    expect(knightsExt(after).merchant).toEqual({ seat: 0, hex: forest });
    // One settlement and the merchant.
    expect(points(after, 0)).toBe(2);
    expect(after.seats[0]?.publicVp).toBe(2);
    expect(held(after, 0)).toEqual([]);
  });

  test('the controller trades that hex’s resource 2:1, and only that one', () => {
    const { state, forest } = position();
    const after = withHand(play(state, 0, 'merchant', { hex: forest }), 0, { lumber: 2, brick: 2 });
    const traded = submit(engine, after, 0, {
      type: 'MARITIME_TRADE',
      give: { lumber: 2 },
      get: { ore: 1 },
    });
    expect(handOf(traded, 0)).toMatchObject({ lumber: 0, ore: 1 });
    expect(
      engine.validate(after, {
        kind: 'command',
        seat: 0,
        command: { type: 'MARITIME_TRADE', give: { brick: 2 }, get: { ore: 1 } },
      }).ok,
    ).toBe(false);
    // The merchant never gives a commodity a 2:1 rate.
    expect(engine.hooks.bankRate(after, 0, 'paper', 4)).toBe(4);
  });

  test('another seat’s Merchant card takes the piece, the rate and the point', () => {
    const { state, forest, hills } = position();
    const mine = play(state, 0, 'merchant', { hex: forest });
    const theirs = withCards({ ...mine, turn: { ...mine.turn, activeSeat: 1 } }, 1, 'merchant');
    const stolen = play(theirs, 1, 'merchant', { hex: hills });
    expect(knightsExt(stolen).merchant).toEqual({ seat: 1, hex: hills });
    expect(mine.seats[0]?.publicVp).toBe(2);
    // The old controller loses the point, the new one has it beside its settlement.
    expect(stolen.seats[0]?.publicVp).toBe(1);
    expect(stolen.seats[1]?.publicVp).toBe(2);
    expect(engine.hooks.bankRate(stolen, 0, 'lumber', 4)).toBe(4);
    expect(engine.hooks.bankRate(stolen, 1, 'brick', 4)).toBe(2);
  });

  test('the controller can move it, and the robber may share its hex', () => {
    const { state, forest } = position();
    const first = play(withCards(state, 0, 'merchant'), 0, 'merchant', { hex: forest });
    expect(refusal(first, 0, 'merchant', { hex: forest })).toBe('already-there');
    const guarded = setRobber(first, forest);
    expect(knightsExt(guarded).merchant?.hex).toBe(forest);
    expect(engine.hooks.bankRate(guarded, 0, 'lumber', 4)).toBe(2);
  });

  test('a land hex next to one of the player’s buildings is required; a desert counts', () => {
    const { state, hills, desert } = position();
    expect(refusal(state, 0, 'merchant', { hex: hills })).toBe('not-adjacent');
    expect(refusal(state, 0, 'merchant')).toBe('invalid-params');
    const built = withBuildings(state, [
      { vertex: verticesOfHex(state, desert)[0] ?? '', seat: 0 },
    ]);
    const after = play(built, 0, 'merchant', { hex: desert });
    // Two settlements and the merchant.
    expect(points(after, 0)).toBe(3);
    // A desert gives the point and no rate.
    expect(engine.hooks.bankRate(after, 0, 'lumber', 4)).toBe(4);
  });

  test('every hex next to a building is listed', () => {
    const { state, forest } = position();
    const listed = playParam(state, 0, 'hex');
    expect(listed).toContain(forest);
    expect(listed.length).toBeGreaterThanOrEqual(1);
  });
});
