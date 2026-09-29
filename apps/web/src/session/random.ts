import {
  decksFor,
  devCardCountsFor,
  isPublicDraw,
  kindsOfCounts,
  publicDrawInput,
  rollExtraDice,
} from '@cp2p/engine';
import type {
  GameState,
  Input,
  LocalRandomAnswer,
  LocalRandomSource,
  Pending,
  PrivateState,
  Seat,
} from '@cp2p/engine';

type SystemPending = Extract<Pending, { kind: 'random' | 'reveal' }>;

export interface Entropy {
  randomBytes(target: Uint8Array): void;
}

export const browserEntropy: Entropy = {
  randomBytes(target) {
    crypto.getRandomValues(target);
  },
};

/** Uniform index without modulo bias. All local randomness stays outside the rules engine. */
export function randomIndex(entropy: Entropy, maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 0x1_0000_0000)
    throw new RangeError('Random bound must be between 1 and 2^32');
  const range = 0x1_0000_0000;
  const accepted = range - (range % maxExclusive);
  const bytes = new Uint8Array(4);
  for (;;) {
    entropy.randomBytes(bytes);
    const value = new DataView(bytes.buffer).getUint32(0, true);
    if (value < accepted) return value % maxExclusive;
  }
}

export function randomSeed(entropy: Entropy): Uint8Array {
  const seed = new Uint8Array(32);
  entropy.randomBytes(seed);
  return seed;
}

function seatFrom(state: GameState, value: unknown): Seat {
  const seat = state.config.seats.find((candidate) => candidate === value);
  if (seat === undefined) throw new Error('Random request has an unknown seat');
  return seat;
}

function privateFor(privates: ReadonlyMap<Seat, PrivateState>, seat: Seat): PrivateState {
  const value = privates.get(seat);
  if (!value) throw new Error(`Missing private state for seat ${seat}`);
  return value;
}

/** A card kind of any deck of cards: a resource, or a commodity in a knights game. */
function kindFrom(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new Error('Random request has no card kind');
  return value;
}

function countOf(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`Invalid ${label} in a random request`);
  return value;
}

function diceDeck(state: GameState): number[] {
  const base = state.ext.base;
  const deck = typeof base === 'object' && base !== null ? Reflect.get(base, 'diceDeck') : null;
  if (
    !Array.isArray(deck) ||
    !deck.every(
      (value) =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 36,
    )
  )
    throw new Error('Balanced dice deck is malformed');
  return deck;
}

/** Derive undealt identities from public reveals and owners' private slots. */
export function remainingDevPool(
  state: GameState,
  privates: ReadonlyMap<Seat, PrivateState>,
  deckId = 'dev',
): string[] {
  const remaining = new Map<string, number>(
    Object.entries(
      deckId === 'dev'
        ? devCardCountsFor(state.config)
        : (decksFor(state.config)[deckId]?.cards ?? {}),
    ),
  );
  const deck = state.decks[deckId];
  if (!deck) throw new Error('Development deck is missing');
  for (const ref of deck.drawn) {
    // A slot may have changed hands since it was drawn (the Spy takes progress cards).
    const holder = state.seats.find((candidate) =>
      candidate.cardSlots.some((item) => item.slotId === ref.slotId),
    );
    const slot = holder?.cardSlots.find((item) => item.slotId === ref.slotId);
    if (!holder || !slot) throw new Error(`Drawn slot ${ref.slotId} is missing`);
    const identity =
      slot.revealed ?? slot.known ?? privateFor(privates, holder.seat).slots[ref.slotId];
    if (identity === undefined) throw new Error(`Drawn slot ${ref.slotId} has no identity`);
    const count = remaining.get(identity);
    if (count === undefined || count < 1)
      throw new Error(`Development card stock is inconsistent at ${ref.slotId}`);
    remaining.set(identity, count - 1);
  }
  const pool = [...remaining].flatMap(([card, count]) => Array<string>(count).fill(card));
  if (pool.length !== deck.remaining)
    throw new Error('Development card stock does not match public deck count');
  return pool;
}

