import { describe, expect, test } from 'vitest';
import { knightsExt } from '../types.js';
import { handOf, withBuildings, withHand } from '../support.js';
import { at, engine, held, play, refusal, scene, withCards } from './testing.js';

function position() {
  const { state, ring, out } = scene();
  const cities = withBuildings(state, [
    { vertex: at(ring, 2), seat: 0, kind: 'city' },
    { vertex: at(ring, 4), seat: 0, kind: 'city' },
  ]);
  return { state: withHand(withCards(cities, 0, 'engineer'), 0, {}), ring, out };
}

describe('Engineer', () => {
  test('builds a city wall for free under a city', () => {
    const { state, ring } = position();
    const after = play(state, 0, 'engineer', { vertex: at(ring, 2) });
    expect(knightsExt(after).walls).toEqual([{ seat: 0, vertex: at(ring, 2) }]);
    expect(handOf(after, 0)).toEqual(handOf(state, 0));
    // The wall adds 2 to the seat's discard limit.
    expect(engine.hooks.handLimit(after, 0, 7)).toBe(9);
    expect(held(after, 0)).toEqual([]);
    expect(knightsExt(after).bottom.science).toEqual(['engineer']);
  });

  test('it needs one of the seat’s own cities without a wall', () => {
    const { state, ring, out } = position();
    expect(refusal(state, 0, 'engineer', { vertex: at(out, 0) })).toBe('no-city');
    expect(refusal(state, 0, 'engineer', { vertex: at(ring, 5) })).toBe('no-city');
    const walled = play(state, 0, 'engineer', { vertex: at(ring, 2) });
    const again = withCards(walled, 0, 'engineer');
    expect(refusal(again, 0, 'engineer', { vertex: at(ring, 2) })).toBe('walled');
    expect(refusal(again, 0, 'engineer', { vertex: at(ring, 4) })).toBeNull();
  });

  test('all three wall pieces may be on the board, and no more', () => {
    const { state, ring } = position();
    const third = withBuildings(state, [{ vertex: at(ring, 0), seat: 0, kind: 'city' }]);
    const walls = ['engineer', 'engineer'].reduce(
      (next, _, index) =>
        play(withCards(next, 0, 'engineer'), 0, 'engineer', {
          vertex: at(ring, [2, 4][index] ?? 0),
        }),
      third,
    );
    const last = play(walls, 0, 'engineer', { vertex: at(ring, 0) });
    expect(knightsExt(last).walls).toHaveLength(3);
    const city = withBuildings(last, []);
    expect(refusal(withCards(city, 0, 'engineer'), 0, 'engineer', { vertex: at(ring, 1) })).toBe(
      'no-city',
    );
  });

  test('it is refused outside the action phase and needs its vertex', () => {
    const { state } = position();
    expect(refusal(state, 0, 'engineer')).toBe('invalid-params');
    expect(refusal(state, 0, 'engineer', { vertex: 3 })).toBe('invalid-vertex');
  });

  test('every city without a wall is listed', () => {
    const { state, ring } = position();
    const listed = engine
      .getLegalCommands(state, 0)
      .commands.filter((item) => item.type === 'PLAY_PROGRESS_CARD')
      .map((item) => item.params);
    expect(listed).toEqual([{ vertex: at(ring, 2) }, { vertex: at(ring, 4) }]);
  });
});
