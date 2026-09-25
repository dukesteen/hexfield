import { Assets } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { Resource } from '@cp2p/engine';
import type { DevelopmentCard } from '../types.js';
import brickUrl from './resources/brick.svg?no-inline';
import brickCardUrl from './cards/brick.svg?no-inline';
import grainUrl from './resources/grain.svg?no-inline';
import grainCardUrl from './cards/grain.svg?no-inline';
import knightCardUrl from './cards/development/knight.svg?no-inline';
import monopolyCardUrl from './cards/development/monopoly.svg?no-inline';
import roadBuildingCardUrl from './cards/development/roadBuilding.svg?no-inline';
import victoryPointCardUrl from './cards/development/victoryPoint.svg?no-inline';
import yearOfPlentyCardUrl from './cards/development/yearOfPlenty.svg?no-inline';
import lumberUrl from './resources/lumber.svg?no-inline';
import lumberCardUrl from './cards/lumber.svg?no-inline';
import oreUrl from './resources/ore.svg?no-inline';
import oreCardUrl from './cards/ore.svg?no-inline';
import woolUrl from './resources/wool.svg?no-inline';
import woolCardUrl from './cards/wool.svg?no-inline';
import harborUrl from './harbors/marker.svg?no-inline';
import jettyUrl from './harbors/jetty.svg?no-inline';
import cityUrl from './pieces/city.svg?no-inline';
import roadUrl from './pieces/road.svg?no-inline';
import robberUrl from './pieces/robber.svg?no-inline';
import settlementUrl from './pieces/settlement.svg?no-inline';
import desertUrl from './tiles/desert.svg?no-inline';
import fieldsUrl from './tiles/fields.svg?no-inline';
import forestUrl from './tiles/forest.svg?no-inline';
import hillsUrl from './tiles/hills.svg?no-inline';
import mountainsUrl from './tiles/mountains.svg?no-inline';
import pastureUrl from './tiles/pasture.svg?no-inline';
import seaUrl from './tiles/sea.svg?no-inline';
import numberTokenUrl from './tokens/number.svg?no-inline';

const HEX_WIDTH = 200;
const HEX_HEIGHT = 231;
const SQUARE_ASSET_SIZE = 64;
const texturePromises = new Map<string, Promise<Texture>>();

const RESOURCE_ICON_URLS: Readonly<Record<Resource, string>> = {
  brick: brickUrl,
  lumber: lumberUrl,
  wool: woolUrl,
  grain: grainUrl,
  ore: oreUrl,
};

const RESOURCE_CARD_URLS: Readonly<Record<Resource, string>> = {
  brick: brickCardUrl,
  lumber: lumberCardUrl,
  wool: woolCardUrl,
  grain: grainCardUrl,
  ore: oreCardUrl,
};

const DEVELOPMENT_CARD_URLS: Readonly<Record<DevelopmentCard, string>> = {
  knight: knightCardUrl,
  roadBuilding: roadBuildingCardUrl,
  yearOfPlenty: yearOfPlentyCardUrl,
  monopoly: monopolyCardUrl,
  victoryPoint: victoryPointCardUrl,
};

export interface BoardTextures {
  readonly terrain: Readonly<
    Record<'forest' | 'hills' | 'pasture' | 'fields' | 'mountains' | 'desert' | 'sea', Texture>
  >;
  readonly numberToken: Texture;
  readonly harborMarker: Texture;
  readonly harborJetty: Texture;
  readonly road: Texture;
  readonly settlement: Texture;
  readonly city: Texture;
  readonly robber: Texture;
  readonly resources: Readonly<Record<Resource, Texture>>;
}

/** Return the static, same-origin SVG URL for a resource icon. */
export function getResourceIconUrl(resource: Resource): string {
  return RESOURCE_ICON_URLS[resource];
}

/** Return the static, same-origin SVG URL for a full resource card face. */
export function getResourceCardUrl(resource: Resource): string {
  return RESOURCE_CARD_URLS[resource];
}

/** Return the static, same-origin SVG URL for a development card face. */
export function getDevelopmentCardUrl(card: DevelopmentCard): string {
  return DEVELOPMENT_CARD_URLS[card];
}

/** Select an SVG raster resolution for its largest on-screen size and device pixel ratio. */
export function rasterResolution(
  devicePixelRatio: number,
  maxPixelRatio: number,
  maxZoom: number,
  displayWidth: number,
  displayHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): number {
  const pixelRatio = Math.min(Math.max(devicePixelRatio, 1), Math.max(maxPixelRatio, 1));
  const zoom = Math.max(maxZoom, 1);
  const maxPhysicalWidth = pixelRatio * displayWidth * zoom;
  const maxPhysicalHeight = pixelRatio * displayHeight * zoom;
  return Math.max(maxPhysicalWidth / sourceWidth, maxPhysicalHeight / sourceHeight);
}

