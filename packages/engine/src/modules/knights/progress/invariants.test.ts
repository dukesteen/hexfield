import { describe, expect, test } from 'vitest';
import type { GameState, PrivateState } from '../../../core/state/index.js';
import type { Seat } from '../../../core/types/index.js';
import { hexOf } from '../support.js';
import { knightsExt, updateKnights } from '../types.js';
import { progressInvariants, progressPrivateInvariants } from './invariants.js';
import { engine, privateOf, scene, withCards, withHidden } from './testing.js';

function clean(): GameState {
  return withCards(scene().state, 0, 'crane', 'engineer');
}

const problems = (state: GameState) => engine.checkInvariants(state);

describe('progress card invariants', () => {
  test('a fresh game and a hand of known cards are consistent', () => {
    expect(progressInvariants(scene().state)).toEqual([]);
    expect(problems(clean())).toEqual([]);
  });

  test('a card that is nowhere, or in two places, breaks conservation', () => {
    const lost = {
      ...clean(),
      decks: { ...clean().decks, 'progress-science': { remaining: 17, drawn: [] } },
    };
    expect(problems(lost)).toContain('science progress deck count mismatch');
    const twice = updateKnights(clean(), (old) => ({
      ...old,
      bottom: { ...old.bottom, science: ['crane'] },
    }));
    expect(problems(twice)).toContain('science progress cards are not conserved');
  });

  test('the bottom queue holds only its deck’s cards and never a victory card', () => {
    const wrong = updateKnights(clean(), (old) => ({
      ...old,
      bottom: { ...old.bottom, science: ['warlord'] },
    }));
    expect(problems(wrong)).toContain('science bottom queue holds warlord');
    const victory = updateKnights(clean(), (old) => ({
      ...old,
      bottom: { ...old.bottom, science: ['printer'] },
    }));
    expect(problems(victory)).toContain('science bottom queue holds printer');
  });

  test('a seat other than the active seat may not hold more than four progress cards', () => {
    const many = withCards(scene().state, 1, 'crane', 'engineer', 'smith', 'medicine', 'mining');
    expect(problems(many)).toContain('seat 1 holds more than 4 progress cards');
    // The active seat may, until it discards.
    const own = withCards(scene().state, 0, 'crane', 'engineer', 'smith', 'medicine', 'mining');
    expect(problems(own)).toEqual([]);
  });

  test('a slot cannot hold a card of another deck', () => {
    const bad = clean();
    const seats = bad.seats.map((seat) =>
      seat.seat === 0
        ? {
            ...seat,
            cardSlots: seat.cardSlots.map((slot, index) =>
              index === 0 ? { ...slot, known: 'warlord' } : slot,
            ),
          }
        : seat,
    );
    expect(problems({ ...bad, seats })).toContain('science slot holds warlord');
  });

  test('the merchant stands on a land hex of a seat, and the windows name real seats', () => {
    const state = scene().state;
    const sea = state.board.hexes.find((hex) => hex.terrain === 'sea')?.id;
    const off = updateKnights(state, (old) => ({
      ...old,
      merchant: { seat: 0, hex: sea ?? 'h:x' },
    }));
    expect(problems(off)).toContain('the merchant is not on a land hex of a seat');
    const ok = updateKnights(state, (old) => ({
      ...old,
      merchant: { seat: 0, hex: hexOf(state, 'forest') },
      fleet: { seat: 1, kinds: ['wool'] },
      harbor: { seat: 0, cards: 1, offered: [1] },
      alchemist: [3, 4],
    }));
    expect(problems(ok)).toEqual([]);
    const seat = updateKnights(ok, (old) => ({ ...old, fleet: { seat: 5, kinds: [] } }));
    expect(problems(seat)).toContain('unknown fleet owner');
    const harbor = updateKnights(ok, (old) => ({
      ...old,
      harbor: { seat: 0, cards: 1, offered: [5] },
    }));
    expect(problems(harbor)).toContain('invalid commercial harbor window');
    const dice = updateKnights(ok, (old) => ({ ...old, alchemist: [0, 7] }));
    expect(problems(dice)).toContain('invalid alchemist dice');
  });

  test('every held card has a private identity of its deck, no more than the deck holds', () => {
    const hidden = withHidden(scene().state, 0, 'crane');
    const privates = (slots: Record<string, string>) =>
      new Map<Seat, PrivateState>([[0, privateOf(engine, hidden.state, 0, {}, slots)]]);
    expect(progressPrivateInvariants(hidden.state, privates({ [hidden.slotId]: 'crane' }))).toEqual(
      [],
    );
    expect(progressPrivateInvariants(hidden.state, privates({}))).toContain(
      `seat 0 lacks the identity of slot ${hidden.slotId}`,
    );
    expect(
      progressPrivateInvariants(hidden.state, privates({ [hidden.slotId]: 'warlord' })).join(),
    ).toContain(`seat 0 slot ${hidden.slotId} holds warlord`);
    // Only one Engineer exists: two seats cannot both hold it.
    const two = withHidden(hidden.state, 1, 'engineer');
    const both = new Map<Seat, PrivateState>([
      [0, privateOf(engine, two.state, 0, {}, { [hidden.slotId]: 'engineer' })],
      [1, privateOf(engine, two.state, 1, {}, { [two.slotId]: 'engineer' })],
    ]);
    expect(progressPrivateInvariants(two.state, both).join()).toContain('too many engineer cards');
    expect(knightsExt(two.state).bottom.science).toEqual([]);
  });
});
