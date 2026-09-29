import type { HandlerContext } from '../../../core/modules/index.js';
import type { GameState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Result, Seat } from '../../../core/types/index.js';
import { recomputeLongestRoadAward } from '../../base/awards/index.js';
import { boardGraph, edgeEndpoints } from '../../base/board/index.js';
import { legalRoadEdges } from '../../base/placement/index.js';
import { updateSeat } from '../../base/shared.js';
import { knightsExt } from '../types.js';
import type { CardModule } from './card.js';

interface DiplomatParams {
  edge: string;
  /** The free road built in its place (only when the removed road was the player's own). */
  build: string | null;
}

function paramsOf(params: unknown): Result<DiplomatParams> {
  if (typeof params !== 'object' || params === null || Array.isArray(params))
    return failure('invalid-params', 'The Diplomat needs an edge');
  const extra = Object.keys(params).find((key) => key !== 'edge' && key !== 'build');
  if (extra !== undefined) return failure('unknown-field', `Unknown card parameter: ${extra}`);
  const edge: unknown = Reflect.get(params, 'edge');
  const build: unknown = Reflect.get(params, 'build');
  if (typeof edge !== 'string') return failure('invalid-edge', 'Choose the road to remove');
  if (build !== undefined && build !== null && typeof build !== 'string')
    return failure('invalid-edge', 'The new road must name an edge');
  return success({ edge, build: build ?? null });
}

/** Vertices with a building or a knight, of any seat. */
function occupied(state: GameState): Set<string> {
  return new Set([
    ...state.board.buildings.map((piece) => piece.vertex),
    ...knightsExt(state).knights.map((knight) => knight.vertex),
  ]);
}

/**
 * A road is open when an end is free: no building or knight stands there and no other road of its
 * owner continues from it. A road on a route that joins two of its owner's buildings or knights has
 * no free end.
 */
export function isOpenRoad(state: GameState, edge: string): boolean {
  const road = state.board.roads.find((item) => item.edge === edge);
  const graph = boardGraph(state);
  const ends = edgeEndpoints(graph, edge);
  if (!road || !ends) return false;
  const anchors = occupied(state);
  const own = state.board.roads.filter((item) => item.seat === road.seat && item.edge !== edge);
  return ends.some((vertex) => {
    if (anchors.has(vertex)) return false;
    return !own.some((item) => edgeEndpoints(graph, item.edge)?.includes(vertex));
  });
}

/**
 * Whether every knight of the seat still reaches one of the seat's settlements or cities along the
 * seat's own roads. A route may not pass another seat's building or knight.
 */
export function knightsConnected(state: GameState, seat: Seat): boolean {
  const graph = boardGraph(state);
  const roads = state.board.roads.filter((road) => road.seat === seat);
  const own = new Set(
    state.board.buildings.filter((piece) => piece.seat === seat).map((piece) => piece.vertex),
  );
  const blocked = new Set([
    ...state.board.buildings.filter((piece) => piece.seat !== seat).map((piece) => piece.vertex),
    ...knightsExt(state)
      .knights.filter((knight) => knight.seat !== seat)
      .map((knight) => knight.vertex),
  ]);
  const next = new Map<string, string[]>();
  for (const road of roads) {
    const ends = edgeEndpoints(graph, road.edge);
    if (!ends) continue;
    next.set(ends[0], [...(next.get(ends[0]) ?? []), ends[1]]);
    next.set(ends[1], [...(next.get(ends[1]) ?? []), ends[0]]);
  }
  return knightsExt(state)
    .knights.filter((knight) => knight.seat === seat)
    .every((knight) => {
      const seen = new Set([knight.vertex]);
      const queue = [knight.vertex];
      for (let head = 0; head < queue.length; head++) {
        const vertex = queue[head];
        if (vertex === undefined) break;
        if (own.has(vertex)) return true;
        for (const other of next.get(vertex) ?? []) {
          if (seen.has(other) || blocked.has(other)) continue;
          seen.add(other);
          queue.push(other);
        }
      }
      return false;
    });
}

