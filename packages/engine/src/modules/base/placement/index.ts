import type { BoardGraph } from '../../../core/geometry/index.js';
import type { GameState } from '../../../core/state/types.js';
import type { Seat } from '../../../core/types/index.js';
import { boardGraph, edgeEndpoints } from '../board/index.js';

/** A settlement's setup rule omits the ordinary road connection. */
export interface SettlementOptions {
  setup?: boolean;
}
/** A setup road must touch the settlement just placed on that turn. */
export interface RoadOptions {
  setupVertex?: string;
}

function canSettle(
  state: GameState,
  seat: Seat,
  vertex: string,
  options: SettlementOptions,
  graph: BoardGraph,
): boolean {
  const index = graph.vertexIndex[vertex];
  if (index === undefined || state.board.buildings.some((piece) => piece.vertex === vertex))
    return false;
  const neighbors = graph.vertexNeighbors[index] ?? [];
  if (
    state.board.buildings.some((piece) => neighbors.some((neighbor) => neighbor === piece.vertex))
  )
    return false;
  return (
    options.setup === true ||
    state.board.roads.some(
      (road) =>
        road.seat === seat && (graph.vertexEdges[index] ?? []).some((edge) => edge === road.edge),
    )
  );
}

/** Test an empty land vertex, distance rule, and ordinary road connection. */
export function canPlaceSettlement(
  state: GameState,
  seat: Seat,
  vertex: string,
  options: SettlementOptions = {},
): boolean {
  return canSettle(state, seat, vertex, options, boardGraph(state));
}

function canRoad(
  state: GameState,
  seat: Seat,
  edge: string,
  options: RoadOptions,
  graph: BoardGraph,
): boolean {
  const endpoints = edgeEndpoints(graph, edge);
  if (!endpoints || state.board.roads.some((road) => road.edge === edge)) return false;
  if (options.setupVertex !== undefined)
    return (
      endpoints.some((vertex) => vertex === options.setupVertex) &&
      state.board.buildings.some(
        (piece) => piece.vertex === options.setupVertex && piece.seat === seat,
      )
    );
  return endpoints.some((vertex) => {
    const building = state.board.buildings.find((piece) => piece.vertex === vertex);
    if (building?.seat === seat) return true;
    if (building) return false;
    const incident = graph.vertexEdges[graph.vertexIndex[vertex] ?? -1] ?? [];
    return state.board.roads.some(
      (road) => road.seat === seat && incident.some((candidate) => candidate === road.edge),
    );
  });
}

/** Test an empty board edge and an unblocked connection to the seat's network. */
export function canPlaceRoad(
  state: GameState,
  seat: Seat,
  edge: string,
  options: RoadOptions = {},
): boolean {
  return canRoad(state, seat, edge, options, boardGraph(state));
}

/** Test that the chosen vertex holds the seat's own settlement. */
export function canUpgradeCity(state: GameState, seat: Seat, vertex: string): boolean {
  return (
    boardGraph(state).vertexIndex[vertex] !== undefined &&
    state.board.buildings.some(
      (piece) => piece.vertex === vertex && piece.seat === seat && piece.kind === 'settlement',
    )
  );
}

/** Enumerate all legal settlement vertices in canonical ID order. */
export function legalSettlementVertices(
  state: GameState,
  seat: Seat,
  options: SettlementOptions = {},
): string[] {
  const graph = boardGraph(state);
  const blocked = new Set<string>();
  for (const building of state.board.buildings) {
    blocked.add(building.vertex);
    const index = graph.vertexIndex[building.vertex];
    if (index !== undefined)
      for (const neighbor of graph.vertexNeighbors[index] ?? []) blocked.add(neighbor);
  }
  if (options.setup === true) return graph.vertexIds.filter((vertex) => !blocked.has(vertex));
  const connected = new Set<string>();
  for (const road of state.board.roads) {
    if (road.seat !== seat) continue;
    const index = graph.edgeIndex[road.edge];
    if (index !== undefined)
      for (const vertex of graph.edgeVertices[index] ?? []) connected.add(vertex);
  }
  return graph.vertexIds.filter((vertex) => !blocked.has(vertex) && connected.has(vertex));
}

/** Enumerate all legal road edges in canonical ID order. */
export function legalRoadEdges(state: GameState, seat: Seat, options: RoadOptions = {}): string[] {
  const graph = boardGraph(state);
  if (options.setupVertex !== undefined)
    return graph.edgeIds.filter((edge) => canRoad(state, seat, edge, options, graph));
  const occupied = new Set(state.board.roads.map((road) => road.edge));
  const buildings = new Map<string, Seat>();
  for (const building of state.board.buildings)
    if (!buildings.has(building.vertex)) buildings.set(building.vertex, building.seat);
  const connected = new Set<string>();
  for (const road of state.board.roads) {
    if (road.seat !== seat) continue;
    const index = graph.edgeIndex[road.edge];
    if (index !== undefined)
      for (const vertex of graph.edgeVertices[index] ?? []) connected.add(vertex);
  }
  return graph.edgeIds.filter((edge) => {
    if (occupied.has(edge)) return false;
    const index = graph.edgeIndex[edge];
    if (index === undefined) return false;
    return (graph.edgeVertices[index] ?? []).some((vertex) =>
      buildings.has(vertex) ? buildings.get(vertex) === seat : connected.has(vertex),
    );
  });
}

/** Enumerate settlements the seat may upgrade. */
export function legalCityVertices(state: GameState, seat: Seat): string[] {
  return state.board.buildings
    .filter((piece) => piece.seat === seat && piece.kind === 'settlement')
    .map((piece) => piece.vertex)
    .toSorted();
}
