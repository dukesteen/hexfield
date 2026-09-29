import { describe, expect, test } from 'vitest';
import { edgeToPixel, vertexToPixel } from '@cp2p/engine/geometry';
import type { EdgeId } from '@cp2p/engine/geometry';
import {
  shipEdgeEnds,
  shipHeadings,
  shipVariant,
  shipVariantAmong,
  shipVariantForEdge,
} from './shipVariant.js';
import { shipAnchor } from './shipLayout.js';

const COS = Math.cos(Math.PI / 6);
const SIN = Math.sin(Math.PI / 6);
/**
 * Bow direction of each authored SVG on screen (y grows downward), read from the art: the
 * pointed bow and the stern castle of each hull in `sf-ship-<color>-<n>.svg`.
 */
const HEADING: Record<number, readonly [number, number]> = {
  1: [COS, SIN],
  2: [0, -1],
  3: [COS, -SIN],
  4: [0, 1],
  5: [-COS, SIN],
  6: [-COS, -SIN],
};

const SIDES = ['NE', 'W', 'NW'] as const;

describe('ship hulls', () => {
  test('both headings of every edge line lie along the edge', () => {
    for (let q = -3; q < 3; q++)
      for (let r = -3; r < 3; r++)
        for (const side of SIDES)
          for (const bow of ['forward', 'back'] as const) {
            const id = `e:${q},${r},${side}` as const;
            const angle = edgeToPixel(id, 1).angle;
            const [hx, hy] = HEADING[shipVariant(id, bow)] ?? [0, 0];
            // Parallel lines have a zero cross product.
            expect(Math.abs(Math.cos(angle) * hy - Math.sin(angle) * hx)).toBeLessThan(1e-9);
          }
  });

  test('the forward bow points from the first end of the edge to the second', () => {
    for (const side of SIDES) {
      const id = `e:1,-2,${side}` as const;
      const [from, to] = shipEdgeEnds(id).map((vertex) => vertexToPixel(vertex, 1));
      if (!from || !to) throw new Error('Missing ends');
      const [hx, hy] = HEADING[shipVariant(id, 'forward')] ?? [0, 0];
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      expect(((to.x - from.x) * hx + (to.y - from.y) * hy) / length).toBeCloseTo(1);
      const [bx, by] = HEADING[shipVariant(id, 'back')] ?? [0, 0];
      expect(((to.x - from.x) * bx + (to.y - from.y) * by) / length).toBeCloseTo(-1);
    }
  });

  test('each line has its two headings and a stable fallback', () => {
    expect([shipVariant('e:0,0,NE', 'forward'), shipVariant('e:0,0,NE', 'back')]).toEqual([1, 6]);
    expect([shipVariant('e:0,0,W', 'forward'), shipVariant('e:0,0,W', 'back')]).toEqual([2, 4]);
    expect([shipVariant('e:0,0,NW', 'forward'), shipVariant('e:0,0,NW', 'back')]).toEqual([3, 5]);
    expect(shipVariantForEdge('e:2,3,NE')).toBe(shipVariantForEdge('e:2,3,NE'));
    expect([1, 6]).toContain(shipVariantForEdge('e:2,3,NE'));
  });

  test('ships head away from their owner along the route', () => {
    // A settlement on the north corner of hex 0,0 and a city on its south corner, with a ship on
    // every edge that meets them: all six hulls, each bow pointing away from the building.
    const ships = [
      'e:1,-1,W',
      'e:0,0,NE',
      'e:0,0,NW',
      'e:0,1,W',
      'e:0,1,NW',
      'e:-1,1,NE',
    ] as const satisfies readonly EdgeId[];
    const headings = shipHeadings({
      roads: [],
      buildings: [
        { vertex: 'v:0,0,N', seat: 0, kind: 'settlement' },
        { vertex: 'v:0,0,S', seat: 0, kind: 'city' },
        // Another player's building at a far end changes nothing.
        { vertex: 'v:1,-1,S', seat: 1, kind: 'city' },
      ],
      ships: ships.map((edge) => ({ edge, seat: 0 })),
    });
    expect(ships.map((edge) => headings.get(edge))).toEqual([2, 1, 5, 4, 3, 6]);
  });

  test('a line of ships sails outward in one direction, through a road', () => {
    const route = ['e:0,1,W', 'e:-1,2,NE', 'e:0,2,W'] as const satisfies readonly EdgeId[];
    const headings = shipHeadings({
      roads: [{ edge: 'e:1,0,W', seat: 0 }],
      buildings: [{ vertex: 'v:1,-1,S', seat: 0, kind: 'settlement' }],
      ships: [{ edge: 'e:0,1,NW', seat: 0 }, ...route.map((edge) => ({ edge, seat: 0 as const }))],
    });
    // Down the south-east side to the south corner, then south, south-east and south again.
    expect(headings.get('e:0,1,NW')).toBe(shipVariant('e:0,1,NW', 'back'));
    expect(route.map((edge) => headings.get(edge))).toEqual([4, 1, 4]);
  });

  test('a ship yet to be placed heads away from its owner', () => {
    const pieces = {
      roads: [],
      buildings: [{ vertex: 'v:0,0,S' as const, seat: 0 as const, kind: 'city' as const }],
      ships: [],
    };
    expect(shipVariantAmong(pieces, 'e:0,1,W', 0)).toBe(4);
    expect(shipVariantAmong(pieces, 'e:0,1,NW', 0)).toBe(3);
  });

  test('a side-on hull is pinned at its own centre, an end-on one at its silhouette', () => {
    for (const variant of [1, 3, 5, 6] as const)
      expect(shipAnchor(variant).y).toBeGreaterThan(0.55);
    for (const variant of [2, 4] as const) expect(shipAnchor(variant)).toEqual({ x: 0.5, y: 0.45 });
  });
});
