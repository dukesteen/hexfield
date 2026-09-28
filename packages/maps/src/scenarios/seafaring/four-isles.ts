import { isLandTerrain } from '@cp2p/engine';
import { cellId } from './layout.js';
import { defineFixedSeafaring } from './types.js';

/**
 * Four Isles, 3-4 players: four seven-hex flowers in a 9x7 frame, one sea hex apart. Two of them
 * carry a desert on the rim, two a gold field. Seats set up on any island, one or two.
 */
export const FOUR_ISLES = defineFixedSeafaring(
  'four-isles',
  {
    rows: [
      '~. ~. F5 P4 ~. ~. Ab M5 ~.',
      '  ~. D. A8 M3 ~. P8 F2 G9 ~.',
      '~. ~. Hb F9 ~. ~. H3 A4 ~.',
      '  ~. ~. ~. ~. ~. ~. ~. ~. ~.',
      '~. ~. H9 Pa ~. ~. F6 H4 ~.',
      '  ~. G8 M3 A6 ~. Ac D. Pa ~.',
      '~. ~. Fa Pb ~. ~. M5 H6 ~.',
    ],
    harbors: [
      ['e:2,0,NW', 'generic'],
      ['e:2,3,NW', 'ore'],
      ['e:0,2,NE', 'grain'],
      ['e:7,0,NE', 'generic'],
      ['e:4,3,NE', 'wool'],
      ['e:-2,7,NE', 'lumber'],
      ['e:1,4,NE', 'generic'],
      ['e:4,7,NW', 'brick'],
      ['e:4,4,NW', 'generic'],
    ],
    robberHex: cellId(1, 1),
  },
  (board) => ({
    pirateHex: cellId(4, 3),
    setupAreas: board.hexes.filter((hex) => isLandTerrain(hex.terrain)).map((hex) => hex.id),
    islandBonus: { vp: 2 },
  }),
);

/**
 * Four Isles, 5-6 players: four ten-hex islands in an 11x7 frame, with two deserts and four gold
 * fields.
 */
export const FOUR_ISLES_56 = defineFixedSeafaring(
  'four-isles-56',
  {
    rows: [
      '~. ~. F2 P9 A5 ~. ~. M8 H4 Fa ~.',
      '  ~. H8 D. M3 P6 ~. P5 Gb A8 Mb ~.',
      '~. ~. Aa F4 Ha ~. ~. F6 P3 Ac ~.',
      '  ~. ~. ~. ~. ~. ~. ~. ~. ~. ~. ~.',
      '~. ~. H3 A2 P3 ~. ~. M9 H5 A6 ~.',
      '  ~. G4 F8 Mb A8 ~. G6 F4 D. G9 ~.',
      '~. ~. Pc H9 Fa ~. ~. Hb P6 M5 ~.',
    ],
    harbors: [
      ['e:2,0,NW', 'generic'],
      ['e:3,3,NW', 'ore'],
      ['e:0,3,NE', 'grain'],
      ['e:10,1,W', 'generic'],
      ['e:6,1,W', 'wool'],
      ['e:6,3,NE', 'generic'],
      ['e:-2,7,NE', 'lumber'],
      ['e:2,4,NE', 'generic'],
      ['e:8,5,W', 'brick'],
      ['e:4,5,W', 'generic'],
    ],
    robberHex: cellId(2, 1),
  },
  (board) => ({
    pirateHex: cellId(5, 3),
    setupAreas: board.hexes.filter((hex) => isLandTerrain(hex.terrain)).map((hex) => hex.id),
    islandBonus: { vp: 2 },
  }),
);
