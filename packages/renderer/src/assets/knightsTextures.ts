import type { Texture } from 'pixi.js';
import {
  BARBARIAN_SHIP_ART,
  BARBARIAN_SHIP_KEY,
  DIE_ART,
  EVENT_FACES,
  KNIGHT_ART,
  KNIGHT_LEVELS,
  KNIGHTS_TRACKS,
  ART_COLOR_NAMES,
  MERCHANT_ART,
  METROPOLIS_ART,
  WALLED_CITY_ART,
  WALLED_METROPOLIS_ART,
  knightArtKey,
  eventDieKey,
  merchantArtKey,
  metropolisArtKey,
  redDieKey,
  walledCityArtKey,
} from '../knightsLayout.js';
import { loadTexture, rasterResolution } from './terrainTextures.js';

/** The textures of the Cities & Knights pieces, by art key. Missing keys are not loaded yet. */
export interface KnightsTextures {
  get(key: string): Texture | undefined;
}

/** Display scale of every piece: art units are eighty to a hex radius. */
const unit = (hexSize: number): number => hexSize / 80;

/** Load every knight, wall, metropolis, merchant and ship texture once, for all six colours. */
export async function loadKnightsTextures(
  devicePixelRatio: number,
  maxPixelRatio: number,
  maxZoom: number,
  hexSize: number,
): Promise<KnightsTextures> {
  const u = unit(hexSize);
  const requests: Promise<readonly [string, Texture]>[] = [];
  const add = (key: string, art: { width: number; height: number }, display = 1): void => {
    const resolution = rasterResolution(
      devicePixelRatio,
      maxPixelRatio,
      maxZoom,
      art.width * u * display,
      art.height * u * display,
      art.width,
      art.height,
    );
    requests.push(
      loadTexture(key, art.width, art.height, resolution).then((texture) => [key, texture]),
    );
  };
  add(BARBARIAN_SHIP_KEY, BARBARIAN_SHIP_ART, 0.8);
  // The dice pop up at screen size, not board size.
  for (const face of [1, 2, 3, 4, 5, 6]) {
    const key = redDieKey(face);
    const resolution = rasterResolution(devicePixelRatio, maxPixelRatio, 1, 64, 64, 60, 60);
    requests.push(loadTexture(key, DIE_ART.width, DIE_ART.height, resolution).then((t) => [key, t]));
  }
  for (const face of EVENT_FACES) {
    const key = eventDieKey(face);
    const resolution = rasterResolution(devicePixelRatio, maxPixelRatio, 1, 64, 64, 60, 60);
    requests.push(loadTexture(key, DIE_ART.width, DIE_ART.height, resolution).then((t) => [key, t]));
  }
  for (const color of ART_COLOR_NAMES) {
    add(walledCityArtKey(color), WALLED_CITY_ART);
    add(merchantArtKey(color), MERCHANT_ART);
    for (const level of KNIGHT_LEVELS)
      for (const active of [true, false]) add(knightArtKey(color, level, active), KNIGHT_ART, 1.25);
    for (const track of KNIGHTS_TRACKS) {
      add(metropolisArtKey(track, false, color), METROPOLIS_ART);
      add(metropolisArtKey(track, true, color), WALLED_METROPOLIS_ART);
    }
  }
  const loaded = new Map(await Promise.all(requests));
  return { get: (key) => loaded.get(key) };
}
