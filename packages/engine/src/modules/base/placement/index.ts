import type { BoardGraph } from '../../../core/geometry/index.js';
import type { HandlerContext } from '../../../core/modules/types.js';
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

/** Edges that connect a seat's network: its roads, extended by the connectivity hook. */
export function connectorEdges(state: GameState, seat: Seat, ctx?: HandlerContext): Set<string> {
  const roads = state.board.roads.filter((road) => road.seat === seat).map((road) => road.edge);
  return new Set(ctx ? ctx.hooks.connectivity(state, seat, roads) : roads);
}

function canSettle(
  state: GameState,
  seat: Seat,
  vertex: string,
  options: SettlementOptions,
  graph: BoardGraph,
  ctx?: HandlerContext,
): boolean {
  const index = graph.vertexIndex[vertex];
  if (index === undefined || state.board.buildings.some((piece) => piece.vertex === vertex))
    return false;
  const neighbors = graph.vertexNeighbors[index] ?? [];
  if (
    state.board.buildings.some((piece) => neighbors.some((neighbor) => neighbor === piece.vertex))
  )
    return false;
  if (options.setup === true) return true;
  const connectors = connectorEdges(state, seat, ctx);
  return (graph.vertexEdges[index] ?? []).some((edge) => connectors.has(edge));
}

/** Test an empty land vertex, distance rule, and ordinary road connection. */
export function canPlaceSettlement(
  state: GameState,
  seat: Seat,
  vertex: string,
  options: SettlementOptions = {},
  ctx?: HandlerContext,
): boolean {
  return canSettle(state, seat, vertex, options, boardGraph(state), ctx);
}

function canRoad(
  state: GameState,
  seat: Seat,
  edge: string,
  options: RoadOptions,
  graph: BoardGraph,
  connectors: ReadonlySet<string>,
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
    return incident.some((candidate) => connectors.has(candidate));
  });
}

/** Test an empty board edge and an unblocked connection to the seat's network. */
export function canPlaceRoad(
  state: GameState,
  seat: Seat,
  edge: string,
  options: RoadOptions = {},
  ctx?: HandlerContext,
): boolean {
  return canRoad(state, seat, edge, options, boardGraph(state), connectorEdges(state, seat, ctx));
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
  ctx?: HandlerContext,
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
  const connected = connectedVertices(graph, connectorEdges(state, seat, ctx));
  return graph.vertexIds.filter((vertex) => !blocked.has(vertex) && connected.has(vertex));
}

function connectedVertices(graph: BoardGraph, connectors: ReadonlySet<string>): Set<string> {
  const connected = new Set<string>();
  for (const edge of connectors) {
    const index = graph.edgeIndex[edge];
    if (index !== undefined)
      for (const vertex of graph.edgeVertices[index] ?? []) connected.add(vertex);
  }
  return connected;
}

/** Enumerate all legal road edges in canonical ID order. */
export function legalRoadEdges(
  state: GameState,
  seat: Seat,
  options: RoadOptions = {},
  ctx?: HandlerContext,
): string[] {
  const graph = boardGraph(state);
  const connectors = connectorEdges(state, seat, ctx);
  if (options.setupVertex !== undefined)
    return graph.edgeIds.filter((edge) => canRoad(state, seat, edge, options, graph, connectors));
  const occupied = new Set(state.board.roads.map((road) => road.edge));
  const buildings = new Map<string, Seat>();
  for (const building of state.board.buildings)
    if (!buildings.has(building.vertex)) buildings.set(building.vertex, building.seat);
  const connected = connectedVertices(graph, connectors);
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
