import { describe, expect, test } from 'vitest';
import { hexToPixel } from '@cp2p/engine/geometry';
import {
  clipSegmentToLoops,
  growLoop,
  hexCornerPoints,
  hexExtents,
  hexUnionLoops,
  loopArea,
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

/** The 19 hexes of a radius-2 board. */
const STANDARD = Array.from({ length: 5 }, (_, i) => i - 2).flatMap((q) =>
  Array.from({ length: 5 }, (_, j) => j - 2)
    .filter((r) => Math.abs(q + r) <= 2)
    .map((r) => ({ q, r })),
);

const ring = (radius: number) =>
  Array.from({ length: 2 * radius + 1 }, (_, i) => i - radius).flatMap((q) =>
    Array.from({ length: 2 * radius + 1 }, (_, j) => j - radius)
      .filter((r) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) === radius)
      .map((r) => ({ q, r })),
  );

const close = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y) < 1e-9;

describe('hex union outlines', () => {
  test('a lone hex is one clockwise loop of its six corners', () => {
    const loops = hexUnionLoops([{ q: 1, r: -1 }], 10);
    expect(loops).toHaveLength(1);
    const [loop = []] = loops;
    expect(loop).toHaveLength(6);
    const corners = hexCornerPoints(hexToPixel(1, -1, 10), 10);
    for (const corner of corners) expect(loop.some((point) => close(point, corner))).toBe(true);
    expect(loopArea(loop)).toBeGreaterThan(0);
  });

  test('duplicate cells count once, and a pair shares no inner edge', () => {
    const loops = hexUnionLoops(
      [
        { q: 0, r: 0 },
        { q: 1, r: 0 },
        { q: 0, r: 0 },
      ],
      10,
    );
    expect(loops.map((loop) => loop.length)).toEqual([10]);
  });

  test('the standard board with its sea ring is one loop of 18 sides per ring hex', () => {
    const loops = hexUnionLoops([...STANDARD, ...ring(3)], 1);
    expect(loops).toHaveLength(1);
    // 6 corner hexes show 3 sides and 12 edge hexes show 2: 42 sides, and one corner each.
    expect(loops[0]).toHaveLength(42);
  });

  test('a fixture footprint joins the outline and makes it longer', () => {
    const board = [...STANDARD, ...ring(3)];
    const withTrack = [...board, { q: 0, r: -3 }, { q: 0, r: -4 }];
    const [plain = []] = hexUnionLoops(board, 1);
    const loops = hexUnionLoops(withTrack, 1);
    expect(loops).toHaveLength(1);
    // The outer track hex adds its 6 sides and removes the 2 it shares with the ring.
    expect(loops[0]).toHaveLength(plain.length + 4);
    const outer = hexCornerPoints(hexToPixel(0, -4, 1), 1)[0];
    expect(loops[0]?.some((point) => outer !== undefined && close(point, outer))).toBe(true);
  });

  test('separate islands give separate clockwise loops', () => {
    const loops = hexUnionLoops(
      [
        { q: 0, r: 0 },
        { q: 1, r: 0 },
        { q: 5, r: 0 },
      ],
      10,
    );
    expect(loops.map((loop) => loop.length).toSorted((a, b) => a - b)).toEqual([6, 10]);
    expect(loops.every((loop) => loopArea(loop) > 0)).toBe(true);
  });

  test('a ring of hexes has an outer loop and an anticlockwise hole', () => {
    const loops = hexUnionLoops(ring(1), 10);
    expect(loops).toHaveLength(2);
    const areas = loops.map(loopArea).toSorted((a, b) => a - b);
    expect(areas[0]).toBeLessThan(0);
    expect(areas[1]).toBeGreaterThan(0);
    // The hole is exactly the missing centre hex.
    const hole = loops.find((loop) => loopArea(loop) < 0) ?? [];
    expect(Math.abs(loopArea(hole))).toBeCloseTo(
      Math.abs(loopArea(hexCornerPoints({ x: 0, y: 0 }, 10))),
    );
  });
});

