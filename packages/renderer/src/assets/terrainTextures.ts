import { Assets } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { Resource } from '@cp2p/engine';
import type { DevelopmentCard } from '../types.js';
import boardBackgroundUrl from './redesign/board-background.svg?no-inline';
import boardFrameUrl from './redesign/board-frame.svg?no-inline';
import boardPreviewUrl from './redesign/board-preview.svg?no-inline';
import boardUnderlayUrl from './redesign/board-underlay.svg?no-inline';
import cardBackUrl from './redesign/card-back.svg?no-inline';
import cardBrickUrl from './redesign/card-brick.svg?no-inline';
import cardGrainUrl from './redesign/card-grain.svg?no-inline';
import cardKnightUrl from './redesign/card-knight.svg?no-inline';
import cardLargestArmyUrl from './redesign/card-largest-army.svg?no-inline';
import cardLongestRoadUrl from './redesign/card-longest-road.svg?no-inline';
import cardLumberUrl from './redesign/card-lumber.svg?no-inline';
import cardMonopolyUrl from './redesign/card-monopoly.svg?no-inline';
import cardOreUrl from './redesign/card-ore.svg?no-inline';
import cardPlentyUrl from './redesign/card-plenty.svg?no-inline';
import cardRoadsUrl from './redesign/card-roads.svg?no-inline';
import cardVictoryUrl from './redesign/card-victory.svg?no-inline';
import cardWoolUrl from './redesign/card-wool.svg?no-inline';
import cityBlackUrl from './redesign/city-black.svg?no-inline';
import cityBlueUrl from './redesign/city-blue.svg?no-inline';
import cityGreenUrl from './redesign/city-green.svg?no-inline';
import cityOrangeUrl from './redesign/city-orange.svg?no-inline';
import cityRedUrl from './redesign/city-red.svg?no-inline';
import cityWhiteUrl from './redesign/city-white.svg?no-inline';
import die1Url from './redesign/die-1.svg?no-inline';
import die2Url from './redesign/die-2.svg?no-inline';
import die3Url from './redesign/die-3.svg?no-inline';
import die4Url from './redesign/die-4.svg?no-inline';
import die5Url from './redesign/die-5.svg?no-inline';
import die6Url from './redesign/die-6.svg?no-inline';
import factionBlackUrl from './redesign/faction-black.svg?no-inline';
import factionBlueUrl from './redesign/faction-blue.svg?no-inline';
import factionGreenUrl from './redesign/faction-green.svg?no-inline';
import factionOrangeUrl from './redesign/faction-orange.svg?no-inline';
import factionRedUrl from './redesign/faction-red.svg?no-inline';
import factionWhiteUrl from './redesign/faction-white.svg?no-inline';
import harbor3to1Url from './redesign/harbor-3to1.svg?no-inline';
import harborBrickUrl from './redesign/harbor-brick.svg?no-inline';
import harborGrainUrl from './redesign/harbor-grain.svg?no-inline';
import harborLumberUrl from './redesign/harbor-lumber.svg?no-inline';
import harborOreUrl from './redesign/harbor-ore.svg?no-inline';
import harborWoolUrl from './redesign/harbor-wool.svg?no-inline';
import iconBankTradeUrl from './redesign/icon-bank-trade.svg?no-inline';
import iconBrickUrl from './redesign/icon-brick.svg?no-inline';
import iconGrainUrl from './redesign/icon-grain.svg?no-inline';
import iconKnightUrl from './redesign/icon-knight.svg?no-inline';
import iconLongestUrl from './redesign/icon-longest.svg?no-inline';
import iconLumberUrl from './redesign/icon-lumber.svg?no-inline';
import iconMonopolyUrl from './redesign/icon-monopoly.svg?no-inline';
import iconOreUrl from './redesign/icon-ore.svg?no-inline';
import iconPlayerTradeUrl from './redesign/icon-player-trade.svg?no-inline';
import iconPlentyUrl from './redesign/icon-plenty.svg?no-inline';
import iconRoadsUrl from './redesign/icon-roads.svg?no-inline';
import iconVictoryUrl from './redesign/icon-victory.svg?no-inline';
import iconWoolUrl from './redesign/icon-wool.svg?no-inline';
import roadBlack1Url from './redesign/road-black-1.svg?no-inline';
import roadBlack2Url from './redesign/road-black-2.svg?no-inline';
import roadBlack3Url from './redesign/road-black-3.svg?no-inline';
import roadBlue1Url from './redesign/road-blue-1.svg?no-inline';
import roadBlue2Url from './redesign/road-blue-2.svg?no-inline';
import roadBlue3Url from './redesign/road-blue-3.svg?no-inline';
import roadGreen1Url from './redesign/road-green-1.svg?no-inline';
import roadGreen2Url from './redesign/road-green-2.svg?no-inline';
import roadGreen3Url from './redesign/road-green-3.svg?no-inline';
import roadOrange1Url from './redesign/road-orange-1.svg?no-inline';
import roadOrange2Url from './redesign/road-orange-2.svg?no-inline';
import roadOrange3Url from './redesign/road-orange-3.svg?no-inline';
import roadRed1Url from './redesign/road-red-1.svg?no-inline';
import roadRed2Url from './redesign/road-red-2.svg?no-inline';
import roadRed3Url from './redesign/road-red-3.svg?no-inline';
import roadWhite1Url from './redesign/road-white-1.svg?no-inline';
import roadWhite2Url from './redesign/road-white-2.svg?no-inline';
import roadWhite3Url from './redesign/road-white-3.svg?no-inline';
import robberUrl from './redesign/robber.svg?no-inline';
import settlementBlackUrl from './redesign/settlement-black.svg?no-inline';
import settlementBlueUrl from './redesign/settlement-blue.svg?no-inline';
import settlementGreenUrl from './redesign/settlement-green.svg?no-inline';
import settlementOrangeUrl from './redesign/settlement-orange.svg?no-inline';
import settlementRedUrl from './redesign/settlement-red.svg?no-inline';
import settlementWhiteUrl from './redesign/settlement-white.svg?no-inline';
import tileDesertUrl from './redesign/tile-desert.svg?no-inline';
import tileFields1Url from './redesign/tile-fields-1.svg?no-inline';
import tileFields2Url from './redesign/tile-fields-2.svg?no-inline';
import tileFields3Url from './redesign/tile-fields-3.svg?no-inline';
import tileForest1Url from './redesign/tile-forest-1.svg?no-inline';
import tileForest2Url from './redesign/tile-forest-2.svg?no-inline';
import tileForest3Url from './redesign/tile-forest-3.svg?no-inline';
import tileHills1Url from './redesign/tile-hills-1.svg?no-inline';
import tileHills2Url from './redesign/tile-hills-2.svg?no-inline';
import tileHills3Url from './redesign/tile-hills-3.svg?no-inline';
import tileHillsQuarry1Url from './redesign/tile-hills-quarry-1.svg?no-inline';
import tileHillsQuarry2Url from './redesign/tile-hills-quarry-2.svg?no-inline';
import tileHillsQuarry3Url from './redesign/tile-hills-quarry-3.svg?no-inline';
import tileMountains1Url from './redesign/tile-mountains-1.svg?no-inline';
import tileMountains2Url from './redesign/tile-mountains-2.svg?no-inline';
import tileMountains3Url from './redesign/tile-mountains-3.svg?no-inline';
import tileMountainsAlpine1Url from './redesign/tile-mountains-alpine-1.svg?no-inline';
import tileMountainsAlpine2Url from './redesign/tile-mountains-alpine-2.svg?no-inline';
import tileMountainsAlpine3Url from './redesign/tile-mountains-alpine-3.svg?no-inline';
import tilePasture1Url from './redesign/tile-pasture-1.svg?no-inline';
import tilePasture2Url from './redesign/tile-pasture-2.svg?no-inline';
import tilePasture3Url from './redesign/tile-pasture-3.svg?no-inline';
import tileSea1Url from './redesign/tile-sea-1.svg?no-inline';
import tileSea2Url from './redesign/tile-sea-2.svg?no-inline';
import tileSea3Url from './redesign/tile-sea-3.svg?no-inline';
import token10Url from './redesign/token-10.svg?no-inline';
import token11Url from './redesign/token-11.svg?no-inline';
import token12Url from './redesign/token-12.svg?no-inline';
import token2Url from './redesign/token-2.svg?no-inline';
import token3Url from './redesign/token-3.svg?no-inline';
import token4Url from './redesign/token-4.svg?no-inline';
import token5Url from './redesign/token-5.svg?no-inline';
import token6Url from './redesign/token-6.svg?no-inline';
import token8Url from './redesign/token-8.svg?no-inline';
import token9Url from './redesign/token-9.svg?no-inline';
import turnMarkerUrl from './redesign/turn-marker.svg?no-inline';
import fixtureBarbarianTrackUrl from './redesign/fixture-barbarian-track.svg?no-inline';

