import type { GameState } from '../../../core/state/types.js';
import type { Seat } from '../../../core/types/index.js';
import { boardGraph, edgeEndpoints } from '../board/index.js';

/** One road in a graph used by the edge-unique trail search. */
export interface TrailEdge {
  id: string;
  vertices: readonly [string, string];
}

/** Longest trail in any undirected road graph. A blocked vertex can end a trail. */
export function longestTrailLength(
  edges: readonly TrailEdge[],
  blockedVertices: ReadonlySet<string>,
): number {
  const touching = new Map<string, number[]>();
  for (let index = 0; index < edges.length; index++) {
    const edge = edges[index];
    if (!edge) continue;
    for (const vertex of edge.vertices) {
      const indices = touching.get(vertex) ?? [];
      indices.push(index);
      touching.set(vertex, indices);
    }
  }
  let best = 0;
  const used = new Set<number>();
  function walk(vertex: string, length: number): void {
    if (length > best) best = length;
    if (best === edges.length) return;
    if (length > 0 && blockedVertices.has(vertex)) return;
    for (const index of touching.get(vertex) ?? []) {
      if (used.has(index)) continue;
      const edge = edges[index];
      if (!edge) continue;
      used.add(index);
      walk(edge.vertices[0] === vertex ? edge.vertices[1] : edge.vertices[0], length + 1);
      used.delete(index);
    }
  }
  for (const vertex of touching.keys()) {
    if (best === edges.length) break;
    walk(vertex, 0);
  }
  return best;
}

/** Longest edge-unique trail for one seat on the board. */
export function longestRoadLength(state: GameState, seat: Seat): number {
  const graph = boardGraph(state);
  const edges = state.board.roads
    .filter((piece) => piece.seat === seat)
    .flatMap((piece) => {
      const vertices = edgeEndpoints(graph, piece.edge);
      return vertices ? [{ id: piece.edge, vertices }] : [];
    });
  const blocked = new Set(
    state.board.buildings.filter((piece) => piece.seat !== seat).map((piece) => piece.vertex),
  );
  return longestTrailLength(edges, blocked);
}

function awardHolder(
  seats: readonly Seat[],
  lengths: readonly number[],
  current: Seat | null,
  threshold: number,
): Seat | null {
  const max = Math.max(...lengths);
  if (max < threshold) return null;
  if (current !== null && lengths[current] === max) return current;
  const leaders = seats.filter((seat) => lengths[seat] === max);
  return leaders.length === 1 ? (leaders[0] ?? null) : null;
}

/** Recalculate the road award, retaining a tied holder and clearing ambiguous ties. */
export function recomputeLongestRoadAward(state: GameState): GameState {
  const current = state.awards.longestRoad ?? null;
  const lengths = state.config.seats.map((seat) => longestRoadLength(state, seat));
  const next = awardHolder(state.config.seats, lengths, current, 5);
  return next === current ? state : { ...state, awards: { ...state.awards, longestRoad: next } };
}

/** Recalculate largest army from base extension knight counts. */
export function recomputeLargestArmyAward(state: GameState): GameState {
  const base: unknown = state.ext.base;
  const knightsPlayed: readonly unknown[] =
    typeof base === 'object' &&
    base !== null &&
    'knightsPlayed' in base &&
    Array.isArray(base.knightsPlayed)
      ? base.knightsPlayed
      : [];
  const lengths = state.config.seats.map((seat) => {
    const count = knightsPlayed[seat];
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : 0;
  });
  const current = state.awards.largestArmy ?? null;
  const next = awardHolder(state.config.seats, lengths, current, 3);
  return next === current ? state : { ...state, awards: { ...state.awards, largestArmy: next } };
}
