import type { EngineEffect } from '../../../core/effects/index.js';
import type { PrivateInputData } from '../../../core/pipeline/index.js';
import {
  gainHidden,
  gainKnown,
  kindBounds,
  loseHidden,
  loseKnown,
  seatBounds,
} from '../../../core/resources/index.js';
import type { GameState, PrivateState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { CardCounts, Result, Seat } from '../../../core/types/index.js';
import {
  cardKindsOf,
  countTotal,
  fillCounts,
  ownSeat,
  parseCardCounts,
  privateExchange,
  resourceTransfers,
  updateSeat,
} from '../../base/shared.js';
import { privateCards } from './mirror.js';

/**
 * Cards moved between seats: explicit counts (every seat sees the kinds, as in a trade or a
 * discard) or `'hidden'` (only the count is public, as in a steal; the two parties learn the kinds
 * through private input data `{ cards: { [kind]: count } }`).
 */
export type Cards = CardCounts | 'hidden';

/** Read a `cards` field: `'hidden'` or a count map over this game's card kinds. */
export function parseCards(state: GameState, value: unknown): Result<Cards> {
  if (value === 'hidden') return success('hidden');
  return parseCardCounts(value, cardKindsOf(state));
}

/** Whether `count` cards (explicit or hidden) can leave the seat's hand, by its public bounds. */
export function movable(state: GameState, from: Seat, cards: Cards, count: number): Result<void> {
  const kinds = cardKindsOf(state);
  const bounds = kindBounds(ownSeat(state, from).resources);
  if (cards === 'hidden') {
    const lost = loseHidden(bounds, count, kinds);
    return lost.ok ? success(undefined) : lost;
  }
  if (countTotal(cards) !== count)
    return failure('wrong-card-count', `Exactly ${count} cards must move`);
  const lost = loseKnown(bounds, fillCounts(cards, kinds), kinds);
  return lost.ok ? success(undefined) : lost;
}

/** Move the cards on the public state, with the effects that account for it. */
export function moveCards(
  state: GameState,
  from: Seat,
  to: Seat,
  cards: Cards,
  count: number,
): { state: GameState; effects: EngineEffect[] } {
  const kinds = cardKindsOf(state);
  let fromBounds = kindBounds(ownSeat(state, from).resources);
  let toBounds = kindBounds(ownSeat(state, to).resources);
  let effects: EngineEffect[];
  if (cards === 'hidden') {
    for (let n = 0; n < count; n++) {
      const lost = loseHidden(fromBounds, 1, kinds);
      const gained = gainHidden(toBounds, 1, kinds);
      if (!lost.ok || !gained.ok) throw new Error('Validated hidden transfer failed');
      fromBounds = lost.value;
      toBounds = gained.value;
    }
    effects = Array.from({ length: count }, () => ({
      type: 'hidden-resource-transfer' as const,
      from,
      to,
      count: 1 as const,
    }));
  } else {
    const filled = fillCounts(cards, kinds);
    const lost = loseKnown(fromBounds, filled, kinds);
    const gained = gainKnown(toBounds, filled, kinds);
    if (!lost.ok || !gained.ok) throw new Error('Validated known transfer failed');
    fromBounds = lost.value;
    toBounds = gained.value;
    effects = resourceTransfers({ kind: 'seat', seat: from }, { kind: 'seat', seat: to }, cards);
  }
  let next = updateSeat(state, from, (old) => ({ ...old, resources: seatBounds(fromBounds) }));
  next = updateSeat(next, to, (old) => ({ ...old, resources: seatBounds(toBounds) }));
  return { state: next, effects };
}

/**
 * One party's private hand after a `moveCards`. A hidden move needs the identities in the input
 * data (`data.cards`); other seats are unaffected.
 */
export function movePrivate(
  priv: PrivateState,
  state: GameState,
  from: Seat,
  to: Seat,
  cards: Cards,
  count: number,
  data: PrivateInputData | undefined,
): Result<PrivateState> {
  if (priv.seat !== from && priv.seat !== to) return success(priv);
  let disclosed: CardCounts;
  if (cards === 'hidden') {
    const parsed = privateCards(data?.cards, cardKindsOf(state));
    if (!parsed.ok) return parsed;
    if (countTotal(parsed.value) !== count)
      return failure('private-cards-mismatch', 'Private cards must match the public count');
    disclosed = parsed.value;
  } else disclosed = cards;
  return privateExchange(priv, disclosed, priv.seat === to);
}

/**
 * A public default for "give `count` cards of your choice", possible only when the hand is exactly
 * known: the most plentiful kinds first, ties in canonical order (as base does for a timeout
 * discard). Null when the public bounds do not fix the hand.
 */
export function exactChoice(state: GameState, seat: Seat, count: number): CardCounts | null {
  const kinds = cardKindsOf(state);
  const bounds = kindBounds(ownSeat(state, seat).resources);
  if (kinds.some((kind) => (bounds.min[kind] ?? 0) !== (bounds.max[kind] ?? 0))) return null;
  let remaining = count;
  const counts: Record<string, number> = Object.fromEntries(kinds.map((kind) => [kind, 0]));
  const ordered = [...kinds].toSorted(
    (left, right) =>
      (bounds.min[right] ?? 0) - (bounds.min[left] ?? 0) ||
      kinds.indexOf(left) - kinds.indexOf(right),
  );
  for (const kind of ordered) {
    const amount = Math.min(bounds.min[kind] ?? 0, remaining);
    counts[kind] = amount;
    remaining -= amount;
  }
  return remaining === 0 ? counts : null;
}
