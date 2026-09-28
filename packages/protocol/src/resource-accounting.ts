import { canonicalEncode } from '@cp2p/codec';
import {
  checkBounds,
  failure,
  gainHidden,
  gainKnown,
  kindBounds,
  kindsOfCounts,
  loseHidden,
  loseKnown,
  revealExact,
  success,
  zeroCounts,
} from '@cp2p/engine';
import type {
  EngineEffect,
  GameState,
  ResourceBounds,
  ResourceEndpoint,
  Result,
  Seat,
} from '@cp2p/engine';
import { MAX_HAND_RESOURCE_COUNT } from './hand-commitments.js';

function checked<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function requireAccounting(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function same(left: unknown, right: unknown): boolean {
  const a = canonicalEncode(left);
  const b = canonicalEncode(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function checkResourceCount(kinds: readonly string[], resource: string, count: number): void {
  requireAccounting(kinds.includes(resource), 'Unsupported accounting resource');
  requireAccounting(
    Number.isSafeInteger(count) && count >= 0 && count <= MAX_HAND_RESOURCE_COUNT,
    'Resource effect count exceeds the six-bit base range',
  );
}

/**
 * Check engine-produced effects against its prospective public transition.
 * This verifies accounting consistency, not command legality or private proofs.
 * Conservation cannot establish the original endpoints/order or detect omitted
 * gross legs whose net change is zero. Always derive effects from the engine.
 */
export function verifyResourceAccounting(
  before: GameState,
  after: GameState,
  effects: readonly EngineEffect[],
): Result<void> {
  try {
    requireAccounting(Array.isArray(effects) && effects.length <= 64, 'Invalid effect list');
    const seats = before.seats.map((seat) => seat.seat);
    requireAccounting(
      seats.length >= 1 && seats.length <= 6 && new Set(seats).size === seats.length,
      'Invalid accounting seat roster',
    );
    requireAccounting(
      same(
        seats,
        after.seats.map((seat) => seat.seat),
      ),
      'Seat roster changed',
    );
    // The game's card kinds are its bank keys; a transition never adds or drops one.
    const kinds = kindsOfCounts(before.bank);
    requireAccounting(
      same(Object.keys(before.bank).toSorted(), kinds.toSorted()) &&
        same(Object.keys(after.bank).toSorted(), kinds.toSorted()),
      'Unsupported bank resource dimensions',
    );
    const bank = { ...before.bank };
    const hands = new Map<Seat, ResourceBounds<string>>();
    const slots = new Map(
      before.seats.map((seat) => [seat.seat, seat.cardSlots.map((slot) => ({ ...slot }))]),
    );
    const decks = Object.fromEntries(
      Object.entries(before.decks).map(([id, deck]) => [
        id,
        {
          ...deck,
          drawn: deck.drawn.map((slot) => ({ ...slot })),
        },
      ]),
    );
    for (const seat of before.seats) {
      checked(checkBounds(kindBounds(seat.resources), kinds));
      hands.set(seat.seat, kindBounds(seat.resources));
    }
    for (const resource of kinds)
      requireAccounting(
        Number.isSafeInteger(bank[resource]) && (bank[resource] ?? -1) >= 0,
        'Invalid bank count',
      );
    const moved = new Set<string>();
    const revealed = new Set<string>();
    const hand = (seat: Seat): ResourceBounds<string> => {
      const result = hands.get(seat);
      if (!result) throw new Error('Effect names an unknown seat');
      return result;
    };
    const move = (endpoint: ResourceEndpoint, resource: string, count: number, credit: boolean) => {
      if (endpoint.kind === 'bank') {
        const next = (bank[resource] ?? 0) + (credit ? count : -count);
        requireAccounting(Number.isSafeInteger(next) && next >= 0, 'Effect overdraws the bank');
        bank[resource] = next;
      } else {
        requireAccounting(endpoint.kind === 'seat', 'Invalid transfer endpoint');
        const counts = { ...zeroCounts(kinds), [resource]: count };
        const update = credit
          ? gainKnown(hand(endpoint.seat), counts, kinds)
          : loseKnown(hand(endpoint.seat), counts, kinds);
        hands.set(endpoint.seat, checked(update));
        moved.add(`${endpoint.seat}:${resource}`);
      }
    };
    for (const effect of effects) {
      switch (effect.type) {
        case 'resource-transfer':
          checkResourceCount(kinds, effect.resource, effect.count);
          requireAccounting(effect.count > 0, 'Public transfer effects must be nonzero');
          requireAccounting(
            effect.from.kind !== effect.to.kind ||
              (effect.from.kind === 'seat' &&
                effect.to.kind === 'seat' &&
                effect.from.seat !== effect.to.seat),
            'Transfer endpoints must differ',
          );
          move(effect.from, effect.resource, effect.count, false);
          move(effect.to, effect.resource, effect.count, true);
          break;
        case 'resource-count-revealed': {
          checkResourceCount(kinds, effect.resource, effect.count);
          const key = `${effect.seat}:${effect.resource}`;
          requireAccounting(
            !moved.has(key) && !revealed.has(key),
            'Count reveal must open the parent once, before movement',
          );
          hands.set(
            effect.seat,
            checked(revealExact(hand(effect.seat), effect.resource, effect.count, kinds)),
          );
          revealed.add(key);
          break;
        }
        case 'hidden-resource-transfer':
          requireAccounting(
            effect.count === 1 && effect.from !== effect.to,
            'Invalid hidden transfer',
          );
          hands.set(effect.from, checked(loseHidden(hand(effect.from), 1, kinds)));
          hands.set(effect.to, checked(gainHidden(hand(effect.to), 1, kinds)));
          for (const resource of kinds) {
            moved.add(`${effect.from}:${resource}`);
            moved.add(`${effect.to}:${resource}`);
          }
          break;
        case 'card-slot-dealt': {
          const owned = slots.get(effect.seat);
          const deck = decks[effect.deck];
          requireAccounting(!!owned && !!deck && deck.remaining > 0, 'Unknown owner or empty deck');
          requireAccounting(
            typeof effect.slotId === 'string' &&
              effect.slotId.length > 0 &&
              ![...slots.values()].some((items) =>
                items.some((slot) => slot.slotId === effect.slotId),
              ),
            'Dealt slot must be new',
          );
          if (!owned || !deck) throw new Error('Missing slot accounting target');
          owned.push({
            slotId: effect.slotId,
            deck: effect.deck,
            acquiredTurn: before.turn.number,
          });
          deck.remaining -= 1;
          deck.drawn.push({ slotId: effect.slotId, seat: effect.seat });
          break;
        }
        case 'deck-card-shown': {
          const deck = decks[effect.deck];
          requireAccounting(
            !!deck && deck.remaining > 0 && seats.includes(effect.seat),
            'Unknown drawer or empty deck',
          );
          requireAccounting(
            typeof effect.slotId === 'string' &&
              effect.slotId.length > 0 &&
              typeof effect.card === 'string' &&
              effect.card.length > 0 &&
              !deck?.drawn.some((slot) => slot.slotId === effect.slotId),
            'Shown card needs a new slot and an identity',
          );
          if (!deck) throw new Error('Missing shown-card accounting target');
          deck.remaining -= 1;
          deck.drawn.push({ slotId: effect.slotId, seat: effect.seat });
          break;
        }
        case 'card-slot-revealed': {
          const owned = slots
            .get(effect.seat)
            ?.find((slot) => slot.slotId === effect.slotId && slot.deck === effect.deck);
          requireAccounting(
            !!owned && owned.revealed === undefined,
            'Reveal must name an unrevealed owned slot',
          );
          requireAccounting(
            typeof effect.card === 'string' && effect.card.length > 0,
            'Invalid revealed card',
          );
          if (!owned) throw new Error('Missing reveal accounting target');
          owned.revealed = effect.card;
          break;
        }
        default:
          throw new Error('Unsupported engine accounting effect');
      }
    }
    requireAccounting(same(bank, after.bank), 'Effects disagree with bank counts');
    requireAccounting(same(decks, after.decks), 'Effects disagree with deck positions');
    for (const seat of after.seats) {
      requireAccounting(same(hand(seat.seat), seat.resources), 'Effects disagree with hand bounds');
      requireAccounting(
        same(slots.get(seat.seat), seat.cardSlots),
        'Effects disagree with card slots',
      );
    }
    return success(undefined);
  } catch (error) {
    return failure(
      'resource-accounting',
      error instanceof Error ? error.message : 'Invalid accounting transition',
    );
  }
}