/**
 * What a human chose when a card lets them look at a hand and take from it (Master Merchant, Spy).
 * Local play resolves the take in the same step as the card, so the choice is stated first. Without
 * one, or when it does not fit what is on the table, the take is random.
 */
export interface TakePreference {
  /** Cards to take from the shown hand: kind to count. */
  readonly cards?: Readonly<Record<string, number>>;
  /** The progress card slot to take, or `null` to take none. */
  readonly progress?: { readonly slotId: string | null };
}

export interface BrowserRandomSource extends LocalRandomSource {
  /**
   * Force the production dice of the next roll, and the faces of extra dice such as the event die
   * (`{ event: 'ship' }`). Extra dice not named here are still rolled at random.
   */
  forceNextDice(dice: readonly [number, number], extra?: Readonly<Record<string, string>>): void;
  clearForcedDice(): void;
  /** State the human's choice for the next Master Merchant or Spy take; `null` clears it. */
  preferTake(preference: TakePreference | null): void;
  /**
   * Rebuild the public-deck bookkeeping of a resumed game from its replayed input log. Public
   * cards leave no identity in state, so the log is the record of what was already shown. Throws
   * when the log shows more of a card than the deck holds or a different number than the state.
   */
  resume(log: readonly Input[], state: Readonly<GameState>): void;
}

/**
 * Local system input source. It keeps no secret deck order, so a save can resume safely: private
 * decks are derived from slots, and `resume` rebuilds the public decks from the replayed log.
 */