const ART: Readonly<Record<string, string>> = {
  'board-background': boardBackgroundUrl,
  'board-frame': boardFrameUrl,
  'board-preview': boardPreviewUrl,
  'board-underlay': boardUnderlayUrl,
  'fixture-barbarian-track': fixtureBarbarianTrackUrl,
  'card-back': cardBackUrl,
  'card-brick': cardBrickUrl,
  'card-grain': cardGrainUrl,
  'card-knight': cardKnightUrl,
  'card-largest-army': cardLargestArmyUrl,
  'card-longest-road': cardLongestRoadUrl,
  'card-lumber': cardLumberUrl,
  'card-monopoly': cardMonopolyUrl,
  'card-ore': cardOreUrl,
  'card-plenty': cardPlentyUrl,
  'card-roads': cardRoadsUrl,
  'card-victory': cardVictoryUrl,
  'card-wool': cardWoolUrl,
  'city-black': cityBlackUrl,
  'city-blue': cityBlueUrl,
  'city-green': cityGreenUrl,
  'city-orange': cityOrangeUrl,
  'city-red': cityRedUrl,
  'city-white': cityWhiteUrl,
  'die-1': die1Url,
  'die-2': die2Url,
  'die-3': die3Url,
  'die-4': die4Url,
  'die-5': die5Url,
  'die-6': die6Url,
  'faction-black': factionBlackUrl,
  'faction-blue': factionBlueUrl,
  'faction-green': factionGreenUrl,
  'faction-orange': factionOrangeUrl,
  'faction-red': factionRedUrl,
  'faction-white': factionWhiteUrl,
  'harbor-3to1': harbor3to1Url,
  'harbor-brick': harborBrickUrl,
  'harbor-grain': harborGrainUrl,
  'harbor-lumber': harborLumberUrl,
  'harbor-ore': harborOreUrl,
  'harbor-wool': harborWoolUrl,
  'icon-bank-trade': iconBankTradeUrl,
  'icon-brick': iconBrickUrl,
  'icon-grain': iconGrainUrl,
  'icon-knight': iconKnightUrl,
  'icon-longest': iconLongestUrl,
  'icon-lumber': iconLumberUrl,
  'icon-monopoly': iconMonopolyUrl,
  'icon-ore': iconOreUrl,
  'icon-player-trade': iconPlayerTradeUrl,
  'icon-plenty': iconPlentyUrl,
  'icon-roads': iconRoadsUrl,
  'icon-victory': iconVictoryUrl,
  'icon-wool': iconWoolUrl,
  'road-black-1': roadBlack1Url,
  'road-black-2': roadBlack2Url,
  'road-black-3': roadBlack3Url,
  'road-blue-1': roadBlue1Url,
  'road-blue-2': roadBlue2Url,
  'road-blue-3': roadBlue3Url,
  'road-green-1': roadGreen1Url,
  'road-green-2': roadGreen2Url,
  'road-green-3': roadGreen3Url,
  'road-orange-1': roadOrange1Url,
  'road-orange-2': roadOrange2Url,
  'road-orange-3': roadOrange3Url,
  'road-red-1': roadRed1Url,
  'road-red-2': roadRed2Url,
  'road-red-3': roadRed3Url,
  'road-white-1': roadWhite1Url,
  'road-white-2': roadWhite2Url,
  'road-white-3': roadWhite3Url,
  robber: robberUrl,
  'settlement-black': settlementBlackUrl,
  'settlement-blue': settlementBlueUrl,
  'settlement-green': settlementGreenUrl,
  'settlement-orange': settlementOrangeUrl,
  'settlement-red': settlementRedUrl,
  'settlement-white': settlementWhiteUrl,
  'tile-desert': tileDesertUrl,
  'tile-fields-1': tileFields1Url,
  'tile-fields-2': tileFields2Url,
  'tile-fields-3': tileFields3Url,
  'tile-forest-1': tileForest1Url,
  'tile-forest-2': tileForest2Url,
  'tile-forest-3': tileForest3Url,
  'tile-hills-1': tileHills1Url,
  'tile-hills-2': tileHills2Url,
  'tile-hills-3': tileHills3Url,
  'tile-hills-quarry-1': tileHillsQuarry1Url,
  'tile-hills-quarry-2': tileHillsQuarry2Url,
  'tile-hills-quarry-3': tileHillsQuarry3Url,
  'tile-mountains-1': tileMountains1Url,
  'tile-mountains-2': tileMountains2Url,
  'tile-mountains-3': tileMountains3Url,
  'tile-mountains-alpine-1': tileMountainsAlpine1Url,
  'tile-mountains-alpine-2': tileMountainsAlpine2Url,
  'tile-mountains-alpine-3': tileMountainsAlpine3Url,
  'tile-pasture-1': tilePasture1Url,
  'tile-pasture-2': tilePasture2Url,
  'tile-pasture-3': tilePasture3Url,
  'tile-sea-1': tileSea1Url,
  'tile-sea-2': tileSea2Url,
  'tile-sea-3': tileSea3Url,
  'token-10': token10Url,
  'token-11': token11Url,
  'token-12': token12Url,
  'token-2': token2Url,
  'token-3': token3Url,
  'token-4': token4Url,
  'token-5': token5Url,
  'token-6': token6Url,
  'token-8': token8Url,
  'token-9': token9Url,
  'turn-marker': turnMarkerUrl,
};
const texturePromises = new Map<string, Promise<Texture>>();
const TERRAIN_NAMES = ['forest', 'hills', 'pasture', 'fields', 'mountains', 'sea'] as const;
export type TerrainName = (typeof TERRAIN_NAMES)[number] | 'desert';
export type ArtColor = 'blue' | 'orange' | 'green' | 'red' | 'black' | 'white';
export type GameArt =
  | 'background'
  | 'cardBack'
  | 'turnMarker'
  | 'bankTrade'
  | 'playerTrade'
  | 'preview';
