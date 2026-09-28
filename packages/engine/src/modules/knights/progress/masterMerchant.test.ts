import { describe, expect, test } from 'vitest';
import { handOf, top, withHand } from '../support.js';
import {
  engine,
  held,
  play,
  privateOf,
  refusal,
  scene,
  system,
  systemRefusal,
  withCards,
  withPoints,
} from './testing.js';

/** Seat 1 leads (5 points) with 4 cards, seat 2 (3 points) has more than the player but 1 card. */
function position() {
  const { state } = scene();
  let next = withHand(state, 0, { wool: 1 });
  next = withHand(next, 1, { ore: 2, cloth: 1, coin: 1 });
  next = withHand(next, 2, { brick: 1 });
  next = withPoints(withPoints(withPoints(next, 0, 2), 1, 5), 2, 3);
  return withCards(next, 0, 'masterMerchant');
}

const show = { kind: 'system' as const, type: 'SHOW_HAND', seat: 1, to: 0, what: 'cards' };

describe('Master Merchant', () => {
  test('the target shows its hand to the player, who then takes 2 cards', () => {
    const played = play(position(), 0, 'masterMerchant', { target: 1 });
    expect(top(played)).toMatchObject({
      id: 'look',
      data: { what: 'cards', actor: 0, target: 1, stage: 'show', count: 2 },
    });
    expect(engine.getPending(played)).toContainEqual({
      kind: 'reveal',
      seat: 1,
      request: { type: 'showHand', to: 0, what: 'cards' },
      systemType: 'SHOW_HAND',
    });
    const shown = system(played, show);
    expect(engine.getPending(shown)).toContainEqual({
      kind: 'reveal',
      seat: 0,
      request: { type: 'takeCards', from: 1, count: 2 },
      systemType: 'TAKE_CARDS',
    });
    const taken = system(shown, {
      kind: 'system',
      type: 'TAKE_CARDS',
      seat: 0,
      from: 1,
      cards: { ore: 1, coin: 1 },
    });
    expect(handOf(taken, 0)).toMatchObject({ wool: 1, ore: 1, coin: 1 });
    expect(handOf(taken, 1)).toMatchObject({ ore: 1, cloth: 1, coin: 0 });
    expect(top(taken)?.id).toBe('main');
    expect(held(taken, 0)).toEqual([]);
  });

  test('only the player learns the hand: the show is private input data', () => {
    const played = play(position(), 0, 'masterMerchant', { target: 1 });
    const actor = privateOf(engine, played, 0, { wool: 1 });
    const seen = engine.applyPrivate(actor, played, show, { hand: { ore: 2, cloth: 1, coin: 1 } });
    expect(seen.ok).toBe(true);
    expect(engine.applyPrivate(actor, played, show).ok).toBe(false);
    // A bystander needs nothing.
    expect(engine.applyPrivate(privateOf(engine, played, 2, { brick: 1 }), played, show).ok).toBe(
      true,
    );
  });

  test('the cards may be taken hidden: only the count is public, the kinds go to the two parties', () => {
    const shown = system(play(position(), 0, 'masterMerchant', { target: 1 }), show);
    const take = {
      kind: 'system' as const,
      type: 'TAKE_CARDS',
      seat: 0,
      from: 1,
      cards: 'hidden',
    };
    const result = engine.apply(shown, take);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.effects).toEqual([
      { type: 'hidden-resource-transfer', from: 1, to: 0, count: 1 },
      { type: 'hidden-resource-transfer', from: 1, to: 0, count: 1 },
    ]);
    const data = { cards: { ore: 2 } };
    const target = privateOf(engine, shown, 1, { ore: 2, cloth: 1, coin: 1 });
    const actor = privateOf(engine, shown, 0, { wool: 1 });
    const lost = engine.applyPrivate(target, shown, take, data);
    const gained = engine.applyPrivate(actor, shown, take, data);
    expect(lost.ok && lost.value.hand).toMatchObject({ ore: 0, cloth: 1, coin: 1 });
    expect(gained.ok && gained.value.hand).toMatchObject({ wool: 1, ore: 2 });
    expect(engine.applyPrivate(target, shown, take, { cards: { paper: 2 } }).ok).toBe(false);
    expect(engine.applyPrivate(target, shown, take, { cards: { ore: 1 } }).ok).toBe(false);
  });

  test('a target with one card gives that card, and the count and cards are checked', () => {
    const solo = play(withPoints(position(), 2, 9), 0, 'masterMerchant', { target: 2 });
    expect(top(solo)).toMatchObject({ data: { count: 1 } });
    const shown = system(solo, { ...show, seat: 2 });
    expect(
      systemRefusal(shown, {
        kind: 'system',
        type: 'TAKE_CARDS',
        seat: 0,
        from: 2,
        cards: { brick: 2 },
      }),
    ).toBe('wrong-card-count');
    const taken = system(shown, {
      kind: 'system',
      type: 'TAKE_CARDS',
      seat: 0,
      from: 2,
      cards: { brick: 1 },
    });
    expect(handOf(taken, 0).brick).toBe(1);
  });

  test('a take of cards the target cannot hold is refused', () => {
    const shown = system(play(position(), 0, 'masterMerchant', { target: 1 }), show);
    expect(
      systemRefusal(shown, {
        kind: 'system',
        type: 'TAKE_CARDS',
        seat: 0,
        from: 1,
        cards: { brick: 1, ore: 1 },
      }),
    ).toBe('insufficient-resources');
    expect(
      systemRefusal(shown, { kind: 'system', type: 'TAKE_CARDS', seat: 1, from: 0, cards: {} }),
    ).not.toBeNull();
  });

  test('the target needs more points than the player and a card in hand', () => {
    const state = position();
    expect(refusal(state, 0, 'masterMerchant', { target: 0 })).toBe('no-target');
    expect(refusal(withPoints(state, 1, 2), 0, 'masterMerchant', { target: 1 })).toBe('no-target');
    expect(refusal(withHand(state, 1, {}), 0, 'masterMerchant', { target: 1 })).toBe('no-target');
    expect(refusal(state, 0, 'masterMerchant', { target: 9 })).toBe('invalid-seat');
    expect(refusal(state, 0, 'masterMerchant')).toBe('invalid-params');
  });

  test('every richer seat with cards is listed', () => {
    const listed = engine
      .getLegalCommands(position(), 0)
      .commands.filter((item) => item.type === 'PLAY_PROGRESS_CARD')
      .map((item) => item.params);
    expect(listed).toEqual([{ target: 1 }, { target: 2 }]);
  });
});
