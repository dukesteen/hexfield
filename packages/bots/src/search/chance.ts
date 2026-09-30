import type { GameState, Input, Pending, PrivateInputData, PrivateState, Seat } from '@cp2p/engine';
import { isPublicDraw, kindsOfCounts, publicDrawInput, rollExtraDice } from '@cp2p/engine';
import type { BotRng } from '../types.js';
import type { World } from './determinize.js';

type SystemPending = Extract<Pending, { kind: 'random' | 'reveal' }>;

export interface ChanceAnswer {
  input: Input;
  privateData?: Partial<Record<Seat, PrivateInputData>>;
}

/** Answers a rollout's chance events and reveals in a sampled world. */
export type Chance = (
  pending: SystemPending,
  state: GameState,
  privates: ReadonlyMap<Seat, PrivateState>,
) => ChanceAnswer | null;

function diceDeck(state: GameState): readonly unknown[] {
  const base = state.ext.base;
  return typeof base === 'object' &&
    base !== null &&
    'diceDeck' in base &&
    Array.isArray(base.diceDeck)
    ? base.diceDeck
    : [];
}

function seatOf(state: GameState, value: unknown): Seat | undefined {
  return state.config.seats.find((seat) => seat === value);
}

function randomCard(hand: Readonly<Record<string, number>>, rng: BotRng): string | undefined {
  const kinds = kindsOfCounts(hand);
  let index = rng.int(
    Math.max(
      1,
      kinds.reduce((sum, kind) => sum + (hand[kind] ?? 0), 0),
    ),
  );
  for (const kind of kinds) {
    index -= hand[kind] ?? 0;
    if (index < 0) return kind;
  }
  return undefined;
}

/**
 * Chance for a sampled world, with every module's events (follow-up B): the dice and any extra
 * die (the knights event die) come from `dice`, which each candidate of a paired comparison
 * replays in the same order; draws from the world's sampled decks (development, progress and fog
 * decks), steals and reveals use `draws`.
 */