const GAME_ART: Record<GameArt, string> = {
  background: 'board-background',
  cardBack: 'card-back',
  turnMarker: 'turn-marker',
  bankTrade: 'icon-bank-trade',
  playerTrade: 'icon-player-trade',
  preview: 'board-preview',
};
const DEVELOPMENT_ART: Record<DevelopmentCard, string> = {
  knight: 'card-knight',
  roadBuilding: 'card-roads',
  yearOfPlenty: 'card-plenty',
  monopoly: 'card-monopoly',
  victoryPoint: 'card-victory',
};

export interface BoardTextures {
  readonly terrain: Readonly<Record<TerrainName, readonly Texture[]>>;
  readonly tokens: Readonly<Record<number, Texture>>;
  readonly harbors: Readonly<Record<string, Texture>>;
  readonly roads: Readonly<Record<ArtColor, readonly [Texture, Texture, Texture]>>;
  readonly settlements: Readonly<Record<ArtColor, Texture>>;
  readonly cities: Readonly<Record<ArtColor, Texture>>;
  readonly robber: Texture;
  readonly dice: readonly [Texture, Texture, Texture, Texture, Texture, Texture];
  readonly frame: Texture;
  readonly underlay: Texture;
  /** Built-in fixture art keyed by `RenderFixture.art`. */
  readonly fixtures: Readonly<Record<string, Texture>>;
}

