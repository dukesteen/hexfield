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
