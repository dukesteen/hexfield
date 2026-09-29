import type { GameState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Result, Seat } from '../../../core/types/index.js';
import { ownSeat } from '../../base/shared.js';
import { paramsObject, seatOf } from './card.js';
import type { CardFlow, CardModule } from './card.js';
import { pushKnights } from './frames.js';
import { LOOK_FRAME, lookPhase, showHand, takeCards } from './look.js';

function targetOf(state: GameState, params: unknown): Result<Seat> {
  const object = paramsObject(params, ['target']);
  if (!object.ok) return object;
  const seat = seatOf(state, object.value.target);
  return seat === undefined ? failure('invalid-seat', 'Choose another seat') : success(seat);
}

/** Seats with more public points than the player and a hand to look at, in seat order. */
export function richerHands(state: GameState, actor: Seat): Seat[] {
  const points = ownSeat(state, actor).publicVp;
  return state.config.seats.filter(
    (seat) =>
      seat !== actor &&
      ownSeat(state, seat).publicVp > points &&
      ownSeat(state, seat).resources.total > 0,
  );
}

export const lookFlow: CardFlow = {
  phases: { [LOOK_FRAME]: lookPhase },
  systemInputs: { SHOW_HAND: showHand, TAKE_CARDS: takeCards },
};

/**
 * Master Merchant (Guild Dues): choose a seat with more points than you. It shows you its resource
 * and commodity cards (to you alone) and you take any 2 of them, or all it has if that is fewer.
 * The hand contents are private, so the card may be played without knowing what it will find.
 */
export const masterMerchant: CardModule = {
  card: {
    id: 'masterMerchant',
    timing: 'main',
    problem: (state, seat, params) => {
      const target = targetOf(state, params);
      if (!target.ok) return target;
      return richerHands(state, seat).includes(target.value)
        ? success(undefined)
        : failure('no-target', 'Choose a seat with more points than you and a card in hand');
    },
    options: (state, seat) => richerHands(state, seat).map((target) => ({ target })),
    apply: (state, seat, params) => {
      const target = targetOf(state, params);
      if (!target.ok) throw new Error('Validated Master Merchant target missing');
      const count = Math.min(2, ownSeat(state, target.value).resources.total);
      return {
        state: pushKnights(state, LOOK_FRAME, {
          what: 'cards',
          actor: seat,
          target: target.value,
          stage: 'show',
          count,
        }),
        events: [{ type: 'masterMerchantPlayed', seat, target: target.value }],
        effects: [],
      };
    },
  },
  flow: lookFlow,
};
