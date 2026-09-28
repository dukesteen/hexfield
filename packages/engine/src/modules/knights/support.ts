import {
  createResourceBounds,
  kindBounds,
  kindsOfCounts,
  seatBounds,
  zeroCounts,
} from '../../core/resources/index.js';
import type { CommandShape, Engine } from '../../core/pipeline/index.js';
import type { GameState } from '../../core/state/index.js';
import type { CardCounts, Seat } from '../../core/types/index.js';
import { boardGraph } from '../base/board/index.js';
import { frame } from '../base/shared.js';
import { KNIGHTS_ID } from './config.js';
import type { Track } from './config.js';
import { knightsConfig } from './testing.js';
import type { KnightsConfigOptions } from './testing.js';
import { updateKnights } from './types.js';
import type { KnightPiece } from './types.js';

/** Test helpers for hand-built Cities and Knights positions. */
export function newGame(
  engine: Engine,
  options: KnightsConfigOptions = {},
  seed = new Uint8Array(32),
): GameState {
  return engine.createGame(knightsConfig(options), seed);
}

/** Jump to the active seat's main phase on a mid-game turn. */
export function inMain(state: GameState, active: Seat = 0, turn = 5): GameState {
  return { ...state, turn: { number: turn, activeSeat: active, phase: [frame('main')] } };
}

/** Jump to the dice phase of a mid-game turn, with the active seat's roll about to be resolved. */
export function inDice(state: GameState, active: Seat = 0, turn = 5): GameState {
  return { ...state, turn: { number: turn, activeSeat: active, phase: [frame('dice')] } };
}

/** Give a seat an exact hand over every card kind, moving the difference to or from the bank. */
export function withHand(state: GameState, seat: Seat, counts: CardCounts): GameState {
  const kinds = kindsOfCounts(state.bank);
  const hand = { ...zeroCounts(kinds), ...counts };
  const total = kinds.reduce((sum, kind) => sum + (hand[kind] ?? 0), 0);
  const exact = createResourceBounds(total, hand, hand, kinds);
  if (!exact.ok) throw new Error(exact.error.message);
  const found = state.seats.find((item) => item.seat === seat)?.resources;
  const before = found ? kindBounds(found) : undefined;
  const bank = { ...state.bank };
  for (const kind of kinds)
    bank[kind] = (bank[kind] ?? 0) + (before?.min[kind] ?? 0) - (hand[kind] ?? 0);
  return {
    ...state,
    bank,
    seats: state.seats.map((item) =>
      item.seat === seat ? { ...item, resources: seatBounds(exact.value) } : item,
    ),
  };
}

/** The exact hand of a seat over every card kind (bounds must be exact). */
export function handOf(state: GameState, seat: Seat): Record<string, number> {
  const held = state.seats.find((item) => item.seat === seat)?.resources;
  if (!held) throw new Error(`No seat ${seat}`);
  const bounds = kindBounds(held);
  return Object.fromEntries(kindsOfCounts(bounds.min).map((kind) => [kind, bounds.min[kind] ?? 0]));
}

/** Place buildings without paying, keeping the piece supplies consistent. */
export function withBuildings(
  state: GameState,
  pieces: readonly { vertex: string; seat: Seat; kind?: string }[],
): GameState {
  const buildings = [
    ...state.board.buildings,
    ...pieces.map((piece) => ({
      vertex: piece.vertex,
      seat: piece.seat,
      kind: piece.kind ?? 'settlement',
    })),
  ];
  return {
    ...state,
    board: { ...state.board, buildings },
    seats: state.seats.map((item) => {
      const own = pieces.filter((piece) => piece.seat === item.seat);
      const cities = own.filter((piece) => piece.kind === 'city').length;
      return {
        ...item,
        piecesLeft: {
          ...item.piecesLeft,
          settlement: (item.piecesLeft.settlement ?? 0) - (own.length - cities),
          city: (item.piecesLeft.city ?? 0) - cities,
        },
      };
    }),
  };
}

/** Set a seat's improvement levels. */
export function withLevels(
  state: GameState,
  seat: Seat,
  levels: Partial<Record<Track, number>>,
): GameState {
  return updateKnights(state, (old) => ({
    ...old,
    improvements: old.improvements.map((item, index) =>
      index === seat ? { ...item, ...levels } : item,
    ),
  }));
}

/** Keep only the given number tokens on the board, so a roll pays exactly the listed hexes. */
export function withTokens(state: GameState, tokens: Readonly<Record<string, number>>): GameState {
  return {
    ...state,
    board: {
      ...state.board,
      hexes: state.board.hexes.map((hex) => ({ ...hex, token: tokens[hex.id] ?? null })),
    },
  };
}

/** The first hex of a terrain, by id. */
export function hexOf(state: GameState, terrain: string, nth = 0): string {
  const hex = state.board.hexes.filter((item) => item.terrain === terrain)[nth];
  if (!hex) throw new Error(`No ${terrain} hex #${nth}`);
  return hex.id;
}

/** The vertices around a hex, by id. */
export function verticesOfHex(state: GameState, hex: string): string[] {
  const graph = boardGraph(state);
  return [...(graph.hexVertices[graph.hexIndex[hex] ?? -1] ?? [])].toSorted();
}

export function setRobber(state: GameState, hex: string | null): GameState {
  return { ...state, board: { ...state.board, robberHex: hex } };
}

