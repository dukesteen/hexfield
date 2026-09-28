import { cellId, islandHexes } from './layout.js';
import { defineFixedSeafaring } from './types.js';

/**
 * New Horizons, 3-4 players: a 21-hex home island in the middle of a 9x7 frame and six small outer
 * islands (14 hexes, three of them gold). Setup is on the home island only; each other island is
 * worth the island bonus.
 */
export const NEW_HORIZONS = defineFixedSeafaring(
  'new-horizons',
  {
    rows: [
      'P9 ~. ~. ~. ~. ~. ~. ~. P3',
      '  G4 ~. ~. A5 Hc P8 ~. A6 F4',
      '~. ~. Ha P8 Mb F5 A2 ~. ~.',
      '  M9 ~. Fb A5 D. H3 M8 ~. G6',
      '~. ~. H9 Fa P8 A5 Ma ~. H4',
      '  Ab ~. ~. P2 Mc F3 ~. ~. ~.',
      'H9 G6 ~. ~. ~. ~. ~. M4 F6',
    ],
    harbors: [
      ['e:0,4,W', 'generic'],
      ['e:6,3,W', 'ore'],
      ['e:3,1,NE', 'grain'],
      ['e:2,6,NW', 'generic'],
      ['e:1,2,NW', 'lumber'],
      ['e:5,1,NE', 'wool'],
      ['e:1,5,W', 'brick'],
      ['e:4,5,NW', 'generic'],
      ['e:9,1,W', 'generic'],
    ],
    robberHex: cellId(4, 3),
  },
  (board) => ({
    pirateHex: cellId(2, 0),
    setupAreas: islandHexes(board, [cellId(4, 3)]),
    islandBonus: { vp: 2 },
  }),
);

/**
 * New Horizons, 5-6 players: a 32-hex home island in an 11x9 frame, eight small outer islands
 * (17 hexes, four of them gold).
 */
export const NEW_HORIZONS_56 = defineFixedSeafaring(
  'new-horizons-56',
  {
    rows: [
      'Pb G8 ~. ~. ~. ~. ~. ~. F5 ~. H5',
      '  A9 ~. ~. ~. H5 P6 A9 ~. ~. G3 ~.',
      '~. ~. ~. Ha P8 Mb Fc A4 ~. ~. ~.',
      '  Mb ~. F6 A4 P3 H2 M9 P3 ~. ~. P9',
      'P6 ~. M2 F3 A8 D. H4 Fc ~. H8 G5',
      '  ~. ~. ~. M9 Ac F6 Mb H8 ~. ~. ~.',
      '~. ~. ~. A2 P8 Hb Fa ~. ~. ~. Aa',
      '  Fa H4 ~. ~. Ma F6 P3 ~. ~. ~. G4',
      'A6 ~. ~. ~. ~. ~. ~. ~. M5 ~. ~.',
    ],
    harbors: [
      ['e:0,4,W', 'generic'],
      ['e:6,5,W', 'ore'],
      ['e:5,1,NW', 'grain'],
      ['e:0,8,NE', 'generic'],
      ['e:7,2,W', 'lumber'],
      ['e:2,2,NW', 'wool'],
      ['e:3,8,NW', 'brick'],
      ['e:0,6,W', 'generic'],
      ['e:-2,4,W', 'generic'],
      ['e:10,3,W', 'generic'],
    ],
    robberHex: cellId(5, 4),
  },
  (board) => ({
    pirateHex: cellId(3, 0),
    setupAreas: islandHexes(board, [cellId(5, 4)]),
    islandBonus: { vp: 2 },
  }),
);
