import type { CommandHandler, PhaseHandler } from '../../../core/modules/index.js';
import type { GameState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Seat } from '../../../core/types/index.js';
import { claimCommands } from '../../base/legal.js';
import { ownSeat, playerPending, withClaim } from '../../base/shared.js';
import { changed } from './card.js';
import type { CardFlow, CardModule } from './card.js';
import { frameData, popPhase, pushKnights, replaceKnights } from './frames.js';
import { exactChoice, movable, moveCards, movePrivate, parseCards } from './transfer.js';

export const WEDDING_FRAME = 'wedding';

/** The giving seats still to answer, and the seat that receives. */
interface WeddingData {
  actor: Seat;
  remaining: Seat[];
}

/** Cards a giver hands over: two, or everything it has if that is fewer. */
export function weddingCount(state: GameState, seat: Seat): number {
  return Math.min(2, ownSeat(state, seat).resources.total);
}

/** Other seats with more public points than the player and at least one card, in seat order. */
export function weddingGivers(state: GameState, actor: Seat): Seat[] {
  const points = ownSeat(state, actor).publicVp;
  return state.config.seats.filter(
    (seat) =>
      seat !== actor &&
      ownSeat(state, seat).publicVp > points &&
      ownSeat(state, seat).resources.total > 0,
  );
}

function data(state: GameState): WeddingData | undefined {
  return frameData<WeddingData>(state, WEDDING_FRAME);
}

/**
 * The seat gives its two cards. `cards` is explicit counts (every seat sees the kinds) or `hidden`
 * (only the count is public and the kinds reach the receiver and the giver as private input data
 * `{ cards }`); either way each giver chooses privately, by its own command.
 */
export const weddingGive: CommandHandler = {
  keys: { allowed: ['cards'] },
  validate: (state, input) => {
    const frame = data(state);
    if (frame === undefined || !frame.remaining.includes(input.seat))
      return failure('not-giving', 'This seat has no wedding gift to give');
    const cards = parseCards(state, input.command.cards);
    return cards.ok
      ? movable(state, input.seat, cards.value, weddingCount(state, input.seat))
      : cards;
  },
  apply: (state, input) => {
    const frame = data(state);
    const cards = parseCards(state, input.command.cards);
    if (frame === undefined || !cards.ok) throw new Error('Validated wedding gift missing');
    const count = weddingCount(state, input.seat);
    const moved = moveCards(state, input.seat, frame.actor, cards.value, count);
    const remaining = frame.remaining.filter((seat) => seat !== input.seat);
    return {
      state: remaining.length
        ? replaceKnights(moved.state, WEDDING_FRAME, { ...frame, remaining })
        : popPhase(moved.state),
      events: [{ type: 'weddingGift', seat: input.seat, to: frame.actor, count }],
      effects: moved.effects,
    };
  },
  applyPrivate: (priv, before, input, privateData) => {
    const frame = data(before);
    const cards = parseCards(before, input.command.cards);
    if (frame === undefined || !cards.ok) return failure('not-giving', 'No wedding gift is open');
    return movePrivate(
      priv,
      before,
      input.seat,
      frame.actor,
      cards.value,
      weddingCount(before, input.seat),
      privateData,
    );
  },
};

export const weddingPhase: PhaseHandler = {
  pending: (state) =>
    withClaim(
      state,
      (data(state)?.remaining ?? []).map((seat) =>
        playerPending(state, seat, ['WEDDING_GIVE'], WEDDING_FRAME),
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
          type: 'WEDDING_GIVE',
          count: weddingCount(state, seat),
          from: ownSeat(state, seat).resources,
        },
      ],
    };
  },
};

const flow: CardFlow = {
  commands: { WEDDING_GIVE: weddingGive },
  phases: { [WEDDING_FRAME]: weddingPhase },
  timeout: (state, request) => {
    if (request.phase !== WEDDING_FRAME || !data(state)?.remaining.includes(request.seat))
      return null;
    const cards = exactChoice(state, request.seat, weddingCount(state, request.seat));
    return cards ? { type: 'WEDDING_GIVE', cards } : null;
  },
};

/**
 * Wedding: each other seat with more public points than the player gives 2 cards of its own
 * choice (resource or commodity), or all it has if that is fewer. The givers answer at once, each
 * with its own `WEDDING_GIVE`.
 */
export const wedding: CardModule = {
  card: {
    id: 'wedding',
    timing: 'main',
    problem: (state, seat, params) =>
      params !== undefined
        ? failure('unknown-field', 'wedding takes no parameters')
        : weddingGivers(state, seat).length > 0
          ? success(undefined)
          : failure('no-richer-seat', 'No other seat has more points than you and a card'),
    options: () => [undefined],
    apply: (state, seat) => ({
      ...changed(
        pushKnights(state, WEDDING_FRAME, { actor: seat, remaining: weddingGivers(state, seat) }),
        { type: 'weddingPlayed', seat },
      ),
    }),
  },
  flow,
};
