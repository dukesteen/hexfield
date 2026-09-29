import type { CommandHandler, PhaseHandler } from '../../../core/modules/index.js';
import type { GameState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Seat } from '../../../core/types/index.js';
import { claimCommands } from '../../base/legal.js';
import {
  affordable,
  cardKindsOf,
  countTotal,
  exchangeBank,
  ownSeat,
  parseCardCounts,
  playerPending,
  withClaim,
} from '../../base/shared.js';
import { changed } from './card.js';
import type { CardFlow, CardModule } from './card.js';
import { frameData, popPhase, pushKnights, replaceKnights } from './frames.js';
import { creditKnown } from './mirror.js';
import { exactChoice } from './transfer.js';

export const SABOTEUR_FRAME = 'saboteur';

/** The seats still to discard. */
interface SaboteurData {
  actor: Seat;
  remaining: Seat[];
}

/** Half of the seat's resource and commodity cards, rounded down. */
export function saboteurCount(state: GameState, seat: Seat): number {
  return Math.floor(ownSeat(state, seat).resources.total / 2);
}

/** Other seats with as many or more public points as the player and at least one card to lose. */
export function saboteurTargets(state: GameState, actor: Seat): Seat[] {
  const points = ownSeat(state, actor).publicVp;
  return state.config.seats.filter(
    (seat) =>
      seat !== actor && ownSeat(state, seat).publicVp >= points && saboteurCount(state, seat) > 0,
  );
}

function data(state: GameState): SaboteurData | undefined {
  return frameData<SaboteurData>(state, SABOTEUR_FRAME);
}

/**
 * A seat discards half its hand of its own choice, to the bank. The kinds are public, exactly as
 * for a discard on a 7 (the bank counts are public), so the input carries the counts.
 */
export const saboteurDiscard: CommandHandler = {
  keys: { allowed: ['cards'] },
  validate: (state, input) => {
    const frame = data(state);
    if (frame === undefined || !frame.remaining.includes(input.seat))
      return failure('not-discarding', 'This seat has no sabotage discard');
    const cards = parseCardCounts(input.command.cards, cardKindsOf(state));
    if (!cards.ok) return cards;
    const need = saboteurCount(state, input.seat);
    return countTotal(cards.value) === need
      ? affordable(state, input.seat, cards.value)
      : failure('wrong-discard-count', `Discard exactly ${need} cards`);
  },
  apply: (state, input) => {
    const frame = data(state);
    const cards = parseCardCounts(input.command.cards, cardKindsOf(state));
    if (frame === undefined || !cards.ok) throw new Error('Validated sabotage discard missing');
    const spent = exchangeBank(state, input.seat, cards.value, false);
    const remaining = frame.remaining.filter((seat) => seat !== input.seat);
    return {
      state: remaining.length
        ? replaceKnights(spent.state, SABOTEUR_FRAME, { ...frame, remaining })
        : popPhase(spent.state),
      events: [{ type: 'sabotageDiscard', seat: input.seat, count: countTotal(cards.value) }],
      effects: spent.effects,
    };
  },
  applyPrivate: (priv, before, input, _data, ctx) =>
    creditKnown(priv, saboteurDiscard.apply(before, input, ctx).effects),
};

export const saboteurPhase: PhaseHandler = {
  pending: (state) =>
    withClaim(
      state,
      (data(state)?.remaining ?? []).map((seat) =>
        playerPending(state, seat, ['SABOTEUR_DISCARD'], SABOTEUR_FRAME),
      ),
    ),
  legalCommands: (state, _frame, seat, priv, ctx) => {
    const claim = claimCommands(state, seat, priv, ctx);
    if (!data(state)?.remaining.includes(seat)) return claim;
    return {
      commands: claim.commands,
      templates: [
        ...claim.templates,
        {
          type: 'SABOTEUR_DISCARD',
          count: saboteurCount(state, seat),
          from: ownSeat(state, seat).resources,
        },
      ],
    };
  },
};

const flow: CardFlow = {
  commands: { SABOTEUR_DISCARD: saboteurDiscard },
  phases: { [SABOTEUR_FRAME]: saboteurPhase },
  timeout: (state, request) => {
    if (request.phase !== SABOTEUR_FRAME || !data(state)?.remaining.includes(request.seat))
      return null;
    const cards = exactChoice(state, request.seat, saboteurCount(state, request.seat));
    return cards ? { type: 'SABOTEUR_DISCARD', cards } : null;
  },
};

/**
 * Saboteur (Sabotage): each other seat with as many or more public points than the player discards
 * half of its resource and commodity cards, rounded down, of its own choice. The cards return to
 * the bank. Seats with fewer than two cards are not affected.
 */
export const saboteur: CardModule = {
  card: {
    id: 'saboteur',
    timing: 'main',
    problem: (state, seat, params) =>
      params !== undefined
        ? failure('unknown-field', 'saboteur takes no parameters')
        : saboteurTargets(state, seat).length > 0
          ? success(undefined)
          : failure('no-target', 'No other seat has as many points as you and cards to lose'),
    options: () => [undefined],
    apply: (state, seat) =>
      changed(
        pushKnights(state, SABOTEUR_FRAME, {
          actor: seat,
          remaining: saboteurTargets(state, seat),
        }),
        { type: 'saboteurPlayed', seat },
      ),
  },
  flow,
};
