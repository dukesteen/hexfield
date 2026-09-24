import type { BoardState } from '@cp2p/engine';
import { hexId } from '@cp2p/engine/geometry';

export const PACKAGE_NAME = '@cp2p/maps';

/** Original fixed island selected from our strict-balanced generator (seed 1147). */
const LAND = [
  [-2, 0, 'desert', null],
  [-2, 1, 'mountains', 8],
  [-2, 2, 'fields', 2],
  [-1, -1, 'hills', 6],
  [-1, 0, 'fields', 4],
  [-1, 1, 'pasture', 10],
  [-1, 2, 'forest', 9],
  [0, -2, 'fields', 5],
  [0, -1, 'mountains', 10],
  [0, 0, 'forest', 3],
  [0, 1, 'hills', 8],
  [0, 2, 'pasture', 5],
  [1, -2, 'mountains', 3],
  [1, -1, 'forest', 9],
  [1, 0, 'fields', 4],
  [1, 1, 'pasture', 11],
  [2, -2, 'forest', 11],
  [2, -1, 'pasture', 6],
  [2, 0, 'hills', 12],
] as const;

const PORTS = [
  ['e:-1,-1,NW', 'generic'],
  ['e:-2,0,W', 'lumber'],
  ['e:-2,3,NE', 'generic'],
  ['e:-3,2,NE', 'generic'],
  ['e:0,3,NW', 'ore'],
  ['e:1,-2,NW', 'brick'],
  ['e:2,-2,NE', 'generic'],
  ['e:2,1,W', 'grain'],
  ['e:3,-1,W', 'wool'],
] as const;

/** Fresh JSON board value to pass as GameConfig.board for standard-fixed. */
export function standardFixedBoard(): BoardState {
  return {
    hexes: LAND.map(([q, r, terrain, token]) => ({ id: hexId({ q, r }), q, r, terrain, token })),
    harbors: PORTS.map(([edge, kind]) => ({ edge, kind })),
    roads: [],
    buildings: [],
    robberHex: 'h:-2,0',
  };
}