/** True for a point on the outline of a radius-12 hex around the hex at (0,0) or (1,0) of size 10. */
function onLargerHex(point: { x: number; y: number }): boolean {
  return [hexToPixel(0, 0, 10), hexToPixel(1, 0, 10)].some((center) => {
    const x = Math.abs(point.x - center.x);
    const y = Math.abs(point.y - center.y);
    const half = (Math.sqrt(3) / 2) * 12;
    return (
      x <= half + 1e-9 &&
      x + Math.sqrt(3) * y <= Math.sqrt(3) * 12 + 1e-9 &&
      (Math.abs(x - half) < 1e-9 || Math.abs(x + Math.sqrt(3) * y - Math.sqrt(3) * 12) < 1e-9)
    );
  });
}

describe('growing an outline', () => {
  test('a grown hex outline is the same hex drawn larger', () => {
    const [loop = []] = hexUnionLoops([{ q: 0, r: 0 }], 10);
    const grown = growLoop(loop, 0.2 * 10 * (Math.sqrt(3) / 2));
    for (const corner of hexCornerPoints({ x: 0, y: 0 }, 12))
      expect(grown.some((point) => close(point, corner))).toBe(true);
  });

  test('a grown pair meets where the larger hexes cross', () => {
    const [loop = []] = hexUnionLoops(
      [
        { q: 0, r: 0 },
        { q: 1, r: 0 },
      ],
      10,
    );
    const grown = growLoop(loop, 0.2 * 10 * (Math.sqrt(3) / 2));
    // Every grown corner lies on the outline of one of the two larger hexes.
    expect(grown.every(onLargerHex)).toBe(true);
    expect(loopArea(grown)).toBeGreaterThan(loopArea(loop));
  });

  test('a hole shrinks as its hexes grow', () => {
    const hole = hexUnionLoops(ring(1), 10).find((loop) => loopArea(loop) < 0) ?? [];
    const grown = growLoop(hole, 1);
    expect(Math.abs(loopArea(grown))).toBeLessThan(Math.abs(loopArea(hole)));
  });
});

describe('clipping a segment', () => {
  test('keeps the parts inside the loops and skips holes', () => {
    const loops = hexUnionLoops(ring(1), 10);
    const y = 0;
    const pieces = clipSegmentToLoops({ x: -100, y }, { x: 100, y }, loops);
    // Left ring hex, then right ring hex: the centre hole is left out.
    expect(pieces).toHaveLength(2);
    const [left, right] = pieces;
    expect(left?.[0].x).toBeCloseTo(-3 * (Math.sqrt(3) / 2) * 10);
    expect(left?.[1].x).toBeCloseTo(-(Math.sqrt(3) / 2) * 10);
    expect(right?.[0].x).toBeCloseTo((Math.sqrt(3) / 2) * 10);
    expect(right?.[1].x).toBeCloseTo(3 * (Math.sqrt(3) / 2) * 10);
  });

  test('a segment that ends inside is cut at its end, and one outside is dropped', () => {
    const loops = hexUnionLoops([{ q: 0, r: 0 }], 10);
    const pieces = clipSegmentToLoops({ x: -100, y: 0 }, { x: 0, y: 0 }, loops);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.[0].x).toBeCloseTo(-(Math.sqrt(3) / 2) * 10);
    expect(pieces[0]?.[1]).toEqual({ x: 0, y: 0 });
    expect(clipSegmentToLoops({ x: -100, y: 50 }, { x: 100, y: 50 }, loops)).toEqual([]);
  });

  test('a line through a corner only touching the loop is not a piece', () => {
    const loops = hexUnionLoops([{ q: 0, r: 0 }], 10);
    expect(clipSegmentToLoops({ x: -100, y: -10 }, { x: 100, y: -10 }, loops)).toEqual([]);
  });
});
