import type { LegalCommandSet, Pending } from '../../core/pipeline/index.js';
import type { GameState, PhaseFrame, PrivateState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { TRACKS } from './config.js';
import { improvementLegal, improvementProblem, privateCanImprove } from './improvements.js';

/** Where the knights build commands are allowed: the main phase, or a special build phase. */
type Slot = 'main' | 'sbp';

function sbpSeat(state: GameState, frame: PhaseFrame): Seat | null {
  const seat: unknown =
    typeof frame.data === 'object' && frame.data !== null
      ? Reflect.get(frame.data, 'seat')
      : undefined;
  return state.config.seats.find((item) => item === seat) ?? null;
}

function slotOf(state: GameState): { slot: Slot; seat: Seat } | null {
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

/** The `pending` hook: let the building seat improve its cities in the main and special build phases. */
export function addKnightsPending(state: GameState, acc: readonly Pending[]): readonly Pending[] {
  const where = slotOf(state);
  if (where === null) return acc;
  return acc.map((item) =>
    item.kind === 'player' &&
    item.seat === where.seat &&
    (where.slot === 'sbp' || item.allowed.includes('END_TURN'))
      ? { ...item, allowed: [...item.allowed, 'BUILD_IMPROVEMENT'] }
      : item,
  );
}

/** The `legalCommands` hook: the improvements the seat can buy now. */
export function addKnightsCommands(
  state: GameState,
  seat: Seat,
  priv: PrivateState | undefined,
  acc: LegalCommandSet,
): LegalCommandSet {
  const where = slotOf(state);
  if (where === null || where.seat !== seat) return acc;
  const commands = TRACKS.filter((track) =>
    priv
      ? improvementProblem(state, seat, track).ok && privateCanImprove(state, seat, track, priv)
      : improvementLegal(state, seat, track).ok,
  ).map((track) => ({ type: 'BUILD_IMPROVEMENT', track }));
  return commands.length
    ? { commands: [...acc.commands, ...commands], templates: acc.templates }
    : acc;
}
