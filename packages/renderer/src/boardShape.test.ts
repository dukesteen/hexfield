import { expect, test } from 'vitest';
import { hexToPixel } from '@cp2p/engine/geometry';
import {
  hexCornerPoints,
  hexExtents,
  isLandTerrain,
  islandBoundarySegments,
  landIslands,
} from './boardShape.js';

const cell = (q: number, r: number, terrain: string) => ({ id: `h:${q},${r}`, q, r, terrain });

/** Two land hexes side by side, a sea hex, another island of one hex, and a fog hex. */
const HEXES = [
  cell(0, 0, 'forest'),
  cell(1, 0, 'gold'),
  cell(2, 0, 'sea'),
  cell(3, 0, 'desert'),
  cell(0, 1, 'fog'),
  cell(-1, 1, 'sea'),
];

test('land is everything except sea and unrevealed fog', () => {
  expect(['forest', 'gold', 'desert', 'hills'].every(isLandTerrain)).toBe(true);
  expect(isLandTerrain('sea')).toBe(false);
  expect(isLandTerrain('fog')).toBe(false);
});

test('islands are connected land, and fog and sea separate them', () => {
  expect(landIslands(HEXES)).toEqual([['h:0,0', 'h:1,0'], ['h:3,0']]);
});

test('a fog reveal that turns fog into land joins the island it touches', () => {
  const revealed = HEXES.map((hex) => (hex.id === 'h:0,1' ? { ...hex, terrain: 'hills' } : hex));
  expect(landIslands(revealed)).toEqual([['h:0,0', 'h:0,1', 'h:1,0'], ['h:3,0']]);
});

test('the coastline of a lone hex has six segments and a pair has ten', () => {
  const lone = islandBoundarySegments([cell(0, 0, 'hills')], 10);
  expect(lone).toHaveLength(6);
  const pair = islandBoundarySegments([cell(0, 0, 'hills'), cell(1, 0, 'hills')], 10);
  expect(pair).toHaveLength(10);
  expect(new Set(pair.map((segment) => segment.island))).toEqual(new Set([0]));
});

test('boundary segments join the corners of their hex', () => {
  const [segment] = islandBoundarySegments([cell(1, 1, 'hills')], 20);
  const corners = hexCornerPoints(hexToPixel(1, 1, 20), 20);
  expect(corners).toContainEqual(segment?.from);
  expect(corners).toContainEqual(segment?.to);
});

test('extents are the exact pixel box of the hexes plus the margin', () => {
  const size = 10;
  const box = hexExtents([cell(0, 0, 'sea'), cell(2, 1, 'sea')], size, 3);
  const far = hexToPixel(2, 1, size);
  expect(box).toEqual({
    minX: -(Math.sqrt(3) / 2) * size - 3,
    maxX: far.x + (Math.sqrt(3) / 2) * size + 3,
    minY: -size - 3,
    maxY: far.y + size + 3,
  });
  expect(hexExtents([], size)).toBeNull();
});
