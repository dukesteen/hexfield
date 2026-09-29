import type { RouteGraph } from '../../core/modules/index.js';
import type { GameState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { boardGraph, edgeEndpoints, vertexOnLand } from '../base/board/index.js';
import { KNIGHTS_PER_LEVEL } from './config.js';
import { knightsExt, updateKnights } from './types.js';
import type { KnightPiece } from './types.js';

function byVertex(a: KnightPiece, b: KnightPiece): number {
  return a.vertex < b.vertex ? -1 : a.vertex > b.vertex ? 1 : 0;
}

/** Replace the knights on the board, keeping them ordered by vertex id. */
export function setKnights(
  state: GameState,
  change: (knights: readonly KnightPiece[]) => KnightPiece[],
): GameState {
  return updateKnights(state, (old) => ({
    ...old,
    knights: change(old.knights).toSorted(byVertex),
  }));
}

export function knightAt(state: GameState, vertex: string): KnightPiece | undefined {
  return knightsExt(state).knights.find((knight) => knight.vertex === vertex);
}

export function knightsOf(state: GameState, seat: Seat): KnightPiece[] {
  return knightsExt(state).knights.filter((knight) => knight.seat === seat);
}

/** Pieces of one level the seat still holds (two of each level per seat). */
export function supplyOf(state: GameState, seat: Seat, level: number): number {
  return (
    KNIGHTS_PER_LEVEL - knightsOf(state, seat).filter((knight) => knight.level === level).length
  );
}

/** A vertex is empty when it holds no building and no knight. */
export function vertexEmpty(state: GameState, vertex: string): boolean {
  return (
    !state.board.buildings.some((piece) => piece.vertex === vertex) &&
    knightAt(state, vertex) === undefined
  );
}

/** Whether one of the seat's roads ends at the vertex. */
export function roadEndsAt(state: GameState, seat: Seat, vertex: string): boolean {
  const graph = boardGraph(state);
  const index = graph.vertexIndex[vertex];
  if (index === undefined) return false;
  const own = new Set(
    state.board.roads.filter((road) => road.seat === seat).map((road) => road.edge),
  );
  return (graph.vertexEdges[index] ?? []).some((edge) => own.has(edge));
}

/** An empty land vertex where one of the seat's roads ends: where a knight can be recruited. */
export function recruitSites(state: GameState, seat: Seat): string[] {
  const graph = boardGraph(state);
  const ends = new Set<string>();
  for (const road of state.board.roads) {
    if (road.seat !== seat) continue;
    for (const vertex of edgeEndpoints(graph, road.edge) ?? []) ends.add(vertex);
  }
  return [...ends]
    .filter((vertex) => vertexOnLand(state, vertex) && vertexEmpty(state, vertex))
    .toSorted();
}

/** Where a knight of the seat can go from a vertex along the seat's own roads. */
export interface KnightReach {
  /** Empty vertices, by id. */
  empty: string[];
  /** Vertices of other seats' knights it may stop on (a displacement), by id. */
  foes: string[];
}

/**
 * A knight walks along its owner's roads. It may pass vertices holding the owner's buildings and
 * knights, may not enter a vertex with another seat's building, and stops at another seat's knight
 * (which it may only displace). The start is never a destination.
 */
export function knightReach(state: GameState, seat: Seat, from: string): KnightReach {
  const graph = boardGraph(state);
  const next = new Map<string, string[]>();
  for (const road of state.board.roads) {
    if (road.seat !== seat) continue;
    const ends = edgeEndpoints(graph, road.edge);
    if (!ends) continue;
    for (const [a, b] of [
      [ends[0], ends[1]],
      [ends[1], ends[0]],
    ] as const)
      next.set(a, [...(next.get(a) ?? []), b]);
  }
  const buildings = new Map(state.board.buildings.map((piece) => [piece.vertex, piece.seat]));
  const knights = new Map(knightsExt(state).knights.map((knight) => [knight.vertex, knight.seat]));
  const seen = new Set([from]);
  const queue = [from];
  const empty: string[] = [];
  const foes: string[] = [];
  for (let head = 0; head < queue.length; head++) {
    const vertex = queue[head];
    if (vertex === undefined) break;
    for (const other of next.get(vertex) ?? []) {
      if (seen.has(other)) continue;
      const building = buildings.get(other);
      if (building !== undefined && building !== seat) continue;
      seen.add(other);
      const knight = knights.get(other);
      if (knight !== undefined && knight !== seat) {
        foes.push(other);
        continue;
      }
      if (building === undefined && knight === undefined) empty.push(other);
      queue.push(other);
    }
  }
  return { empty: empty.toSorted(), foes: foes.toSorted() };
}

/** The `routeGraph` hook: every knight interrupts other seats' routes like a building. */
export function knightRoutes(state: GameState, seat: Seat, acc: RouteGraph): RouteGraph {
  const foes = knightsExt(state)
    .knights.filter((knight) => knight.seat !== seat)
    .map((knight) => knight.vertex);
  return foes.length ? { ...acc, blocked: [...acc.blocked, ...foes] } : acc;
}

/** The `placement.settlement` hook: a knight blocks the site for everyone, its owner included. */
export function settlementNotOnKnight(
  state: GameState,
  _seat: Seat,
  vertex: string,
  verdict: boolean,
): boolean {
  return verdict && knightAt(state, vertex) === undefined;
}

/**
 * The `placement.road` hook: another seat's knight is not a place to connect a road through,
 * exactly like another seat's building. A road may still end at the knight's vertex.
 */
export function roadNotThroughKnight(
  state: GameState,
  seat: Seat,
  edge: string,
  verdict: boolean,
): boolean {
  if (!verdict) return false;
  const foes = knightsExt(state).knights.filter((knight) => knight.seat !== seat);
  if (foes.length === 0) return true;
  const graph = boardGraph(state);
  const ends = edgeEndpoints(graph, edge);
  if (!ends) return false;
  return ends.some((vertex) => {
    const building = state.board.buildings.find((piece) => piece.vertex === vertex);
    if (building) return building.seat === seat;
    // Connected through an own road; an opposing knight on the vertex cuts that link.
    return !foes.some((knight) => knight.vertex === vertex) && roadEndsAt(state, seat, vertex);
  });
}

/** The `onTurnStart` hook: the seat's active knights are ready, and nobody else's are. */
export function readyForTurn(state: GameState, seat: Seat): GameState {
  const knights = knightsExt(state).knights;
  return knights.some((knight) => knight.ready !== (knight.seat === seat && knight.active))
    ? setKnights(state, (list) =>
        list.map((knight) => ({ ...knight, ready: knight.seat === seat && knight.active })),
      )
    : state;
}
