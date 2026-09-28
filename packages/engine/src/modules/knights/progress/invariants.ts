import type { GameState, PrivateState } from '../../../core/state/index.js';
import type { Seat } from '../../../core/types/index.js';
import { isLandHex } from '../../base/board/index.js';
import { KNIGHTS_ID, TRACKS } from '../config.js';
import { knightsExt } from '../types.js';
import {
  HAND_LIMIT,
  PROGRESS_CARDS,
  VICTORY_CARDS,
  deckOfTrack,
  deckSize,
  trackOfDeck,
} from './catalogue.js';
import { handCount } from './hand.js';

/** Whether a progress frame is open: a seat may hold more than the limit until its discard. */
function drawWindowOpen(state: GameState): boolean {
  return state.turn.phase.some(
    (frame) =>
      frame.module === KNIGHTS_ID && (frame.id === 'progress' || frame.id === 'progressDeal'),
  );
}

/**
 * Public checks for the progress cards: every card is somewhere exactly once (hidden deck, bottom
 * queue, a hand, or a shown victory card), no seat holds more than four outside a discard window,
 * and the merchant, fleet and harbor windows are consistent.
 */
export function progressInvariants(state: GameState): string[] {
  const errors: string[] = [];
  const ext = knightsExt(state);
  const seats = state.config.seats;
  for (const track of TRACKS) {
    const deck = state.decks[deckOfTrack(track)];
    if (deck === undefined) {
      errors.push(`missing ${track} progress deck`);
      continue;
    }
    const size = deckSize(track);
    if (deck.remaining + deck.drawn.length !== size)
      errors.push(`${track} progress deck count mismatch`);
    const queue = ext.bottom[track];
    for (const card of queue) {
      if (!Object.hasOwn(PROGRESS_CARDS[track], card) || Object.hasOwn(VICTORY_CARDS, card))
        errors.push(`${track} bottom queue holds ${card}`);
    }
    let held = 0;
    let shown = 0;
    for (const seat of state.seats)
      for (const slot of seat.cardSlots) {
        if (trackOfDeck(slot.deck) !== track) continue;
        if (slot.revealed === undefined) held++;
        else if (Object.hasOwn(VICTORY_CARDS, slot.revealed)) shown++;
        for (const card of [slot.known, slot.revealed])
          if (card !== undefined && !Object.hasOwn(PROGRESS_CARDS[track], card))
            errors.push(`${track} slot holds ${card}`);
      }
    if (deck.remaining + queue.length + held + shown !== size)
      errors.push(`${track} progress cards are not conserved`);
  }
  if (!drawWindowOpen(state))
    for (const seat of seats)
      if (seat !== state.turn.activeSeat && handCount(state, seat) > HAND_LIMIT)
        errors.push(`seat ${seat} holds more than ${HAND_LIMIT} progress cards`);
  const merchant = ext.merchant;
  if (merchant !== null && (!seats.includes(merchant.seat) || !isLandHex(state, merchant.hex)))
    errors.push('the merchant is not on a land hex of a seat');
  if (ext.fleet !== null && !seats.includes(ext.fleet.seat)) errors.push('unknown fleet owner');
  if (
    ext.harbor !== null &&
    (!seats.includes(ext.harbor.seat) || ext.harbor.offered.some((seat) => !seats.includes(seat)))
  )
    errors.push('invalid commercial harbor window');
  if (
    ext.alchemist !== null &&
    ext.alchemist.some((face) => !Number.isSafeInteger(face) || face < 1 || face > 6)
  )
    errors.push('invalid alchemist dice');
  return errors;
}

/**
 * Local audit of the hidden identities: every held card has one, they belong to their decks, and no
 * identity appears more often than the deck holds it (hands, known cards, the queue, shown victory
 * cards). The unseen remainder of a deck is exactly its public `remaining`.
 */
export function progressPrivateInvariants(
  state: GameState,
  privates: ReadonlyMap<Seat, PrivateState>,
): string[] {
  const errors: string[] = [];
  const ext = knightsExt(state);
  for (const track of TRACKS) {
    const counts = new Map<string, number>();
    const count = (card: string): void => {
      counts.set(card, (counts.get(card) ?? 0) + 1);
    };
    for (const card of ext.bottom[track]) count(card);
    for (const seat of state.seats) {
      const priv = privates.get(seat.seat);
      for (const slot of seat.cardSlots) {
        if (trackOfDeck(slot.deck) !== track) continue;
        if (slot.revealed !== undefined) {
          if (Object.hasOwn(VICTORY_CARDS, slot.revealed)) count(slot.revealed);
          continue;
        }
        const identity = slot.known ?? priv?.slots[slot.slotId];
        if (identity === undefined) {
          errors.push(`seat ${seat.seat} lacks the identity of slot ${slot.slotId}`);
          continue;
        }
        if (!Object.hasOwn(PROGRESS_CARDS[track], identity))
          errors.push(`seat ${seat.seat} slot ${slot.slotId} holds ${identity}`);
        count(identity);
      }
    }
    let seen = 0;
    for (const [card, n] of counts) {
      seen += n;
      if (n > (PROGRESS_CARDS[track][card] ?? 0)) errors.push(`too many ${card} cards`);
    }
    const remaining = state.decks[deckOfTrack(track)]?.remaining ?? 0;
    if (seen + remaining !== deckSize(track)) errors.push(`${track} identities are not conserved`);
  }
  return errors;
}
