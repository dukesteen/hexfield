import type { BoardShapeSpec, BoardState } from '@cp2p/engine';
import { boardFromLayout, shapeFromBoard } from './layout.js';
import type { SeafaringLayout } from './layout.js';

/** The fog stack a scenario hands the seafaring module: tile counts by terrain and token counts by number. */
export interface FogSpec {
  /** Terrain to count. The counts sum to the number of `fog` hexes on the board. */
  readonly terrains: Readonly<Record<string, number>>;
  /** Token number (as a string) to count. One token per gold or resource tile; sea and desert take none. */
  readonly tokens: Readonly<Record<string, number>>;
}

/** The `config.options.seafaring` object a scenario passes to the engine module. */
export type SeafaringOptions = {
  /** Sea hex the pirate starts on, or null for off-board. */
  readonly pirateHex: string | null;
  /** Hexes whose vertices allow setup settlements. Absent means every land hex. */
  readonly setupAreas?: readonly string[];
  readonly islandBonus?: { readonly vp: 1 | 2 };
  /** Explicit, disjoint hex groups scoring the island bonus. Absent means the islands. */
  readonly bonusRegions?: readonly (readonly string[])[];
  readonly fog?: FogSpec;
  /** `archipelago` asks the module to generate the board at genesis instead of using `config.board`. */
  readonly layout?: 'archipelago' | 'archipelago-v2';
};

/** A fixed seafaring scenario: its board, the matching shape spec and the module options. */
export interface FixedSeafaringData {
  readonly id: string;
  readonly shape: BoardShapeSpec;
  /** A fresh board each call, to pass as `GameConfig.board`. */
  readonly board: () => BoardState;
  readonly options: SeafaringOptions;
}

/** Build the data for a fixed scenario from its layout and a function of the built board. */
export function defineFixedSeafaring(
  id: string,
  layout: SeafaringLayout,
  options: (board: BoardState) => SeafaringOptions,
): FixedSeafaringData {
  const first = boardFromLayout(layout);
  return Object.freeze({
    id,
    shape: shapeFromBoard(id, first),
    board: () => boardFromLayout(layout),
    options: Object.freeze(options(first)),
  });
}
