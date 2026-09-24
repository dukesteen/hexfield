import { DEV_CARD_COUNTS, RESOURCES } from '@cp2p/engine';
import type {
  GameState,
  LocalRandomAnswer,
  LocalRandomSource,
  Pending,
  PrivateState,
  Resource,
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

function resourceFrom(value: unknown): Resource {
  const resource = RESOURCES.find((item) => item === value);
  if (!resource) throw new Error('Random request has an unknown resource');
  return resource;
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
): string[] {
  const remaining = new Map<string, number>(Object.entries(DEV_CARD_COUNTS));
  const deck = state.decks.dev;
  if (!deck) throw new Error('Development deck is missing');
  for (const ref of deck.drawn) {
    const slot = state.seats
      .find((holder) => holder.seat === ref.seat)
      ?.cardSlots.find((item) => item.slotId === ref.slotId);
    if (!slot) throw new Error(`Drawn slot ${ref.slotId} is missing`);
    const identity = slot.revealed ?? privateFor(privates, ref.seat).slots[ref.slotId];
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

export interface BrowserRandomSource extends LocalRandomSource {
  forceNextDice(dice: readonly [number, number]): void;
  clearForcedDice(): void;
}

/** Local system input source. It keeps no secret deck order, so a save can resume safely. */
export function createBrowserRandomSource(entropy: Entropy = browserEntropy): BrowserRandomSource {
  let forcedDice: readonly [number, number] | null = null;
  return {
    forceNextDice(dice) {
      if (
        dice.length !== 2 ||
        dice.some((face) => !Number.isSafeInteger(face) || face < 1 || face > 6)
      )
        throw new RangeError('Forced dice must be two faces from 1 to 6');
      forcedDice = [dice[0], dice[1]];
    },
    clearForcedDice() {
      forcedDice = null;
    },
    resolve(
      pending: SystemPending,
      state: Readonly<GameState>,
      privates: ReadonlyMap<Seat, PrivateState>,
    ): LocalRandomAnswer {
      switch (pending.systemType) {
        case 'START_SEAT': {
          const seat = state.config.seats[randomIndex(entropy, state.config.seats.length)];
          if (seat === undefined) throw new Error('No starting seat');
          return { input: { kind: 'system', type: 'START_SEAT', seat } };
        }
        case 'DICE_RESULT': {
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
              },
            };
          }
          const dice = forcedDice ?? [randomIndex(entropy, 6) + 1, randomIndex(entropy, 6) + 1];
          forcedDice = null;
          return { input: { kind: 'system', type: 'DICE_RESULT', dice } };
        }
        case 'CARD_DEALT': {
          const seat = seatFrom(state, pending.request.seat);
          const slotId = pending.request.slotId;
          if (typeof slotId !== 'string') throw new Error('Draw request is missing a slot id');
          const pool = remainingDevPool(state, privates);
          const card = pool[randomIndex(entropy, pool.length)];
          if (!card) throw new Error('Development deck is empty');
          return { input: { kind: 'system', type: 'CARD_DEALT', deck: 'dev', seat, slotId, card } };
        }
        case 'STEAL_RESULT': {
          const thief = seatFrom(state, pending.request.thief);
          const victim = seatFrom(state, pending.request.victim);
          const hand = privateFor(privates, victim).hand;
          const size = RESOURCES.reduce((sum, resource) => sum + (hand[resource] ?? 0), 0);
          let index = randomIndex(entropy, size);
          for (const resource of RESOURCES) {
            index -= hand[resource] ?? 0;
            if (index < 0)
              return { input: { kind: 'system', type: 'STEAL_RESULT', thief, victim, resource } };
          }
          throw new Error('Steal index exceeds the private hand');
        }
        case 'REVEAL_COUNT': {
          if (pending.kind !== 'reveal') throw new Error('Reveal request has no owner');
          const resource = resourceFrom(pending.request.resource);
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
        default:
          throw new Error(`Unsupported local random request ${pending.systemType}`);
      }
    },
  };
}
