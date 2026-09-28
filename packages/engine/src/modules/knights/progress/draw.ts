import type { EngineEffect } from '../../../core/effects/index.js';
import type {
  CommandHandler,
  DrawInfo,
  HandlerContext,
  PhaseHandler,
  SystemInputHandler,
  Transition,
} from '../../../core/modules/index.js';
import type { CommandShape, Pending } from '../../../core/pipeline/index.js';
import type { CardSlot, GameState, PrivateState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Result, Seat } from '../../../core/types/index.js';
import { claimCommands } from '../../base/legal.js';
import { resolveRoll } from '../../base/phases/turn.js';
import { frame, playerPending, pushPhase, updateSeat, withClaim } from '../../base/shared.js';
import { TRACKS } from '../config.js';
import type { Track } from '../config.js';
import { slotOf } from '../slot.js';
import { knightsExt, levelOf, updateKnights } from '../types.js';
import {
  VICTORY_CARDS,
  deckOfTrack,
  isProgressCard,
  isVictoryCard,
  trackOfCard,
  trackOfDeck,
} from './catalogue.js';
import { frameData, popPhase, pushKnights, replaceKnights, requireFrame } from './frames.js';
import { findSlot, heldSlots, identityOf, seatsFrom, surplus } from './hand.js';
import { creditKnown } from './mirror.js';

export const PROGRESS_FRAME = 'progress';
export const DEAL_FRAME = 'progressDeal';

/** The order in which a timeout picks a deck. */
const TIMEOUT_DECKS: readonly Track[] = ['science', 'trade', 'politics'];

/** A seat owed a card. `deck` is null while the seat still has to name a deck (defender ties). */
export interface DrawEntry {
  seat: Seat;
  deck: Track | null;
}

/** A hidden card drawn from a deck that holds a victory card: its drawer must show or deny it. */
export interface CheckEntry {
  seat: Seat;
  slotId: string;
  deck: Track;
}

/**
 * The frame that holds a roll back while progress cards are dealt: the draws in order, then the
 * drawers' victory-card checks, then the discards of seats other than the active seat.
 */
export interface ProgressFrameData {
  roll: number;
  queue: DrawEntry[];
  checks: CheckEntry[];
  /** Seats that must discard, or null until the draws and checks are over. */
  discards: Seat[] | null;
}

/** A card dealt again from a deck's public bottom queue; its drawer acknowledges the deal. */
export interface DealFrameData {
  seat: Seat;
  deck: Track;
  slotId: string;
  card: string;
}

function progressData(state: GameState): ProgressFrameData {
  return requireFrame<ProgressFrameData>(state, PROGRESS_FRAME);
}

function setProgress(state: GameState, data: ProgressFrameData): GameState {
  return replaceKnights(state, PROGRESS_FRAME, data);
}

/** Whether a track's deck can still give a card: hidden positions left, or a returned card waiting. */
export function deckOpen(state: GameState, track: Track): boolean {
  return (
    (state.decks[deckOfTrack(track)]?.remaining ?? 0) > 0 ||
    (knightsExt(state).bottom[track]?.length ?? 0) > 0
  );
}

/** Whether a victory card has been shown by any seat. */
export function victoryShown(state: GameState, card: string): boolean {
  return state.seats.some((seat) => seat.cardSlots.some((slot) => slot.revealed === card));
}

/** Whether a hidden card from this deck may be the deck's victory card (which is not yet shown). */
function mayBeVictory(state: GameState, track: Track): boolean {
  return Object.entries(VICTORY_CARDS).some(
    ([card, home]) => home === track && !victoryShown(state, card),
  );
}

function nextSlotId(state: GameState): { state: GameState; slotId: string } {
  return {
    slotId: `progress:${state.counters.nextSlotId}`,
    state: {
      ...state,
      counters: { ...state.counters, nextSlotId: state.counters.nextSlotId + 1 },
    },
  };
}

type Step = { state: GameState; done: false } | { state: GameState; done: true; roll: number };

