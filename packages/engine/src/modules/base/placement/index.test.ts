import { describe, expect, test } from 'vitest';
import { buildBoardGraph } from '../../../core/geometry/index.js';
import type { GameState } from '../../../core/state/types.js';
import {
  canPlaceRoad,
  canPlaceSettlement,
  canUpgradeCity,
  legalCityVertices,
  legalRoadEdges,
  legalSettlementVertices,
} from './index.js';

const coords = Array.from({ length: 5 }, (_, q) => q - 2).flatMap((q) =>
  Array.from({ length: 5 }, (_, r) => r - 2)
    .filter((r) => Math.abs(q + r) <= 2)
    .map((r) => ({ q, r })),
);
const graph = buildBoardGraph(coords);
function state(board: Partial<GameState['board']> = {}): GameState {
  return {
    schema: 1,
    engineVersion: 'test',
    config: { modules: [], seats: [0, 1], options: {} },
    board: {
      hexes: coords.map(({ q, r }) => ({ id: `h:${q},${r}`, q, r, terrain: 'forest', token: 3 })),
      harbors: [],
      roads: [],
      buildings: [],
      robberHex: 'h:0,0',
      ...board,
    },
    seats: [],
    bank: {},
    decks: {},
    turn: { number: 0, activeSeat: 0, phase: [] },
    awards: {},
    counters: { nextOfferId: 0, nextSlotId: 0, inputSeq: 0 },
    ext: {},
    result: null,
  };
}
function firstNeighbor(vertex: string): string {
  const neighbor = graph.vertexNeighbors[graph.vertexIndex[vertex] ?? -1]?.[0];
  if (!neighbor) throw new Error('No neighbor');
  return neighbor;
}
function edgeAt(vertex: string): string {
  const edge = graph.vertexEdges[graph.vertexIndex[vertex] ?? -1]?.[0];
  if (!edge) throw new Error('No edge');
  return edge;
}

describe('pure placement helpers', () => {
  test('setup accepts coastal land vertices, rejects adjacent and occupied vertices', () => {
    const coastal = graph.vertexIds.find(
      (vertex) => graph.vertexHexes[graph.vertexIndex[vertex] ?? -1]?.length === 1,
    );
    if (!coastal) throw new Error('No coast');
    expect(canPlaceSettlement(state(), 0, coastal, { setup: true })).toBe(true);
    expect(canPlaceSettlement(state(), 0, 'constructor', { setup: true })).toBe(false);
    const occupied = state({ buildings: [{ vertex: coastal, seat: 1, kind: 'settlement' }] });
    expect(canPlaceSettlement(occupied, 0, coastal, { setup: true })).toBe(false);
    expect(canPlaceSettlement(occupied, 0, firstNeighbor(coastal), { setup: true })).toBe(false);
    expect(legalSettlementVertices(occupied, 0, { setup: true })).not.toContain(
      firstNeighbor(coastal),
    );
  });
  test('ordinary settlement needs own road; city needs own settlement', () => {
    const vertex = graph.vertexIds[0];
    if (!vertex) throw new Error('No vertex');
    expect(canPlaceSettlement(state(), 0, vertex)).toBe(false);
    expect(
      canPlaceSettlement(state({ roads: [{ edge: edgeAt(vertex), seat: 0 }] }), 0, vertex),
    ).toBe(true);
    const occupied = state({ buildings: [{ vertex, seat: 0, kind: 'settlement' }] });
    expect(canUpgradeCity(occupied, 0, vertex)).toBe(true);
    expect(canUpgradeCity(occupied, 1, vertex)).toBe(false);
    expect(legalCityVertices(occupied, 0)).toEqual([vertex]);
    expect(
      canUpgradeCity(state({ buildings: [{ vertex, seat: 0, kind: 'city' }] }), 0, vertex),
    ).toBe(false);
  });
  test('setup road touches its just-placed settlement', () => {
    const vertex = graph.vertexIds[0];
    if (!vertex) throw new Error('No vertex');
    const placed = state({ buildings: [{ vertex, seat: 0, kind: 'settlement' }] });
    const edge = edgeAt(vertex);
    expect(canPlaceRoad(placed, 0, edge, { setupVertex: vertex })).toBe(true);
    expect(canPlaceRoad(placed, 1, edge, { setupVertex: vertex })).toBe(false);
    expect(legalRoadEdges(placed, 0, { setupVertex: vertex })).toContain(edge);
    expect(canPlaceRoad(placed, 0, 'toString', { setupVertex: vertex })).toBe(false);
  });
  test('opponent building cuts an existing road connection, including at coast', () => {
    const edge = graph.edgeIds.find((candidate) => {
      const vertices = graph.edgeVertices[graph.edgeIndex[candidate] ?? -1] ?? [];
      return vertices.some(
        (vertex) => (graph.vertexEdges[graph.vertexIndex[vertex] ?? -1]?.length ?? 0) === 3,
      );
    });
    if (!edge) throw new Error('No edge');
    const [a, b] = graph.edgeVertices[graph.edgeIndex[edge] ?? -1] ?? [];
    if (!a || !b) throw new Error('No endpoints');
    const next = graph.vertexEdges[graph.vertexIndex[a] ?? -1]?.find(
      (candidate) => candidate !== edge,
    );
    if (!next) throw new Error('No next edge');
    const open = state({ roads: [{ edge, seat: 0 }] });
    expect(canPlaceRoad(open, 0, next)).toBe(true);
    expect(
      canPlaceRoad(
        state({
          roads: [{ edge, seat: 0 }],
          buildings: [{ vertex: a, seat: 1, kind: 'settlement' }],
        }),
        0,
        next,
      ),
    ).toBe(false);
    expect(
      canPlaceRoad(
        state({
          roads: [{ edge, seat: 0 }],
          buildings: [{ vertex: a, seat: 0, kind: 'settlement' }],
        }),
        0,
        next,
      ),
    ).toBe(true);
    expect(canPlaceRoad(state({ roads: [{ edge, seat: 0 }] }), 0, edge)).toBe(false);
  });
});
