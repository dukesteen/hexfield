import { expect, test } from 'vitest';
import { hexToPixel } from '@cp2p/engine/geometry';
import { FRAME_GROWTH, boardFrameLoops } from './boardFrame.js';
import { hexCornerPoints, loopArea } from './boardShape.js';

const close = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y) < 1e-9;

/** The 37 cells the authored standard frame surrounds: 19 board hexes and the sea ring. */
const STANDARD_WITH_RING = Array.from({ length: 7 }, (_, i) => i - 3).flatMap((q) =>
  Array.from({ length: 7 }, (_, j) => j - 3)
    .filter((r) => Math.abs(q + r) <= 3)
    .map((r) => ({ q, r })),
);

test('the standard frame reaches the corners of the authored art', () => {
  // The authored frame is hexes of radius 96 around tiles of radius 80.
  const [loop = []] = boardFrameLoops(STANDARD_WITH_RING, 80);
  expect(1 + FRAME_GROWTH).toBe(96 / 80);
  const top = hexCornerPoints(hexToPixel(0, -3, 80), 96)[0];
  const left = hexCornerPoints(hexToPixel(-3, 0, 80), 96)[4];
  expect(loop.some((point) => top !== undefined && close(point, top))).toBe(true);
  expect(loop.some((point) => left !== undefined && close(point, left))).toBe(true);
});

test('a fixture cell outside the ring is framed as well', () => {
  const cells = [...STANDARD_WITH_RING, { q: 0, r: -4 }];
  const loops = boardFrameLoops(cells, 80);
  expect(loops).toHaveLength(1);
  const outerTop = hexCornerPoints(hexToPixel(0, -4, 80), 96)[0];
  expect(loops[0]?.some((point) => outerTop !== undefined && close(point, outerTop))).toBe(true);
});

test('islands far apart get a frame each', () => {
  const loops = boardFrameLoops(
    [
      { q: 0, r: 0 },
      { q: 6, r: 0 },
    ],
    10,
  );
  expect(loops).toHaveLength(2);
  expect(loops.every((loop) => loopArea(loop) > 0)).toBe(true);
});
