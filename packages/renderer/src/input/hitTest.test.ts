import { expect, test } from 'vitest';
import { buildBoardGraph, edgeToPixel, hexToPixel, vertexToPixel } from '@cp2p/engine/geometry';
import { hitTestBoard } from './hitTest.js';

const graph = buildBoardGraph([
  { q: 0, r: 0 },
  { q: 1, r: 0 },
]);

test('hex hit testing uses axial regions including corners', () => {
  const hit = hitTestBoard({
    graph,
    point: { x: 40, y: 24 },
    hexSize: 54,
    worldUnitsPerCssPixel: 1,
    mode: 'hex',
  });
  expect(hit).toEqual({ kind: 'hex', id: 'h:0,0' });
  expect(
    hitTestBoard({
      graph,
      point: { x: 45, y: 20 },
      hexSize: 54,
      worldUnitsPerCssPixel: 1,
      mode: 'hex',
    }),
  ).toEqual({ kind: 'hex', id: 'h:0,0' });
  expect(
    hitTestBoard({
      graph,
      point: { x: 45, y: -20 },
      hexSize: 54,
      worldUnitsPerCssPixel: 1,
      mode: 'hex',
    }),
  ).toEqual({ kind: 'hex', id: 'h:0,0' });
  expect(
    hitTestBoard({
      graph,
      point: { x: 0, y: 0 },
      hexSize: 54,
      worldUnitsPerCssPixel: 1,
      mode: 'hex',
    }),
  ).toEqual({ kind: 'hex', id: 'h:0,0' });
});

test('vertex targets keep a 44 CSS-pixel diameter when zoomed out', () => {
  const id = graph.vertexIds[0];
  if (!id) throw new Error('Graph has no vertices');
  const point = vertexToPixel(id, 54);
  expect(
    hitTestBoard({
      graph,
      point: { x: point.x + 40, y: point.y },
      hexSize: 54,
      worldUnitsPerCssPixel: 2,
      mode: 'vertex',
      legalVertices: new Set([id]),
    }),
  ).toEqual({ kind: 'vertex', id });
  expect(
    hitTestBoard({
      graph,
      point: { x: point.x + 45, y: point.y },
      hexSize: 54,
      worldUnitsPerCssPixel: 2,
      mode: 'vertex',
      legalVertices: new Set([id]),
    }),
  ).toBeNull();
});

test('constrained hit testing never falls back to an illegal adjacent feature', () => {
  const nearest = graph.vertexIds[0];
  const other = graph.vertexIds[1];
  if (!nearest || !other) throw new Error('Graph has too few vertices');
  const point = vertexToPixel(nearest, 54);
  expect(
    hitTestBoard({
      graph,
      point,
      hexSize: 54,
      worldUnitsPerCssPixel: 1,
      mode: 'vertex',
      legalVertices: new Set(),
    }),
  ).toBeNull();
  expect(
    hitTestBoard({
      graph,
      point,
      hexSize: 54,
      worldUnitsPerCssPixel: 1,
      mode: 'vertex',
      legalVertices: new Set([other]),
    }),
  ).toBeNull();
});

test('edge distance uses exact topology endpoints and selects only legal edges', () => {
  const id = graph.edgeIds[0];
  if (!id) throw new Error('Graph has no edges');
  const point = edgeToPixel(id, 54).midpoint;
  expect(
    hitTestBoard({
      graph,
      point,
      hexSize: 54,
      worldUnitsPerCssPixel: 1,
      mode: 'edge',
      legalEdges: new Set([id]),
    }),
  ).toEqual({ kind: 'edge', id });
  expect(
    hitTestBoard({
      graph,
      point: hexToPixel(0, 0, 54),
      hexSize: 54,
      worldUnitsPerCssPixel: 1,
      mode: 'edge',
      legalEdges: new Set(),
    }),
  ).toBeNull();
});

/** A land hex among sea hexes, like a seafaring board. */
const seaBoard = buildBoardGraph([
  { q: 0, r: 0 },
  { q: 1, r: 0 },
  { q: 1, r: -1 },
]);

test('a ship edge between two sea hexes is hit only while it is a legal target', () => {
  const edge = seaBoard.edgeIds.find((id) => {
    const owners = seaBoard.edgeHexes[seaBoard.edgeIndex[id] ?? -1] ?? [];
    return owners.length === 2 && owners.includes('h:1,0') && owners.includes('h:1,-1');
  });
  if (!edge) throw new Error('The sea board has no edge between the two sea hexes');
  const middle = edgeToPixel(edge, 54).midpoint;
  const options = {
    graph: seaBoard,
    point: middle,
    hexSize: 54,
    worldUnitsPerCssPixel: 1,
    mode: 'edge' as const,
  };
  expect(hitTestBoard({ ...options, legalEdges: new Set([edge]) })).toEqual({
    kind: 'edge',
    id: edge,
  });
  expect(hitTestBoard({ ...options, legalEdges: new Set() })).toBeNull();
});

test('the pirate can be sent to any legal sea hex and to no other hex', () => {
  const sea = 'h:1,0';
  const options = {
    graph: seaBoard,
    point: hexToPixel(1, 0, 54),
    hexSize: 54,
    worldUnitsPerCssPixel: 1,
    mode: 'hex' as const,
  };
  expect(hitTestBoard({ ...options, legalHexes: new Set([sea]) })).toEqual({
    kind: 'hex',
    id: sea,
  });
  expect(hitTestBoard({ ...options, legalHexes: new Set(['h:0,0']) })).toBeNull();
});