/**
 * Move the progress frame (on top) to whatever it waits for next, without a Transition: it pushes
 * the next draw or deal frame, or stops at a pick, a victory check or a discard. When nothing is
 * left it pops the frame and reports the held-back roll. Every step that needs an effect is an
 * input, so this never has to produce one.
 */
export function advance(state: GameState): Step {
  let next = state;
  for (;;) {
    const data = progressData(next);
    const head = data.queue[0];
    if (head !== undefined) {
      const rest = data.queue.slice(1);
      let track = head.deck;
      if (track === null) {
        const open = TRACKS.filter((candidate) => deckOpen(next, candidate));
        if (open.length === 0) {
          next = setProgress(next, { ...data, queue: rest });
          continue;
        }
        const only = open[0];
        if (open.length > 1 || only === undefined) return { state: next, done: false };
        track = only;
      }
      const deck = deckOfTrack(track);
      if ((next.decks[deck]?.remaining ?? 0) > 0) {
        const dealt = nextSlotId(setProgress(next, { ...data, queue: rest }));
        return {
          state: pushPhase(
            dealt.state,
            frame('drawDev', { seat: head.seat, slotId: dealt.slotId, deck }),
          ),
          done: false,
        };
      }
      const card = knightsExt(next).bottom[track][0];
      if (card === undefined) {
        next = setProgress(next, { ...data, queue: rest });
        continue;
      }
      const dealt = nextSlotId(setProgress(next, { ...data, queue: rest }));
      const deal: DealFrameData = { seat: head.seat, deck: track, slotId: dealt.slotId, card };
      return { state: pushKnights(dealt.state, DEAL_FRAME, deal), done: false };
    }
    if (data.checks.length > 0) return { state: next, done: false };
    if (data.discards === null) {
      const active = next.turn.activeSeat;
      const over = seatsFrom(next).filter((seat) => seat !== active && surplus(next, seat) > 0);
      next = setProgress(next, { ...data, discards: over });
      continue;
    }
    if (data.discards.length > 0) return { state: next, done: false };
    return { state: popPhase(next), done: true, roll: data.roll };
  }
}

/** Continue after a step that closed something: more frames, or resolve the held-back roll. */
export function settle(state: GameState, acc: Transition, ctx: HandlerContext): Transition {
  const step = advance(state);
  if (!step.done) return { ...acc, state: step.state };
  const resolved = resolveRoll(step.state, step.roll, ctx);
  return {
    state: resolved.state,
    events: [...acc.events, ...resolved.events],
    effects: [...acc.effects, ...resolved.effects],
  };
}

/** The gate face `track`: every seat at level L >= 1 with a red die <= L + 1 draws, in turn order. */
export function beginGateDraws(
  state: GameState,
  track: Track,
  red: number,
  roll: number,
): GameState {
  const queue: DrawEntry[] = seatsFrom(state)
    .filter((seat) => {
      const level = levelOf(state, seat, track);
      return level >= 1 && red <= level + 1;
    })
    .map((seat) => ({ seat, deck: track }));
  return begin(state, queue, roll);
}

/** Tied top defenders each pick a deck and draw, in turn order from the active seat. */
export function beginTieDraws(state: GameState, tied: readonly Seat[], roll: number): GameState {
  const queue: DrawEntry[] = seatsFrom(state)
    .filter((seat) => tied.includes(seat))
    .map((seat) => ({ seat, deck: null }));
  return begin(state, queue, roll);
}

function begin(state: GameState, queue: DrawEntry[], roll: number): GameState {
  if (queue.length === 0) return state;
  const data: ProgressFrameData = { roll, queue, checks: [], discards: null };
  return advance(pushKnights(state, PROGRESS_FRAME, data)).state;
}

