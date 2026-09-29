import type { CommandShape, Engine, SystemInput } from '../../../core/pipeline/index.js';
import { createResourceBounds, kindsOfCounts, seatBounds } from '../../../core/resources/index.js';
import type { GameState, PrivateState } from '../../../core/state/index.js';
import type { Seat } from '../../../core/types/index.js';
import { frame } from '../../base/shared.js';
import { knightsEngine } from '../testing.js';
import {
  inMain,
  newGame,
  rejection,
  ringLayout,
  submit,
  withBuildings,
  withKnights,
  withRoads,
} from '../support.js';
import { deckOfTrack, trackOfCard } from './catalogue.js';
import { heldSlots } from './hand.js';

export const engine: Engine = knightsEngine();
export const fiveSixEngine: Engine = knightsEngine(true);

/** `list[index]`, or the empty string so a test can pass it where a vertex id is needed. */
export const at = (list: readonly string[], index: number): string => list[index] ?? '';

/**
 * Give a seat a progress card in hand as if it had drawn it: the deck's public counter moves and
 * the slot carries the identity as a public `known` card, so a test needs no private state.
 */
export function withProgress(
  state: GameState,
  seat: Seat,
  card: string,
): { state: GameState; slotId: string } {
  const track = trackOfCard(card);
  if (track === null) throw new Error(`Unknown progress card ${card}`);
  const deck = deckOfTrack(track);
  const slotId = `progress:${state.counters.nextSlotId}`;
  const before = state.decks[deck];
  if (!before) throw new Error(`No ${deck}`);
  return {
    slotId,
    state: {
      ...state,
      counters: { ...state.counters, nextSlotId: state.counters.nextSlotId + 1 },
      decks: {
        ...state.decks,
        [deck]: { remaining: before.remaining - 1, drawn: [...before.drawn, { slotId, seat }] },
      },
      seats: state.seats.map((item) =>
        item.seat === seat
          ? {
              ...item,
              cardSlots: [
                ...item.cardSlots,
                { slotId, deck, acquiredTurn: state.turn.number, known: card },
              ],
            }
          : item,
      ),
    },
  };
}

/**
 * Like `withProgress`, but the identity stays private to the owner: the public slot has no `known`
 * card, and the caller puts the identity into that seat's private state.
 */
export function withHidden(
  state: GameState,
  seat: Seat,
  card: string,
): { state: GameState; slotId: string } {
  const dealt = withProgress(state, seat, card);
  return {
    slotId: dealt.slotId,
    state: {
      ...dealt.state,
      seats: dealt.state.seats.map((item) =>
        item.seat === seat
          ? {
              ...item,
              cardSlots: item.cardSlots.map((slot) => {
                if (slot.slotId !== dealt.slotId) return slot;
                const { known: _known, ...rest } = slot;
                return rest;
              }),
            }
          : item,
      ),
    },
  };
}

/** Several cards at once. */
export function withCards(state: GameState, seat: Seat, ...cards: string[]): GameState {
  return cards.reduce((next, card) => withProgress(next, seat, card).state, state);
}

/** The slot id of the first card of that kind the seat holds. */
export function slotFor(state: GameState, seat: Seat, card: string): string {
  const slot = heldSlots(state, seat).find((item) => item.known === card);
  if (!slot) throw new Error(`Seat ${seat} holds no ${card}`);
  return slot.slotId;
}

/** The identities the seat holds, in order. */
export function held(state: GameState, seat: Seat): (string | undefined)[] {
  return heldSlots(state, seat).map((slot) => slot.known);
}

/** The command that plays the card. */
export function playCommand(
  state: GameState,
  seat: Seat,
  card: string,
  params?: Record<string, unknown>,
): CommandShape {
  return {
    type: 'PLAY_PROGRESS_CARD',
    slotId: slotFor(state, seat, card),
    card,
    ...(params === undefined ? {} : { params }),
  };
}

/** Play the card from the seat's hand. */
export function play(
  state: GameState,
  seat: Seat,
  card: string,
  params?: Record<string, unknown>,
  e: Engine = engine,
): GameState {
  return submit(e, state, seat, playCommand(state, seat, card, params));
}

