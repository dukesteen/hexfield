import type { GameState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Result, Seat } from '../../../core/types/index.js';
import { paramsObject, seatOf } from './card.js';
import type { CardFlow, CardModule } from './card.js';
import { pushKnights } from './frames.js';
import { handCount } from './hand.js';
import { LOOK_FRAME, lookPhase, showHand, takeProgress } from './look.js';

function targetOf(state: GameState, params: unknown): Result<Seat> {
  const object = paramsObject(params, ['target']);
  if (!object.ok) return object;
  const seat = seatOf(state, object.value.target);
  return seat === undefined ? failure('invalid-seat', 'Choose another seat') : success(seat);
}

/** Other seats that hold a progress card. Progress card counts are public, like a hand's size. */
export function withProgressCards(state: GameState, actor: Seat): Seat[] {
  return state.config.seats.filter((seat) => seat !== actor && handCount(state, seat) > 0);
}

const flow: CardFlow = {
  phases: { [LOOK_FRAME]: lookPhase },
  systemInputs: { SHOW_HAND: showHand, TAKE_PROGRESS: takeProgress },
};

/**
 * Spy (Espionage): choose another seat that holds progress cards. It shows them to you alone and
 * you may take one (even another Spy, to play at once or keep). Victory cards are never in a hand.
 * The target then holds one fewer.
 */
export const spy: CardModule = {
  card: {
    id: 'spy',
    timing: 'main',
    problem: (state, seat, params) => {
      const target = targetOf(state, params);
      if (!target.ok) return target;
      return withProgressCards(state, seat).includes(target.value)
        ? success(undefined)
        : failure('no-target', 'Choose another seat that holds progress cards');
    },
    options: (state, seat) => withProgressCards(state, seat).map((target) => ({ target })),
    apply: (state, seat, params) => {
      const target = targetOf(state, params);
      if (!target.ok) throw new Error('Validated Spy target missing');
      return {
        state: pushKnights(state, LOOK_FRAME, {
          what: 'progress',
          actor: seat,
          target: target.value,
          stage: 'show',
          count: 1,
        }),
        events: [{ type: 'spyPlayed', seat, target: target.value }],
        effects: [],
      };
    },
  },
  flow,
};