export function sampledChance(world: World, dice: BotRng, draws: BotRng): Chance {
  const pop = (deck: string): string | undefined =>
    deck === 'dev' ? world.devDeck.pop() : world.decks.get(deck)?.pop();
  return (pending, state, privates) => {
    if (isPublicDraw(pending)) {
      const card = typeof pending.request.deck === 'string' ? pop(pending.request.deck) : undefined;
      return card === undefined ? null : { input: publicDrawInput(pending, card) };
    }
    const { request } = pending;
    switch (pending.systemType) {
      case 'DICE_RESULT': {
        const extra = rollExtraDice(request, (bound) => dice.int(bound));
        const withExtra = Object.keys(extra).length ? { extra } : {};
        if (request.mode === 'fixed') {
          const fixed = request.dice;
          if (!Array.isArray(fixed) || fixed.length !== 2) return null;
          return { input: { kind: 'system', type: 'DICE_RESULT', dice: [...fixed], ...withExtra } };
        }
        if (request.mode === 'balanced') {
          const deck = diceDeck(state);
          const index = dice.int(deck.length);
          const card = Number(deck[index]);
          return {
            input: {
              kind: 'system',
              type: 'DICE_RESULT',
              index,
              dice: [Math.floor(card / 6) + 1, (card % 6) + 1],
              ...withExtra,
            },
          };
        }
        return {
          input: {
            kind: 'system',
            type: 'DICE_RESULT',
            dice: [dice.int(6) + 1, dice.int(6) + 1],
            ...withExtra,
          },
        };
      }
      case 'CARD_DEALT': {
        const deck = typeof request.deck === 'string' ? request.deck : 'dev';
        const card = pop(deck);
        const seat = seatOf(state, request.seat);
        if (card === undefined || seat === undefined || typeof request.slotId !== 'string')
          return null;
        return {
          input: { kind: 'system', type: 'CARD_DEALT', deck, seat, slotId: request.slotId, card },
        };
      }
      case 'STEAL_RESULT': {
        const thief = seatOf(state, request.thief);
        const victim = seatOf(state, request.victim);
        const hand = victim === undefined ? undefined : privates.get(victim)?.hand;
        const resource = hand ? randomCard(hand, draws) : undefined;
        if (thief === undefined || victim === undefined || resource === undefined) return null;
        return { input: { kind: 'system', type: 'STEAL_RESULT', thief, victim, resource } };
      }
      case 'REVEAL_COUNT': {
        if (pending.kind !== 'reveal' || typeof request.resource !== 'string') return null;
        const hand = privates.get(pending.seat)?.hand ?? {};
        return {
          input: {
            kind: 'system',
            type: 'REVEAL_COUNT',
            seat: pending.seat,
            resource: request.resource,
            count: hand[request.resource] ?? 0,
          },
        };
      }
      case 'REVEAL_PROGRESS': {
        if (pending.kind !== 'reveal' || typeof request.slotId !== 'string') return null;
        const held = privates.get(pending.seat)?.slots[request.slotId];
        const card = held === 'printer' || held === 'constitution' ? held : 'none';
        return {
          input: {
            kind: 'system',
            type: 'REVEAL_PROGRESS',
            seat: pending.seat,
            slotId: request.slotId,
            card,
          },
        };
      }
      case 'DEAL_KNOWN': {
        if (pending.kind !== 'reveal') return null;
        const { type: _type, ...echoed } = request;
        return { input: { ...echoed, kind: 'system', type: 'DEAL_KNOWN', seat: pending.seat } };
      }
      case 'SHOW_HAND': {
        if (pending.kind !== 'reveal') return null;
        const actor = seatOf(state, request.to);
        const target = privates.get(pending.seat);
        if (actor === undefined || !target) return null;
        const shown =
          request.what === 'progress'
            ? { progress: { ...target.slots } }
            : { hand: { ...target.hand } };
        return {
          input: {
            kind: 'system',
            type: 'SHOW_HAND',
            seat: pending.seat,
            to: actor,
            what: request.what,
          },
          privateData: { [actor]: shown },
        };
      }
      case 'TAKE_CARDS': {
        if (pending.kind !== 'reveal') return null;
        const from = seatOf(state, request.from);
        const count = typeof request.count === 'number' ? request.count : 0;
        const hand = from === undefined ? undefined : privates.get(from)?.hand;
        if (from === undefined || !hand) return null;
        const left: Record<string, number> = { ...hand };
        const cards: Record<string, number> = {};
        for (let n = 0; n < count; n++) {
          const kind = randomCard(left, draws);
          if (kind === undefined) return null;
          left[kind] = (left[kind] ?? 0) - 1;
          cards[kind] = (cards[kind] ?? 0) + 1;
        }
        return { input: { kind: 'system', type: 'TAKE_CARDS', seat: pending.seat, from, cards } };
      }
      case 'TAKE_PROGRESS': {
        if (pending.kind !== 'reveal') return null;
        const from = seatOf(state, request.from);
        if (from === undefined) return null;
        const held = (state.seats.find((seat) => seat.seat === from)?.cardSlots ?? []).filter(
          (slot) => slot.revealed === undefined && slot.deck.startsWith('progress-'),
        );
        const slot = held[draws.int(held.length + 1)];
        if (!slot)
          return {
            input: {
              kind: 'system',
              type: 'TAKE_PROGRESS',
              seat: pending.seat,
              from,
              slotId: null,
            },
          };
        const card = slot.known ?? privates.get(from)?.slots[slot.slotId];
        if (card === undefined)
          return {
            input: {
              kind: 'system',
              type: 'TAKE_PROGRESS',
              seat: pending.seat,
              from,
              slotId: null,
            },
          };
        return {
          input: {
            kind: 'system',
            type: 'TAKE_PROGRESS',
            seat: pending.seat,
            from,
            slotId: slot.slotId,
            ...(slot.known === undefined ? { card } : {}),
          },
        };
      }
      default:
        return null;
    }
  };
}
