import type { CommandShape, Engine } from '../../core/pipeline/index.js';
import type { GameState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { boardGraph, hexesForVertex } from '../base/board/index.js';
import { frame } from '../base/shared.js';
import { unlockRobber } from '../knights/support.js';
import { updateSeafaring } from '../seafaring/types.js';
import { seafarersKnightsConfig, seafarersKnightsEngine } from './testing.js';
import type { SeafarersKnightsConfigOptions } from './testing.js';
import { updateCombo } from './types.js';

export {
  edgeBetween,
  handOf,
  roll,
  setRobber,
  withHand,
  withKnights,
  withLevels,
  withStep,
} from '../knights/support.js';
export { edgesAt, otherEnd, withBuildings, withRoads, withShips } from '../seafaring/support.js';

/**
 * Test positions for seafaring with knights on `testArchipelago`. Seat 0's settlement `HOME` is on
 * the main island's east coast. Its ships run `HOME -S1- COAST -S2- FAR -S3- SEA`: `COAST` and
 * `FAR` are coast vertices of the fields island `h:4,-2`, `SEA` touches only sea hexes and is a
 * corner of the pirate's start hex `h:3,0`.
 */
export const HOME = 'v:3,-2,S';
export const COAST = 'v:3,-1,N';
export const FAR = 'v:4,-2,S';
export const SEA = 'v:3,0,N';
export const S1 = 'e:3,-1,NW';
export const S2 = 'e:3,-1,NE';
export const S3 = 'e:4,-1,W';
/** A road from `HOME` along the main island's coast to `SHORE`. */
export const R1 = 'e:3,-1,W';
export const SHORE = 'v:2,0,N';
/** The fields island next to `COAST` and `FAR`, and the sea hexes around them. */
export const FIELDS = 'h:4,-2';
export const GOLD = 'h:4,-3';
export const PIRATE_START = 'h:3,0';

export const engine: Engine = seafarersKnightsEngine();

export function newGame(
  options: SeafarersKnightsConfigOptions = {},
  e: Engine = engine,
  seed = new Uint8Array(32),
): GameState {
  return e.createGame(seafarersKnightsConfig(options), seed);
}

/** Jump to the active seat's main phase on a mid-game turn. */
export function inMain(state: GameState, active: Seat = 0, turn = 5): GameState {
  return { ...state, turn: { number: turn, activeSeat: active, phase: [frame('main')] } };
}

/** Jump to the dice phase of a mid-game turn. */
export function inDice(state: GameState, active: Seat = 0, turn = 5): GameState {
  return { ...state, turn: { number: turn, activeSeat: active, phase: [frame('dice')] } };
}

/** The pirate has entered play (as after the first attack) on the given hex; the robber is free. */
export function afterFirstAttack(
  state: GameState,
  pirate: string | null = PIRATE_START,
): GameState {
  const entered = updateCombo(state, (old) => ({ ...old, pirateEntered: true }));
  return unlockRobber(updateSeafaring(entered, (old) => ({ ...old, pirateHex: pirate })));
}

export function submit(state: GameState, seat: Seat, command: CommandShape, e = engine): GameState {
  const result = e.apply(state, { kind: 'command', seat, command });
  if (!result.ok) throw new Error(`${command.type}: ${result.error.code}: ${result.error.message}`);
  return result.value.state;
}

/** The rejection code of a command, or null when it is legal. */
export function rejection(
  state: GameState,
  seat: Seat,
  command: CommandShape,
  e = engine,
): string | null {
  const result = e.validate(state, { kind: 'command', seat, command });
  return result.ok ? null : result.error.code;
}

/** The legal commands of one type for a seat. */
export function legal(state: GameState, seat: Seat, type: string, e = engine): CommandShape[] {
  return e.getLegalCommands(state, seat).commands.filter((command) => command.type === type);
}

/** Whether every hex around the vertex is sea. */
export function isSeaVertex(state: GameState, vertex: string): boolean {
  const terrain = new Map(state.board.hexes.map((hex) => [hex.id, hex.terrain]));
  return hexesForVertex(state, vertex).every((hex) => terrain.get(hex) === 'sea');
}

/** The vertices of a hex, by id. */
export function cornersOf(state: GameState, hex: string): string[] {
  const graph = boardGraph(state);
  return [...(graph.hexVertices[graph.hexIndex[hex] ?? -1] ?? [])].toSorted();
}

export const top = (state: GameState) => state.turn.phase.at(-1);
