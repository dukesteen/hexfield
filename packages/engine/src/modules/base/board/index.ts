import {
  classifyEdge,
  detectIslands,
  isLandTerrain,
  isSeaTerrain,
  vertexTouchesLand,
} from '../../../core/board/index.js';
import type { EdgeKind, Island } from '../../../core/board/index.js';
import { buildBoardGraph } from '../../../core/geometry/index.js';
import type { BoardGraph, VertexId } from '../../../core/geometry/index.js';
import type { GameState } from '../../../core/state/types.js';
import type { Seat } from '../../../core/types/index.js';

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

interface Terrain {
  land: ReadonlySet<string>;
  seaEdges: ReadonlySet<string>;
  waterVertices: ReadonlySet<string>;
  edgeKinds: ReadonlyMap<string, EdgeKind>;
  islands: readonly Island[];
}

const terrains = new WeakMap<GameState['board']['hexes'], Terrain>();

function terrain(state: GameState): Terrain {
  const hexes = state.board.hexes;
  let cached = terrains.get(hexes);
  if (!cached) {
    const graph = boardGraph(state);
    const land = new Set(hexes.filter((hex) => isLandTerrain(hex.terrain)).map((hex) => hex.id));
    const sea = new Set(hexes.filter((hex) => isSeaTerrain(hex.terrain)).map((hex) => hex.id));
    cached = {
      land,
      seaEdges: new Set(
        graph.edgeIds.filter((id) => {
          const owners = graph.edgeHexes[graph.edgeIndex[id] ?? -1] ?? [];
          return owners.length === 1 || owners.some((owner) => sea.has(owner));
        }),
      ),
      waterVertices: new Set(graph.vertexIds.filter((id) => !vertexTouchesLand(graph, id, land))),
      edgeKinds: new Map(
        graph.edgeIds.flatMap((id) => {
          const kind = classifyEdge(graph, id, land);
          return kind ? [[id, kind] as const] : [];
        }),
      ),
      islands: detectIslands(hexes),
    };
    terrains.set(hexes, cached);
  }
  return cached;
}

/** True for a board hex that is land: not sea and not unrevealed fog. */
export function isLandHex(state: GameState, hex: string): boolean {
  return terrain(state).land.has(hex);
}

/** True when a vertex touches at least one land hex, so a base piece may stand there. */
export function vertexOnLand(state: GameState, vertex: string): boolean {
  return (
    boardGraph(state).vertexIndex[vertex] !== undefined && !terrain(state).waterVertices.has(vertex)
  );
}

/** An edge's position relative to land, or null off board. Base roads need `land` or `coastal`. */
export function edgeKindOf(state: GameState, edge: string): EdgeKind | null {
  return terrain(state).edgeKinds.get(edge) ?? null;
}

/**
 * True when an edge has a revealed sea side: a sea hex or the off-board side of a perimeter edge.
 * Fog is never counted, so a ship never sits where a reveal could make both sides land.
 */
export function edgeHasSeaSide(state: GameState, edge: string): boolean {
  return terrain(state).seaEdges.has(edge);
}

/** True when a road or a ship already sits on the edge. */
export function edgeOccupied(state: GameState, edge: string): boolean {
  return (
    state.board.roads.some((road) => road.edge === edge) ||
    (state.board.ships?.some((ship) => ship.edge === edge) ?? false)
  );
}

/** The board's islands, cached per hex list. Recomputed automatically when a reveal replaces hexes. */
export function boardIslands(state: GameState): readonly Island[] {
  return terrain(state).islands;
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
export function harborRate(state: GameState, seat: Seat, resource: string): number {
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