export function createBrowserRandomSource(entropy: Entropy = browserEntropy): BrowserRandomSource {
  let forcedDice: readonly [number, number] | null = null;
  let forcedExtra: Readonly<Record<string, string>> | null = null;
  let takePreference: TakePreference | null = null;
  // Public-deck cards already shown, from the replayed log and this session; the rest of the
  // deck is picked uniformly.
  const shown = new Map<string, Map<string, number>>();
  const publicCard = (state: Readonly<GameState>, deckId: unknown): string => {
    if (typeof deckId !== 'string') throw new Error('Public draw has no deck');
    const declared = decksFor(state.config)[deckId];
    if (declared?.reveal !== 'public') throw new Error(`Deck ${deckId} is not a public deck`);
    const seen = shown.get(deckId) ?? new Map<string, number>();
    const pool = Object.entries(declared.cards).flatMap(([card, count]) =>
      Array<string>(Math.max(0, count - (seen.get(card) ?? 0))).fill(card),
    );
    const card = pool[randomIndex(entropy, pool.length)];
    if (!card) throw new Error(`Public deck ${deckId} is empty`);
    seen.set(card, (seen.get(card) ?? 0) + 1);
    shown.set(deckId, seen);
    return card;
  };
  // The faces of the extra dice (an event die) a dice request adds; nothing in a base game.
  const extraDice = (pending: SystemPending): { extra?: Record<string, string> } => {
    const extra = rollExtraDice(pending.request, (bound) => randomIndex(entropy, bound));
    const forced = forcedExtra;
    forcedExtra = null;
    if (forced)
      for (const [die, face] of Object.entries(forced)) if (die in extra) extra[die] = face;
    return Object.keys(extra).length ? { extra } : {};
  };
  return {
    forceNextDice(dice, extra) {
      if (
        dice.length !== 2 ||
        dice.some((face) => !Number.isSafeInteger(face) || face < 1 || face > 6)
      )
        throw new RangeError('Forced dice must be two faces from 1 to 6');
      forcedDice = [dice[0], dice[1]];
      forcedExtra = extra ?? null;
    },
    clearForcedDice() {
      forcedDice = null;
      forcedExtra = null;
    },
    preferTake(preference) {
      takePreference = preference;
    },
    resume(log, state) {
      const decks = decksFor(state.config);
      const seen = new Map<string, Map<string, number>>();
      for (const input of log) {
        if (input.kind !== 'system') continue;
        const { deck, card } = input;
        if (typeof deck !== 'string' || typeof card !== 'string') continue;
        if (decks[deck]?.reveal !== 'public') continue;
        const counts = seen.get(deck) ?? new Map<string, number>();
        counts.set(card, (counts.get(card) ?? 0) + 1);
        seen.set(deck, counts);
      }
      for (const [deck, declared] of Object.entries(decks)) {
        if (declared.reveal !== 'public') continue;
        const counts = seen.get(deck) ?? new Map<string, number>();
        let total = 0;
        for (const [card, count] of counts) {
          if (count > (declared.cards[card] ?? 0))
            throw new Error(`Public deck ${deck} shows ${card} more often than it holds`);
          total += count;
        }
        if (total !== state.decks[deck]?.drawn.length)
          throw new Error(`Public deck ${deck} log does not match its public draw count`);
      }
      shown.clear();
      for (const [deck, counts] of seen) shown.set(deck, counts);
    },
    resolve(
      pending: SystemPending,
      state: Readonly<GameState>,
      privates: ReadonlyMap<Seat, PrivateState>,
    ): LocalRandomAnswer {
      if (isPublicDraw(pending))
        return { input: publicDrawInput(pending, publicCard(state, pending.request.deck)) };
      switch (pending.systemType) {
        case 'START_SEAT': {
          const seat = state.config.seats[randomIndex(entropy, state.config.seats.length)];
          if (seat === undefined) throw new Error('No starting seat');
          return { input: { kind: 'system', type: 'START_SEAT', seat } };
        }
        case 'DICE_RESULT': {
          if (pending.request.mode === 'fixed') {
            // The Alchemist named both production dice; only the extra dice are rolled.
            const fixed = pending.request.dice;
            if (!Array.isArray(fixed) || fixed.length !== 2)
              throw new Error('Malformed fixed dice request');
            return {
              input: {
                kind: 'system',
                type: 'DICE_RESULT',
                dice: [...fixed],
                ...extraDice(pending),
              },
            };
          }
          if (pending.request.mode === 'balanced') {
            if (forcedDice) throw new Error('Cannot force a balanced dice result');
            const deck = diceDeck(state);
            const index = randomIndex(entropy, deck.length);
            const card = deck[index];
            if (card === undefined) throw new Error('Balanced dice deck is empty');
            return {
              input: {
                kind: 'system',
                type: 'DICE_RESULT',
                index,
                dice: [Math.floor(card / 6) + 1, (card % 6) + 1],
                ...extraDice(pending),
              },
            };
          }
          const dice = forcedDice ?? [randomIndex(entropy, 6) + 1, randomIndex(entropy, 6) + 1];
          forcedDice = null;
          return { input: { kind: 'system', type: 'DICE_RESULT', dice, ...extraDice(pending) } };
        }
        case 'CARD_DEALT': {
          const seat = seatFrom(state, pending.request.seat);
          const slotId = pending.request.slotId;
          if (typeof slotId !== 'string') throw new Error('Draw request is missing a slot id');
          const deckId = typeof pending.request.deck === 'string' ? pending.request.deck : 'dev';
          const pool = remainingDevPool(state, privates, deckId);
          const card = pool[randomIndex(entropy, pool.length)];
          if (!card) throw new Error('Development deck is empty');
          return {
            input: { kind: 'system', type: 'CARD_DEALT', deck: deckId, seat, slotId, card },
          };
        }
        case 'STEAL_RESULT': {
          const thief = seatFrom(state, pending.request.thief);
          const victim = seatFrom(state, pending.request.victim);
          const hand = privateFor(privates, victim).hand;
          const kinds = kindsOfCounts(hand);
          const size = kinds.reduce((sum, resource) => sum + (hand[resource] ?? 0), 0);
          let index = randomIndex(entropy, size);
          for (const resource of kinds) {
            index -= hand[resource] ?? 0;
            if (index < 0)
              return { input: { kind: 'system', type: 'STEAL_RESULT', thief, victim, resource } };
          }
          throw new Error('Steal index exceeds the private hand');
        }
        case 'REVEAL_COUNT': {
          if (pending.kind !== 'reveal') throw new Error('Reveal request has no owner');
          const resource = kindFrom(pending.request.resource);
          return {
            input: {
              kind: 'system',
              type: 'REVEAL_COUNT',
              seat: pending.seat,
              resource,
              count: privateFor(privates, pending.seat).hand[resource] ?? 0,
            },
          };
        }
        case 'REVEAL_PROGRESS': {
          // A drawer shows a victory card it drew, or says none.
          if (pending.kind !== 'reveal' || typeof pending.request.slotId !== 'string')
            throw new Error('Malformed victory check');
          const held = privateFor(privates, pending.seat).slots[pending.request.slotId];
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
          const actor = seatFrom(state, pending.request.to);
          const target = privateFor(privates, pending.seat);
          const revealed =
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
            privateData: { [actor]: revealed },
          };
        }
        case 'TAKE_CARDS': {
          // The actor takes `count` cards of the shown hand: its own choice, else random.
          if (pending.kind !== 'reveal') throw new Error('Malformed take');
          const from = seatFrom(state, pending.request.from);
          const count = countOf(pending.request.count, 'take count');
          const hand = privateFor(privates, from).hand;
          const chosen = takePreference?.cards;
          takePreference = null;
          const fits =
            chosen !== undefined &&
            Object.values(chosen).reduce((sum, taken) => sum + taken, 0) === count &&
            Object.entries(chosen).every(
              ([kind, taken]) => taken >= 0 && taken <= (hand[kind] ?? 0),
            );
          const taken: Record<string, number> = {};
          if (fits && chosen) {
            for (const [kind, amount] of Object.entries(chosen))
              if (amount > 0) taken[kind] = amount;
          } else {
            const pool = kindsOfCounts(hand).flatMap((kind) =>
              Array<string>(hand[kind] ?? 0).fill(kind),
            );
            for (let n = 0; n < count; n++) {
              const picked = pool.splice(randomIndex(entropy, pool.length), 1)[0];
              if (picked === undefined) throw new Error('Take exceeds the shown hand');
              taken[picked] = (taken[picked] ?? 0) + 1;
            }
          }
          // Local logs name the kinds, like a local steal, so a recorded game replays from its
          // public inputs alone.
          return {
            input: { kind: 'system', type: 'TAKE_CARDS', seat: pending.seat, from, cards: taken },
          };
        }
        case 'TAKE_PROGRESS': {
          // The Spy takes one shown progress card, or none.
          if (pending.kind !== 'reveal') throw new Error('Malformed take');
          const from = seatFrom(state, pending.request.from);
          const held = (state.seats.find((seat) => seat.seat === from)?.cardSlots ?? []).filter(
            (slot) => slot.revealed === undefined && slot.deck.startsWith('progress-'),
          );
          const chosen = takePreference?.progress;
          takePreference = null;
          const preferred =
            chosen === undefined
              ? undefined
              : chosen.slotId === null
                ? null
                : held.find((slot) => slot.slotId === chosen.slotId);
          const slot =
            preferred === undefined ? held[randomIndex(entropy, held.length + 1)] : preferred;
          if (slot === undefined || slot === null)
            return {
              input: {
                kind: 'system',
                type: 'TAKE_PROGRESS',
                seat: pending.seat,
                from,
                slotId: null,
              },
            };
          const card = slot.known ?? privateFor(privates, from).slots[slot.slotId];
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
          throw new Error(`Unsupported local random request ${pending.systemType}`);
      }
    },
  };
}
