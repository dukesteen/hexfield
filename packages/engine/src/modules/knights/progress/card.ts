import type { EngineEffect } from '../../../core/effects/index.js';
import type { GameEvent } from '../../../core/events/index.js';
import type {
  CommandHandler,
  HandlerContext,
  PhaseHandler,
  SystemInputHandler,
  TimeoutRequest,
} from '../../../core/modules/index.js';
import type { CommandShape, LegalCommandSet } from '../../../core/pipeline/index.js';
import type { GameState, PrivateState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Result, Seat } from '../../../core/types/index.js';

/** What playing a card changes: the state, the log events and the accounting effects. */
export interface CardResult {
  state: GameState;
  events: GameEvent[];
  effects: EngineEffect[];
}

/** The effect of one progress card. `PLAY_PROGRESS_CARD` handles the slot, the reveal and the queue. */
export interface ProgressCard {
  id: string;
  /** The Alchemist is played before the roll, every other card in the action phase. */
  timing: 'preRoll' | 'main';
  /** Why the seat cannot play the card now with these parameters, judged on public state. */
  problem(state: GameState, seat: Seat, params: unknown, ctx: HandlerContext): Result<void>;
  /**
   * The parameter sets to list as legal commands (`undefined` for a card without parameters). The
   * owner's private state, when known, lets a paying card leave out what the hand cannot pay.
   */
  options(
    state: GameState,
    seat: Seat,
    ctx: HandlerContext,
    priv?: PrivateState,
  ): readonly (Record<string, unknown> | undefined)[];
  /** Resolve a validated play. May push frames for choices other seats (or the player) make. */
  apply(state: GameState, seat: Seat, params: unknown, ctx: HandlerContext): CardResult;
}

/** The inputs, frames and defaults a card with follow-up choices adds to the module. */
export interface CardFlow {
  commands?: Record<string, CommandHandler>;
  systemInputs?: Record<string, SystemInputHandler>;
  phases?: Record<string, PhaseHandler>;
  /** The public default for a `TIMEOUT` on one of this card's frames, or null when none exists. */
  timeout?(state: GameState, request: TimeoutRequest): CommandShape | null;
  /** Legal commands outside a frame (Commercial Harbor's offers), for the active seat's main phase. */
  legal?(
    state: GameState,
    seat: Seat,
    priv: PrivateState | undefined,
    ctx: HandlerContext,
  ): LegalCommandSet;
  /** Command types the active seat may use in its main phase because of this card. */
  mainCommands?(state: GameState, seat: Seat): readonly string[];
}

/** One card's file: its effect, and its flow if it has follow-up choices. */
export interface CardModule {
  card: ProgressCard;
  flow?: CardFlow;
}

/** A card that needs no parameters, judged by a public test. */
export function plainCard(
  spec: Pick<ProgressCard, 'id' | 'timing'> & {
    problem?: (state: GameState, seat: Seat, ctx: HandlerContext) => Result<void>;
    apply: (state: GameState, seat: Seat, ctx: HandlerContext) => CardResult;
  },
): ProgressCard {
  return {
    id: spec.id,
    timing: spec.timing,
    problem: (state, seat, params, ctx) =>
      params === undefined
        ? (spec.problem?.(state, seat, ctx) ?? success(undefined))
        : failure('unknown-field', `${spec.id} takes no parameters`),
    options: () => [undefined],
    apply: (state, seat, _params, ctx) => spec.apply(state, seat, ctx),
  };
}

/** A parameter object with exactly the named fields (or none for a card without parameters). */
export function paramsObject(
  params: unknown,
  keys: readonly string[],
): Result<Record<string, unknown>> {
  if (typeof params !== 'object' || params === null || Array.isArray(params))
    return failure('invalid-params', 'This card needs parameters');
  const extra = Object.keys(params).find((key) => !keys.includes(key));
  if (extra !== undefined) return failure('unknown-field', `Unknown card parameter: ${extra}`);
  const record: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.hasOwn(params, key))
      return failure('invalid-params', `The card needs the parameter ${key}`);
    record[key] = Reflect.get(params, key);
  }
  return success(record);
}

export function seatOf(state: GameState, value: unknown): Seat | undefined {
  return state.config.seats.find((seat) => seat === value);
}

export function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** The result of a card that changed nothing but the state. */
export function changed(state: GameState, ...events: GameEvent[]): CardResult {
  return { state, events, effects: [] };
}
