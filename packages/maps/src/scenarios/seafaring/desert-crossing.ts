import { cellId, islandHexes } from './layout.js';
import { defineFixedSeafaring } from './types.js';

/**
 * Desert Crossing, 3-4 players: a 31-hex island in a 9x7 frame cut in two by a zigzag strip of
 * five desert hexes, plus four two-hex islands in the corners. The west side is home; the east
 * side holds two gold fields.
 *
 * The strip joins both sides into one connected island, so the bonus uses explicit regions: west
 * (home), east, and the four corner islands. The strip hexes belong to no region.
 */
export const DESERT_CROSSING = defineFixedSeafaring(
  'desert-crossing',
  {
    rows: [
      'P8 Ha ~. ~. ~. ~. ~. ~. Ga',
      '  ~. ~. F8 P4 D. A2 H9 ~. M9',
      '~. A8 F2 H5 D. G6 M5 P6 ~.',
      '  ~. F4 P3 Aa D. H3 Fc Mb ~.',
      '~. H3 A6 F9 D. Pc Ab H5 ~.',
      '  ~. ~. Mb M4 D. F5 G6 ~. A9',
      'F8 Aa ~. ~. ~. ~. ~. ~. H4',
    ],
    harbors: [
      ['e:-1,4,W', 'ore'],
      ['e:3,1,NE', 'grain'],
      ['e:1,6,NW', 'generic'],
      ['e:7,3,W', 'brick'],
      ['e:2,6,NW', 'wool'],
      ['e:4,1,NE', 'lumber'],
      ['e:4,6,NW', 'generic'],
      ['e:0,0,NW', 'generic'],
      ['e:7,5,W', 'generic'],
    ],
    robberHex: cellId(4, 3),
  },
  (board) => {
    const main = islandHexes(board, [cellId(4, 3)]);
    const byId = new Map(board.hexes.map((hex) => [hex.id, hex]));
    const strip = (id: string) => byId.get(id)?.terrain === 'desert';
    const side = (test: (x: number) => boolean) =>
      main.filter((id) => {
        const hex = byId.get(id);
        return hex !== undefined && !strip(id) && test(hex.q + hex.r / 2);
      });
    const west = side((x) => x < 4);
    const east = side((x) => x > 4);
    return {
      pirateHex: cellId(4, 6),
      setupAreas: west,
      islandBonus: { vp: 2 },
      bonusRegions: [
        west,
        east,
        islandHexes(board, [cellId(0, 0)]),
        islandHexes(board, [cellId(8, 0)]),
        islandHexes(board, [cellId(0, 6)]),
        islandHexes(board, [cellId(8, 6)]),
      ],
    };
  },
);
