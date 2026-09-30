import { DESERT_CROSSING, DESERT_CROSSING_56 } from './desert-crossing.js';
import { FOGBOUND, FOGBOUND_56 } from './fogbound.js';
import { FOUR_ISLES, FOUR_ISLES_56 } from './four-isles.js';
import { NEW_HORIZONS, NEW_HORIZONS_56 } from './new-horizons.js';
import type { FixedSeafaringData } from './types.js';

export { DESERT_CROSSING, DESERT_CROSSING_56 } from './desert-crossing.js';
export { FOGBOUND, FOGBOUND_56, FOGBOUND_56_FOG, FOGBOUND_FOG } from './fogbound.js';
export { FOUR_ISLES, FOUR_ISLES_56 } from './four-isles.js';
export {
  adjacentLandPairs,
  boardFromLayout,
  cellId,
  harborIssues,
  harborProblems,
  islandHexes,
  parseRows,
  renderRows,
  shapeFromBoard,
  tokenProblems,
} from './layout.js';
export type { HarborIssue, SeafaringLayout } from './layout.js';
export { NEW_HORIZONS, NEW_HORIZONS_56 } from './new-horizons.js';
export { OPEN_SEA_OPTIONS } from './open-sea.js';
export { defineFixedSeafaring } from './types.js';
export type { FixedSeafaringData, FogSpec, SeafaringOptions } from './types.js';

/** Every fixed seafaring scenario, in lobby order. */
export const FIXED_SEAFARING: readonly FixedSeafaringData[] = Object.freeze([
  NEW_HORIZONS,
  NEW_HORIZONS_56,
  FOUR_ISLES,
  FOUR_ISLES_56,
  FOGBOUND,
  FOGBOUND_56,
  DESERT_CROSSING,
  DESERT_CROSSING_56,
]);
