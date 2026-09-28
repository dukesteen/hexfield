import { isLandTerrain } from '@cp2p/engine';
import { cellId } from './layout.js';
import { defineFixedSeafaring } from './types.js';

/**
 * The hidden tiles behind the fog: 13 tiles, ten of them land (two gold) and three open sea. The
 * token counts cover the ten land tiles.
 */
export const FOGBOUND_FOG = Object.freeze({
  terrains: Object.freeze({
    forest: 2,
    hills: 2,
    pasture: 1,
    fields: 2,
    mountains: 1,
    gold: 2,
    sea: 3,
  }),
  tokens: Object.freeze({ '3': 1, '4': 1, '5': 2, '6': 1, '8': 1, '9': 2, '10': 1, '11': 1 }),
});

/**
 * Fogbound, 3-4 players: two 11-hex islands in a 9x7 frame with a vertical band of 13 fog hexes
 * between them, one sea hex from either coast. No island bonus; the fog is the prize.
 */
export const FOGBOUND = defineFixedSeafaring(
  'fogbound',
  {
    rows: [
      '~. ~. ~. ?. ?. ?. ~. ~. ~.',
      '  ~. F8 ~. ?. ?. ~. ~. P6 ~.',
      'Hb P4 Aa ~. ?. ~. Fb M4 H3',
      '  M2 D. F3 ~. ?. ~. A6 Pc F9',
      'P6 A9 H8 ~. ?. ~. H5 Aa M8',
      '  ~. M5 ~. ?. ?. ~. ~. F5 ~.',
      '~. ~. ~. ?. ?. ?. ~. ~. ~.',
    ],
    harbors: [
      ['e:-1,2,W', 'generic'],
      ['e:-1,6,NW', 'ore'],
      ['e:2,2,W', 'grain'],
      ['e:-3,5,NE', 'generic'],
      ['e:8,3,W', 'generic'],
      ['e:4,4,W', 'brick'],
      ['e:7,1,NW', 'wool'],
      ['e:5,6,NW', 'lumber'],
      ['e:5,2,NW', 'generic'],
    ],
    robberHex: cellId(1, 3),
  },
  (board) => ({
    pirateHex: cellId(6, 6),
    setupAreas: board.hexes.filter((hex) => isLandTerrain(hex.terrain)).map((hex) => hex.id),
    fog: FOGBOUND_FOG,
  }),
);