/** Authored size of the two-hex fixture art: two pointy-top hexes joined east to west. */
export const FIXTURE_ART_SIZE = { width: 289, height: 174 } as const;

export function getResourceIconUrl(resource: Resource): string {
  return artUrl(`icon-${resource}`);
}
export function getResourceCardUrl(resource: Resource): string {
  return artUrl(`card-${resource}`);
}
export function getDevelopmentCardUrl(card: DevelopmentCard): string {
  return artUrl(DEVELOPMENT_ART[card]);
}
export function getPieceIconUrl(piece: 'road' | 'settlement' | 'city', color = 'blue'): string {
  const artColor = normalizeArtColor(color);
  return artUrl(`${piece}-${artColor}${piece === 'road' ? '-2' : ''}`);
}
export function getDieUrl(face: number): string {
  return artUrl(`die-${Math.min(6, Math.max(1, Math.trunc(face) || 1))}`);
}
export function getFactionUrl(color: string): string {
  return artUrl(`faction-${normalizeArtColor(color)}`);
}
export function getAwardCardUrl(award: 'longestRoad' | 'largestArmy'): string {
  return artUrl(award === 'longestRoad' ? 'card-longest-road' : 'card-largest-army');
}
export function getGameArtUrl(art: GameArt): string {
  return artUrl(GAME_ART[art]);
}
function artUrl(key: string): string {
  const url = ART[key];
  if (!url) throw new Error(`Missing art asset: ${key}`);
  return url;
}

