import { describe, expect, test } from 'vitest';
import type { Seat } from '../../../core/types/index.js';
import type { Input } from '../../../core/pipeline/index.js';
import type { GameState } from '../../../core/state/index.js';
import { handOf, rejection, submit, top, withHand } from '../support.js';
import {
  engine,
  held,
  play,
  privateOf,
  refusal,
  scene,
  system,
  systemRefusal,
  withBounds,
  withCards,
  withPoints,
} from './testing.js';

/** Seats 1 and 2 are ahead of seat 0. Seat 1 holds 5 cards, seat 2 one card. */
function position() {
  const { state } = scene();
  let next = withHand(state, 0, { wool: 1 });
  next = withHand(next, 1, { ore: 3, grain: 2 });
  next = withHand(next, 2, { brick: 1 });
  next = withPoints(withPoints(withPoints(next, 0, 2), 1, 5), 2, 3);
  return withCards(next, 0, 'wedding');
}

const give = (state: GameState, seat: Seat, cards: Record<string, number> | 'hidden') =>
  submit(engine, state, seat, { type: 'WEDDING_GIVE', cards });

describe('Wedding', () => {
  test('each richer seat gives 2 cards of its choice, or all it has', () => {
    const wedding = play(position(), 0, 'wedding');
    expect(top(wedding)).toMatchObject({ id: 'wedding', data: { actor: 0, remaining: [1, 2] } });
    const pending = engine.getPending(wedding).filter((item) => item.kind === 'player');
    expect(pending.map((item) => (item.kind === 'player' ? item.seat : -1))).toEqual(
      expect.arrayContaining([1, 2]),
    );
    const one = give(wedding, 1, { ore: 1, grain: 1 });
    expect(handOf(one, 1)).toMatchObject({ ore: 2, grain: 1 });
    expect(top(one)).toMatchObject({ data: { remaining: [2] } });
    const two = give(one, 2, { brick: 1 });
    expect(top(two)?.id).toBe('main');
    expect(handOf(two, 0)).toMatchObject({ wool: 1, ore: 1, grain: 1, brick: 1 });
    expect(handOf(two, 2).brick).toBe(0);
    expect(held(two, 0)).toEqual([]);
  });

  test('a seat with equal or fewer points, or no card, is not asked', () => {
    const state = withPoints(withHand(position(), 2, {}), 1, 2);
    expect(refusal(state, 0, 'wedding')).toBe('no-richer-seat');
    const some = withPoints(withHand(position(), 2, {}), 1, 4);
    const wedding = play(some, 0, 'wedding');
    expect(top(wedding)).toMatchObject({ data: { remaining: [1] } });
  });

  test('the count and the affordability of a gift are checked', () => {
    const wedding = play(position(), 0, 'wedding');
    expect(rejection(engine, wedding, 1, { type: 'WEDDING_GIVE', cards: { ore: 1 } })).toBe(
      'wrong-card-count',
    );
    expect(
      rejection(engine, wedding, 1, { type: 'WEDDING_GIVE', cards: { ore: 2, grain: 1 } }),
    ).toBe('wrong-card-count');
    expect(rejection(engine, wedding, 1, { type: 'WEDDING_GIVE', cards: { wool: 2 } })).toBe(
      'insufficient-resources',
    );
    expect(rejection(engine, wedding, 2, { type: 'WEDDING_GIVE', cards: { brick: 2 } })).toBe(
      'wrong-card-count',
    );
    expect(rejection(engine, wedding, 0, { type: 'WEDDING_GIVE', cards: { wool: 1 } })).toBe(
      'not-pending',
    );
  });

  test('a giver may keep the kinds hidden: only the count is public', () => {
    const wedding = play(position(), 0, 'wedding');
    const result = engine.apply(wedding, {
      kind: 'command',
      seat: 1,
      command: { type: 'WEDDING_GIVE', cards: 'hidden' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.effects).toEqual([
      { type: 'hidden-resource-transfer', from: 1, to: 0, count: 1 },
      { type: 'hidden-resource-transfer', from: 1, to: 0, count: 1 },
    ]);
    expect(result.value.state.seats[1]?.resources.total).toBe(3);
    expect(result.value.state.seats[0]?.resources.total).toBe(3);
    const input: Input = {
      kind: 'command',
      seat: 1,
      command: { type: 'WEDDING_GIVE', cards: 'hidden' },
    };
    const giver = privateOf(engine, wedding, 1, { ore: 3, grain: 2 });
    const receiver = privateOf(engine, wedding, 0, { wool: 1 });
    const data = { cards: { ore: 1, grain: 1 } };
    const gave = engine.applyPrivate(giver, wedding, input, data);
    const got = engine.applyPrivate(receiver, wedding, input, data);
    expect(gave.ok && gave.value.hand).toMatchObject({ ore: 2, grain: 1 });
    expect(got.ok && got.value.hand).toMatchObject({ wool: 1, ore: 1, grain: 1 });
    // Without the identities neither party can update its hand, and a bystander is unaffected.
    expect(engine.applyPrivate(giver, wedding, input).ok).toBe(false);
    expect(
      engine.applyPrivate(privateOf(engine, wedding, 2, { brick: 1 }), wedding, input).ok,
    ).toBe(true);
    // The giver cannot give what it does not hold.
    expect(engine.applyPrivate(giver, wedding, input, { cards: { wool: 2 } }).ok).toBe(false);
  });

  test('a timeout gives from an exactly known hand and waits for the owner otherwise', () => {
    const wedding = play(position(), 0, 'wedding');
    const timed = system(wedding, { kind: 'system', type: 'TIMEOUT', seat: 1, phase: 'wedding' });
    expect(handOf(timed, 1)).toMatchObject({ ore: 1, grain: 2 });
    // A hand that the public bounds do not fix cannot be decided by a timeout.
    const vague = play(withBounds(position(), 1, 5, { ore: 5, grain: 5 }), 0, 'wedding');
    expect(
      systemRefusal(vague, { kind: 'system', type: 'TIMEOUT', seat: 1, phase: 'wedding' }),
    ).toBe('unsupported-timeout');
  });

  test('a giver is offered a template, the seat’s own choice', () => {
    const wedding = play(position(), 0, 'wedding');
    const legal = engine.getLegalCommands(wedding, 1);
    expect(legal.templates).toContainEqual(
      expect.objectContaining({ type: 'WEDDING_GIVE', count: 2 }),
    );
    expect(engine.getLegalCommands(wedding, 0).templates.map((item) => item.type)).not.toContain(
      'WEDDING_GIVE',
    );
  });
});
