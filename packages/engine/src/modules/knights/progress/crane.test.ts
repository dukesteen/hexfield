import { describe, expect, test } from 'vitest';
import { knightsExt, levelOf } from '../types.js';
import { handOf, withBuildings, withHand, withLevels } from '../support.js';
import { at, engine, held, play, refusal, scene, withCards } from './testing.js';

function position(cards: string[] = ['crane']) {
  const { state, ring } = scene();
  const rich = withBuildings(state, [{ vertex: at(ring, 4), seat: 0, kind: 'city' }]);
  return withCards(rich, 0, ...cards);
}

describe('Crane', () => {
  test('level 1 is free', () => {
    const state = withHand(position(), 0, {});
    const after = play(state, 0, 'crane', { track: 'science' });
    expect(levelOf(after, 0, 'science')).toBe(1);
    expect(handOf(after, 0)).toEqual(handOf(state, 0));
  });

  test('a later level costs one commodity less', () => {
    const state = withHand(withLevels(position(), 0, { trade: 2 }), 0, { cloth: 2 });
    // Level 3 would cost 3 cloth; the Crane makes it 2.
    const after = play(state, 0, 'crane', { track: 'trade' });
    expect(levelOf(after, 0, 'trade')).toBe(3);
    expect(handOf(after, 0).cloth).toBe(0);
    expect(after.bank.cloth).toBe((state.bank.cloth ?? 0) + 2);
  });

  test('the discounted price must still be affordable', () => {
    const state = withHand(withLevels(position(), 0, { politics: 3 }), 0, { coin: 2 });
    expect(refusal(state, 0, 'crane', { track: 'politics' })).toBe('insufficient-resources');
  });

  test('one Crane covers one improvement and two Cranes two levels, never one twice', () => {
    const state = withHand(position(['crane', 'crane']), 0, { paper: 1 });
    const once = play(state, 0, 'crane', { track: 'science' });
    expect(levelOf(once, 0, 'science')).toBe(1);
    const twice = play(once, 0, 'crane', { track: 'science' });
    // Level 2 costs 2 paper, discounted to 1.
    expect(levelOf(twice, 0, 'science')).toBe(2);
    expect(handOf(twice, 0).paper).toBe(0);
    // Both Cranes are spent: the hand is empty and each went under its deck.
    expect(held(twice, 0)).toEqual([]);
    expect(knightsExt(twice).bottom.science).toEqual(['crane', 'crane']);
  });

  test('the ordinary rules of an improvement still apply', () => {
    const { state } = scene();
    const noCity = withCards(state, 0, 'crane');
    expect(refusal(noCity, 0, 'crane', { track: 'science' })).toBe('no-city');
    const maxed = withLevels(position(), 0, { science: 5 });
    expect(refusal(maxed, 0, 'crane', { track: 'science' })).toBe('max-level');
    expect(refusal(position(), 0, 'crane', { track: 'sea' })).toBe('invalid-track');
    expect(refusal(position(), 0, 'crane')).toBe('invalid-params');
  });

  test('a level 4 purchase takes the metropolis like any purchase', () => {
    const state = withHand(withLevels(position(), 0, { science: 3 }), 0, { paper: 3 });
    const after = play(state, 0, 'crane', { track: 'science' });
    expect(levelOf(after, 0, 'science')).toBe(4);
    expect(knightsExt(after).metropolises.science?.seat).toBe(0);
  });

  test('it is listed for every track the hand can pay', () => {
    const rich = withHand(position(), 0, { cloth: 3 });
    const listed = engine
      .getLegalCommands(rich, 0)
      .commands.filter((item) => item.type === 'PLAY_PROGRESS_CARD');
    expect(listed.map((item) => item.params)).toEqual(
      expect.arrayContaining([{ track: 'science' }, { track: 'trade' }, { track: 'politics' }]),
    );
  });
});
