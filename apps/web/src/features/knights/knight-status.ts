import type { CommandShape, GameState, Seat } from '@cp2p/engine';
import { knightLevel, knightsState } from './state';

/** A knight's readiness, as the rules name it. */
export type KnightReadiness = 'inactive' | 'activatedThisTurn' | 'ready';

/** Why a knight has no move, displacement or chase to offer, when it has none. */
export type KnightIdleReason =
  | 'notYours'
  | 'notYourTurn'
  | 'afterRoll'
  | 'finishStep'
  | 'inactive'
  | 'activatedThisTurn'
  | 'noTarget';

/** What a tap on a knight tells its owner: its state, what it can do now, or why nothing. */
export interface KnightStatus {
  readonly vertex: string;
  readonly seat: Seat;
  readonly level: 1 | 2 | 3;
  readonly readiness: KnightReadiness;
  /** Empty vertices along the owner's roads it may move to now. */
  readonly moves: readonly string[];
  /** Weaker rival knights it may displace now. */
  readonly displaces: readonly string[];
  readonly chase: CommandShape | undefined;
  readonly activate: CommandShape | undefined;
  readonly promote: CommandShape | undefined;
  /** Set when it can neither move, displace nor chase. */
  readonly idle: KnightIdleReason | null;
}

const vertexOf = (command: CommandShape, key: string): string | null => {
  const value = command[key];
  return typeof value === 'string' ? value : null;
};

/**
 * The status of the knight at a vertex for the viewing seat, from the public state and the legal
 * commands the engine offers that seat now. Nothing is decided here: every action shown is one of
 * those commands, and the reason only explains their absence.
 */
export function knightStatus(
  state: Readonly<GameState>,
  viewer: Seat | null,
  vertex: string,
  commands: readonly CommandShape[],
): KnightStatus | null {
  const knight = knightsState(state)?.knights.find((piece) => piece.vertex === vertex);
  if (!knight) return null;
  const mine = viewer !== null && knight.seat === viewer;
  const own = mine ? commands : [];
  const from = (type: string) =>
    own.filter((command) => command.type === type && vertexOf(command, 'from') === vertex);
  const at = (type: string) =>
    own.find((command) => command.type === type && vertexOf(command, 'vertex') === vertex);
  const moves = from('MOVE_KNIGHT')
    .map((command) => vertexOf(command, 'to'))
    .filter((to): to is string => to !== null);
  const displaces = from('DISPLACE_KNIGHT')
    .map((command) => vertexOf(command, 'to'))
    .filter((to): to is string => to !== null);
  const chase = at('CHASE_ROBBER');
  const readiness: KnightReadiness = !knight.active
    ? 'inactive'
    : knight.ready
      ? 'ready'
      : 'activatedThisTurn';
  const top = state.turn.phase.at(-1);
  const step = top?.module === 'base' ? top.id : null;
  let idle: KnightIdleReason | null = null;
  if (moves.length === 0 && displaces.length === 0 && chase === undefined)
    idle = !mine
      ? 'notYours'
      : state.turn.activeSeat !== viewer
        ? 'notYourTurn'
        : step === 'preRoll'
          ? 'afterRoll'
          : step !== 'main'
            ? 'finishStep'
            : readiness === 'ready'
              ? 'noTarget'
              : readiness;
  return {
    vertex,
    seat: knight.seat,
    level: knightLevel(knight.level),
    readiness,
    moves,
    displaces,
    chase,
    activate: at('ACTIVATE_KNIGHT'),
    promote: at('PROMOTE_KNIGHT'),
    idle,
  };
}
