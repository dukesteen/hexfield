import { describe, expect, test } from 'vitest';
import type { Input } from '../../../core/pipeline/index.js';
import { frame } from '../../base/shared.js';
import { handOf, inMain, newGame, rejection, submit, withHand } from '../support.js';
import { knightsExt } from '../types.js';
import { CARD_MODULES } from './cards.js';
import { PROGRESS_CARDS, VICTORY_CARDS } from './catalogue.js';
import {
  engine,
  inPreRoll,
  held,
  play,
  playCommand,
  privateOf,
  refusal,
  scene,
  slotFor,
  withCards,
  withHidden,
} from './testing.js';

describe('PLAY_PROGRESS_CARD', () => {
  test('every card of the three decks has exactly one handler, and the decks hold 18 each', () => {
    const ids = CARD_MODULES.map((item) => item.card.id);
    expect(new Set(ids).size).toBe(ids.length);
    const catalogue = Object.values(PROGRESS_CARDS).flatMap((deck) => Object.keys(deck));
    expect([...ids].toSorted()).toEqual([...catalogue].toSorted());
    for (const deck of Object.values(PROGRESS_CARDS))
      expect(Object.values(deck).reduce((sum, count) => sum + count, 0)).toBe(18);
    expect(Object.keys(VICTORY_CARDS).toSorted()).toEqual(['constitution', 'printer']);
    // Only the Alchemist is played before the roll.
    expect(
      CARD_MODULES.filter((item) => item.card.timing === 'preRoll').map((item) => item.card.id),
    ).toEqual(['alchemist']);
  });

  test('the play reveals the slot, and the card goes under its deck in the order played', () => {
    const { state } = scene();
    const dealt = withCards(withHand(state, 0, {}), 0, 'merchantFleet', 'merchantFleet', 'crane');
    const slotId = slotFor(dealt, 0, 'merchantFleet');
    const result = engine.apply(dealt, {
      kind: 'command',
      seat: 0,
      command: playCommand(dealt, 0, 'merchantFleet', { kind: 'wool' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.effects[0]).toEqual({
      type: 'card-slot-revealed',
      seat: 0,
      deck: 'progress-trade',
      slotId,
      card: 'merchantFleet',
    });
    expect(result.value.events[0]).toEqual({
      type: 'progressCardPlayed',
      seat: 0,
      card: 'merchantFleet',
    });
    expect(held(result.value.state, 0)).toEqual(['merchantFleet', 'crane']);
    const two = submit(
      engine,
      result.value.state,
      0,
      playCommand(result.value.state, 0, 'merchantFleet', { kind: 'ore' }),
    );
    expect(knightsExt(two).bottom).toEqual({
      trade: ['merchantFleet', 'merchantFleet'],
      politics: [],
      science: [],
    });
    expect(two.seats[0]?.cardSlots.filter((slot) => slot.revealed !== undefined)).toHaveLength(2);
  });

  test('a card is played from the action phase, on the seat’s own turn, and not while a frame is open', () => {
    const { state } = scene();
    const held0 = withCards(state, 0, 'merchantFleet');
    const params = { kind: 'wool' };
    expect(refusal(held0, 0, 'merchantFleet', params)).toBeNull();
    const roll = inPreRoll(withCards(newGame(engine, { seats: 3 }), 0, 'merchantFleet'));
    expect(refusal(roll, 0, 'merchantFleet', params)).toBe('not-in-action-phase');
    const other = { ...held0, turn: { ...held0.turn, activeSeat: 1 as const } };
    expect(refusal(other, 0, 'merchantFleet', params)).toBe('not-pending');
    const frames = {
      ...held0,
      turn: {
        ...held0.turn,
        phase: [...held0.turn.phase, frame('roadBuilding', { remaining: 1 })],
      },
    };
    expect(refusal(frames, 0, 'merchantFleet', params)).toBe('not-pending');
    // Another seat’s slot, a played slot and an unknown slot are not the seat’s hand.
    const cmd = playCommand(held0, 0, 'merchantFleet', params);
    expect(rejection(engine, held0, 1, cmd)).toBe('not-pending');
    expect(rejection(engine, held0, 0, { ...cmd, slotId: 'progress:404' })).toBe(
      'invalid-progress-slot',
    );
    const played = play(held0, 0, 'merchantFleet', params);
    expect(rejection(engine, played, 0, cmd)).toBe('not-pending');
  });

  test('the card named must be the card in the slot and a card of that deck', () => {
    const { state } = scene();
    const held0 = withCards(state, 0, 'merchantFleet');
    const cmd = playCommand(held0, 0, 'merchantFleet', { kind: 'wool' });
    expect(rejection(engine, held0, 0, { ...cmd, card: 'warlord' })).toBe('card-deck-mismatch');
    expect(rejection(engine, held0, 0, { ...cmd, card: 'merchant' })).toBe(
      'progress-card-mismatch',
    );
    expect(rejection(engine, held0, 0, { ...cmd, card: 'nonsense' })).toBe('invalid-progress-card');
    expect(rejection(engine, held0, 0, { ...cmd, extra: 1 })).toBe('unknown-field');
  });

  test('a card held hidden is revealed by its owner’s play, and the identity must match', () => {
    const hidden = withHidden(scene().state, 0, 'merchantFleet');
    const command = {
      type: 'PLAY_PROGRESS_CARD',
      slotId: hidden.slotId,
      card: 'merchantFleet',
      params: { kind: 'wool' },
    };
    const input: Input = { kind: 'command', seat: 0, command };
    const owner = privateOf(
      engine,
      hidden.state,
      0,
      {},
      { [hidden.slotId]: 'merchantFleet', other: 'crane' },
    );
    const done = engine.applyPrivate(owner, hidden.state, input);
    expect(done.ok && done.value.slots).toEqual({ other: 'crane' });
    // The seat cannot play a card that is not the one it holds, and others' slots are untouched.
    const liar = privateOf(engine, hidden.state, 0, {}, { [hidden.slotId]: 'crane' });
    expect(engine.applyPrivate(liar, hidden.state, input).ok).toBe(false);
    const bystander = privateOf(engine, hidden.state, 1, {}, { x: 'crane' });
    const seen = engine.applyPrivate(bystander, hidden.state, input);
    expect(seen.ok && seen.value.slots).toEqual({ x: 'crane' });
    expect(submit(engine, hidden.state, 0, command).seats[0]?.cardSlots[0]).toMatchObject({
      revealed: 'merchantFleet',
    });
  });

  test('the legal plays are concrete for a known card and templates for a hidden one', () => {
    const hidden = withHidden(scene().state, 0, 'merchantFleet');
    const template = engine.getLegalCommands(hidden.state, 0).templates;
    expect(template).toContainEqual({
      type: 'PLAY_PROGRESS_CARD',
      slotId: hidden.slotId,
      card: 'private identity',
    });
    const owner = privateOf(engine, hidden.state, 0, {}, { [hidden.slotId]: 'merchantFleet' });
    const own = engine.getLegalCommands(hidden.state, 0, owner).commands;
    expect(own.filter((item) => item.type === 'PLAY_PROGRESS_CARD')).toHaveLength(8);
    // Not the timing: the same card is not offered before the roll.
    const preRoll = { ...hidden.state, turn: { ...hidden.state.turn, phase: [frame('preRoll')] } };
    expect(
      engine
        .getLegalCommands(preRoll, 0, owner)
        .commands.filter((item) => item.type === 'PLAY_PROGRESS_CARD'),
    ).toEqual([]);
  });

  test('a seat with no card is not offered the command, and one with a card is', () => {
    const { state } = scene();
    const none = engine.getPending(state).find((item) => item.kind === 'player' && item.seat === 0);
    expect(none?.kind === 'player' && none.allowed).not.toContain('PLAY_PROGRESS_CARD');
    const some = engine
      .getPending(withCards(state, 0, 'warlord'))
      .find((item) => item.kind === 'player' && item.seat === 0);
    expect(some?.kind === 'player' && some.allowed).toContain('PLAY_PROGRESS_CARD');
    const roll = inPreRoll(withCards(newGame(engine, { seats: 3 }), 0, 'alchemist'));
    const pre = engine.getPending(roll).find((item) => item.kind === 'player' && item.seat === 0);
    expect(pre?.kind === 'player' && pre.allowed).toEqual([
      'ROLL_DICE',
      'PLAY_DEV_CARD',
      'CLAIM_VICTORY',
      'PLAY_PROGRESS_CARD',
    ]);
  });

  test('progress cards cannot be played as development cards', () => {
    const { state } = scene();
    const held0 = withCards(withHand(state, 0, {}), 0, 'warlord');
    const slotId = slotFor(held0, 0, 'warlord');
    expect(
      rejection(engine, held0, 0, { type: 'PLAY_DEV_CARD', slotId, card: 'knight' }),
    ).not.toBeNull();
    expect(handOf(held0, 0)).toBeDefined();
    expect(inMain(held0, 0).turn.phase).toHaveLength(1);
  });
});
