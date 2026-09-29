import type { BoardState } from '@cp2p/engine';
import { cellId, islandHexes } from './layout.js';
import { defineFixedSeafaring } from './types.js';
import type { SeafaringOptions } from './types.js';

/**
 * The options of a Desert Crossing board whose desert strip runs down offset column `strip`
 * through `center`: the west side is home and the setup area, and the regions are west, east and
 * each corner islet (named by one of its hexes). The strip hexes belong to no region.
 */
function crossingOptions(
  board: BoardState,
  layout: { strip: number; center: string; islets: readonly string[]; pirateHex: string },
): SeafaringOptions {
  const { strip, center, islets, pirateHex } = layout;
  const main = islandHexes(board, [center]);
  const byId = new Map(board.hexes.map((hex) => [hex.id, hex]));
  const side = (test: (x: number) => boolean) =>
    main.filter((id) => {
      const hex = byId.get(id);
      return hex !== undefined && hex.terrain !== 'desert' && test(hex.q + hex.r / 2);
    });
  const west = side((x) => x < strip);
  return {
    pirateHex,
    setupAreas: west,
    islandBonus: { vp: 2 },
    bonusRegions: [west, side((x) => x > strip), ...islets.map((hex) => islandHexes(board, [hex]))],
  };
}

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
  (board) =>
    crossingOptions(board, {
      strip: 4,
      center: cellId(4, 3),
      islets: [cellId(0, 0), cellId(8, 0), cellId(0, 6), cellId(8, 6)],
      pirateHex: cellId(4, 6),
    }),
);

/**
 * Desert Crossing, 5-6 players: a 47-hex island in an 11x9 frame cut by a zigzag strip of seven
 * desert hexes, with 20 hexes on either side, and four three-hex islets in the corners. The west
 * side is home and balanced; the east side and two of the islets hold the four gold fields.
 */
export const DESERT_CROSSING_56 = defineFixedSeafaring(
  'desert-crossing-56',
  {
    rows: [
      'Pa Hb ~. ~. ~. ~. ~. ~. ~. G6 M9',
      '  F3 ~. ~. Fc Pa D. H9 A3 ~. ~. P4',
      '~. ~. Ab H6 M3 D. Fc G8 M4 ~. ~.',
      '  ~. ~. P3 F2 A5 D. P2 Ma F8 ~. ~.',
      '~. H5 Mb P6 F9 D. A5 H9 F5 Ga ~.',
      '  ~. ~. A4 Hb M8 D. M8 A3 P6 ~. ~.',
      '~. ~. F9 Pa A5 D. F9 M2 A4 ~. ~.',
      '  H4 ~. ~. M4 Ha D. Pc Hb ~. ~. F6',
      'A5 Gb ~. ~. ~. ~. ~. ~. ~. P8 H3',
    ],
    harbors: [
      ['e:1,2,NW', 'grain'],
      ['e:-1,4,W', 'generic'],
      ['e:-2,7,NE', 'lumber'],
      ['e:-1,8,NE', 'ore'],
      ['e:7,1,NE', 'generic'],
      ['e:8,3,W', 'wool'],
      ['e:6,6,NW', 'brick'],
      ['e:4,8,NW', 'generic'],
      ['e:2,0,W', 'generic'],
      ['e:7,7,W', 'generic'],
    ],
    robberHex: cellId(5, 4),
  },
  (board) =>
    crossingOptions(board, {
      strip: 5,
      center: cellId(5, 4),
      islets: [cellId(0, 0), cellId(10, 0), cellId(0, 8), cellId(10, 8)],
      pirateHex: cellId(5, 8),
    }),
);
