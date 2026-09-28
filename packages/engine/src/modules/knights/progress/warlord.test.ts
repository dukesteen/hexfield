import { describe, expect, test } from 'vitest';
import { knightAt, knightsOf } from '../pieces.js';
import { handOf, submit, withHand } from '../support.js';
import { at, engine, held, knightsOn, play, refusal, scene, withCards } from './testing.js';

function position() {
  const { state, ring } = scene();
  let next = knightsOn(state, 0, [at(ring, 1)], { active: true, ready: true });
  next = knightsOn(next, 0, [at(ring, 2)], { level: 2, active: false, ready: false });
  next = knightsOn(next, 0, [at(ring, 3)], { level: 3, active: false, ready: false });
  next = knightsOn(next, 1, [at(ring, 4)], { active: false, ready: false });
  return { state: withHand(withCards(next, 0, 'warlord'), 0, {}), ring };
}

describe('Warlord', () => {
  test('activates all of the seat’s knights for free', () => {
    const { state } = position();
    const after = play(state, 0, 'warlord');
    expect(knightsOf(after, 0).every((knight) => knight.active)).toBe(true);
    expect(handOf(after, 0)).toEqual(handOf(state, 0));
    expect(held(after, 0)).toEqual([]);
  });

  test('other seats’ knights stay as they were', () => {
    const { state } = position();
    expect(knightsOf(play(state, 0, 'warlord'), 1).map((knight) => knight.active)).toEqual([false]);
  });

  test('activation never makes an inactive knight ready for this turn', () => {
    const { state, ring } = position();
    const after = play(state, 0, 'warlord');
    expect([1, 2, 3].map((index) => knightAt(after, at(ring, index))?.ready)).toEqual([
      true,
      false,
      false,
    ]);
    // A knight that was already ready can act, the others cannot.
    const acting = engine
      .getLegalCommands(after, 0)
      .commands.filter((item) => item.type === 'MOVE_KNIGHT');
    expect(new Set(acting.map((item) => item.from))).toEqual(new Set([at(ring, 1)]));
    expect(
      submit(engine, after, 0, { type: 'MOVE_KNIGHT', from: at(ring, 1), to: at(ring, 0) }),
    ).toBeDefined();
  });

  test('with nothing to activate it is refused', () => {
    const { state } = position();
    const done = play(state, 0, 'warlord');
    expect(refusal(withCards(done, 0, 'warlord'), 0, 'warlord')).toBe('nothing-to-activate');
    expect(refusal(withCards(scene().state, 0, 'warlord'), 0, 'warlord')).toBe(
      'nothing-to-activate',
    );
    expect(refusal(state, 0, 'warlord', { all: true })).toBe('unknown-field');
  });
});