/** The rejection code of playing the card, or null when it is legal. */
export function refusal(
  state: GameState,
  seat: Seat,
  card: string,
  params?: Record<string, unknown>,
  e: Engine = engine,
): string | null {
  return rejection(e, state, seat, playCommand(state, seat, card, params));
}

/** Jump to the pre-roll phase of a mid-game turn. */
export function inPreRoll(state: GameState, active: Seat = 0, turn = 5): GameState {
  return { ...state, turn: { number: turn, activeSeat: active, phase: [frame('preRoll')] } };
}

/** A three-seat main phase: seat 0 holds a settlement and roads round a ring hex, with a city of seat 1. */
export function scene(e: Engine = engine) {
  const base = newGame(e, { seats: 3 });
  const layout = ringLayout(base);
  const { ring, out } = layout;
  let state = withBuildings(base, [
    { vertex: at(out, 0), seat: 0 },
    { vertex: at(ring, 5), seat: 1, kind: 'city' },
  ]);
  state = withRoads(state, 0, [at(out, 0), ...ring.slice(0, 5)]);
  return { state: inMain(state), ...layout };
}

/** Put the seat's knights on the given ring vertices (active and ready unless overridden). */
export function knightsOn(
  state: GameState,
  seat: Seat,
  vertices: readonly string[],
  fields: { level?: number; active?: boolean; ready?: boolean } = {},
): GameState {
  return withKnights(
    state,
    vertices.map((vertex) => ({ seat, vertex, ...fields })),
  );
}

/** The private state of a seat with the given hand (a base genesis private state, then set). */
export function privateOf(
  e: Engine,
  state: GameState,
  seat: Seat,
  hand: Record<string, number>,
  slots: Record<string, string> = {},
): PrivateState {
  const created = e.createPrivateState(seat, state.config);
  return { ...created, hand: { ...created.hand, ...hand }, slots };
}

/** Set a seat's public points, for the comparisons a card makes (Wedding, Saboteur, Master Merchant). */
export function withPoints(state: GameState, seat: Seat, points: number): GameState {
  return {
    ...state,
    seats: state.seats.map((item) => (item.seat === seat ? { ...item, publicVp: points } : item)),
  };
}

/**
 * Leave a seat's hand only partly known: `total` cards, each kind between `min` and `max`. The
 * kinds not named are held at zero.
 */
export function withBounds(
  state: GameState,
  seat: Seat,
  total: number,
  max: Record<string, number>,
  min: Record<string, number> = {},
): GameState {
  const kinds = kindsOfCounts(state.bank);
  const low = Object.fromEntries(kinds.map((kind) => [kind, min[kind] ?? 0]));
  const high = Object.fromEntries(kinds.map((kind) => [kind, max[kind] ?? 0]));
  const bounds = createResourceBounds(total, low, high, kinds);
  if (!bounds.ok) throw new Error(bounds.error.message);
  return {
    ...state,
    seats: state.seats.map((item) =>
      item.seat === seat ? { ...item, resources: seatBounds(bounds.value) } : item,
    ),
  };
}

/** Apply a system input and return the new state. */
export function system(state: GameState, input: SystemInput, e: Engine = engine): GameState {
  const result = e.apply(state, input);
  if (!result.ok) throw new Error(`${input.type}: ${result.error.code}: ${result.error.message}`);
  return result.value.state;
}

/** The rejection code of a system input, or null. */
export function systemRefusal(
  state: GameState,
  input: SystemInput,
  e: Engine = engine,
): string | null {
  const result = e.validate(state, input);
  return result.ok ? null : result.error.code;
}

/** One field of the parameters of every legal `PLAY_PROGRESS_CARD` the seat has, in listing order. */
export function playParam(state: GameState, seat: Seat, key: string): unknown[] {
  return engine
    .getLegalCommands(state, seat)
    .commands.filter((item) => item.type === 'PLAY_PROGRESS_CARD')
    .map((item) =>
      typeof item.params === 'object' && item.params !== null
        ? Reflect.get(item.params, key)
        : undefined,
    );
}

/** The `slotId` of the data of the top frame, for a draw or a deal that is waiting. */
export function frameSlot(state: GameState): string {
  const data = state.turn.phase.at(-1)?.data;
  return typeof data === 'object' && data !== null ? String(Reflect.get(data, 'slotId')) : '';
}
