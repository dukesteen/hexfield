import type { HandlerContext } from '../../../core/modules/index.js';
import type { GameState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Result, Seat } from '../../../core/types/index.js';
import { recomputeLongestRoadAward } from '../../base/awards/index.js';
import { boardGraph, edgeEndpoints } from '../../base/board/index.js';
import { openShipEdges } from '../../base/board/shipRoutes.js';
import { legalRoadEdges } from '../../base/placement/index.js';
import { updateSeat } from '../../base/shared.js';
import { strandsKnight } from '../pieces.js';
import { knightsExt } from '../types.js';
import type { CardModule } from './card.js';

export { knightsConnected } from '../pieces.js';

interface DiplomatParams {
  edge: string;
  /** The free piece built in its place (only when the removed piece was the player's own). */
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
 * no free end. Ships never continue a road.
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
 * A ship is open by the Seafarers rule (an open end of an open route), with the owner's knights
 * closing routes like buildings. The pirate, "built this turn" and the once-per-turn limit do not
 * matter for the Diplomat (C&K FAQ: "The Diplomat doesn't fear pirates").
 */
export function isOpenShip(state: GameState, edge: string): boolean {
  const ship = (state.board.ships ?? []).find((item) => item.edge === edge);
  if (!ship) return false;
  const anchors = new Set([
    ...state.board.buildings.filter((piece) => piece.seat === ship.seat).map((p) => p.vertex),
    ...knightsExt(state)
      .knights.filter((knight) => knight.seat === ship.seat)
      .map((knight) => knight.vertex),
  ]);
  return openShipEdges(state, ship.seat, anchors).includes(edge);
}

type PieceKind = 'road' | 'ship';

/** The road or ship on an edge, with its owner. */
function pieceOn(state: GameState, edge: string): { kind: PieceKind; seat: Seat } | undefined {
  const road = state.board.roads.find((item) => item.edge === edge);
  if (road) return { kind: 'road', seat: road.seat };
  const ship = (state.board.ships ?? []).find((item) => item.edge === edge);
  return ship ? { kind: 'ship', seat: ship.seat } : undefined;
}

function withoutPiece(state: GameState, edge: string): GameState {
  const piece = pieceOn(state, edge);
  if (!piece) return state;
  const board =
    piece.kind === 'road'
      ? { ...state.board, roads: state.board.roads.filter((item) => item.edge !== edge) }
      : { ...state.board, ships: (state.board.ships ?? []).filter((item) => item.edge !== edge) };
  return updateSeat({ ...state, board }, piece.seat, (old) => ({
    ...old,
    piecesLeft: { ...old.piecesLeft, [piece.kind]: (old.piecesLeft[piece.kind] ?? 0) + 1 },
  }));
}

/**
 * Edges the player may build its free piece on after the removal, other than the removed one. The
 * piece is of the removed piece's kind: a road for a road, a ship for a ship.
 */
function replacements(state: GameState, seat: Seat, edge: string, ctx: HandlerContext): string[] {
  const after = withoutPiece(state, edge);
  if (pieceOn(state, edge)?.kind === 'ship')
    return ctx.hooks
      .freePieces(after, seat, [], ctx)
      .flatMap((command) =>
        command.type === 'PLACE_FREE_SHIP' &&
        typeof command.edge === 'string' &&
        command.edge !== edge
          ? [command.edge]
          : [],
      );
  return legalRoadEdges(after, seat, {}, ctx).filter(
    (candidate) => candidate !== edge && ctx.hooks.placement.road(after, seat, candidate, true),
  );
}

function removalProblem(state: GameState, edge: string): Result<void> {
  const piece = pieceOn(state, edge);
  if (!piece) return failure('no-road', 'There is no road or ship on that edge');
  if (!(piece.kind === 'road' ? isOpenRoad(state, edge) : isOpenShip(state, edge)))
    return failure('not-open', 'Only a road or ship with a free end can be removed');
  return strandsKnight(state, piece.seat, edge)
    ? failure('disconnects-knight', 'Removing that piece would leave a knight disconnected')
    : success(undefined);
}

/** Every edge holding a road or a ship, in board order (roads first). */
function pieceEdges(state: GameState): string[] {
  return [...state.board.roads, ...(state.board.ships ?? [])].map((piece) => piece.edge);
}

/**
 * Diplomat (Diplomacy): remove one open road or ship, anyone's. A piece of another seat returns to
 * its supply. If it was the player's own, the player may build one piece of the same kind for free
 * on a legal edge other than the removed one; `build` names it in the same play, so Longest Road is
 * settled once, after both steps. The removal may not leave a knight disconnected from a settlement
 * or city, and may leave a building with no road.
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
      const own = pieceOn(state, parsed.value.edge)?.seat === seat;
      if (parsed.value.build === null) return success(undefined);
      if (!own) return failure('not-own-road', 'Only removing your own road earns a free road');
      return replacements(state, seat, parsed.value.edge, ctx).includes(parsed.value.build)
        ? success(undefined)
        : failure('illegal-road', 'The free road must go on another legal edge');
    },
    options: (state, seat, ctx) =>
      pieceEdges(state)
        .filter((edge) => removalProblem(state, edge).ok)
        .flatMap((edge) =>
          pieceOn(state, edge)?.seat === seat
            ? [
                { edge, build: null },
                ...replacements(state, seat, edge, ctx).map((build) => ({ edge, build })),
              ]
            : [{ edge, build: null }],
        ),
    apply: (state, seat, params, ctx) => {
      const parsed = paramsOf(params);
      if (!parsed.ok) throw new Error('Validated Diplomat parameters missing');
      const piece = pieceOn(state, parsed.value.edge);
      if (!piece) throw new Error('Validated Diplomat piece missing');
      let next = withoutPiece(state, parsed.value.edge);
      const events: { type: string; [key: string]: unknown }[] = [
        {
          type: piece.kind === 'road' ? 'roadRemoved' : 'shipRemoved',
          seat: piece.seat,
          edge: parsed.value.edge,
          by: seat,
        },
      ];
      if (parsed.value.build !== null) {
        const build = parsed.value.build;
        next = {
          ...next,
          board:
            piece.kind === 'road'
              ? { ...next.board, roads: [...next.board.roads, { edge: build, seat }] }
              : { ...next.board, ships: [...(next.board.ships ?? []), { edge: build, seat }] },
        };
        next = updateSeat(next, seat, (old) => ({
          ...old,
          piecesLeft: { ...old.piecesLeft, [piece.kind]: (old.piecesLeft[piece.kind] ?? 0) - 1 },
        }));
        next = ctx.hooks.afterBuild(next, seat, piece.kind, build);
        events.push({
          type: piece.kind === 'road' ? 'roadBuilt' : 'shipBuilt',
          seat,
          edge: build,
          free: true,
        });
      }
      return { state: recomputeLongestRoadAward(next, ctx), events, effects: [] };
    },
  },
};
