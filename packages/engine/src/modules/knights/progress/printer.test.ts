import { describe, expect, test } from 'vitest';
import type { Input } from '../../../core/pipeline/index.js';
import type { GameState } from '../../../core/state/index.js';
import { inDice, newGame, rejection, submit, withLevels, withTokens } from '../support.js';
import { knightsExt, updateKnights } from '../types.js';
import {
  engine,
  held,
  privateOf,
  refusal,
  scene,
  system,
  withCards,
  withHidden,
} from './testing.js';

/** Seat 0 rolls a science gate and draws. */
function drawing(points = 0): GameState {
  const base = withLevels(newGame(engine, { seats: 3 }), 0, { science: 2 });
  return updateKnights(inDice(withTokens(base, {})), (old) => ({
    ...old,
    defenders: [points, 0, 0],
  }));
}

function drawPrinter(state: GameState): GameState {
  const rolled = system(state, {
    kind: 'system',
    type: 'DICE_RESULT',
    dice: [1, 4],
    extra: { event: 'science' },
  });
  const pending = engine.getPending(rolled).find((item) => item.kind === 'random');
  if (pending?.kind !== 'random') throw new Error('No draw');
  return system(rolled, {
    kind: 'system',
    type: 'CARD_DEALT',
    deck: 'progress-science',
    seat: 0,
    slotId: String(pending.request.slotId),
    card: 'printer',
  });
}

function show(state: GameState, card: string): GameState {
  const ask = engine.getPending(state).find((item) => item.kind === 'reveal');
  if (ask?.kind !== 'reveal') throw new Error('No victory check');
  return system(state, {
    kind: 'system',
    type: 'REVEAL_PROGRESS',
    seat: ask.seat,
    slotId: String(ask.request.slotId),
    card,
  });
}

describe('Printer', () => {
  test('is shown when drawn and is worth one point', () => {
    const shown = show(drawPrinter(drawing()), 'printer');
    expect(shown.seats[0]?.publicVp).toBe(1);
    expect(held(shown, 0)).toEqual([]);
    expect(shown.seats[0]?.cardSlots[0]).toMatchObject({ revealed: 'printer' });
  });

  test('it is never returned under its deck and never counts in the hand', () => {
    const shown = show(drawPrinter(drawing()), 'printer');
    expect(knightsExt(shown).bottom.science).toEqual([]);
    expect(shown.decks['progress-science']?.remaining).toBe(17);
    expect(engine.checkInvariants(shown)).toEqual([]);
    // A seat with four cards and a shown Printer holds no surplus.
    const full = withCards(shown, 0, 'crane', 'engineer', 'smith', 'medicine');
    expect(
      engine
        .getPending(full)
        .some((item) => item.kind === 'player' && item.allowed.includes('END_TURN')),
    ).toBe(true);
  });

  test('a card that is not the Printer cannot be shown, and a victory card is not discarded', () => {
    const drawn = drawPrinter(drawing());
    const ask = engine.getPending(drawn).find((item) => item.kind === 'reveal');
    const slotId = ask?.kind === 'reveal' ? String(ask.request.slotId) : '';
    expect(
      engine.validate(drawn, {
        kind: 'system',
        type: 'REVEAL_PROGRESS',
        seat: 0,
        slotId,
        card: 'crane',
      }).ok,
    ).toBe(false);
    const five = withCards(scene().state, 0, 'crane', 'engineer', 'smith', 'medicine');
    const hidden = withHidden(five, 0, 'printer');
    expect(
      rejection(engine, hidden.state, 0, {
        type: 'DISCARD_PROGRESS',
        cards: [{ slotId: hidden.slotId, card: 'printer' }],
      }),
    ).toBe('victory-card');
  });

  test('a kept-hidden Printer is shown by playing it, and then it counts', () => {
    const hidden = withHidden(scene().state, 0, 'printer');
    const owner = privateOf(engine, hidden.state, 0, {}, { [hidden.slotId]: 'printer' });
    const command = { type: 'PLAY_PROGRESS_CARD', slotId: hidden.slotId, card: 'printer' };
    const input: Input = { kind: 'command', seat: 0, command };
    const played = submit(engine, hidden.state, 0, command);
    // The scene's settlement and the Printer.
    expect(played.seats[0]?.publicVp).toBe(2);
    const mine = engine.applyPrivate(owner, hidden.state, input);
    expect(mine.ok && mine.value.slots).toEqual({});
    // Not the card it claims.
    const liar = privateOf(engine, hidden.state, 0, {}, { [hidden.slotId]: 'crane' });
    expect(engine.applyPrivate(liar, hidden.state, input).ok).toBe(false);
    expect(knightsExt(played).bottom.science).toEqual([]);
    expect(refusal(withCards(scene().state, 0, 'printer'), 0, 'printer', { x: 1 })).toBe(
      'unknown-field',
    );
  });

  test('a point that brings a seat to 13 wins on its own turn', () => {
    const shown = show(drawPrinter(drawing(12)), 'printer');
    expect(shown.result).toMatchObject({ winner: 0, reason: 'public-vp' });
    expect(show(drawPrinter(drawing(11)), 'printer').result).toBeNull();
  });
});