/** The `afterDraw` hook: note a possible victory card, then carry on with the frame beneath. */
export function afterProgressDraw(
  draw: DrawInfo,
  acc: Transition,
  ctx: HandlerContext,
): Transition {
  const track = trackOfDeck(draw.deck);
  const data = frameData<ProgressFrameData>(acc.state, PROGRESS_FRAME);
  if (track === null || data === undefined) return acc;
  const checked = mayBeVictory(acc.state, track)
    ? setProgress(acc.state, {
        ...data,
        checks: [...data.checks, { seat: draw.seat, slotId: draw.slotId, deck: track }],
      })
    : acc.state;
  return settle(checked, acc, ctx);
}

// ---------------------------------------------------------------------------------------------
// Frames

function pickPending(state: GameState, data: ProgressFrameData): Pending[] {
  const head = data.queue[0];
  return head ? [playerPending(state, head.seat, ['CHOOSE_PROGRESS_DECK'], PROGRESS_FRAME)] : [];
}

export const progressPhase: PhaseHandler = {
  pending: (state) => {
    const data = progressData(state);
    if (data.queue.length > 0) return withClaim(state, pickPending(state, data));
    if (data.checks.length > 0)
      return withClaim(
        state,
        data.checks.map((check) => ({
          kind: 'reveal' as const,
          seat: check.seat,
          request: {
            type: 'progressVictory',
            slotId: check.slotId,
            deck: deckOfTrack(check.deck),
          },
          systemType: 'REVEAL_PROGRESS',
        })),
      );
    return withClaim(
      state,
      (data.discards ?? []).map((seat) =>
        playerPending(state, seat, ['DISCARD_PROGRESS'], PROGRESS_FRAME),
      ),
    );
  },
  legalCommands: (state, _frame, seat, priv, ctx) => {
    const claim = claimCommands(state, seat, priv, ctx);
    const data = progressData(state);
    const commands: CommandShape[] = [];
    const templates: { type: string; [key: string]: unknown }[] = [];
    if (data.queue[0]?.seat === seat)
      for (const track of TRACKS)
        if (deckOpen(state, track)) commands.push({ type: 'CHOOSE_PROGRESS_DECK', deck: track });
    if (data.queue.length === 0 && data.checks.length === 0 && data.discards?.includes(seat)) {
      const listed = discardOptions(state, seat, priv, surplus(state, seat), surplus(state, seat));
      commands.push(...listed.commands);
      templates.push(...listed.templates);
    }
    return {
      commands: [...commands, ...claim.commands],
      templates: [...templates, ...claim.templates],
    };
  },
};

export const dealPhase: PhaseHandler = {
  pending: (state) => {
    const deal = requireFrame<DealFrameData>(state, DEAL_FRAME);
    return withClaim(state, [
      {
        kind: 'reveal',
        seat: deal.seat,
        request: {
          type: 'progressDeal',
          deck: deckOfTrack(deal.deck),
          slotId: deal.slotId,
          card: deal.card,
        },
        systemType: 'DEAL_KNOWN',
      },
    ]);
  },
  legalCommands: (state, _frame, seat, priv, ctx) => claimCommands(state, seat, priv, ctx),
};

// ---------------------------------------------------------------------------------------------
// Inputs

function trackOf(value: unknown): Track | null {
  return TRACKS.find((track) => track === value) ?? null;
}

/** The seat names a deck for a defender-tie draw. */
export const chooseProgressDeck: CommandHandler = {
  keys: { allowed: ['deck'] },
  validate: (state, input) => {
    const data = frameData<ProgressFrameData>(state, PROGRESS_FRAME);
    if (data === undefined || data.queue.length === 0)
      return failure('no-deck-choice', 'No progress deck is waiting for a choice');
    const head = data.queue[0];
    if (head?.seat !== input.seat || head.deck !== null)
      return failure('not-choosing-deck', 'It is not this seat’s deck choice');
    const track = trackOf(input.command.deck);
    return track !== null && deckOpen(state, track)
      ? success(undefined)
      : failure('invalid-deck', 'Choose the science, trade or politics deck, if it holds a card');
  },
  apply: (state, input, ctx) => {
    const data = progressData(state);
    const track = trackOf(input.command.deck);
    if (track === null) throw new Error('Validated deck missing');
    const queue = data.queue.map((entry, index) =>
      index === 0 ? { ...entry, deck: track } : entry,
    );
    return settle(setProgress(state, { ...data, queue }), { state, events: [], effects: [] }, ctx);
  },
  applyPrivate: (priv, before, input, _data, ctx) =>
    creditKnown(priv, chooseProgressDeck.apply(before, input, ctx).effects),
};

