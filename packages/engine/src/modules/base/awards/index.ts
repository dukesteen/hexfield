import type { HandlerContext, RouteGraph } from '../../../core/modules/types.js';
import type { GameState } from '../../../core/state/types.js';
import type { Seat } from '../../../core/types/index.js';
import { boardGraph, edgeEndpoints } from '../board/index.js';

/** One edge (a road, or a ship in a seafaring route) in a graph used by the edge-unique trail search. */
export interface TrailEdge {
  id: string;
  vertices: readonly [string, string];
  kind?: string;
}

/** Whether a trail that arrived over `from` may leave `vertex` over `to`. */
export type TransitionAllowed = (vertex: string, from: TrailEdge, to: TrailEdge) => boolean;

/** Edges of the same kind always join; differing kinds join only at the listed vertices. */
export function kindTransitions(transitions: readonly string[] = []): TransitionAllowed {
  const allowed = new Set(transitions);
  return (vertex, from, to) => from.kind === to.kind || allowed.has(vertex);
}

/**
 * Longest trail in any undirected edge graph. A blocked vertex can end a trail but not be passed
 * through. `allowed` may forbid joining two edges at a vertex; without it every join is allowed.
 */
export function longestTrailLength(
  edges: readonly TrailEdge[],
  blockedVertices: ReadonlySet<string>,
  allowed?: TransitionAllowed,
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
  function walk(vertex: string, length: number, arrived: TrailEdge | null): void {
    if (length > best) best = length;
    if (best === edges.length) return;
    if (length > 0 && blockedVertices.has(vertex)) return;
    for (const index of touching.get(vertex) ?? []) {
      if (used.has(index)) continue;
      const edge = edges[index];
      if (!edge) continue;
      if (allowed && arrived && !allowed(vertex, arrived, edge)) continue;
      used.add(index);
      walk(edge.vertices[0] === vertex ? edge.vertices[1] : edge.vertices[0], length + 1, edge);
      used.delete(index);
    }
  }
  for (const vertex of touching.keys()) {
    if (best === edges.length) break;
    walk(vertex, 0, null);
  }
  return best;
}

/** The base route graph: a seat's roads, interrupted by opponent buildings. */
export function baseRouteGraph(state: GameState, seat: Seat): RouteGraph {
  const graph = boardGraph(state);
  const edges = state.board.roads
    .filter((piece) => piece.seat === seat)
    .flatMap((piece) => {
      const vertices = edgeEndpoints(graph, piece.edge);
      return vertices ? [{ id: piece.edge, vertices }] : [];
    });
  const blocked = state.board.buildings
    .filter((piece) => piece.seat !== seat)
    .map((piece) => piece.vertex);
  return { edges, blocked };
}

/** Longest edge-unique trail for one seat, over the module-extended route graph. */
export function longestRoadLength(state: GameState, seat: Seat, ctx?: HandlerContext): number {
  const base = baseRouteGraph(state, seat);
  const route = ctx ? ctx.hooks.routeGraph(state, seat, base) : base;
  return longestTrailLength(
    route.edges,
    new Set(route.blocked),
    route.transitions || route.edges.some((edge) => edge.kind !== undefined)
      ? kindTransitions(route.transitions)
      : undefined,
  );
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
export function recomputeLongestRoadAward(state: GameState, ctx?: HandlerContext): GameState {
  const current = state.awards.longestRoad ?? null;
  const lengths = state.config.seats.map((seat) => longestRoadLength(state, seat, ctx));
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
