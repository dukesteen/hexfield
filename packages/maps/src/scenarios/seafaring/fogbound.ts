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

/**
 * The 5-6 player fog stack: 19 tiles, 15 of them land (two gold) and four open sea. The token
 * counts cover the 15 land tiles.
 */
export const FOGBOUND_56_FOG = Object.freeze({
  terrains: Object.freeze({
    forest: 3,
    hills: 3,
    pasture: 2,
    fields: 3,
    mountains: 2,
    gold: 2,
    sea: 4,
  }),
  tokens: Object.freeze({
    '2': 1,
    '3': 1,
    '4': 2,
    '5': 2,
    '6': 2,
    '8': 2,
    '9': 2,
    '10': 2,
    '11': 1,
  }),
});

/**
 * Fogbound, 5-6 players: two 17-hex islands, each with a desert at its heart, in an 11x9 frame
 * with a band of 19 fog hexes between them, one sea hex from either coast. No island bonus.
 */
export const FOGBOUND_56 = defineFixedSeafaring(
  'fogbound-56',
  {
    rows: [
      '~. ~. ~. ~. ~. ?. ~. ~. ~. ~. ~.',
      '  ~. F9 P3 ~. ?. ?. ~. ~. Ac H4 ~.',
      '~. Ha A8 ~. ?. ?. ?. ~. P5 M6 ~.',
      '  M6 Fb P4 ~. ?. ?. ~. ~. F4 A9 P6',
      'Ab D. H9 ~. ?. ?. ?. ~. H5 D. Mb',
      '  F8 M3 A8 ~. ?. ?. ~. ~. P8 Fa A5',
      '~. P2 F5 ~. ?. ?. ?. ~. M4 P9 ~.',
      '  ~. H6 Ma ~. ?. ?. ~. ~. Fa H3 ~.',
      '~. ~. ~. ~. ~. ?. ~. ~. ~. ~. ~.',
    ],
    harbors: [
      ['e:1,1,NW', 'generic'],
      ['e:2,2,W', 'grain'],
      ['e:-3,6,NE', 'ore'],
      ['e:1,5,W', 'generic'],
      ['e:-2,8,NW', 'lumber'],
      ['e:9,1,NE', 'generic'],
      ['e:7,2,W', 'wool'],
      ['e:9,3,NW', 'generic'],
      ['e:6,5,W', 'brick'],
      ['e:6,8,NW', 'generic'],
    ],
    robberHex: cellId(1, 4),
  },
  (board) => ({
    pirateHex: cellId(6, 8),
    setupAreas: board.hexes.filter((hex) => isLandTerrain(hex.terrain)).map((hex) => hex.id),
    fog: FOGBOUND_56_FOG,
  }),
);