/** A drawer shows a victory card it drew, or says it drew none. */
export const revealProgress: SystemInputHandler = {
  keys: { allowed: ['seat', 'slotId', 'card'] },
  validate: (state, input) => {
    const data = frameData<ProgressFrameData>(state, PROGRESS_FRAME);
    const check =
      data?.queue.length === 0
        ? data.checks.find((item) => item.seat === input.seat && item.slotId === input.slotId)
        : undefined;
    if (check === undefined)
      return failure('no-victory-check', 'No victory check is open for this card');
    if (input.card === 'none') return success(undefined);
    return typeof input.card === 'string' && VICTORY_CARDS[input.card] === check.deck
      ? success(undefined)
      : failure('invalid-victory-card', 'Show the deck’s victory card, or none');
  },
  apply: (state, input, ctx) => {
    const data = progressData(state);
    const seat = state.config.seats.find((item) => item === input.seat);
    const card = input.card;
    if (seat === undefined || typeof card !== 'string') throw new Error('Validated reveal missing');
    const check = data.checks.find((item) => item.seat === seat && item.slotId === input.slotId);
    if (check === undefined) throw new Error('Validated victory check missing');
    let next = setProgress(state, {
      ...data,
      checks: data.checks.filter((item) => item !== check),
    });
    const effects: EngineEffect[] = [];
    if (card !== 'none') {
      next = updateSeat(next, seat, (old) => ({
        ...old,
        cardSlots: old.cardSlots.map((slot) =>
          slot.slotId === check.slotId ? { ...slot, revealed: card } : slot,
        ),
      }));
      effects.push({
        type: 'card-slot-revealed',
        seat,
        deck: deckOfTrack(check.deck),
        slotId: check.slotId,
        card,
      });
    }
    return settle(
      next,
      { state, events: card === 'none' ? [] : [{ type: 'victoryCardShown', seat, card }], effects },
      ctx,
    );
  },
  applyPrivate: (priv, before, input, _data, ctx) => {
    const card = input.card;
    if (priv.seat === input.seat && typeof input.slotId === 'string') {
      const held = priv.slots[input.slotId];
      if (card === 'none' && held !== undefined && isVictoryCard(held))
        return failure('hidden-victory-card', 'A victory card must be shown when it is drawn');
      if (card !== 'none' && held !== card)
        return failure('private-card-mismatch', 'The shown card differs from the drawn card');
    }
    const slots = Object.fromEntries(
      Object.entries(priv.slots).filter(([slotId]) => card === 'none' || slotId !== input.slotId),
    );
    return creditKnown({ ...priv, slots }, revealProgress.apply(before, input, ctx).effects);
  },
};

