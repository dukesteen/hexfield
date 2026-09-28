import { hashValue } from '@cp2p/codec';
import type {
  GameState,
  LocalRandomAnswer,
  LocalRandomSource,
  Pending,
  PrivateState,
  Seat,
} from '@cp2p/engine';
import {
  DEV_CARD_COUNTS,
  decksFor,
  isPublicDraw,
  kindsOfCounts,
  publicDrawInput,
  rollExtraDice,
} from '@cp2p/engine';
import { createRng } from '@cp2p/engine/rng';

type SystemPending = Extract<Pending, { kind: 'random' | 'reveal' }>;

function deckCards(counts: Readonly<Record<string, number>>): string[] {
  return Object.entries(counts).flatMap(([card, count]) => Array<string>(count).fill(card));
}

export interface LocalRandomOptions {
  /** Development deck composition; defaults to the 25-card base deck. */
  devCards?: Readonly<Record<string, number>>;
  /** Exact draw order for directed simulation fixtures; every standard card is still present. */
  devCardOrder?: readonly string[];
  /** Directed dice total for feature fixtures; random-mode requests only. */
  fixedDiceTotal?: number;
}

export interface SeededLocalRandomSource extends LocalRandomSource {
  remainingCards(): readonly string[];
}

/** Domain-separated 32-byte seed for one game component. */
export function deriveSeed(
  simulationSeed: number,
  gameIndex: number,
  domain: string,
  seat?: Seat,
): Uint8Array {
  if (!Number.isSafeInteger(simulationSeed) || !Number.isSafeInteger(gameIndex) || gameIndex < 0)
    throw new RangeError('Simulation seed and game index must be safe integers');
  return hashValue(['cp2p-sim-v1', simulationSeed, gameIndex, domain, seat ?? null]);
}

