import type { HandlerContext } from '../../core/modules/index.js';
import type { GameState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { boardGraph, edgeEndpoints, edgeHasSeaSide, edgeOccupied } from '../base/board/index.js';
import { openShipEdges } from '../base/board/shipRoutes.js';
import { seafaringExt, updateSeafaring } from './types.js';

/** A seat's ship edges, in placement order. */
export function shipEdges(state: GameState, seat: Seat): string[] {
  return (state.board.ships ?? []).filter((ship) => ship.seat === seat).map((ship) => ship.edge);
}

/** The six edges of the pirate's hex, or none while the pirate is off the board. */
export function pirateEdges(state: GameState): ReadonlySet<string> {
  const hex = seafaringExt(state).pirateHex;
  if (hex === null) return new Set();
  const graph = boardGraph(state);
  const index = graph.hexIndex[hex];
  return new Set(index === undefined ? [] : (graph.hexEdges[index] ?? []));
}

/**
 * What other modules say about vertices for one seat's ships, from the `routeGraph` hook: `stops`
 * are vertices where another seat's pieces (knights) stop the seat's routes, `anchors` are the
 * seat's own pieces that close a route like a building does (its knights).
 */
export interface ShipContext {
  stops: ReadonlySet<string>;
  anchors: ReadonlySet<string>;
}

const NO_CONTEXT: ShipContext = { stops: new Set(), anchors: new Set() };

/** The seat's ship context. Without the engine context (seafaring alone, tests) it is empty. */
export function shipContext(state: GameState, seat: Seat, ctx?: HandlerContext): ShipContext {
  if (!ctx) return NO_CONTEXT;
  const route = ctx.hooks.routeGraph(state, seat, { edges: [], blocked: [] });
  const anchors = route.anchors ?? [];
  return route.blocked.length === 0 && anchors.length === 0
    ? NO_CONTEXT
    : { stops: new Set(route.blocked), anchors: new Set(anchors) };
}

function buildingAt(state: GameState, vertex: string): Seat | undefined {
  return state.board.buildings.find((piece) => piece.vertex === vertex)?.seat;
}

/**
 * True when a ship on these vertices would touch the seat's own building, or an own ship
 * (ignoring `ignore`) at a vertex that holds no opponent building or stopping piece. Roads never
 * connect a ship.
 */
function shipConnects(
  state: GameState,
  seat: Seat,
  vertices: readonly [string, string],
  ignore: string | undefined,
  stops: ReadonlySet<string>,
): boolean {
  const own = (state.board.ships ?? []).filter(
    (ship) => ship.seat === seat && ship.edge !== ignore,
  );
  const graph = boardGraph(state);
  return vertices.some((vertex) => {
    const holder = buildingAt(state, vertex);
    if (holder === seat) return true;
    if (holder !== undefined || stops.has(vertex)) return false;
    const index = graph.vertexIndex[vertex];
    const around: readonly string[] = index === undefined ? [] : (graph.vertexEdges[index] ?? []);
    return own.some((ship) => around.includes(ship.edge));
  });
}

export interface ShipOptions {
  /** A ship edge to treat as removed when checking the connection (a ship being moved). */
  ignore?: string;
  /** A setup ship must touch this vertex, which holds the seat's new settlement. */
  setupVertex?: string;
  /** The seat's ship context, computed once for many edges. */
  context?: ShipContext;
  /** The engine context, from which the ship context is computed when none is given. */
  ctx?: HandlerContext | undefined;
}

/** Whether the seat may put a ship on the edge now. Supply and cost are checked elsewhere. */
export function canPlaceShip(
  state: GameState,
  seat: Seat,
  edge: string,
  options: ShipOptions = {},
): boolean {
  const endpoints = edgeEndpoints(boardGraph(state), edge);
  if (!endpoints || edgeOccupied(state, edge) || !edgeHasSeaSide(state, edge)) return false;
  if (pirateEdges(state).has(edge)) return false;
  if (options.setupVertex !== undefined)
    return (
      endpoints.some((vertex) => vertex === options.setupVertex) &&
      buildingAt(state, options.setupVertex) === seat
    );
  const context = options.context ?? shipContext(state, seat, options.ctx);
  return shipConnects(state, seat, endpoints, options.ignore, context.stops);
}

/** Every edge where the seat could place a ship, in id order. */
export function legalShipEdges(state: GameState, seat: Seat, options: ShipOptions = {}): string[] {
  const context = options.context ?? shipContext(state, seat, options.ctx);
  const withContext = { ...options, context };
  return boardGraph(state).edgeIds.filter((edge) => canPlaceShip(state, seat, edge, withContext));
}

/**
 * Ship edges of the seat that may be moved now, ignoring the once-per-turn limit. A route closes
 * at the seat's buildings and at the anchors of its ship context (knights), so a ship whose move
 * would leave a knight without a route to a building never moves.
 */
export function movableShips(
  state: GameState,
  seat: Seat,
  context: ShipContext = NO_CONTEXT,
): string[] {
  const anchors = new Set([
    ...state.board.buildings.filter((piece) => piece.seat === seat).map((piece) => piece.vertex),
    ...context.anchors,
  ]);
  const built = new Set(seafaringExt(state).builtThisTurn);
  const blocked = pirateEdges(state);
  return openShipEdges(state, seat, anchors).filter(
    (edge) => !built.has(edge) && !blocked.has(edge),
  );
}

/** Every legal `MOVE_SHIP` as `{ from, to }`, computed with the moved ship removed. */
export function legalShipMoves(
  state: GameState,
  seat: Seat,
  ctx?: HandlerContext,
): readonly { from: string; to: string }[] {
  const context = shipContext(state, seat, ctx);
  return movableShips(state, seat, context).flatMap((from) =>
    legalShipEdges(state, seat, { ignore: from, context }).map((to) => ({ from, to })),
  );
}

/**
 * Part of the `afterBuild` hook: a ship placed, moved or built by a card this turn cannot be moved
 * this turn. Idempotent, so a placing command and a card may both report it.
 */
export function noteBuiltShip(state: GameState, type: string, edge: string): GameState {
  if (type !== 'ship' || seafaringExt(state).builtThisTurn.includes(edge)) return state;
  return updateSeafaring(state, (old) => ({ ...old, builtThisTurn: [...old.builtThisTurn, edge] }));
}
