import type { GameState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { boardGraph, edgeEndpoints } from '../base/board/index.js';
import { knightsExt } from './types.js';

type EdgeKind = 'road' | 'ship';

interface Step {
  to: string;
  kind: EdgeKind;
}

/** Where a walk along a seat's network can end up. */
export interface NetworkReach {
  /** Empty vertices, by id. */
  empty: string[];
  /** Vertices of other seats' knights the walk may stop on (a displacement), by id. */
  foes: string[];
  /** Whether the walk reaches one of the seat's own settlements or cities. */
  home: boolean;
}

/**
 * The seat's network as steps between vertices: its roads and, in a seafaring game, its ships
 * (`board.ships`, empty otherwise). `without` names an edge to treat as removed.
 */
function networkSteps(state: GameState, seat: Seat, without?: string): Map<string, Step[]> {
  const graph = boardGraph(state);
  const steps = new Map<string, Step[]>();
  const add = (edge: string, kind: EdgeKind): void => {
    const ends = edgeEndpoints(graph, edge);
    if (!ends) return;
    steps.set(ends[0], [...(steps.get(ends[0]) ?? []), { to: ends[1], kind }]);
    steps.set(ends[1], [...(steps.get(ends[1]) ?? []), { to: ends[0], kind }]);
  };
  for (const road of state.board.roads)
    if (road.seat === seat && road.edge !== without) add(road.edge, 'road');
  for (const ship of state.board.ships ?? [])
    if (ship.seat === seat && ship.edge !== without) add(ship.edge, 'ship');
  return steps;
}

/**
 * A walk along a seat's own network from a vertex. A path may pass vertices holding the seat's own
 * buildings and knights and may not enter a vertex with another seat's building. It stops at
 * another seat's knight, which it may only displace. Roads and ships join only at the seat's own
 * settlements and cities (the Seafarers continuity rule), and the starting vertex joins both.
 * The start is never a destination.
 */
export function networkReach(
  state: GameState,
  seat: Seat,
  from: string,
  without?: string,
): NetworkReach {
  const steps = networkSteps(state, seat, without);
  const buildings = new Map(state.board.buildings.map((piece) => [piece.vertex, piece.seat]));
  const knights = new Map(knightsExt(state).knights.map((knight) => [knight.vertex, knight.seat]));
  const states = new Set<string>([`${from}|`]);
  const queue: { vertex: string; kind: EdgeKind | null }[] = [{ vertex: from, kind: null }];
  const seen = new Set([from]);
  const empty: string[] = [];
  const foes: string[] = [];
  let home = buildings.get(from) === seat;
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (current === undefined) break;
    for (const step of steps.get(current.vertex) ?? []) {
      if (current.kind !== null && step.kind !== current.kind) continue;
      const other = step.to;
      const building = buildings.get(other);
      if (building !== undefined && building !== seat) continue;
      const knight = knights.get(other);
      if (knight !== undefined && knight !== seat) {
        if (!seen.has(other)) foes.push(other);
        seen.add(other);
        continue;
      }
      // Arriving at an own building frees the kind: the next step may be a road or a ship.
      const kind = building === seat ? null : step.kind;
      if (building === seat) home = true;
      const key = `${other}|${kind ?? ''}`;
      if (states.has(key)) continue;
      states.add(key);
      if (!seen.has(other)) {
        seen.add(other);
        if (building === undefined && knight === undefined) empty.push(other);
      }
      queue.push({ vertex: other, kind });
    }
  }
  return { empty: empty.toSorted(), foes: foes.toSorted(), home };
}

/** Whether one of the seat's roads or ships ends at the vertex. */
export function routeEndsAt(state: GameState, seat: Seat, vertex: string): boolean {
  return networkSteps(state, seat).has(vertex);
}
