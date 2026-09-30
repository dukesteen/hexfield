import { failure, isLandTerrain, solveTokens, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { hexId } from '@cp2p/engine/geometry';
import { createRng } from '@cp2p/engine/rng';
import { isMapToken } from './schema.js';
import type { MapDef, MapHex, MapTerrain } from './schema.js';
import { isTokenless } from './validate.js';

/** The base game's 18 numbers in an order where every prefix stays balanced across the dice. */
const TOKEN_CYCLE = [5, 9, 6, 8, 4, 10, 3, 11, 2, 12, 5, 9, 6, 8, 4, 10, 3, 11] as const;
/** The base game's 19 tiles in an order where every prefix keeps the five resources even. */
const TERRAIN_CYCLE: readonly MapTerrain[] = [
  'forest',
  'fields',
  'pasture',
  'hills',
  'mountains',
  'forest',
  'fields',
  'pasture',
  'hills',
  'mountains',
  'desert',
  'forest',
  'fields',
  'pasture',
  'hills',
  'mountains',
  'forest',
  'fields',
  'pasture',
];

/** Number tokens for `count` hexes, repeating the base set. */
export function defaultTokenBag(count: number): number[] {
  return Array.from({ length: count }, (_, index) => TOKEN_CYCLE[index % TOKEN_CYCLE.length] ?? 5);
}

function seedBytes(seed: number): Uint8Array {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, seed >>> 0, true);
  return bytes;
}

const needsToken = (hex: MapHex): boolean =>
  isLandTerrain(hex.terrain) && !isTokenless(hex.terrain);

/**
 * Number every land hex that produces, with the balanced search of the random layouts (no equal or
 * 6/8 numbers side by side). A map whose producing hexes all carry numbers keeps its numbers and
 * only moves them; otherwise the base set is repeated. Tokenless hexes lose any token.
 */
export function autoTokens(map: MapDef, seed: number): Result<MapDef> {
  const slots = map.hexes.filter(needsToken);
  const kept = slots.every((hex) => isMapToken(hex.token));
  const bag = kept ? slots.map((hex) => hex.token ?? 0) : defaultTokenBag(slots.length);
  const withIds = slots.map((hex) => ({ ...hex, id: hexId(hex) }));
  for (let attempt = 0; attempt < 20; attempt++) {
    const solved = solveTokens(createRng(seedBytes(seed + attempt * 7919)), withIds, bag);
    if (!solved) continue;
    return success({
      ...map,
      hexes: map.hexes.map((hex) => {
        const token = needsToken(hex) ? solved.get(hexId(hex)) : null;
        return { ...hex, token: isMapToken(token) ? token : null };
      }),
    });
  }
  return failure('TOKENS_UNSOLVED', 'No balanced numbering was found for this map');
}

/**
 * Deal a fresh tile bag over the map's land (its shape stays): the base game's proportions, one
 * desert per nineteen tiles, and on a seafaring map one gold field per ten. Then number it and put
 * the robber on a desert (or clear it on a seafaring map with none).
 */
export function randomiseMap(map: MapDef, seed: number): Result<MapDef> {
  const rng = createRng(seedBytes(seed));
  const cells = map.hexes.filter((hex) => isLandTerrain(hex.terrain));
  const seafaring = map.modules.includes('seafaring');
  const gold = seafaring ? Math.floor(cells.length / 10) : 0;
  const bag = [
    ...Array.from({ length: gold }, (): MapTerrain => 'gold'),
    ...Array.from(
      { length: cells.length - gold },
      (_, index) => TERRAIN_CYCLE[index % TERRAIN_CYCLE.length] ?? 'forest',
    ),
  ];
  const dealt = rng.shuffle(bag);
  let next = 0;
  const hexes = map.hexes.map((hex) =>
    isLandTerrain(hex.terrain)
      ? { ...hex, terrain: dealt[next++] ?? hex.terrain, token: null }
      : hex,
  );
  const desert = hexes.find((hex) => hex.terrain === 'desert');
  const standing = hexes.find((hex) => map.robber !== null && hexId(hex) === map.robber);
  // The robber starts on a desert; without one, a base map keeps it on land and seafaring lifts it.
  const robber = desert
    ? hexId(desert)
    : seafaring
      ? null
      : standing && isLandTerrain(standing.terrain)
        ? map.robber
        : cells[0]
          ? hexId(cells[0])
          : null;
  return autoTokens({ ...map, hexes, robber }, rng.nextU32());
}