/** Load and share all board textures at the resolution required by maximum board zoom. */
export async function loadBoardTextures(
  devicePixelRatio: number,
  maxPixelRatio: number,
  maxZoom: number,
  hexSize: number,
): Promise<BoardTextures> {
  const terrainResolution = rasterResolution(
    devicePixelRatio,
    maxPixelRatio,
    maxZoom,
    Math.sqrt(3) * hexSize,
    2 * hexSize,
    HEX_WIDTH,
    HEX_HEIGHT,
  );
  const tokenResolution = assetResolution(
    devicePixelRatio,
    maxPixelRatio,
    maxZoom,
    hexSize,
    0.82,
    0.82,
    80,
  );
  const harborResolution = rasterResolution(
    devicePixelRatio,
    maxPixelRatio,
    maxZoom,
    hexSize * 0.96,
    hexSize * 0.96,
    SQUARE_ASSET_SIZE,
    SQUARE_ASSET_SIZE,
  );
  const jettyResolution = rasterResolution(
    devicePixelRatio,
    maxPixelRatio,
    maxZoom,
    (hexSize * 4) / 3,
    (hexSize * 7) / 6,
    128,
    112,
  );
  const pieceResolution = assetResolution(
    devicePixelRatio,
    maxPixelRatio,
    maxZoom,
    hexSize,
    0.56,
    0.56,
    SQUARE_ASSET_SIZE,
  );
  const roadResolution = assetResolution(
    devicePixelRatio,
    maxPixelRatio,
    maxZoom,
    hexSize,
    0.74,
    0.18,
    96,
    24,
  );
  const resourceResolution = assetResolution(
    devicePixelRatio,
    maxPixelRatio,
    maxZoom,
    hexSize,
    0.29,
    0.29,
    SQUARE_ASSET_SIZE,
  );

  const [
    forest,
    hills,
    pasture,
    fields,
    mountains,
    desert,
    sea,
    numberToken,
    harborMarker,
    harborJetty,
    road,
    settlement,
    city,
    robber,
    brick,
    lumber,
    wool,
    grain,
    ore,
  ] = await Promise.all([
    loadTexture('terrain-forest', forestUrl, HEX_WIDTH, HEX_HEIGHT, terrainResolution),
    loadTexture('terrain-hills', hillsUrl, HEX_WIDTH, HEX_HEIGHT, terrainResolution),
    loadTexture('terrain-pasture', pastureUrl, HEX_WIDTH, HEX_HEIGHT, terrainResolution),
    loadTexture('terrain-fields', fieldsUrl, HEX_WIDTH, HEX_HEIGHT, terrainResolution),
    loadTexture('terrain-mountains', mountainsUrl, HEX_WIDTH, HEX_HEIGHT, terrainResolution),
    loadTexture('terrain-desert', desertUrl, HEX_WIDTH, HEX_HEIGHT, terrainResolution),
    loadTexture('terrain-sea', seaUrl, HEX_WIDTH, HEX_HEIGHT, terrainResolution),
    loadTexture('token-number', numberTokenUrl, 80, 80, tokenResolution),
    loadTexture('harbor-marker', harborUrl, SQUARE_ASSET_SIZE, SQUARE_ASSET_SIZE, harborResolution),
    loadTexture('harbor-jetty', jettyUrl, 128, 112, jettyResolution),
    loadTexture('piece-road', roadUrl, 96, 24, roadResolution),
    loadTexture(
      'piece-settlement',
      settlementUrl,
      SQUARE_ASSET_SIZE,
      SQUARE_ASSET_SIZE,
      pieceResolution,
    ),
    loadTexture('piece-city', cityUrl, SQUARE_ASSET_SIZE, SQUARE_ASSET_SIZE, pieceResolution),
    loadTexture('piece-robber', robberUrl, SQUARE_ASSET_SIZE, SQUARE_ASSET_SIZE, pieceResolution),
    loadTexture(
      'resource-brick',
      brickUrl,
      SQUARE_ASSET_SIZE,
      SQUARE_ASSET_SIZE,
      resourceResolution,
    ),
    loadTexture(
      'resource-lumber',
      lumberUrl,
      SQUARE_ASSET_SIZE,
      SQUARE_ASSET_SIZE,
      resourceResolution,
    ),
    loadTexture('resource-wool', woolUrl, SQUARE_ASSET_SIZE, SQUARE_ASSET_SIZE, resourceResolution),
    loadTexture(
      'resource-grain',
      grainUrl,
      SQUARE_ASSET_SIZE,
      SQUARE_ASSET_SIZE,
      resourceResolution,
    ),
    loadTexture('resource-ore', oreUrl, SQUARE_ASSET_SIZE, SQUARE_ASSET_SIZE, resourceResolution),
  ]);

  return {
    terrain: { forest, hills, pasture, fields, mountains, desert, sea },
    numberToken,
    harborMarker,
    harborJetty,
    road,
    settlement,
    city,
    robber,
    resources: { brick, lumber, wool, grain, ore },
  };
}

function assetResolution(
  devicePixelRatio: number,
  maxPixelRatio: number,
  maxZoom: number,
  hexSize: number,
  displayWidthInHexes: number,
  displayHeightInHexes: number,
  sourceWidth: number,
  sourceHeight = sourceWidth,
): number {
  return rasterResolution(
    devicePixelRatio,
    maxPixelRatio,
    maxZoom,
    hexSize * displayWidthInHexes,
    hexSize * displayHeightInHexes,
    sourceWidth,
    sourceHeight,
  );
}

function loadTexture(
  key: string,
  url: string,
  width: number,
  height: number,
  resolution: number,
): Promise<Texture> {
  const stableResolution = Number(resolution.toFixed(2));
  const cacheKey = `${key}:${width}x${height}:${stableResolution}`;
  const existing = texturePromises.get(cacheKey);
  if (existing) return existing;

  const srcUrl = new URL(url, window.location.href);
  srcUrl.searchParams.set('resolution', String(stableResolution));
  const loading = Assets.load<Texture>({
    alias: `cp2p-${cacheKey}`,
    src: srcUrl.href,
    data: { width, height, resolution: stableResolution },
  }).catch((error: unknown) => {
    texturePromises.delete(cacheKey);
    throw error;
  });
  texturePromises.set(cacheKey, loading);
  return loading;
}
