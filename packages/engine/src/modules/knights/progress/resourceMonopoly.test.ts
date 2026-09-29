import { describe, expect, test } from 'vitest';
import type { GameState } from '../../../core/state/index.js';
import { handOf, top, withHand } from '../support.js';
import { engine, held, play, playParam, refusal, scene, withCards } from './testing.js';

function position() {
  const { state } = scene();
  const hands = withHand(withHand(withHand(state, 0, { ore: 1 }), 1, { ore: 3, wool: 2 }), 2, {
    ore: 1,
    coin: 4,
  });
  return withCards(hands, 0, 'resourceMonopoly');
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

describe('Resource Monopoly', () => {
  test('each other seat gives 2 of the named resource, or its only one', () => {
    const named = play(position(), 0, 'resourceMonopoly', { kind: 'ore' });
    expect(top(named)).toMatchObject({ id: 'monopoly', data: { resource: 'ore', limit: 2 } });
    const pending = engine.getPending(named).filter((item) => item.kind === 'reveal');
    expect(pending.map((item) => (item.kind === 'reveal' ? item.seat : -1))).toEqual([1, 2]);
    const one = reveal(named, 1, 'ore', 3);
    expect(handOf(one, 1)).toMatchObject({ ore: 1, wool: 2 });
    expect(handOf(one, 0).ore).toBe(3);
    const two = reveal(one, 2, 'ore', 1);
    expect(handOf(two, 2)).toMatchObject({ ore: 0, coin: 4 });
    expect(handOf(two, 0).ore).toBe(4);
    expect(top(two)?.id).toBe('main');
    expect(held(two, 0)).toEqual([]);
  });

  test('a seat with none is not asked, and a short hand gives what it has', () => {
    const state = withHand(position(), 2, { coin: 1 });
    const named = play(state, 0, 'resourceMonopoly', { kind: 'ore' });
    expect(engine.getPending(named).filter((item) => item.kind === 'reveal')).toHaveLength(1);
    const done = reveal(named, 1, 'ore', 3);
    expect(handOf(done, 0).ore).toBe(3);
  });

  test('a count outside the public bounds is refused, and the bank is untouched', () => {
    const named = play(position(), 0, 'resourceMonopoly', { kind: 'ore' });
    const bad = engine.validate(named, {
      kind: 'system',
      type: 'REVEAL_COUNT',
      seat: 1,
      resource: 'ore',
      count: 5,
    });
    expect(bad.ok).toBe(false);
    expect(reveal(named, 1, 'ore', 3).bank).toEqual(named.bank);
  });

  test('only resources may be named, and someone must be able to hold it', () => {
    const state = position();
    expect(refusal(state, 0, 'resourceMonopoly', { kind: 'coin' })).toBe('invalid-kind');
    expect(refusal(state, 0, 'resourceMonopoly', { kind: 'gold' })).toBe('invalid-kind');
    expect(refusal(state, 0, 'resourceMonopoly')).toBe('invalid-params');
    const empty = withHand(withHand(state, 1, {}), 2, {});
    expect(refusal(empty, 0, 'resourceMonopoly', { kind: 'ore' })).toBe('no-holder');
  });

  test('only a resource some other seat may hold is listed', () => {
    expect(playParam(position(), 0, 'kind')).toEqual(['wool', 'ore']);
  });
});
