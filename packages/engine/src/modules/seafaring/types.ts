import type { GameState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import type { SeafaringOptions } from './config.js';
import { SEAFARING_ID } from './config.js';

/** A permanent new-island bonus, attached to the settlement that earned it. */
export interface IslandBonusToken {
  seat: Seat;
  region: string;
  vertex: string;
}

/**
 * A placement's fog reveals in progress. `hexes` are still `fog`, in reveal order, and the head is
 * the hex being drawn. `terrain` holds the head's terrain once drawn, while its token is drawn; the
 * hex changes only when both are known. The revealer receives the reward.
 */
export interface FogReveal {
  seat: Seat;
  hexes: string[];
  terrain: string | null;
}

/** Public state under `ext.seafaring`. */
export interface SeafaringExt {
  /** The pirate's sea hex, or null while it is off the board. */
  pirateHex: string | null;
  /** Ship edges built or moved this turn. They cannot be moved this turn. */
  builtThisTurn: string[];
  /** The turn number of the last ship move, or null. One move per turn. */
  shipMovedTurn: number | null;
  /** Per seat (indexed by seat), the ids of the regions of its setup settlements. */
  homeRegions: string[][];
  bonus: IslandBonusToken[];
  /** Present only when the scenario has fog. `null` while no reveal is pending. */
  fog?: FogReveal | null;
}

/** One seat's gold claim, in the order the choices are made. */
export interface GoldClaim {
  seat: Seat;
  claim: number;
}

/** Data of the module's `goldChoice` frame. */
export interface GoldFrameData {
  queue: GoldClaim[];
}

export function seafaringOptions(state: Pick<GameState, 'config'>): SeafaringOptions {
  const value: unknown = state.config.options[SEAFARING_ID];
  if (typeof value !== 'object' || value === null) throw new Error('Missing seafaring options');
  // Genesis validates and normalizes every option against the module's schema.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as SeafaringOptions;
}

export function seafaringExt(state: GameState): SeafaringExt {
  const value = state.ext[SEAFARING_ID];
  if (typeof value !== 'object' || value === null) throw new Error('Missing seafaring state');
  // Module genesis and handlers own this extension slot.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as SeafaringExt;
}

export function updateSeafaring(
  state: GameState,
  change: (old: SeafaringExt) => SeafaringExt,
): GameState {
  return { ...state, ext: { ...state.ext, [SEAFARING_ID]: change(seafaringExt(state)) } };
}
