import { describe, expect, test } from 'vitest';
import type { GameState } from '../../../core/state/index.js';
import { handOf, top, withHand } from '../support.js';
import { engine, held, play, playParam, refusal, scene, withCards } from './testing.js';

function position() {
  const { state } = scene();
  const hands = withHand(withHand(withHand(state, 0, {}), 1, { cloth: 3, ore: 1 }), 2, {
    cloth: 1,
  });
  return withCards(hands, 0, 'tradeMonopoly');
}

function reveal(state: GameState, seat: number, kind: string, count: number): GameState {
  const result = engine.apply(state, {
    kind: 'system',
    type: 'REVEAL_COUNT',
    seat,
    resource: kind,
    count,
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value.state;
}

describe('Trade Monopoly', () => {
  test('each other seat gives 1 of the named commodity, if it has one', () => {
    const named = play(position(), 0, 'tradeMonopoly', { kind: 'cloth' });
    expect(top(named)).toMatchObject({ id: 'monopoly', data: { resource: 'cloth', limit: 1 } });
    const one = reveal(named, 1, 'cloth', 3);
    expect(handOf(one, 1)).toMatchObject({ cloth: 2, ore: 1 });
    const two = reveal(one, 2, 'cloth', 1);
    expect(handOf(two, 2).cloth).toBe(0);
    expect(handOf(two, 0).cloth).toBe(2);
    expect(top(two)?.id).toBe('main');
    expect(held(two, 0)).toEqual([]);
  });

  test('a seat that cannot hold the commodity is not asked', () => {
    const state = withHand(position(), 2, { ore: 2 });
    const named = play(state, 0, 'tradeMonopoly', { kind: 'cloth' });
    const asked = engine
      .getPending(named)
      .flatMap((item) => (item.kind === 'reveal' ? [item.seat] : []));
    expect(asked).toEqual([1]);
  });

  test('a seat that may hold it and does not answers with zero and gives nothing', () => {
    const unsure = {
      ...position(),
    };
    const named = play(unsure, 0, 'tradeMonopoly', { kind: 'cloth' });
    const done = reveal(reveal(named, 1, 'cloth', 3), 2, 'cloth', 1);
    expect(handOf(done, 0).cloth).toBe(2);
  });

  test('only commodities may be named, and someone must be able to hold it', () => {
    const state = position();
    expect(refusal(state, 0, 'tradeMonopoly', { kind: 'ore' })).toBe('invalid-kind');
    expect(refusal(state, 0, 'tradeMonopoly', { kind: 'coin' })).toBe('no-holder');
    expect(refusal(state, 0, 'tradeMonopoly')).toBe('invalid-params');
  });

  test('only a commodity some other seat may hold is listed', () => {
    expect(playParam(position(), 0, 'kind')).toEqual(['cloth']);
  });
});