function requiredPrivate(privates: ReadonlyMap<Seat, PrivateState>, seat: Seat): PrivateState {
  const value = privates.get(seat);
  if (!value) throw new Error(`Missing private hand for seat ${seat}`);
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid ${label} random request`);
  return value;
}

function diceDeck(state: GameState): number[] {
  const ext = state.ext.base;
  if (typeof ext !== 'object' || ext === null || !('diceDeck' in ext))
    throw new Error('Balanced dice deck is missing');
  const deck = ext.diceDeck;
  if (!Array.isArray(deck) || !deck.every((value) => Number.isSafeInteger(value)))
    throw new Error('Balanced dice deck is malformed');
  return deck;
}

/** Seeded local system source with the real configured deck. Local inputs record dealt identities. */
export function createLocalRandomSource(
  seed: Uint8Array,
  options: LocalRandomOptions = {},
): SeededLocalRandomSource {
  const rng = createRng(seed);
  if (
    options.fixedDiceTotal !== undefined &&
    (!Number.isSafeInteger(options.fixedDiceTotal) ||
      options.fixedDiceTotal < 2 ||
      options.fixedDiceTotal > 12)
  )
    throw new RangeError('Directed dice total must be an integer from 2 to 12');
  const cards = deckCards(options.devCards ?? DEV_CARD_COUNTS);
  const ordered = options.devCardOrder;
  if (
    ordered &&
    (ordered.length !== cards.length ||
      [...ordered].toSorted().join(',') !== [...cards].toSorted().join(','))
  )
    throw new RangeError('Directed development deck must contain exactly the configured cards');
  const devDeck = ordered ? [...ordered].toReversed() : rng.shuffle(cards);
  // Every module deck other than `dev` (fog tiles, progress cards) gets its own hidden stack. Its
  // order comes only from this source's seed, never from the genesis (board) seed.
  const moduleStacks = new Map<string, string[]>();
  const moduleCard = (
    state: Readonly<GameState>,
    deckId: unknown,
    reveal: 'private' | 'public',
  ): string => {
    if (typeof deckId !== 'string') throw new Error('Draw has no deck');
    let stack = moduleStacks.get(deckId);
    if (!stack) {
      const declared = decksFor(state.config)[deckId];
      if (declared?.reveal !== reveal) throw new Error(`Deck ${deckId} is not a ${reveal} deck`);
      stack = createRng(hashValue(['cp2p-local-deck-v1', seed, deckId])).shuffle(
        deckCards(declared.cards),
      );
      moduleStacks.set(deckId, stack);
    }
    const card = stack.pop();
    if (!card) throw new Error(`Deck ${deckId} is empty`);
    return card;
  };
  return {
    remainingCards: () => [...devDeck],
    resolve(
      pending: SystemPending,
      state: Readonly<GameState>,
      privates: ReadonlyMap<Seat, PrivateState>,
    ): LocalRandomAnswer {
      if (isPublicDraw(pending))
        return {
          input: publicDrawInput(pending, moduleCard(state, pending.request.deck, 'public')),
        };
      switch (pending.systemType) {
        case 'START_SEAT': {
          const seat = state.config.seats[rng.int(state.config.seats.length)];
          if (seat === undefined) throw new Error('No starting seat');
          return { input: { kind: 'system', type: 'START_SEAT', seat } };
        }
        case 'DICE_RESULT': {
          const extraDice = (): { extra?: Record<string, string> } => {
            const extra = rollExtraDice(pending.request, (bound) => rng.int(bound));
            return Object.keys(extra).length ? { extra } : {};
          };
          if (pending.request.mode === 'fixed') {
            const fixed = pending.request.dice;
            if (!Array.isArray(fixed) || fixed.length !== 2)
              throw new Error('Malformed fixed dice request');
            return {
              input: { kind: 'system', type: 'DICE_RESULT', dice: [...fixed], ...extraDice() },
            };
          }
          if (pending.request.mode === 'balanced') {
            if (options.fixedDiceTotal !== undefined)
              throw new Error('Directed dice total cannot override balanced dice');
            const deck = diceDeck(state);
            const index = rng.int(deck.length);
            const card = deck[index];
            if (card === undefined) throw new Error('Empty balanced dice deck');
            return {
              input: {
                kind: 'system',
                type: 'DICE_RESULT',
                index,
                dice: [Math.floor(card / 6) + 1, (card % 6) + 1],
                ...extraDice(),
              },
            };
          }
          if (options.fixedDiceTotal !== undefined) {
            const first = Math.max(1, options.fixedDiceTotal - 6);
            return {
              input: {
                kind: 'system',
                type: 'DICE_RESULT',
                dice: [first, options.fixedDiceTotal - first],
                ...extraDice(),
              },
            };
          }
          const dice = [rng.int(6) + 1, rng.int(6) + 1];
          return {
            input: { kind: 'system', type: 'DICE_RESULT', dice, ...extraDice() },
          };
        }
        case 'CARD_DEALT': {
          const seatValue = requiredInteger(pending.request.seat, 'draw seat');
          const seat = state.config.seats.find((candidate) => candidate === seatValue);
          const slotId = pending.request.slotId;
          const deckId = pending.request.deck ?? 'dev';
          const card = deckId === 'dev' ? devDeck.pop() : moduleCard(state, deckId, 'private');
          if (seat === undefined || typeof slotId !== 'string' || !card)
            throw new Error('Invalid development draw');
          return {
            input: { kind: 'system', type: 'CARD_DEALT', deck: deckId, seat, slotId, card },
          };
        }
        case 'STEAL_RESULT': {
          const thief = state.config.seats.find(
            (seat) => seat === requiredInteger(pending.request.thief, 'thief'),
          );
          const victim = state.config.seats.find(
            (seat) => seat === requiredInteger(pending.request.victim, 'victim'),
          );
          if (thief === undefined || victim === undefined) throw new Error('Unknown steal seat');
          const hand = requiredPrivate(privates, victim).hand;
          const kinds = kindsOfCounts(hand);
          const size = kinds.reduce((sum, resource) => sum + (hand[resource] ?? 0), 0);
          let index = rng.int(size);
          for (const resource of kinds) {
            index -= hand[resource] ?? 0;
            if (index < 0)
              return { input: { kind: 'system', type: 'STEAL_RESULT', thief, victim, resource } };
          }
          throw new Error('Steal index exceeded private hand');
        }
        case 'REVEAL_COUNT': {
          if (pending.kind !== 'reveal' || typeof pending.request.resource !== 'string')
            throw new Error('Malformed monopoly reveal');
          const hand = requiredPrivate(privates, pending.seat).hand;
          const resource = kindsOfCounts(hand).find((item) => item === pending.request.resource);
          if (!resource) throw new Error('Unknown reveal resource');
          return {
            input: {
              kind: 'system',
              type: 'REVEAL_COUNT',
              seat: pending.seat,
              resource,
              count: hand[resource] ?? 0,
            },
          };
        }
        case 'REVEAL_PROGRESS': {
          // A drawer shows a victory card it drew, or says none.
          if (pending.kind !== 'reveal' || typeof pending.request.slotId !== 'string')
            throw new Error('Malformed victory check');
          const held = requiredPrivate(privates, pending.seat).slots[pending.request.slotId];
          const victory = held === 'printer' || held === 'constitution';
          return {
            input: {
              kind: 'system',
              type: 'REVEAL_PROGRESS',
              seat: pending.seat,
              slotId: pending.request.slotId,
              card: victory ? held : 'none',
            },
          };
        }
        case 'DEAL_KNOWN': {
          // A returned card dealt again: everything is already public in the request.
          const { type: _type, ...echoed } = pending.request;
          return { input: { ...echoed, kind: 'system', type: 'DEAL_KNOWN', seat: pending.seat } };
        }
        case 'SHOW_HAND': {
          if (pending.kind !== 'reveal') throw new Error('Malformed hand reveal');
          const actor = state.config.seats.find((seat) => seat === pending.request.to);
          const target = requiredPrivate(privates, pending.seat);
          if (actor === undefined) throw new Error('Unknown seat shown a hand');
          const shown =
            pending.request.what === 'progress'
              ? { progress: { ...target.slots } }
              : { hand: { ...target.hand } };
          return {
            input: {
              kind: 'system',
              type: 'SHOW_HAND',
              seat: pending.seat,
              to: actor,
              what: pending.request.what,
            },
            privateData: { [actor]: shown },
          };
        }
        case 'TAKE_CARDS': {
          // The actor takes `count` cards of the shown hand; only the two parties learn the kinds.
          if (pending.kind !== 'reveal') throw new Error('Malformed take');
          const from = state.config.seats.find((seat) => seat === pending.request.from);
          const count = requiredInteger(pending.request.count, 'take count');
          if (from === undefined) throw new Error('Unknown seat to take from');
          const hand = requiredPrivate(privates, from).hand;
          const pool = kindsOfCounts(hand).flatMap((kind) =>
            Array<string>(hand[kind] ?? 0).fill(kind),
          );
          const taken: Record<string, number> = {};
          for (let n = 0; n < count; n++) {
            const picked = pool.splice(rng.int(pool.length), 1)[0];
            if (picked === undefined) throw new Error('Take exceeds the shown hand');
            taken[picked] = (taken[picked] ?? 0) + 1;
          }
          return {
            input: {
              kind: 'system',
              type: 'TAKE_CARDS',
              seat: pending.seat,
              from,
              cards: 'hidden',
            },
            privateData: { [pending.seat]: { cards: taken }, [from]: { cards: taken } },
          };
        }
        case 'TAKE_PROGRESS': {
          // The Spy takes one shown progress card, or none.
          if (pending.kind !== 'reveal') throw new Error('Malformed take');
          const from = state.config.seats.find((seat) => seat === pending.request.from);
          if (from === undefined) throw new Error('Unknown seat to take from');
          const held = (state.seats.find((seat) => seat.seat === from)?.cardSlots ?? []).filter(
            (slot) => slot.revealed === undefined && slot.deck.startsWith('progress-'),
          );
          const index = rng.int(held.length + 1);
          const slot = held[index];
          if (slot === undefined)
            return {
              input: {
                kind: 'system',
                type: 'TAKE_PROGRESS',
                seat: pending.seat,
                from,
                slotId: null,
              },
            };
          const card = slot.known ?? requiredPrivate(privates, from).slots[slot.slotId];
          return {
            input: {
              kind: 'system',
              type: 'TAKE_PROGRESS',
              seat: pending.seat,
              from,
              slotId: slot.slotId,
            },
            privateData: { [pending.seat]: { card } },
          };
        }
        default:
          throw new Error(`Unsupported random request ${pending.systemType}`);
      }
    },
  };
}