export function normalizeArtColor(color: string): ArtColor {
  switch (color) {
    case 'orange':
    case 'green':
    case 'red':
    case 'black':
    case 'white':
    case 'blue':
      return color;
    case 'magenta':
      return 'black';
    case 'yellow':
      return 'white';
    default:
      return 'blue';
  }
}

export function artColorFromNumber(color: number): ArtColor {
  const palette: readonly [ArtColor, number][] = [
    ['blue', 0x0072b2],
    ['orange', 0xd55e00],
    ['green', 0x009e73],
    ['black', 0xb35b93],
    ['white', 0xe6ad26],
    ['red', 0xcf4a44],
    ['black', 0x3d3842],
    ['white', 0xefe7d6],
    ['blue', 0x4f7fbf],
    ['orange', 0xe59a3c],
    ['green', 0x5f9a4c],
    ['red', 0xcf5a4b],
  ];
  let nearest: ArtColor = 'blue';
  let smallest = Infinity;
  for (const [name, candidate] of palette) {
    const dr = ((color >> 16) & 255) - ((candidate >> 16) & 255);
    const dg = ((color >> 8) & 255) - ((candidate >> 8) & 255);
    const db = (color & 255) - (candidate & 255);
    const distance = dr * dr + dg * dg + db * db;
    if (distance < smallest) {
      smallest = distance;
      nearest = name;
    }
  }
  return nearest;
}

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
    (150 / 80) * hexSize,
    (174 / 80) * hexSize,
    150,
    174,
  );
  const tokenResolution = rasterResolution(
    devicePixelRatio,
    maxPixelRatio,
    maxZoom,
    hexSize * 0.625,
    hexSize * 0.625,
    50,
    50,
  );
  const pieceResolution = rasterResolution(
    devicePixelRatio,
    maxPixelRatio,
    maxZoom,
    hexSize * 0.62,
    hexSize * 0.72,
    48,
    50,
  );
  const harborResolution = rasterResolution(
    devicePixelRatio,
    maxPixelRatio,
    maxZoom,
    hexSize * 1.7,
    hexSize * 1.7,
    100,
    100,
  );
  const requests = new Map<string, Promise<Texture>>();
  const add = (key: string, width: number, height: number, resolution: number): void => {
    requests.set(key, loadTexture(key, width, height, resolution));
  };
  for (const name of TERRAIN_NAMES)
    for (const variant of [1, 2, 3]) add(`tile-${name}-${variant}`, 150, 174, terrainResolution);
  add('tile-desert', 150, 174, terrainResolution);
  for (const value of [2, 3, 4, 5, 6, 8, 9, 10, 11, 12])
    add(`token-${value}`, 50, 50, tokenResolution);
  for (const kind of ['3to1', 'brick', 'lumber', 'wool', 'grain', 'ore'])
    add(`harbor-${kind}`, 100, 100, harborResolution);
  for (const color of ['blue', 'orange', 'green', 'red', 'black', 'white'] as const) {
    for (const variant of [1, 2, 3]) add(`road-${color}-${variant}`, 60, 60, pieceResolution);
    add(`settlement-${color}`, 40, 40, pieceResolution);
    add(`city-${color}`, 48, 50, pieceResolution);
  }
  add('robber', 64, 92, pieceResolution);
  const diceResolution = rasterResolution(devicePixelRatio, maxPixelRatio, 1, 64, 64, 60, 60);
  for (const face of [1, 2, 3, 4, 5, 6]) add(`die-${face}`, 60, 60, diceResolution);
  const frameResolution = rasterResolution(
    devicePixelRatio,
    maxPixelRatio,
    maxZoom,
    hexSize * 14,
    hexSize * 13,
    1120,
    1040,
  );
  add('board-frame', 1120, 1040, frameResolution);
  add(
    'fixture-barbarian-track',
    FIXTURE_ART_SIZE.width,
    FIXTURE_ART_SIZE.height,
    rasterResolution(
      devicePixelRatio,
      maxPixelRatio,
      maxZoom,
      hexSize * 2 * Math.sqrt(3),
      hexSize * 2,
      FIXTURE_ART_SIZE.width,
      FIXTURE_ART_SIZE.height,
    ),
  );
  add('board-underlay', 1120, 1040, frameResolution);
  const loaded = new Map(
    await Promise.all([...requests].map(async ([key, request]) => [key, await request] as const)),
  );
  const get = (key: string): Texture => {
    const texture = loaded.get(key);
    if (!texture) throw new Error(`Missing board texture: ${key}`);
    return texture;
  };
  const terrain: Record<TerrainName, readonly Texture[]> = {
    forest: [1, 2, 3].map((variant) => get(`tile-forest-${variant}`)),
    hills: [1, 2, 3].map((variant) => get(`tile-hills-${variant}`)),
    pasture: [1, 2, 3].map((variant) => get(`tile-pasture-${variant}`)),
    fields: [1, 2, 3].map((variant) => get(`tile-fields-${variant}`)),
    mountains: [1, 2, 3].map((variant) => get(`tile-mountains-${variant}`)),
    sea: [1, 2, 3].map((variant) => get(`tile-sea-${variant}`)),
    desert: [get('tile-desert')],
  };
  const tokens: Record<number, Texture> = {};
  for (const value of [2, 3, 4, 5, 6, 8, 9, 10, 11, 12]) tokens[value] = get(`token-${value}`);
  const harbors: Record<string, Texture> = {};
  for (const kind of ['3to1', 'brick', 'lumber', 'wool', 'grain', 'ore'])
    harbors[kind] = get(`harbor-${kind}`);
  const roads: Record<ArtColor, readonly [Texture, Texture, Texture]> = {
    blue: [get('road-blue-1'), get('road-blue-2'), get('road-blue-3')],
    orange: [get('road-orange-1'), get('road-orange-2'), get('road-orange-3')],
    green: [get('road-green-1'), get('road-green-2'), get('road-green-3')],
    red: [get('road-red-1'), get('road-red-2'), get('road-red-3')],
    black: [get('road-black-1'), get('road-black-2'), get('road-black-3')],
    white: [get('road-white-1'), get('road-white-2'), get('road-white-3')],
  };
  const settlements: Record<ArtColor, Texture> = {
    blue: get('settlement-blue'),
    orange: get('settlement-orange'),
    green: get('settlement-green'),
    red: get('settlement-red'),
    black: get('settlement-black'),
    white: get('settlement-white'),
  };
  const cities: Record<ArtColor, Texture> = {
    blue: get('city-blue'),
    orange: get('city-orange'),
    green: get('city-green'),
    red: get('city-red'),
    black: get('city-black'),
    white: get('city-white'),
  };
  return {
    terrain,
    tokens,
    harbors,
    roads,
    settlements,
    cities,
    robber: get('robber'),
    dice: [get('die-1'), get('die-2'), get('die-3'), get('die-4'), get('die-5'), get('die-6')],
    frame: get('board-frame'),
    underlay: get('board-underlay'),
    fixtures: { 'barbarian-track': get('fixture-barbarian-track') },
  };
}

function loadTexture(
  key: string,
  width: number,
  height: number,
  resolution: number,
): Promise<Texture> {
  const stableResolution = Number(resolution.toFixed(2));
  const cacheKey = `${key}:${width}x${height}:${stableResolution}`;
  const existing = texturePromises.get(cacheKey);
  if (existing) return existing;
  const url = ART[key];
  if (!url) return Promise.reject(new Error(`Missing art asset: ${key}`));
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
