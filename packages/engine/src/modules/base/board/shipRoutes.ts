import type { GameState } from '../../../core/state/index.js';
import type { Seat } from '../../../core/types/index.js';
import { boardGraph, edgeEndpoints } from './index.js';

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

/**
 * The seat's ships that sit at an open end of an open route (Seafarers FAQ, "When is a ship
 * open?"), in id order. `anchors` are the vertices that close a route: the seat's own settlements
 * and cities, and any further vertex a module names (knights). A route is a chain of ships joined
 * at shared vertices that hold no anchor. A route touching two different anchors is closed. Nothing
 * else is checked: not the pirate, not "built this turn", not the once-per-turn move.
 */
export function openShipEdges(
  state: GameState,
  seat: Seat,
  anchors: ReadonlySet<string>,
): string[] {
  const graph = boardGraph(state);
  const ships = (state.board.ships ?? []).filter((ship) => ship.seat === seat).map((s) => s.edge);
  const ends = new Map<string, readonly [string, string]>();
  for (const edge of ships) {
    const endpoints = edgeEndpoints(graph, edge);
    if (endpoints) ends.set(edge, endpoints);
  }
  const shipsAt = new Map<string, string[]>();
  for (const [edge, endpoints] of ends)
    for (const vertex of endpoints) shipsAt.set(vertex, [...(shipsAt.get(vertex) ?? []), edge]);

  const parent = new Map<string, string>(ships.map((edge) => [edge, edge]));
  const find = (edge: string): string => {
    let root = edge;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    return root;
  };
  for (const [vertex, group] of shipsAt) {
    if (anchors.has(vertex)) continue;
    const first = group[0];
    if (first === undefined) continue;
    for (const other of group.slice(1)) parent.set(find(other), find(first));
  }
  const routes = new Map<string, string[]>();
  for (const edge of ships) routes.set(find(edge), [...(routes.get(find(edge)) ?? []), edge]);

  const open: string[] = [];
  for (const route of routes.values()) {
    const touched = new Set(
      route.flatMap((edge) => (ends.get(edge) ?? []).filter((vertex) => anchors.has(vertex))),
    );
    // A route joining two different anchors is closed, even if it were cut.
    if (touched.size >= 2) continue;
    for (const edge of route) {
      const endpoints = ends.get(edge);
      if (!endpoints) continue;
      const freeEnd = endpoints.some(
        (vertex) => !anchors.has(vertex) && (shipsAt.get(vertex)?.length ?? 0) === 1,
      );
      // A circle has no open end: with no anchor every ship on it may move, and a circle through
      // one anchor lets the ships that touch that anchor move.
      const circle =
        !freeEnd &&
        onCycle(route, ends, edge) &&
        (touched.size === 0 || endpoints.some((vertex) => touched.has(vertex)));
      if (freeEnd || circle) open.push(edge);
    }
  }
  return open.toSorted();
}
