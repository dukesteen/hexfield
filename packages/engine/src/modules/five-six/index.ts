import type {
  CommandHandler,
  GameModule,
  HandlerContext,
  PhaseHandler,
  RenderHint,
} from '../../core/modules/index.js';
import type { Input, Pending } from '../../core/pipeline/index.js';
import type { GameState, PhaseFrame, PrivateState } from '../../core/state/index.js';
import { failure, success } from '../../core/types/index.js';
import type { Seat } from '../../core/types/index.js';
import { buildCommands } from '../base/legal.js';
import { finishTurnFlowFrame } from '../base/phases/turn.js';
import { afterInput } from '../base/shared.js';
import { baseOptions } from '../base/types.js';
import { incompatibleModules } from '../compat.js';
import { FIVE_SIX_BOARD } from './board.js';

export const FIVE_SIX_VERSION = '1.0.0';
export const FIVE_SIX_ID = 'five-six';

/** Bank size per resource and the development deck for five and six players. */
export const FIVE_SIX_BANK = 24;
export const FIVE_SIX_DEV_CARDS = Object.freeze({
  knight: 20,
  victoryPoint: 5,
  roadBuilding: 3,
  yearOfPlenty: 3,
  monopoly: 3,
});

/** Commands the special build phase allows: builds and development-card purchases only. */
export const SBP_COMMANDS = Object.freeze([
  'BUILD_ROAD',
  'BUILD_SETTLEMENT',
  'BUILD_CITY',
  'BUY_DEV_CARD',
  'END_SBP',
]);

interface FiveSixOptions {
  specialBuildPhase: boolean;
}

function options(state: GameState): FiveSixOptions {
  const value: unknown = state.config.options[FIVE_SIX_ID];
  const enabled =
    typeof value === 'object' && value !== null ? Reflect.get(value, 'specialBuildPhase') : true;
  return { specialBuildPhase: enabled !== false };
}

function sbpSeat(frame: PhaseFrame | undefined): Seat | null {
  if (frame?.module !== FIVE_SIX_ID || frame.id !== 'sbp') return null;
  const data: unknown = frame.data;
  const seat = typeof data === 'object' && data !== null ? Reflect.get(data, 'seat') : undefined;
  return seat === 0 || seat === 1 || seat === 2 || seat === 3 || seat === 4 || seat === 5
    ? seat
    : null;
}

function sbpPending(state: GameState, seat: Seat): Pending {
  const timer = baseOptions(state.config.options.base).turnTimer;
  return timer
    ? {
        kind: 'player',
        seat,
        allowed: [...SBP_COMMANDS],
        deadline: { phase: 'sbp', seconds: timer.mainSec },
      }
    : { kind: 'player', seat, allowed: [...SBP_COMMANDS] };
}

const sbpPhase: PhaseHandler = {
  pending: (state, frame) => {
    const seat = sbpSeat(frame);
    if (seat === null) throw new Error('Invalid special build phase');
    return [sbpPending(state, seat)];
  },
  legalCommands: (state, frame, seat, priv, ctx) =>
    sbpSeat(frame) === seat
      ? { commands: [{ type: 'END_SBP' }, ...buildCommands(state, seat, priv, ctx)], templates: [] }
      : { commands: [], templates: [] },
};

/** End a seat's special build phase for it when its own hand can build nothing. */
function autoEndSbp(
  state: GameState,
  privates: ReadonlyMap<Seat, PrivateState>,
  ctx: HandlerContext,
): Input | null {
  const seat = sbpSeat(state.turn.phase.at(-1));
  const priv = seat === null ? undefined : privates.get(seat);
  if (seat === null || !priv) return null;
  // The legalCommands hook lets a module add builds, such as ships, to the base list.
  const builds = ctx.hooks.legalCommands(
    state,
    seat,
    priv,
    { commands: buildCommands(state, seat, priv, ctx), templates: [] },
    ctx,
  );
  if (builds.commands.length > 0) return null;
  return { kind: 'command', seat, command: { type: 'END_SBP' } };
}

const endSbp: CommandHandler = {
  keys: { allowed: [] },
  validate: (state, input) =>
    sbpSeat(state.turn.phase.at(-1)) === input.seat
      ? success(undefined)
      : failure('not-special-build', 'No special build phase is active for this seat'),
  apply: (state, _input, ctx) => {
    const finished = finishTurnFlowFrame(state, ctx);
    const next = afterInput(finished.state, ctx);
    const ended = !finished.state.result && next.result;
    return {
      state: next,
      events: [
        ...finished.events,
        ...(ended ? [{ type: 'gameEnded', winner: ended.winner, reason: ended.reason }] : []),
      ],
      effects: finished.effects,
    };
  },
};

/** Five and six players: the larger board, supply and deck, and the special build phase. */
export function fiveSixModule(): GameModule {
  return {
    id: FIVE_SIX_ID,
    version: FIVE_SIX_VERSION,
    dependsOn: ['base'],
    conflictsWith: incompatibleModules(FIVE_SIX_ID),
    optionsSchema: [{ key: 'specialBuildPhase', type: 'boolean', default: true }],
    hooks: {
      seatRange: () => ({ min: 5, max: 6 }),
      boardSpec: () => FIVE_SIX_BOARD,
      bankInit: (_config, acc) =>
        Object.fromEntries(Object.keys(acc).map((kind) => [kind, FIVE_SIX_BANK])),
      devDeck: () => ({ ...FIVE_SIX_DEV_CARDS }),
      turnFlow: (state, acc) => {
        if (!options(state).specialBuildPhase) return acc;
        const seats = state.config.seats;
        const start = seats.indexOf(state.turn.activeSeat);
        const others = seats.map((_, offset) => seats[(start + offset) % seats.length]);
        return [
          ...acc,
          ...others
            .slice(1)
            .flatMap((seat) =>
              seat === undefined ? [] : [{ id: 'sbp', module: FIVE_SIX_ID, data: { seat } }],
            ),
        ];
      },
      timeoutAction: (state, request, acc) =>
        acc ??
        (request.phase === 'sbp' && sbpSeat(state.turn.phase.at(-1)) === request.seat
          ? { type: 'END_SBP' }
          : null),
      renderHints: (state, acc) => {
        const seat = sbpSeat(state.turn.phase.at(-1));
        const hint: RenderHint[] =
          seat === null ? [] : [{ module: FIVE_SIX_ID, kind: 'special-build', seat }];
        return [...acc, ...hint];
      },
    },
    autoInput: autoEndSbp,
    commands: { END_SBP: endSbp },
    systemInputs: {},
    phases: { sbp: sbpPhase },
  };
}
