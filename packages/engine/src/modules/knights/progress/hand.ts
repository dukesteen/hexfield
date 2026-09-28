import type { CardSlot, GameState, PrivateState } from '../../../core/state/index.js';
import type { Seat } from '../../../core/types/index.js';
import { ownSeat } from '../../base/shared.js';
import { deckOfTrack, HAND_LIMIT, trackOfDeck } from './catalogue.js';

/** Seats in turn order starting with `start` (the active seat by default). */
export function seatsFrom(state: GameState, start: Seat = state.turn.activeSeat): Seat[] {
  const seats = state.config.seats;
  const first = Math.max(0, seats.indexOf(start));
  return seats
    .map((_, offset) => seats[(first + offset) % seats.length])
    .filter((seat): seat is Seat => seat !== undefined);
}

/** A progress card slot that is still in a hand: not played, not discarded, not a shown victory card. */
export function isHeld(slot: CardSlot): boolean {
  return slot.revealed === undefined && trackOfDeck(slot.deck) !== null;
}

/** The seat's progress cards in hand, in the order it received them. */
export function heldSlots(state: GameState, seat: Seat): CardSlot[] {
  return ownSeat(state, seat).cardSlots.filter(isHeld);
}

/** How many progress cards the seat holds. Victory cards are shown on the draw and never count. */
export function handCount(state: GameState, seat: Seat): number {
  return heldSlots(state, seat).length;
}

/** Cards the seat must get rid of to be at the limit. */
export function surplus(state: GameState, seat: Seat): number {
  return Math.max(0, handCount(state, seat) - HAND_LIMIT);
}

export function findSlot(state: GameState, seat: Seat, slotId: unknown): CardSlot | undefined {
  return typeof slotId === 'string'
    ? ownSeat(state, seat).cardSlots.find((slot) => slot.slotId === slotId)
    : undefined;
}

/** The identity of a held card: public for a dealt-again card, else the owner's private slot. */
export function identityOf(slot: CardSlot, priv: PrivateState | undefined): string | undefined {
  return slot.known ?? priv?.slots[slot.slotId];
}

/** The deck id of a track, for callers that only hold the slot. */
export { deckOfTrack };
