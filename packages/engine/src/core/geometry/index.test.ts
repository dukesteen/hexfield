import { array, assert, integer, property } from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  buildBoardGraph,
  edgeId,
  edgeToPixel,
  hexId,
  hexToPixel,
  HEX_DIRECTIONS,
  vertexId,
  vertexToPixel,
  type BoardGraph,
  type HexCoord,
} from './index.js';

function radiusHexes(radius: number): HexCoord[] {
  const result: HexCoord[] = [];
  for (let q = -radius; q <= radius; q++) {
    for (let r = -radius; r <= radius; r++) {
      if (Math.abs(q + r) <= radius) result.push({ q, r });
    }
  }
  return result;
}

function pixelKey(x: number, y: number): string {
  return `${Math.round(x * 1e6)},${Math.round(y * 1e6)}`;
}

function addMembership(map: Map<string, Set<string>>, key: string, hex: string): void {
  let members = map.get(key);
  if (!members) {
    members = new Set();
    map.set(key, members);
  }
  members.add(hex);
}

function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing value at ${index}`);
  return value;
}

function graphIndex(indices: Readonly<Record<string, number>>, id: string): number {
  const index = indices[id];
  if (index === undefined) throw new Error(`Missing graph index for ${id}`);
  return index;
}

function expectPixelMemberships(hexes: readonly HexCoord[], graph: BoardGraph): void {
  const cornerAngles = [
    -Math.PI / 2,
    -Math.PI / 6,
    Math.PI / 6,
    Math.PI / 2,
    (5 * Math.PI) / 6,
    (7 * Math.PI) / 6,
  ];
  const pixelVertices = new Map<string, Set<string>>();
  const pixelEdges = new Map<string, Set<string>>();

  for (const hex of hexes) {
    const center = hexToPixel(hex.q, hex.r, 1);
    const corners = cornerAngles.map((angle) => ({
      x: center.x + Math.cos(angle),
      y: center.y + Math.sin(angle),
    }));
    for (let i = 0; i < 6; i++) {
      const first = at(corners, i);
      const second = at(corners, (i + 1) % 6);
      addMembership(pixelVertices, pixelKey(first.x, first.y), hexId(hex));
      addMembership(
        pixelEdges,
        pixelKey((first.x + second.x) / 2, (first.y + second.y) / 2),
        hexId(hex),
      );
    }
  }

  expect(pixelVertices.size).toBe(graph.vertexIds.length);
  expect(pixelEdges.size).toBe(graph.edgeIds.length);
  for (const vertex of graph.vertexIds) {
    const point = vertexToPixel(vertex, 1);
    const members = pixelVertices.get(pixelKey(point.x, point.y));
    expect([...(members ?? [])].toSorted()).toEqual(
      at(graph.vertexHexes, graphIndex(graph.vertexIndex, vertex)),
    );
  }
  for (const edge of graph.edgeIds) {
    const { midpoint } = edgeToPixel(edge, 1);
    const members = pixelEdges.get(pixelKey(midpoint.x, midpoint.y));
    expect([...(members ?? [])].toSorted()).toEqual(
      at(graph.edgeHexes, graphIndex(graph.edgeIndex, edge)),
    );
  }
}

function hasHole(hexes: readonly HexCoord[]): boolean {
  const occupied = new Set(hexes.map(hexId));
  const minQ = Math.min(...hexes.map((hex) => hex.q)) - 1;
  const maxQ = Math.max(...hexes.map((hex) => hex.q)) + 1;
  const minR = Math.min(...hexes.map((hex) => hex.r)) - 1;
  const maxR = Math.max(...hexes.map((hex) => hex.r)) + 1;
  const outside = new Set<string>();
  const queue: HexCoord[] = [{ q: minQ, r: minR }];
  for (let i = 0; i < queue.length; i++) {
    const hex = at(queue, i);
    const id = hexId(hex);
    if (outside.has(id) || occupied.has(id)) continue;
    outside.add(id);
    for (const direction of HEX_DIRECTIONS) {
      const next = { q: hex.q + direction.q, r: hex.r + direction.r };
      if (next.q >= minQ && next.q <= maxQ && next.r >= minR && next.r <= maxR) {
        queue.push(next);
      }
    }
  }
  for (let q = minQ; q <= maxQ; q++) {
    for (let r = minR; r <= maxR; r++) {
      const id = hexId({ q, r });
      if (!occupied.has(id) && !outside.has(id)) return true;
    }
  }
  return false;
}

describe('pointy-top board geometry', () => {
  test.each([
    [2, 19, 54, 72],
    [3, 37, 96, 132],
  ])(
    'radius %i has %i hexes, %i vertices and %i edges',
    (radius, hexCount, vertexCount, edgeCount) => {
      const hexes = radiusHexes(radius);
      const graph = buildBoardGraph(hexes);
      expect(graph.hexIds).toHaveLength(hexCount);
      expect(graph.vertexIds).toHaveLength(vertexCount);
      expect(graph.edgeIds).toHaveLength(edgeCount);
      expect(graph.edgeIds.length).toBe(graph.vertexIds.length + graph.hexIds.length - 1);
      expectPixelMemberships(hexes, graph);
    },
  );

  test('canonical ownership joins shared corners and sides', () => {
    const center = { q: 0, r: 0 };
    expect(vertexId(center, 'NE')).toBe(vertexId({ q: 1, r: -1 }, 'S'));
    expect(vertexId(center, 'SE')).toBe(vertexId({ q: 0, r: 1 }, 'N'));
    expect(edgeId(center, 'E')).toBe(edgeId({ q: 1, r: 0 }, 'W'));
    expect(edgeId(center, 'SE')).toBe(edgeId({ q: 0, r: 1 }, 'NW'));
  });

  test('index records do not inherit prototype names as board IDs', () => {
    const graph = buildBoardGraph([{ q: 0, r: 0 }]);
    for (const id of ['constructor', 'toString', '__proto__']) {
      expect(graph.hexIndex[id]).toBeUndefined();
      expect(graph.vertexIndex[id]).toBeUndefined();
      expect(graph.edgeIndex[id]).toBeUndefined();
    }
  });

  test('random connected sets have consistent incidence and symmetric neighbors', () => {
    assert(
      property(array(integer({ min: 0, max: 5 }), { maxLength: 40 }), (steps) => {
        const hexes: HexCoord[] = [{ q: 0, r: 0 }];
        const seen = new Set<string>(['h:0,0']);
        let current = at(hexes, 0);
        for (const step of steps) {
          const direction = at(HEX_DIRECTIONS, step);
          current = { q: current.q + direction.q, r: current.r + direction.r };
          if (!seen.has(hexId(current))) {
            seen.add(hexId(current));
            hexes.push(current);
          }
        }
        const graph = buildBoardGraph(hexes);
        expect(buildBoardGraph(hexes.toReversed())).toEqual(graph);
        expectPixelMemberships(hexes, graph);
        for (const vertex of graph.vertexIds) {
          const index = graphIndex(graph.vertexIndex, vertex);
          expect(at(graph.vertexHexes, index).length).toBeGreaterThanOrEqual(1);
          expect(at(graph.vertexHexes, index).length).toBeLessThanOrEqual(3);
          expect(at(graph.vertexEdges, index).length).toBeGreaterThanOrEqual(2);
          expect(at(graph.vertexEdges, index).length).toBeLessThanOrEqual(3);
          for (const neighbor of at(graph.vertexNeighbors, index)) {
            expect(at(graph.vertexNeighbors, graphIndex(graph.vertexIndex, neighbor))).toContain(
              vertex,
            );
          }
          for (const edge of at(graph.vertexEdges, index)) {
            expect(at(graph.edgeVertices, graphIndex(graph.edgeIndex, edge))).toContain(vertex);
          }
        }
        for (const edge of graph.edgeIds) {
          const index = graphIndex(graph.edgeIndex, edge);
          expect(at(graph.edgeHexes, index).length).toBeGreaterThanOrEqual(1);
          expect(at(graph.edgeHexes, index).length).toBeLessThanOrEqual(2);
          expect(at(graph.edgeVertices, index)).toHaveLength(2);
          for (const vertex of at(graph.edgeVertices, index)) {
            expect(at(graph.vertexEdges, graphIndex(graph.vertexIndex, vertex))).toContain(edge);
          }
        }
        const euler = graph.vertexIds.length - graph.edgeIds.length + graph.hexIds.length;
        expect(hasHole(hexes) || euler === 1).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
