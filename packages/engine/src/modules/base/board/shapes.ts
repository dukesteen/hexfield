import { coastEdgeCycle } from '../../../core/board/index.js';
import type { HexCoord } from '../../../core/geometry/index.js';
import type { BoardShapeSpec } from '../../../core/modules/types.js';

/** The 19 axial positions of the standard radius-two island. */
export const STANDARD_HEXES: readonly HexCoord[] = Array.from(
  { length: 5 },
  (_, row) => row - 2,
).flatMap((q) =>
  Array.from({ length: 5 }, (_, row) => row - 2)
    .filter((r) => Math.abs(q + r) <= 2)
    .map((r) => ({ q, r })),
);

const STANDARD_COAST = coastEdgeCycle(STANDARD_HEXES);
if (STANDARD_COAST.length !== 30) throw new Error('Invalid standard coast');

/** Offsets into the thirty-edge coast cycle; the resulting slots never share a vertex. */
const STANDARD_HARBOR_OFFSETS = [0, 3, 6, 10, 13, 16, 20, 23, 26];

/** Base board shape: tile, token and harbor bags plus one fixed two-hex fixture slot. */
export const STANDARD_BOARD: BoardShapeSpec = Object.freeze({
  id: 'standard',
  hexes: STANDARD_HEXES,
  terrains: Object.freeze([
    ...Array<string>(4).fill('forest'),
    ...Array<string>(4).fill('pasture'),
    ...Array<string>(4).fill('fields'),
    ...Array<string>(3).fill('hills'),
    ...Array<string>(3).fill('mountains'),
    'desert',
  ]),
  tokens: Object.freeze([2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12]),
  harbors: Object.freeze([
    'generic',
    'generic',
    'generic',
    'generic',
    'brick',
    'lumber',
    'wool',
    'grain',
    'ore',
  ]),
  harborSlots: Object.freeze(
    STANDARD_HARBOR_OFFSETS.map((offset) => {
      const edge = STANDARD_COAST[offset];
      if (!edge) throw new Error('Missing standard harbor slot');
      return edge;
    }),
  ),
  fixtureSlots: Object.freeze([
    Object.freeze({ id: 'north', anchor: { q: 0, r: -3 }, outer: { q: 0, r: -4 } }),
  ]),
  pipCaps: Object.freeze({ forest: 14, pasture: 14, fields: 14, hills: 11, mountains: 11 }),
});
