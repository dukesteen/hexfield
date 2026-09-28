import { describe, expect, test } from 'vitest';
import type { Seat } from '../../../core/types/index.js';
import type { GameState } from '../../../core/state/index.js';
import { handOf, rejection, submit, top, withHand } from '../support.js';
import {
  engine,
  held,
  play,
  refusal,
  scene,
  system,
  systemRefusal,
  withBounds,
  withCards,
  withPoints,
} from './testing.js';

/** Seat 0 has 4 points. Seat 1 (5 points, 7 cards) and seat 2 (4 points, 3 cards) are affected. */
function position() {
  const { state } = scene();
  let next = withHand(state, 0, { wool: 4 });
  next = withHand(next, 1, { ore: 4, grain: 3 });
  next = withHand(next, 2, { brick: 2, cloth: 1 });
  next = withPoints(withPoints(withPoints(next, 0, 4), 1, 5), 2, 4);
  return withCards(next, 0, 'saboteur');
}

const discard = (state: GameState, seat: Seat, cards: Record<string, number>) =>
  submit(engine, state, seat, { type: 'SABOTEUR_DISCARD', cards });

describe('Saboteur', () => {
  test('every seat with as many or more points discards half its hand, rounded down', () => {
    const sabotage = play(position(), 0, 'saboteur');
    expect(top(sabotage)).toMatchObject({ id: 'saboteur', data: { actor: 0, remaining: [1, 2] } });
    const one = discard(sabotage, 1, { ore: 2, grain: 1 });
    expect(handOf(one, 1)).toMatchObject({ ore: 2, grain: 2 });
    expect(one.bank.ore).toBe((sabotage.bank.ore ?? 0) + 2);
    expect(one.bank.grain).toBe((sabotage.bank.grain ?? 0) + 1);
    const two = discard(one, 2, { cloth: 1 });
    expect(top(two)?.id).toBe('main');
    expect(handOf(two, 2)).toMatchObject({ brick: 2, cloth: 0 });
    expect(held(two, 0)).toEqual([]);
    // The player is never affected.
    expect(handOf(two, 0).wool).toBe(4);
  });

  test('a seat with fewer points or fewer than two cards is spared', () => {
    const fewer = withPoints(position(), 2, 3);
    expect(top(play(fewer, 0, 'saboteur'))).toMatchObject({ data: { remaining: [1] } });
    const single = withHand(position(), 2, { brick: 1 });
    expect(top(play(single, 0, 'saboteur'))).toMatchObject({ data: { remaining: [1] } });
    const none = withPoints(withPoints(position(), 1, 3), 2, 3);
    expect(refusal(none, 0, 'saboteur')).toBe('no-target');
    expect(refusal(position(), 0, 'saboteur', { seat: 1 })).toBe('unknown-field');
  });

  test('the discard has exactly half the hand and must be affordable', () => {
    const sabotage = play(position(), 0, 'saboteur');
    expect(rejection(engine, sabotage, 1, { type: 'SABOTEUR_DISCARD', cards: { ore: 2 } })).toBe(
      'wrong-discard-count',
    );
    expect(rejection(engine, sabotage, 1, { type: 'SABOTEUR_DISCARD', cards: { wool: 3 } })).toBe(
      'insufficient-resources',
    );
    expect(rejection(engine, sabotage, 0, { type: 'SABOTEUR_DISCARD', cards: { wool: 2 } })).toBe(
      'not-pending',
    );
    expect(rejection(engine, sabotage, 1, { type: 'SABOTEUR_DISCARD', cards: { paper: 3 } })).toBe(
      'insufficient-resources',
    );
  });

  test('the discards return to the bank and the seats answer at once, in any order', () => {
    const sabotage = play(position(), 0, 'saboteur');
    const later = discard(sabotage, 2, { brick: 1 });
    expect(top(later)).toMatchObject({ data: { remaining: [1] } });
    const done = discard(later, 1, { ore: 3 });
    expect(top(done)?.id).toBe('main');
    expect(handOf(done, 1)).toMatchObject({ ore: 1, grain: 3 });
  });

  test('a timeout discards from an exactly known hand, and waits for the owner otherwise', () => {
    const sabotage = play(position(), 0, 'saboteur');
    const timed = system(sabotage, { kind: 'system', type: 'TIMEOUT', seat: 1, phase: 'saboteur' });
    expect(handOf(timed, 1)).toMatchObject({ ore: 1, grain: 3 });
    const vague = play(withBounds(position(), 1, 7, { ore: 7, grain: 7 }), 0, 'saboteur');
    expect(
      systemRefusal(vague, { kind: 'system', type: 'TIMEOUT', seat: 1, phase: 'saboteur' }),
    ).toBe('unsupported-timeout');
  });

  test('a discarding seat is offered a discard template of half its hand', () => {
    const sabotage = play(position(), 0, 'saboteur');
    expect(engine.getLegalCommands(sabotage, 1).templates).toContainEqual(
      expect.objectContaining({ type: 'SABOTEUR_DISCARD', count: 3 }),
    );
  });
});
