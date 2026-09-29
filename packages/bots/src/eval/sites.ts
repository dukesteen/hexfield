import type { GameState, Seat } from '@cp2p/engine';
import { boardInfo } from './board.js';
import type { BoardInfo } from './board.js';

/** Land vertices where a settlement may stand by the distance rule (ignoring connection). */
export function openSites(state: GameState, info: BoardInfo = boardInfo(state)): Set<string> {
  const { graph } = info;
  const taken = new Set(state.board.buildings.map((piece) => piece.vertex));
  const open = new Set<string>();
  graph.vertexIds.forEach((vertex, index) => {
    if (!info.onLand[index] || taken.has(vertex)) return;
    if ((graph.vertexNeighbors[index] ?? []).some((neighbor) => taken.has(neighbor))) return;
    open.add(vertex);
  });
  return open;
}

/** Whether a road can ever lie on this edge: it borders at least one land hex. */
function landEdge(state: GameState, info: BoardInfo, edge: number): boolean {
  const byId = landHexIds(state);
  return (info.graph.edgeHexes[edge] ?? []).some((hex) => byId.has(hex));
}

const landIds = new WeakMap<object, Set<string>>();
function landHexIds(state: GameState): Set<string> {
  let ids = landIds.get(state.board.hexes);
  if (!ids) {
    ids = new Set(
      state.board.hexes
        .filter((hex) => hex.terrain !== 'sea' && hex.terrain !== 'fog')
        .map((hex) => hex.id),
    );
    landIds.set(state.board.hexes, ids);
  }
  return ids;
}

/** Vertices the seat's network touches: its buildings and the ends of its roads and ships. */
export function networkVertices(
  state: GameState,
  seat: Seat,
  info = boardInfo(state),
): Set<string> {
  const vertices = new Set<string>();
  for (const piece of state.board.buildings) if (piece.seat === seat) vertices.add(piece.vertex);
  for (const road of [...state.board.roads, ...(state.board.ships ?? [])]) {
    if (road.seat !== seat) continue;
    const index = info.graph.edgeIndex[road.edge];
    for (const vertex of index === undefined ? [] : (info.graph.edgeVertices[index] ?? []))
      vertices.add(vertex);
  }
  return vertices;
}

/**
 * The number of new roads a seat needs to reach each vertex (0 for its own network), up to
 * `limit`. Roads cannot pass another seat's road or building.
 */
export function roadDistances(
  state: GameState,
  seat: Seat,
  limit = 3,
  info = boardInfo(state),
): Map<string, number> {
  const { graph } = info;
  const taken = new Set(
    [...state.board.roads, ...(state.board.ships ?? [])].map((road) => road.edge),
  );
  const foreign = new Set(
    state.board.buildings.filter((piece) => piece.seat !== seat).map((piece) => piece.vertex),
  );
  const distance = new Map<string, number>();
  let frontier = [...networkVertices(state, seat, info)];
  for (const vertex of frontier) distance.set(vertex, 0);
  for (let step = 1; step <= limit && frontier.length; step++) {
    const next: string[] = [];
    for (const vertex of frontier) {
      if (foreign.has(vertex)) continue;
      const index = graph.vertexIndex[vertex];
      for (const edge of index === undefined ? [] : (graph.vertexEdges[index] ?? [])) {
        const edgeIndex = graph.edgeIndex[edge];
        if (edgeIndex === undefined || taken.has(edge) || !landEdge(state, info, edgeIndex))
          continue;
        for (const other of graph.edgeVertices[edgeIndex] ?? []) {
          if (distance.has(other)) continue;
          distance.set(other, step);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return distance;
}

/** Edges that start a shortest road path from the seat's network toward `target`. */
export function firstRoadsToward(
  state: GameState,
  seat: Seat,
  target: string,
  distances: ReadonlyMap<string, number>,
  info = boardInfo(state),
): Set<string> {
  const { graph } = info;
  const result = new Set<string>();
  const goal = distances.get(target);
  if (goal === undefined || goal === 0) return result;
  // Walk back from the target along strictly decreasing distances.
  let layer = new Set([target]);
  for (let step = goal; step >= 1; step--) {
    const previous = new Set<string>();
    for (const vertex of layer) {
      const index = graph.vertexIndex[vertex];
      for (const edge of index === undefined ? [] : (graph.vertexEdges[index] ?? [])) {
        const edgeIndex = graph.edgeIndex[edge];
        if (edgeIndex === undefined) continue;
        const other = (graph.edgeVertices[edgeIndex] ?? []).find((item) => item !== vertex);
        if (other === undefined || distances.get(other) !== step - 1) continue;
        if (step === 1) result.add(edge);
        previous.add(other);
      }
    }
    layer = previous;
  }
  return result;
}
