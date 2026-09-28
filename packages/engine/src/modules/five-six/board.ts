import { coastEdgeCycle } from '../../core/board/index.js';
import type { HexCoord } from '../../core/geometry/index.js';
import type { BoardShapeSpec } from '../../core/modules/types.js';

/** Rows of 3-4-5-6-5-4-3 land hexes: an island elongated along its middle row. */
const ROWS: readonly (readonly [r: number, firstQ: number, length: number])[] = [
  [-3, 1, 3],
  [-2, 0, 4],
  [-1, -1, 5],
  [0, -2, 6],
  [1, -2, 5],
  [2, -2, 4],
  [3, -2, 3],
];

export const FIVE_SIX_HEXES: readonly HexCoord[] = Object.freeze(
  ROWS.flatMap(([r, firstQ, length]) =>
    Array.from({ length }, (_, index) => Object.freeze({ q: firstQ + index, r })),
  ),
);

const COAST = coastEdgeCycle(FIVE_SIX_HEXES);
if (COAST.length !== 38) throw new Error('Invalid five-six coast');

/** Offsets into the 38-edge coast. None shares a vertex or the fixture anchor's frame hex. */
const HARBOR_OFFSETS = [0, 4, 7, 11, 14, 18, 21, 25, 28, 31, 35];

/** The 30-hex board used by five and six players. */
export const FIVE_SIX_BOARD: BoardShapeSpec = Object.freeze({
  id: 'five-six',
  hexes: FIVE_SIX_HEXES,
  terrains: Object.freeze([
    ...Array<string>(6).fill('forest'),
    ...Array<string>(6).fill('pasture'),
    ...Array<string>(6).fill('fields'),
    ...Array<string>(5).fill('hills'),
    ...Array<string>(5).fill('mountains'),
    'desert',
    'desert',
  ]),
  tokens: Object.freeze([
    2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12,
  ]),
  harbors: Object.freeze([
    'generic',
    'generic',
    'generic',
    'generic',
    'generic',
    'brick',
    'lumber',
    'wool',
    'wool',
    'grain',
    'ore',
  ]),
  harborSlots: Object.freeze(
    HARBOR_OFFSETS.map((offset) => {
      const edge = COAST[offset];
      if (!edge) throw new Error('Missing five-six harbor slot');
      return edge;
    }),
  ),
  fixtureSlots: Object.freeze([
    Object.freeze({ id: 'north-west', anchor: { q: 1, r: -4 }, outer: { q: 1, r: -5 } }),
  ]),
  pipCaps: Object.freeze({ forest: 21, pasture: 21, fields: 21, hills: 18, mountains: 18 }),
});
