import { buildBoardGraph } from '../../../core/geometry/index.js';
import type { BoardGraph, VertexId } from '../../../core/geometry/index.js';
import type { GameState } from '../../../core/state/types.js';
import type { Resource, Seat } from '../../../core/types/index.js';

const graphs = new WeakMap<GameState['board']['hexes'], BoardGraph>();

function freezeGraph(graph: BoardGraph): BoardGraph {
  for (const group of [
    graph.hexVertices,
    graph.hexEdges,
    graph.vertexHexes,
    graph.vertexEdges,
    graph.vertexNeighbors,
    graph.edgeVertices,
    graph.edgeHexes,
  ]) {
    for (const members of group) Object.freeze(members);
    Object.freeze(group);
  }
  for (const value of [
    graph.hexIds,
    graph.vertexIds,
    graph.edgeIds,
    graph.hexIndex,
    graph.vertexIndex,
    graph.edgeIndex,
  ])
    Object.freeze(value);
  return Object.freeze(graph);
}

/** Rebuild the integer graph from public board coordinates. */
export function boardGraph(state: GameState): BoardGraph {
  const hexes = state.board.hexes;
  let graph = graphs.get(hexes);
  if (!graph) {
    graph = freezeGraph(buildBoardGraph(hexes));
    graphs.set(hexes, graph);
  }
  return graph;
}

/** Canonical vertices bordering a land hex, or an empty list for an unknown hex. */
export function verticesForHex(state: GameState, hex: string): string[] {
  const graph = boardGraph(state);
  const index = graph.hexIndex[hex];
  return index === undefined ? [] : [...(graph.hexVertices[index] ?? [])];
}

/** Canonical edges incident to a vertex, or an empty list off board. */
export function edgesForVertex(state: GameState, vertex: string): string[] {
  const graph = boardGraph(state);
  const index = graph.vertexIndex[vertex];
  return index === undefined ? [] : [...(graph.vertexEdges[index] ?? [])];
}

/** Canonical land hexes incident to a vertex, or an empty list off board. */
export function hexesForVertex(state: GameState, vertex: string): string[] {
  const graph = boardGraph(state);
  const index = graph.vertexIndex[vertex];
  return index === undefined ? [] : [...(graph.vertexHexes[index] ?? [])];
}

/** Return the best maritime trade rate granted by built harbor vertices. */
export function harborRate(state: GameState, seat: Seat, resource: Resource): number {
  const graph = boardGraph(state);
  const occupied = new Set(
    state.board.buildings.filter((piece) => piece.seat === seat).map((piece) => piece.vertex),
  );
  let rate = 4;
  for (const harbor of state.board.harbors) {
    if (harbor.kind !== 'generic' && harbor.kind !== resource) continue;
    const edgeIndex = graph.edgeIndex[harbor.edge];
    if (edgeIndex === undefined) continue;
    const vertices = graph.edgeVertices[edgeIndex];
    if (vertices?.some((vertex) => occupied.has(vertex))) {
      rate = Math.min(rate, harbor.kind === resource ? 2 : 3);
    }
  }
  return rate;
}

/** Direct graph memberships for rules which already have a graph instance. */
export function edgeEndpoints(
  graph: BoardGraph,
  edge: string,
): readonly [VertexId, VertexId] | null {
  const index = graph.edgeIndex[edge];
  return index === undefined ? null : (graph.edgeVertices[index] ?? null);
}