/** The drawer acknowledges a card dealt again from the bottom queue; the state already names it. */
export const dealKnown: SystemInputHandler = {
  keys: { allowed: ['seat', 'deck', 'slotId', 'card'] },
  validate: (state, input) => {
    const deal = frameData<DealFrameData>(state, DEAL_FRAME);
    if (deal === undefined) return failure('no-deal', 'No returned card is being dealt');
    return input.seat === deal.seat &&
      input.deck === deckOfTrack(deal.deck) &&
      input.slotId === deal.slotId &&
      input.card === deal.card &&
      knightsExt(state).bottom[deal.deck][0] === deal.card
      ? success(undefined)
      : failure('deal-mismatch', 'The deal does not match the returned card');
  },
  apply: (state, _input, ctx) => {
    const deal = requireFrame<DealFrameData>(state, DEAL_FRAME);
    const slot: CardSlot = {
      slotId: deal.slotId,
      deck: deckOfTrack(deal.deck),
      acquiredTurn: state.turn.number,
      known: deal.card,
    };
    let next = updateKnights(popPhase(state), (old) => ({
      ...old,
      bottom: { ...old.bottom, [deal.deck]: old.bottom[deal.deck].slice(1) },
    }));
    next = updateSeat(next, deal.seat, (old) => ({ ...old, cardSlots: [...old.cardSlots, slot] }));
    return settle(
      next,
      {
        state,
        events: [{ type: 'cardDealt', deck: slot.deck, seat: deal.seat, slotId: deal.slotId }],
        effects: [
          {
            type: 'card-slot-known',
            seat: deal.seat,
            deck: slot.deck,
            slotId: deal.slotId,
            card: deal.card,
          },
        ],
      },
      ctx,
    );
  },
  applyPrivate: (priv, before, input, _data, ctx) =>
    creditKnown(priv, dealKnown.apply(before, input, ctx).effects),
};

// ---------------------------------------------------------------------------------------------
// Discards

interface Discard {
  slotId: string;
  card: string;
}

function parseDiscards(value: unknown): Result<Discard[]> {
  if (!Array.isArray(value) || value.length === 0)
    return failure('invalid-discard', 'Name the progress cards to discard');
  const list: Discard[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null)
      return failure('invalid-discard', 'Each discard names a slot and its card');
    const slotId: unknown = Reflect.get(item, 'slotId');
    const card: unknown = Reflect.get(item, 'card');
    if (typeof slotId !== 'string' || !isProgressCard(card))
      return failure('invalid-discard', 'Each discard names a slot and its card');
    list.push({ slotId, card });
  }
  return new Set(list.map((item) => item.slotId)).size === list.length
    ? success(list)
    : failure('invalid-discard', 'A card cannot be discarded twice');
}

function discardProblem(state: GameState, seat: Seat, list: readonly Discard[]): Result<void> {
  const need = surplus(state, seat);
  const frameOpen = frameData<ProgressFrameData>(state, PROGRESS_FRAME);
  if (frameOpen !== undefined) {
    if (
      frameOpen.queue.length > 0 ||
      frameOpen.checks.length > 0 ||
      !frameOpen.discards?.includes(seat)
    )
      return failure('not-discarding', 'This seat has no progress discard pending');
    if (list.length !== need)
      return failure('wrong-discard-count', `Discard exactly ${need} progress cards`);
  } else {
    const where = slotOf(state);
    if (where?.slot !== 'main' || where.seat !== seat)
      return failure('not-discarding', 'Progress cards are discarded in your action phase');
    if (need === 0)
      return failure('under-limit', 'A seat may not discard progress cards under the limit');
    if (list.length > need)
      return failure('too-many-discards', `Discard at most ${need} progress cards`);
  }
  for (const item of list) {
    const slot = findSlot(state, seat, item.slotId);
    if (slot === undefined || slot.revealed !== undefined || trackOfDeck(slot.deck) === null)
      return failure('invalid-slot', 'That is not a progress card in your hand');
    if (trackOfCard(item.card) !== trackOfDeck(slot.deck))
      return failure('card-deck-mismatch', 'That card does not belong to the slot’s deck');
    if (isVictoryCard(item.card))
      return failure('victory-card', 'A victory card is played, not discarded');
    if (slot.known !== undefined && slot.known !== item.card)
      return failure('card-mismatch', 'That slot holds another card');
  }
  return success(undefined);
}

