import { describe, expect, test } from 'vitest';
import type { GameState } from '../../../core/state/index.js';
import { top, withHand } from '../support.js';
import {
  engine,
  held,
  play,
  privateOf,
  refusal,
  scene,
  slotFor,
  system,
  systemRefusal,
  withCards,
  withHidden,
} from './testing.js';

/** Seat 1 holds a Merchant and a Warlord, seat 2 nothing. Seat 0 holds the Spy. */
function position() {
  const { state } = scene();
  return withCards(withCards(withHand(state, 0, {}), 1, 'merchant', 'warlord'), 0, 'spy');
}

const show = { kind: 'system' as const, type: 'SHOW_HAND', seat: 1, to: 0, what: 'progress' };

function shown(state: GameState = position()): GameState {
  return system(play(state, 0, 'spy', { target: 1 }), show);
}

describe('Spy', () => {
  test('the target shows its progress cards to the player, who takes one', () => {
    const played = play(position(), 0, 'spy', { target: 1 });
    expect(top(played)).toMatchObject({ id: 'look', data: { what: 'progress', target: 1 } });
    const state = system(played, show);
    expect(engine.getPending(state)).toContainEqual({
      kind: 'reveal',
      seat: 0,
      request: { type: 'takeProgress', from: 1 },
      systemType: 'TAKE_PROGRESS',
    });
    const slotId = slotFor(state, 1, 'warlord');
    const taken = engine.apply(state, {
      kind: 'system',
      type: 'TAKE_PROGRESS',
      seat: 0,
      from: 1,
      slotId,
    });
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    expect(taken.value.effects).toEqual([
      { type: 'card-slot-moved', from: 1, to: 0, deck: 'progress-politics', slotId },
    ]);
    expect(held(taken.value.state, 0)).toEqual(['warlord']);
    expect(held(taken.value.state, 1)).toEqual(['merchant']);
    expect(top(taken.value.state)?.id).toBe('main');
  });

  test('the player may take nothing', () => {
    const done = system(shown(), {
      kind: 'system',
      type: 'TAKE_PROGRESS',
      seat: 0,
      from: 1,
      slotId: null,
    });
    expect(held(done, 0)).toEqual([]);
    expect(held(done, 1)).toEqual(['merchant', 'warlord']);
    expect(top(done)?.id).toBe('main');
  });

  test('a taken Spy can be played at once', () => {
    const start = withCards(position(), 1, 'spy');
    const state = shown(start);
    const done = system(state, {
      kind: 'system',
      type: 'TAKE_PROGRESS',
      seat: 0,
      from: 1,
      slotId: slotFor(state, 1, 'spy'),
    });
    expect(held(done, 0)).toEqual(['spy']);
    expect(refusal(done, 0, 'spy', { target: 1 })).toBeNull();
  });

  test('a card that is not in the target’s hand cannot be taken', () => {
    const state = shown(withCards(position(), 0, 'engineer'));
    expect(
      systemRefusal(state, {
        kind: 'system',
        type: 'TAKE_PROGRESS',
        seat: 0,
        from: 1,
        slotId: 'progress:404',
      }),
    ).toBe('invalid-slot');
    const own = slotFor(state, 0, 'engineer');
    expect(
      systemRefusal(state, {
        kind: 'system',
        type: 'TAKE_PROGRESS',
        seat: 0,
        from: 1,
        slotId: own,
      }),
    ).toBe('invalid-slot');
    expect(
      systemRefusal(state, {
        kind: 'system',
        type: 'TAKE_PROGRESS',
        seat: 0,
        from: 1,
        slotId: slotFor(state, 1, 'merchant'),
        card: 'warlord',
      }),
    ).toBe('card-mismatch');
  });

  test('the player is shown the cards privately and learns the taken card by private data', () => {
    const hidden = withHidden(
      withHidden(withHand(scene().state, 0, {}), 1, 'merchant').state,
      1,
      'warlord',
    );
    const start = withCards(hidden.state, 0, 'spy');
    const played = play(start, 0, 'spy', { target: 1 });
    const actor = privateOf(engine, played, 0, {});
    expect(engine.applyPrivate(actor, played, show, { progress: { x: 'merchant' } }).ok).toBe(true);
    expect(engine.applyPrivate(actor, played, show).ok).toBe(false);
    const state = system(played, show);
    const slotId = hidden.slotId;
    const take = { kind: 'system' as const, type: 'TAKE_PROGRESS', seat: 0, from: 1, slotId };
    const target = privateOf(engine, state, 1, {}, { [slotId]: 'warlord', other: 'merchant' });
    const lost = engine.applyPrivate(target, state, take);
    expect(lost.ok && Object.keys(lost.value.slots)).toEqual(['other']);
    const won = engine.applyPrivate(actor, state, take, { card: 'warlord' });
    expect(won.ok && won.value.slots).toEqual({ [slotId]: 'warlord' });
    // The taker must learn the card.
    expect(engine.applyPrivate(actor, state, take).ok).toBe(false);
    // The public state moves the slot without naming it.
    const moved = system(state, take);
    expect(held(moved, 0)).toEqual([undefined]);
    expect(held(moved, 1)).toEqual([undefined]);
  });

  test('the target must hold a progress card, and it cannot be the player', () => {
    const state = position();
    expect(refusal(state, 0, 'spy', { target: 2 })).toBe('no-target');
    expect(refusal(state, 0, 'spy', { target: 0 })).toBe('no-target');
    expect(refusal(state, 0, 'spy', { target: 7 })).toBe('invalid-seat');
    expect(refusal(state, 0, 'spy')).toBe('invalid-params');
    expect(
      engine
        .getLegalCommands(state, 0)
        .commands.filter((item) => item.type === 'PLAY_PROGRESS_CARD')
        .map((item) => item.params),
    ).toEqual([{ target: 1 }]);
  });
});
