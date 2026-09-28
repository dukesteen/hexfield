import { buildBoardGraph, edgeId, hexId, vertexId } from '../../core/geometry/index.js';
import type { BoardGraph } from '../../core/geometry/index.js';
import type { CommandShape } from '../../core/pipeline/index.js';
import type { Engine } from '../../core/pipeline/index.js';
import { exactResourceBounds } from '../../core/resources/index.js';
import type { GameState } from '../../core/state/index.js';
import { RESOURCES } from '../../core/types/index.js';
import type { ResourceCounts, Seat } from '../../core/types/index.js';
import { frame } from '../base/shared.js';
import { seafaringConfig } from './testing.js';
import type { SeafaringConfigOptions } from './testing.js';

export { edgeId, hexId, vertexId };

/** Test helpers for hand-built seafaring positions. */
export const ZERO: ResourceCounts = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };

export function newGame(
  engine: Engine,
  options: SeafaringConfigOptions = {},
  seed = new Uint8Array(32),
): GameState {
  return engine.createGame(seafaringConfig(options), seed);
}

/** Jump to the active seat's main phase on a mid-game turn. */
export function inMain(state: GameState, active: Seat = 0, turn = 5): GameState {
  return { ...state, turn: { number: turn, activeSeat: active, phase: [frame('main')] } };
}

export function inPhase(
  state: GameState,
  id: string,
  data: unknown = null,
  module = 'base',
): GameState {
  return { ...state, turn: { ...state.turn, phase: [{ id, module, data }] } };
}

/** Give a seat an exact hand, moving the difference to or from the bank. */
export function withHand(state: GameState, seat: Seat, counts: Partial<ResourceCounts>): GameState {
  const exact = exactResourceBounds({ ...ZERO, ...counts });
  if (!exact.ok) throw new Error(exact.error.message);
  const before = state.seats.find((item) => item.seat === seat)?.resources;
  const bank = { ...state.bank };
  for (const kind of RESOURCES)
    bank[kind] = (bank[kind] ?? 0) + (before?.min[kind] ?? 0) - exact.value.min[kind];
  return {
    ...state,
    bank,
    seats: state.seats.map((item) =>
      item.seat === seat ? { ...item, resources: exact.value } : item,
    ),
  };
}

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

export function withShips(state: GameState, seat: Seat, edges: readonly string[]): GameState {
  return {
    ...state,
    board: {
      ...state.board,
      ships: [...(state.board.ships ?? []), ...edges.map((edge) => ({ edge, seat }))],
    },
    seats: state.seats.map((item) =>
      item.seat === seat
        ? {
            ...item,
            piecesLeft: { ...item.piecesLeft, ship: (item.piecesLeft.ship ?? 0) - edges.length },
          }
        : item,
    ),
  };
}

export function withRoads(state: GameState, seat: Seat, edges: readonly string[]): GameState {
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

export function graphOf(state: GameState): BoardGraph {
  return buildBoardGraph(state.board.hexes);
}

/**
 * A simple path of ship-legal sea edges starting at `start`, avoiding `avoid` edges and vertices.
 * Edges must have a sea side and not touch the hexes listed in `keepClear`.
 */
export function seaPath(
  state: GameState,
  start: string,
  length: number,
  options: { avoid?: ReadonlySet<string>; keepClear?: readonly string[] } = {},
): string[] {
  const graph = graphOf(state);
  const clear = new Set(
    (options.keepClear ?? []).flatMap((hex) => graph.hexEdges[graph.hexIndex[hex] ?? -1] ?? []),
  );
  const seaSided = (edge: string): boolean => {
    const owners = graph.edgeHexes[graph.edgeIndex[edge] ?? -1] ?? [];
    const terrain = new Map(state.board.hexes.map((hex) => [hex.id, hex.terrain]));
    return owners.length === 1 || owners.some((owner) => terrain.get(owner) === 'sea');
  };
  function walk(vertex: string, edges: string[], seen: Set<string>): string[] | null {
    if (edges.length === length) return edges;
    for (const edge of graph.vertexEdges[graph.vertexIndex[vertex] ?? -1] ?? []) {
      if (edges.includes(edge) || clear.has(edge) || options.avoid?.has(edge) || !seaSided(edge))
        continue;
      const [a, b] = graph.edgeVertices[graph.edgeIndex[edge] ?? -1] ?? ['', ''];
      const next = a === vertex ? b : a;
      if (seen.has(next)) continue;
      const found = walk(next, [...edges, edge], new Set([...seen, next]));
      if (found) return found;
    }
    return null;
  }
  const found = walk(start, [], new Set([start]));
  if (!found) throw new Error(`No sea path of ${length} from ${start}`);
  return found;
}

/** The far vertex of an edge from a given vertex. */
export function otherEnd(state: GameState, edge: string, from: string): string {
  const graph = graphOf(state);
  const [a, b] = graph.edgeVertices[graph.edgeIndex[edge] ?? -1] ?? ['', ''];
  return a === from ? b : a;
}

/** Vertices along a path that starts at `start`. */
export function pathVertices(state: GameState, start: string, edges: readonly string[]): string[] {
  const vertices = [start];
  for (const edge of edges) vertices.push(otherEnd(state, edge, vertices.at(-1) ?? start));
  return vertices;
}

/** Edge ids around a vertex. */
export function edgesAt(state: GameState, vertex: string): string[] {
  const graph = graphOf(state);
  return [...(graph.vertexEdges[graph.vertexIndex[vertex] ?? -1] ?? [])];
}

/** Edge ids of a hex. */
export function edgesOfHex(state: GameState, hex: string): string[] {
  const graph = graphOf(state);
  return [...(graph.hexEdges[graph.hexIndex[hex] ?? -1] ?? [])];
}

/** A shortest ship-legal path of edges from `start` to any of `goals`, by breadth-first search. */
export function shortestSeaPath(
  state: GameState,
  start: string,
  goals: ReadonlySet<string>,
  keepClear: readonly string[] = [],
): string[] {
  const graph = graphOf(state);
  const terrain = new Map(state.board.hexes.map((hex) => [hex.id, hex.terrain]));
  const clear = new Set(keepClear.flatMap((hex) => edgesOfHex(state, hex)));
  const previous = new Map<string, { vertex: string; edge: string }>();
  const queue = [start];
  const seen = new Set([start]);
  for (let head = 0; head < queue.length; head++) {
    const vertex = queue[head] ?? '';
    if (goals.has(vertex) && vertex !== start) {
      const edges: string[] = [];
      let at = vertex;
      while (at !== start) {
        const step = previous.get(at);
        if (!step) break;
        edges.unshift(step.edge);
        at = step.vertex;
      }
      return edges;
    }
    for (const edge of edgesAt(state, vertex)) {
      const owners = graph.edgeHexes[graph.edgeIndex[edge] ?? -1] ?? [];
      const sea = owners.length === 1 || owners.some((owner) => terrain.get(owner) === 'sea');
      const next = otherEnd(state, edge, vertex);
      if (!sea || clear.has(edge) || seen.has(next)) continue;
      seen.add(next);
      previous.set(next, { vertex, edge });
      queue.push(next);
    }
  }
  throw new Error('No sea path to the goal');
}

/** Vertices around the hexes that are land vertices of the given hex ids. */
export function verticesOfHexes(state: GameState, hexes: readonly string[]): Set<string> {
  const graph = graphOf(state);
  return new Set(hexes.flatMap((hex) => graph.hexVertices[graph.hexIndex[hex] ?? -1] ?? []));
}