/** Every way to discard between `least` and `most` held cards, for the seat's known hand. */
export function discardOptions(
  state: GameState,
  seat: Seat,
  priv: PrivateState | undefined,
  least: number,
  most: number,
): { commands: CommandShape[]; templates: { type: string; [key: string]: unknown }[] } {
  const held = heldSlots(state, seat);
  const known = held.map((slot) => ({ slot, card: identityOf(slot, priv) }));
  if (known.some((item) => item.card === undefined))
    return most > 0
      ? { commands: [], templates: [{ type: 'DISCARD_PROGRESS', count: most, from: 'held slots' }] }
      : { commands: [], templates: [] };
  const commands: CommandShape[] = [];
  const pick = (start: number, chosen: { slotId: string; card: string }[]): void => {
    if (chosen.length >= least && chosen.length > 0)
      commands.push({ type: 'DISCARD_PROGRESS', cards: chosen });
    if (chosen.length >= most) return;
    for (let index = start; index < known.length; index++) {
      const item = known[index];
      if (item?.card !== undefined && !isVictoryCard(item.card))
        pick(index + 1, [...chosen, { slotId: item.slot.slotId, card: item.card }]);
    }
  };
  pick(0, []);
  return { commands, templates: [] };
}

/** Discard progress cards down to the limit; the cards are shown and go under their decks. */
export const discardProgress: CommandHandler = {
  keys: { allowed: ['cards'] },
  validate: (state, input) => {
    const list = parseDiscards(input.command.cards);
    return list.ok ? discardProblem(state, input.seat, list.value) : list;
  },
  apply: (state, input, ctx) => {
    const list = parseDiscards(input.command.cards);
    if (!list.ok) throw new Error('Validated discards missing');
    const effects: EngineEffect[] = [];
    let next = state;
    for (const item of list.value) {
      const slot = findSlot(next, input.seat, item.slotId);
      const track = slot ? trackOfDeck(slot.deck) : null;
      if (!slot || track === null) throw new Error('Validated discard slot missing');
      next = updateSeat(next, input.seat, (old) => ({
        ...old,
        cardSlots: old.cardSlots.map((held) =>
          held.slotId === item.slotId ? { ...held, revealed: item.card } : held,
        ),
      }));
      next = updateKnights(next, (old) => ({
        ...old,
        bottom: { ...old.bottom, [track]: [...old.bottom[track], item.card] },
      }));
      effects.push({
        type: 'card-slot-revealed',
        seat: input.seat,
        deck: slot.deck,
        slotId: item.slotId,
        card: item.card,
      });
    }
    const event = { type: 'progressDiscarded', seat: input.seat, count: list.value.length };
    const data = frameData<ProgressFrameData>(state, PROGRESS_FRAME);
    if (data === undefined) return { state: next, events: [event], effects };
    const closed = setProgress(next, {
      ...data,
      discards: (data.discards ?? []).filter((seat) => seat !== input.seat),
    });
    return settle(closed, { state, events: [event], effects }, ctx);
  },
  applyPrivate: (priv, before, input, _data, ctx) => {
    const list = parseDiscards(input.command.cards);
    if (!list.ok) return list;
    let next = priv;
    if (priv.seat === input.seat) {
      const owned = new Set(list.value.map((item) => item.slotId));
      for (const item of list.value) {
        const slot = findSlot(before, input.seat, item.slotId);
        if (slot?.known === undefined && priv.slots[item.slotId] !== item.card)
          return failure('private-card-mismatch', 'The discarded card differs from the held card');
      }
      next = {
        ...priv,
        slots: Object.fromEntries(
          Object.entries(priv.slots).filter(([slotId]) => !owned.has(slotId)),
        ),
      };
    }
    return creditKnown(next, discardProgress.apply(before, input, ctx).effects);
  },
};

// ---------------------------------------------------------------------------------------------
// Timeouts

/** The public default for a progress frame: the first deck that still has a card. */
export function automaticProgress(state: GameState, seat: Seat): CommandShape | null {
  const data = frameData<ProgressFrameData>(state, PROGRESS_FRAME);
  if (data?.queue[0]?.seat !== seat) return null;
  const deck = TIMEOUT_DECKS.find((track) => deckOpen(state, track));
  return deck === undefined ? null : { type: 'CHOOSE_PROGRESS_DECK', deck };
}
