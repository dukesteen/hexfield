import type { GameState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { boardGraph, edgeEndpoints, edgeHasSeaSide, edgeOccupied } from '../base/board/index.js';
import { seafaringExt } from './types.js';

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

function buildingAt(state: GameState, vertex: string): Seat | undefined {
  return state.board.buildings.find((piece) => piece.vertex === vertex)?.seat;
}

/**
 * True when a ship on these vertices would touch the seat's own building, or an own ship
 * (ignoring `ignore`) at a vertex that holds no opponent building. Roads never connect a ship.
 */
function shipConnects(
  state: GameState,
  seat: Seat,
  vertices: readonly [string, string],
  ignore: string | undefined,
): boolean {
  const own = (state.board.ships ?? []).filter(
    (ship) => ship.seat === seat && ship.edge !== ignore,
  );
  const graph = boardGraph(state);
  return vertices.some((vertex) => {
    const holder = buildingAt(state, vertex);
    if (holder === seat) return true;
    if (holder !== undefined) return false;
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
  return shipConnects(state, seat, endpoints, options.ignore);
}

/** Every edge where the seat could place a ship, in id order. */
export function legalShipEdges(state: GameState, seat: Seat, options: ShipOptions = {}): string[] {
  return boardGraph(state).edgeIds.filter((edge) => canPlaceShip(state, seat, edge, options));
}

/** Ship edges of the seat that may be moved now, ignoring the once-per-turn limit. */
export function movableShips(state: GameState, seat: Seat): string[] {
  const graph = boardGraph(state);
  const ships = shipEdges(state, seat);
  const ends = new Map<string, readonly [string, string]>();
  for (const edge of ships) {
    const endpoints = edgeEndpoints(graph, edge);
    if (endpoints) ends.set(edge, endpoints);
  }
  const buildings = new Set(
    state.board.buildings.filter((piece) => piece.seat === seat).map((piece) => piece.vertex),
  );
  const shipsAt = new Map<string, string[]>();
  for (const [edge, endpoints] of ends)
    for (const vertex of endpoints) shipsAt.set(vertex, [...(shipsAt.get(vertex) ?? []), edge]);

  // A route is a chain of ships joined at shared vertices that hold no own building.
  const parent = new Map<string, string>(ships.map((edge) => [edge, edge]));
  const find = (edge: string): string => {
    let root = edge;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    return root;
  };
  for (const [vertex, group] of shipsAt) {
    if (buildings.has(vertex)) continue;
    const first = group[0];
    if (first === undefined) continue;
    for (const other of group.slice(1)) parent.set(find(other), find(first));
  }
  const routes = new Map<string, string[]>();
  for (const edge of ships) routes.set(find(edge), [...(routes.get(find(edge)) ?? []), edge]);

  const built = new Set(seafaringExt(state).builtThisTurn);
  const blocked = pirateEdges(state);
  const movable: string[] = [];
  for (const route of routes.values()) {
    const touched = new Set(
      route.flatMap((edge) => (ends.get(edge) ?? []).filter((vertex) => buildings.has(vertex))),
    );
    // A route joining two different own buildings is closed, even if it were cut.
    if (touched.size >= 2) continue;
    for (const edge of route) {
      if (built.has(edge) || blocked.has(edge)) continue;
      const endpoints = ends.get(edge);
      if (!endpoints) continue;
      const open = endpoints.some(
        (vertex) => !buildings.has(vertex) && (shipsAt.get(vertex)?.length ?? 0) === 1,
      );
      // A circle has no open end: with no building every ship on it may move, and a circle
      // through one building lets the ships that touch that building move.
      const circle =
        !open &&
        onCycle(route, ends, edge) &&
        (touched.size === 0 || endpoints.some((vertex) => touched.has(vertex)));
      if (open || circle) movable.push(edge);
    }
  }
  return movable.toSorted();
}

/** True when the ship's endpoints stay connected through the route's other ships. */
function onCycle(
  route: readonly string[],
  ends: ReadonlyMap<string, readonly [string, string]>,
  edge: string,
): boolean {
  const target = ends.get(edge);
  if (!target) return false;
  const seen = new Set<string>([target[0]]);
  const queue = [target[0]];
  for (let head = 0; head < queue.length; head++) {
    const vertex = queue[head];
    for (const other of route) {
      if (other === edge) continue;
      const endpoints = ends.get(other);
      if (!endpoints || !endpoints.includes(vertex ?? '')) continue;
      const next = endpoints[0] === vertex ? endpoints[1] : endpoints[0];
      if (next === target[1]) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/** Every legal `MOVE_SHIP` as `{ from, to }`, computed with the moved ship removed. */
export function legalShipMoves(
  state: GameState,
  seat: Seat,
): readonly { from: string; to: string }[] {
  return movableShips(state, seat).flatMap((from) =>
    legalShipEdges(state, seat, { ignore: from }).map((to) => ({ from, to })),
  );
}
