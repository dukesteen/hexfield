import { hexId } from '../../core/geometry/index.js';
import type { Engine } from '../../core/pipeline/index.js';
import type { BoardHex, BoardState, GameConfig } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { engineForModules, moduleSelection } from '../catalogue.js';
import { SEAFARING_ID } from './config.js';
import type { SeafaringOptions } from './config.js';

/** A hex of a hand-built board: `[q, r, terrain, token]`. Sea and desert take a null token. */
export type HexSpec = readonly [q: number, r: number, terrain: string, token?: number | null];

/** An explicit seafaring board from hex specs. The robber starts where given, or off the board. */
export function explicitBoard(
  hexes: readonly HexSpec[],
  robberHex: string | null = null,
  harbors: BoardState['harbors'] = [],
): BoardState {
  const list: BoardHex[] = hexes
    .map(([q, r, terrain, token]) => ({
      id: hexId({ q, r }),
      q,
      r,
      terrain,
      token: token ?? null,
    }))
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { hexes: list, harbors, roads: [], buildings: [], robberHex };
}

/** The standard island (a strict-balanced layout) used as the main island of the test board. */
const MAIN_ISLAND: readonly HexSpec[] = [
  [-2, 0, 'desert'],
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
];

/** The main island's hex ids of `testArchipelago`. */
export const ARCHIPELAGO_MAIN: readonly string[] = MAIN_ISLAND.map(([q, r]) => hexId({ q, r }));

const MAIN_HARBORS: BoardState['harbors'] = [
  { edge: 'e:-1,-1,NW', kind: 'generic' },
  { edge: 'e:-2,0,W', kind: 'lumber' },
  { edge: 'e:-2,3,NE', kind: 'generic' },
  { edge: 'e:-3,2,NE', kind: 'generic' },
  { edge: 'e:0,3,NW', kind: 'ore' },
  { edge: 'e:1,-2,NW', kind: 'brick' },
  { edge: 'e:2,-2,NE', kind: 'generic' },
  { edge: 'e:2,1,W', kind: 'grain' },
  { edge: 'e:3,-1,W', kind: 'wool' },
];

/**
 * A temporary board for tests and simulations: the 19-hex standard island in the middle of a
 * radius-4 sea, plus three two-hex islands (two with gold) two hexes out. The pirate starts on
 * `h:3,0`. The real scenarios live in `@cp2p/maps`.
 */
export function testArchipelago(): BoardState {
  const extra: readonly HexSpec[] = [
    [4, -3, 'gold', 6],
    [4, -2, 'fields', 9],
    [-4, 3, 'gold', 8],
    [-4, 2, 'pasture', 5],
    [0, 4, 'hills', 4],
    [-1, 4, 'forest', 11],
  ];
  const taken = new Set([...MAIN_ISLAND, ...extra].map(([q, r]) => hexId({ q, r })));
  const sea: HexSpec[] = [];
  for (let q = -4; q <= 4; q++)
    for (let r = -4; r <= 4; r++)
      if (Math.abs(q + r) <= 4 && !taken.has(hexId({ q, r }))) sea.push([q, r, 'sea']);
  return explicitBoard([...MAIN_ISLAND, ...extra, ...sea], 'h:-2,0', MAIN_HARBORS);
}

const SEATS: readonly Seat[] = [0, 1, 2, 3, 4, 5];

export interface SeafaringConfigOptions {
  seats?: number;
  board?: BoardState;
  fiveSix?: boolean;
  seafaring?: Partial<SeafaringOptions>;
  base?: Record<string, unknown>;
}

/** A genesis config for seafaring on the given board (default: `testArchipelago`). */
export function seafaringConfig(options: SeafaringConfigOptions = {}): GameConfig {
  return {
    modules: moduleSelection(['base', ...(options.fiveSix ? ['five-six'] : []), SEAFARING_ID]),
    seats: SEATS.slice(0, options.seats ?? 3),
    options: {
      base: { ...options.base },
      [SEAFARING_ID]: {
        pirateHex: 'h:3,0',
        setupAreas: [...ARCHIPELAGO_MAIN],
        islandBonus: { vp: 2 },
        ...options.seafaring,
      },
    },
    board: options.board ?? testArchipelago(),
  };
}

/** An engine with base and seafaring, plus five-six when asked. */
export function seafaringEngine(fiveSix = false): Engine {
  return engineForModules(
    moduleSelection(['base', ...(fiveSix ? ['five-six'] : []), SEAFARING_ID]),
  );
}
