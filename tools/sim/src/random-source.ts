import { hashValue } from '@cp2p/codec';
import type {
  GameState,
  LocalRandomAnswer,
  LocalRandomSource,
  Pending,
  PrivateState,
  Seat,
} from '@cp2p/engine';
import { RESOURCES } from '@cp2p/engine';
import { createRng } from '@cp2p/engine/rng';

type SystemPending = Extract<Pending, { kind: 'random' | 'reveal' }>;

const DEV_CARDS = [
  ...Array<string>(14).fill('knight'),
  ...Array<string>(5).fill('victoryPoint'),
  ...Array<string>(2).fill('roadBuilding'),
  ...Array<string>(2).fill('yearOfPlenty'),
  ...Array<string>(2).fill('monopoly'),
];

export interface LocalRandomOptions {
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

/** Seeded local system source with the real 25-card deck. Local inputs record dealt identities. */
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
  const ordered = options.devCardOrder;
  if (
    ordered &&
    (ordered.length !== DEV_CARDS.length ||
      [...ordered].toSorted().join(',') !== [...DEV_CARDS].toSorted().join(','))
  )
    throw new RangeError('Directed development deck must contain exactly the standard 25 cards');
  const devDeck = ordered ? [...ordered].toReversed() : rng.shuffle(DEV_CARDS);
  return {
    remainingCards: () => [...devDeck],
    resolve(
      pending: SystemPending,
      state: Readonly<GameState>,
      privates: ReadonlyMap<Seat, PrivateState>,
    ): LocalRandomAnswer {
      switch (pending.systemType) {
        case 'START_SEAT': {
          const seat = state.config.seats[rng.int(state.config.seats.length)];
          if (seat === undefined) throw new Error('No starting seat');
          return { input: { kind: 'system', type: 'START_SEAT', seat } };
        }
        case 'DICE_RESULT': {
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
              },
            };
          }
          return {
            input: { kind: 'system', type: 'DICE_RESULT', dice: [rng.int(6) + 1, rng.int(6) + 1] },
          };
        }
        case 'CARD_DEALT': {
          const seatValue = requiredInteger(pending.request.seat, 'draw seat');
          const seat = state.config.seats.find((candidate) => candidate === seatValue);
          const slotId = pending.request.slotId;
          const card = devDeck.pop();
          if (seat === undefined || typeof slotId !== 'string' || !card)
            throw new Error('Invalid development draw');
          return {
            input: { kind: 'system', type: 'CARD_DEALT', deck: 'dev', seat, slotId, card },
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
          const size = RESOURCES.reduce((sum, resource) => sum + (hand[resource] ?? 0), 0);
          let index = rng.int(size);
          for (const resource of RESOURCES) {
            index -= hand[resource] ?? 0;
            if (index < 0)
              return { input: { kind: 'system', type: 'STEAL_RESULT', thief, victim, resource } };
          }
          throw new Error('Steal index exceeded private hand');
        }
        case 'REVEAL_COUNT': {
          if (pending.kind !== 'reveal' || typeof pending.request.resource !== 'string')
            throw new Error('Malformed monopoly reveal');
          const resource = RESOURCES.find((item) => item === pending.request.resource);
          if (!resource) throw new Error('Unknown reveal resource');
          return {
            input: {
              kind: 'system',
              type: 'REVEAL_COUNT',
              seat: pending.seat,
              resource,
              count: requiredPrivate(privates, pending.seat).hand[resource] ?? 0,
            },
          };
        }
        default:
          throw new Error(`Unsupported random request ${pending.systemType}`);
      }
    },
  };
}
