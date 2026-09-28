import type { GameState, PhaseFrame } from '../../core/state/index.js';
import { failure, success } from '../../core/types/index.js';
import type { Result, Seat } from '../../core/types/index.js';

/** Where the knights build commands are allowed: the main phase, or a special build phase. */
export type Slot = 'main' | 'sbp';

function sbpSeat(state: GameState, frame: PhaseFrame): Seat | null {
  const seat: unknown =
    typeof frame.data === 'object' && frame.data !== null
      ? Reflect.get(frame.data, 'seat')
      : undefined;
  return state.config.seats.find((item) => item === seat) ?? null;
}

/** The building slot on top of the stack: the active seat's main phase, or a seat's special build. */
export function slotOf(state: GameState): { slot: Slot; seat: Seat } | null {
  const top = state.turn.phase.at(-1);
  if (!top) return null;
  if (top.module === 'five-six' && top.id === 'sbp') {
    const seat = sbpSeat(state, top);
    return seat === null ? null : { slot: 'sbp', seat };
  }
  return top.module === 'base' && top.id === 'main'
    ? { slot: 'main', seat: state.turn.activeSeat }
    : null;
}

/** Building, activating and promoting: the main phase of the seat, or its special build phase. */
export function buildSlot(state: GameState, seat: Seat): Result<Slot> {
  const where = slotOf(state);
  return where !== null && where.seat === seat
    ? success(where.slot)
    : failure('not-building', 'This is not the seat’s building phase');
}

/** Knight actions belong to the active seat's main phase, never to a special build phase. */
export function actionSlot(state: GameState, seat: Seat): Result<void> {
  const where = slotOf(state);
  if (where?.slot === 'sbp')
    return failure('no-knight-action-in-sbp', 'Knights cannot act in a special build phase');
  return where !== null && where.seat === seat
    ? success(undefined)
    : failure('not-acting', 'Knights act in the active seat’s main phase');
}