function withoutRoad(state: GameState, edge: string): GameState {
  const road = state.board.roads.find((item) => item.edge === edge);
  if (!road) return state;
  return updateSeat(
    {
      ...state,
      board: { ...state.board, roads: state.board.roads.filter((item) => item.edge !== edge) },
    },
    road.seat,
    (old) => ({ ...old, piecesLeft: { ...old.piecesLeft, road: (old.piecesLeft.road ?? 0) + 1 } }),
  );
}

/** Edges the player may build its free road on after the removal, other than the removed one. */
function replacements(state: GameState, seat: Seat, edge: string, ctx: HandlerContext): string[] {
  const after = withoutRoad(state, edge);
  return legalRoadEdges(after, seat, {}, ctx).filter(
    (candidate) => candidate !== edge && ctx.hooks.placement.road(after, seat, candidate, true),
  );
}

function removalProblem(state: GameState, edge: string): Result<void> {
  const road = state.board.roads.find((item) => item.edge === edge);
  if (!road) return failure('no-road', 'There is no road on that edge');
  if (!isOpenRoad(state, edge))
    return failure('not-open', 'Only a road with a free end can be removed');
  return knightsConnected(withoutRoad(state, edge), road.seat)
    ? success(undefined)
    : failure('disconnects-knight', 'Removing that road would leave a knight disconnected');
}

/**
 * Diplomat (Diplomacy): remove one open road, anyone's. A road of another seat returns to its
 * supply. If the road was the player's own, the player may build one road for free on a legal
 * edge other than the removed one; `build` names it in the same play, so Longest Road is settled
 * once, after both steps. The removal may not leave a knight disconnected from a settlement or
 * city, and may leave a building with no road.
 */
export const diplomat: CardModule = {
  card: {
    id: 'diplomat',
    timing: 'main',
    problem: (state, seat, params, ctx) => {
      const parsed = paramsOf(params);
      if (!parsed.ok) return parsed;
      const removal = removalProblem(state, parsed.value.edge);
      if (!removal.ok) return removal;
      const own = state.board.roads.find((item) => item.edge === parsed.value.edge)?.seat === seat;
      if (parsed.value.build === null) return success(undefined);
      if (!own) return failure('not-own-road', 'Only removing your own road earns a free road');
      return replacements(state, seat, parsed.value.edge, ctx).includes(parsed.value.build)
        ? success(undefined)
        : failure('illegal-road', 'The free road must go on another legal edge');
    },
    options: (state, seat, ctx) =>
      state.board.roads
        .filter((road) => removalProblem(state, road.edge).ok)
        .flatMap((road) =>
          road.seat === seat
            ? [
                { edge: road.edge, build: null },
                ...replacements(state, seat, road.edge, ctx).map((build) => ({
                  edge: road.edge,
                  build,
                })),
              ]
            : [{ edge: road.edge, build: null }],
        ),
    apply: (state, seat, params, ctx) => {
      const parsed = paramsOf(params);
      if (!parsed.ok) throw new Error('Validated Diplomat parameters missing');
      const road = state.board.roads.find((item) => item.edge === parsed.value.edge);
      if (!road) throw new Error('Validated Diplomat road missing');
      let next = withoutRoad(state, parsed.value.edge);
      const events: { type: string; [key: string]: unknown }[] = [
        { type: 'roadRemoved', seat: road.seat, edge: parsed.value.edge, by: seat },
      ];
      if (parsed.value.build !== null) {
        const build = parsed.value.build;
        next = {
          ...next,
          board: { ...next.board, roads: [...next.board.roads, { edge: build, seat }] },
        };
        next = updateSeat(next, seat, (old) => ({
          ...old,
          piecesLeft: { ...old.piecesLeft, road: (old.piecesLeft.road ?? 0) - 1 },
        }));
        next = ctx.hooks.afterBuild(next, seat, 'road', build);
        events.push({ type: 'roadBuilt', seat, edge: build, free: true });
      }
      return { state: recomputeLongestRoadAward(next, ctx), events, effects: [] };
    },
  },
};
