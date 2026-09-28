import type { SeafaringOptions } from './types.js';

/**
 * Open Sea has no fixed board. The seafaring module builds one at genesis from the game's random
 * seed (`generateArchipelago`, picking the 9x7 or the 11x9 frame by seat count) and starts the
 * pirate on the hex that generator names, so `pirateHex` here is only a placeholder. Setup areas
 * are absent: seats may settle any island. The bonus counts every island other than a seat's
 * home islands.
 */
export const OPEN_SEA_OPTIONS: SeafaringOptions = Object.freeze({
  layout: 'archipelago',
  pirateHex: null,
  islandBonus: Object.freeze({ vp: 1 }),
});
