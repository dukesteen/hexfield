import type { EngineEffect } from '../../../core/effects/index.js';
import type { CommandHandler, HandlerContext } from '../../../core/modules/index.js';
import type { CommandShape, LegalCommandSet } from '../../../core/pipeline/index.js';
import type { GameState, PrivateState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Result, Seat } from '../../../core/types/index.js';
import { topFrame, updateSeat } from '../../base/shared.js';
import { slotOf } from '../slot.js';
import { updateKnights } from '../types.js';
import { isVictoryCard, trackOfCard, trackOfDeck } from './catalogue.js';
import type { ProgressCard } from './card.js';
import { cardOf } from './cards.js';
import { findSlot, heldSlots, identityOf } from './hand.js';
import { creditKnown } from './mirror.js';

/** Where a card may be played: the Alchemist before the roll, the rest in the action phase. */
function timingProblem(state: GameState, seat: Seat, card: ProgressCard): Result<void> {
  if (card.timing === 'preRoll') {
    const top = topFrame(state);
    return top?.module === 'base' && top.id === 'preRoll' && state.turn.activeSeat === seat
      ? success(undefined)
      : failure('not-before-roll', 'The Alchemist is played before rolling the dice');
  }
  const where = slotOf(state);
  return where?.slot === 'main' && where.seat === seat
    ? success(undefined)
    : failure('not-in-action-phase', 'Progress cards are played in your action phase');
}

/** Everything `PLAY_PROGRESS_CARD` checks on public information. */
export function playProblem(
  state: GameState,
  seat: Seat,
  command: CommandShape,
  ctx: HandlerContext,
): Result<void> {
  const card = cardOf(command.card);
  if (card === undefined) return failure('invalid-progress-card', 'That is not a progress card');
  const slot = findSlot(state, seat, command.slotId);
  if (slot === undefined || slot.revealed !== undefined || trackOfDeck(slot.deck) === null)
    return failure('invalid-progress-slot', 'That is not a progress card in your hand');
  if (trackOfDeck(slot.deck) !== trackOfCard(card.id))
    return failure('card-deck-mismatch', 'That card does not belong to the slot’s deck');
  if (slot.known !== undefined && slot.known !== card.id)
    return failure('progress-card-mismatch', 'That slot holds another card');
  const timing = timingProblem(state, seat, card);
  return timing.ok ? card.problem(state, seat, command.params, ctx) : timing;
}

/** Play a progress card: it is shown, does its work, and goes under its deck (victory cards stay). */
export const playProgressCard: CommandHandler = {
  keys: { allowed: ['slotId', 'card', 'params'], optional: ['params'] },
  validate: (state, input, ctx) => playProblem(state, input.seat, input.command, ctx),
  apply: (state, input, ctx) => {
    const card = cardOf(input.command.card);
    const slotId = input.command.slotId;
    const slot = findSlot(state, input.seat, slotId);
    const track = slot ? trackOfDeck(slot.deck) : null;
    if (!card || !slot || track === null || typeof slotId !== 'string')
      throw new Error('Validated progress play missing');
    let next = updateSeat(state, input.seat, (old) => ({
      ...old,
      cardSlots: old.cardSlots.map((held) =>
        held.slotId === slotId ? { ...held, revealed: card.id } : held,
      ),
    }));
    if (!isVictoryCard(card.id))
      next = updateKnights(next, (old) => ({
        ...old,
        bottom: { ...old.bottom, [track]: [...old.bottom[track], card.id] },
      }));
    const shown: EngineEffect = {
      type: 'card-slot-revealed',
      seat: input.seat,
      deck: slot.deck,
      slotId,
      card: card.id,
    };
    const played = card.apply(next, input.seat, input.command.params, ctx);
    return {
      state: played.state,
      events: [{ type: 'progressCardPlayed', seat: input.seat, card: card.id }, ...played.events],
      effects: [shown, ...played.effects],
    };
  },
  applyPrivate: (priv, before, input, _data, ctx) => {
    const slotId = input.command.slotId;
    const card = input.command.card;
    if (typeof slotId !== 'string') return failure('invalid-progress-slot', 'Slot missing');
    let next: PrivateState = priv;
    if (priv.seat === input.seat) {
      const slot = findSlot(before, input.seat, slotId);
      if (slot?.known === undefined && priv.slots[slotId] !== card)
        return failure('private-card-mismatch', 'The played card differs from the held card');
      next = {
        ...priv,
        slots: Object.fromEntries(Object.entries(priv.slots).filter(([id]) => id !== slotId)),
      };
    }
    return creditKnown(next, playProgressCard.apply(before, input, ctx).effects);
  },
};

/** The plays a seat may make now: concrete commands for cards it can identify, else templates. */
export function playCommands(
  state: GameState,
  seat: Seat,
  priv: PrivateState | undefined,
  ctx: HandlerContext,
  timing: 'preRoll' | 'main',
): LegalCommandSet {
  const commands: CommandShape[] = [];
  const templates: LegalCommandSet['templates'] = [];
  for (const slot of heldSlots(state, seat)) {
    const id = identityOf(slot, priv);
    if (id === undefined) {
      templates.push({ type: 'PLAY_PROGRESS_CARD', slotId: slot.slotId, card: 'private identity' });
      continue;
    }
    const card = cardOf(id);
    if (card?.timing !== timing) continue;
    for (const params of card.options(state, seat, ctx, priv))
      commands.push({
        type: 'PLAY_PROGRESS_CARD',
        slotId: slot.slotId,
        card: id,
        ...(params === undefined ? {} : { params }),
      });
  }
  return { commands, templates };
}
