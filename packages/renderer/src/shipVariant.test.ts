import { expect, test } from 'vitest';
import { edgeToPixel } from '@cp2p/engine/geometry';
import { shipVariantForEdge } from './shipVariant.js';

const COS = Math.cos(Math.PI / 6);
const SIN = Math.sin(Math.PI / 6);
/** Hull heading of each authored SVG as a screen-space direction (y grows downward). */
const HEADING: Record<number, readonly [number, number]> = {
  1: [COS, SIN],
  2: [0, -1],
  3: [COS, -SIN],
  4: [0, 1],
  5: [-COS, SIN],
  6: [-COS, -SIN],
};

test('a ship always heads along the line of its own edge', () => {
  for (let q = -3; q < 3; q++)
    for (let r = -3; r < 3; r++)
      for (const side of ['NE', 'W', 'NW'] as const) {
        const id = `e:${q},${r},${side}` as const;
        const angle = edgeToPixel(id, 1).angle;
        const [hx, hy] = HEADING[shipVariantForEdge(id)] ?? [0, 0];
        // Parallel lines have a zero cross product.
        expect(Math.abs(Math.cos(angle) * hy - Math.sin(angle) * hx)).toBeLessThan(1e-9);
      }
});

test('each edge line uses both of its headings across the board', () => {
  const seen = new Map<string, Set<number>>();
  for (let q = -8; q < 8; q++)
    for (let r = -8; r < 8; r++)
      for (const side of ['NE', 'W', 'NW'] as const) {
        const set = seen.get(side) ?? new Set<number>();
        set.add(shipVariantForEdge(`e:${q},${r},${side}`));
        seen.set(side, set);
      }
  const sorted = (side: string) => [...(seen.get(side) ?? [])].toSorted((a, b) => a - b);
  expect(sorted('NE')).toEqual([1, 6]);
  expect(sorted('W')).toEqual([2, 4]);
  expect(sorted('NW')).toEqual([3, 5]);
});

test('the same edge always draws the same ship', () => {
  expect(shipVariantForEdge('e:2,3,NE')).toBe(shipVariantForEdge('e:2,3,NE'));
});