export function unlockRobber(state: GameState): GameState {
  return updateKnights(state, (old) => ({ ...old, robberLocked: false }));
}

/** Resolve a roll of the given faces and event die. */
export function roll(
  engine: Engine,
  state: GameState,
  dice: readonly [number, number],
  event = 'trade',
): GameState {
  const result = engine.apply(state, {
    kind: 'system',
    type: 'DICE_RESULT',
    dice: [...dice],
    extra: { event },
  });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value.state;
}

export function submit(
  engine: Engine,
  state: GameState,
  seat: Seat,
  command: CommandShape,
): GameState {
  const result = engine.apply(state, { kind: 'command', seat, command });
  if (!result.ok) throw new Error(`${command.type}: ${result.error.code}: ${result.error.message}`);
  return result.value.state;
}

/** The rejection code of a command, or null if it is legal. */
export function rejection(
  engine: Engine,
  state: GameState,
  seat: Seat,
  command: CommandShape,
): string | null {
  const result = engine.validate(state, { kind: 'command', seat, command });
  return result.ok ? null : result.error.code;
}

export const top = (state: GameState) => state.turn.phase.at(-1);

/** A simple path of `length` distinct adjacent vertices, starting at `start` or the first vertex. */
export function pathVertices(
  state: GameState,
  length: number,
  start?: string,
  avoid: readonly string[] = [],
): string[] {
  const graph = boardGraph(state);
  const banned = new Set(avoid);
  function extend(path: string[]): string[] | null {
    if (path.length === length) return path;
    const last = path.at(-1);
    const index = last === undefined ? undefined : graph.vertexIndex[last];
    if (index === undefined) return null;
    for (const next of [...(graph.vertexNeighbors[index] ?? [])].toSorted()) {
      if (path.includes(next) || banned.has(next)) continue;
      const found = extend([...path, next]);
      if (found) return found;
    }
    return null;
  }
  const found = extend([start ?? graph.vertexIds[0] ?? '']);
  if (!found) throw new Error('No path of that length');
  return found;
}

/** The edge between two adjacent vertices. */
export function edgeBetween(state: GameState, a: string, b: string): string {
  const graph = boardGraph(state);
  const vertices: readonly (readonly string[])[] = graph.edgeVertices;
  const edge = graph.edgeIds.find((id) => {
    const ends = vertices[graph.edgeIndex[id] ?? -1];
    return ends !== undefined && ends.includes(a) && ends.includes(b);
  });
  if (edge === undefined) throw new Error(`No edge between ${a} and ${b}`);
  return edge;
}

/** Give a seat roads along a path of adjacent vertices, without paying. */
export function withRoads(state: GameState, seat: Seat, path: readonly string[]): GameState {
  const edges = path.slice(1).map((vertex, index) => edgeBetween(state, path[index] ?? '', vertex));
  return {
    ...state,
    board: {
      ...state.board,
      roads: [...state.board.roads, ...edges.map((edge) => ({ edge, seat }))],
    },
    seats: state.seats.map((item) =>
      item.seat === seat
        ? {
            ...item,
            piecesLeft: { ...item.piecesLeft, road: (item.piecesLeft.road ?? 0) - edges.length },
          }
        : item,
    ),
  };
}

/** Put knights on the board; unstated fields are an active, ready basic knight. */
export function withKnights(
  state: GameState,
  pieces: readonly (Pick<KnightPiece, 'seat' | 'vertex'> & Partial<KnightPiece>)[],
): GameState {
  return updateKnights(state, (old) => ({
    ...old,
    knights: [
      ...old.knights,
      ...pieces.map((piece) => ({
        level: 1,
        active: true,
        ready: true,
        promotedTurn: null,
        ...piece,
      })),
    ].toSorted((a, b) => (a.vertex < b.vertex ? -1 : a.vertex > b.vertex ? 1 : 0)),
  }));
}

/**
 * A hex whose six corners each have a neighbor outside the hex: a closed ring `ring[0..5]` (each
 * corner is adjacent to the next) and the outward neighbor `out[i]` of each corner.
 */
export function ringLayout(state: GameState): { hex: string; ring: string[]; out: string[] } {
  const graph = boardGraph(state);
  const around: readonly (readonly string[])[] = graph.vertexNeighbors;
  for (const hex of graph.hexIds) {
    const ring: string[] = [...(graph.hexVertices[graph.hexIndex[hex] ?? -1] ?? [])];
    if (ring.length !== 6) continue;
    const out = ring.map((vertex, index) => {
      const neighbors = around[graph.vertexIndex[vertex] ?? -1] ?? [];
      const before = ring[(index + 5) % 6];
      const after = ring[(index + 1) % 6];
      return neighbors.find((item) => item !== before && item !== after && !ring.includes(item));
    });
    const outward = out.filter((item): item is string => item !== undefined);
    const adjacent = ring.every((vertex, index) =>
      (around[graph.vertexIndex[vertex] ?? -1] ?? []).includes(ring[(index + 1) % 6] ?? ''),
    );
    if (outward.length === 6 && adjacent && new Set([...ring, ...outward]).size === 12)
      return { hex, ring, out: outward };
  }
  throw new Error('No ring hex');
}

/** Set the barbarian ship's step. */
export function withStep(state: GameState, step: number): GameState {
  return updateKnights(state, (old) => ({ ...old, barbarians: { step } }));
}

export { KNIGHTS_ID };
