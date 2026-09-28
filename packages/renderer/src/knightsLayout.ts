import type { Point } from '@cp2p/engine/geometry';
import { hexToPixel } from '@cp2p/engine/geometry';
import type { ArtColor } from './assets/terrainTextures.js';
import type { KnightsTrack, RenderFixture } from './types.js';

/** Authored sizes (art units, 80 to a hex radius) of the Cities & Knights piece art. */
export const KNIGHT_ART = { width: 44, height: 34 } as const;
export const WALLED_CITY_ART = { width: 91.6, height: 64.9, originX: 45.8, originY: 38 } as const;
export const METROPOLIS_ART = { width: 60, height: 70, originX: 30, originY: 56 } as const;
export const WALLED_METROPOLIS_ART = {
  width: 108.4,
  height: 97.1,
  originX: 54.2,
  originY: 66,
} as const;
export const MERCHANT_ART = { width: 30, height: 46 } as const;
export const BARBARIAN_SHIP_ART = { width: 58, height: 60 } as const;

/** Where a knight disc, a merchant and the barbarian ship sit on their art, as fractions. */
export const KNIGHT_ANCHOR = { x: 0.5, y: 0.6 } as const;
export const MERCHANT_ANCHOR = { x: 0.5, y: 0.94 } as const;
export const BARBARIAN_SHIP_ANCHOR = { x: 0.5, y: 0.78 } as const;

export const KNIGHTS_TRACKS: readonly KnightsTrack[] = ['trade', 'politics', 'science'];
export const KNIGHT_LEVELS = [1, 2, 3] as const;
export const ART_COLOR_NAMES: readonly ArtColor[] = [
  'blue',
  'orange',
  'green',
  'red',
  'black',
  'white',
];

export function knightArtKey(color: ArtColor, level: number, active: boolean): string {
  const clamped = Math.min(3, Math.max(1, Math.trunc(level) || 1));
  return `ck-knight-${color}-${clamped}-${active ? 'active' : 'inactive'}`;
}

export function walledCityArtKey(color: ArtColor): string {
  return `ck-city-walled-${color}`;
}

export function metropolisArtKey(track: KnightsTrack, walled: boolean, color: ArtColor): string {
  return `ck-metropolis-${track}${walled ? '-walled' : ''}-${color}`;
}

export function merchantArtKey(color: ArtColor): string {
  return `ck-merchant-${color}`;
}

export const BARBARIAN_SHIP_KEY = 'ck-barbarian-ship-piece';

/** Every art key the board draws for the six player colours, for one preload. */
export function knightsBoardArtKeys(): string[] {
  const keys = [BARBARIAN_SHIP_KEY];
  for (const color of ART_COLOR_NAMES) {
    keys.push(walledCityArtKey(color), merchantArtKey(color));
    for (const level of KNIGHT_LEVELS)
      for (const active of [true, false]) keys.push(knightArtKey(color, level, active));
    for (const track of KNIGHTS_TRACKS)
      for (const walled of [false, true]) keys.push(metropolisArtKey(track, walled, color));
  }
  return keys;
}

/** The art size and anchor of a city with its wall and metropolis, if it has either. */
export function decoratedCity(
  wall: boolean,
  metropolis: KnightsTrack | undefined,
): { art: { width: number; height: number; originX: number; originY: number } } | null {
  if (metropolis) return { art: wall ? WALLED_METROPOLIS_ART : METROPOLIS_ART };
  return wall ? { art: WALLED_CITY_ART } : null;
}

/**
 * Space of the barbarian track art, matching `FIXTURE_ART_SIZE`: two pointy-top hexes of radius
 * 80 joined east to west, the ship's start in the west hex and the landing island in the east
 * hex. The steps are where the numbered circles are printed.
 */
export const TRACK_ART = {
  width: 289,
  height: 174,
  center: { x: 144.5, y: 87 },
  /** The start space, the six numbered spaces and the landing beside the island. */
  points: [
    { x: 30, y: 99 },
    { x: 57, y: 73 },
    { x: 86, y: 97 },
    { x: 116, y: 72 },
    { x: 146, y: 93 },
    { x: 175, y: 68 },
    { x: 202, y: 93 },
    { x: 236, y: 98 },
  ],
} as const;

/** The art scale that lets the track's hexes fill their grid cells (art hexes have radius 80). */
export function fixtureScale(hexSize: number): number {
  return hexSize / 80;
}

/** The centre of the fixture art, its rotation and the world-space scale, from its footprint. */
export function fixtureFrame(
  fixture: RenderFixture,
  hexSize: number,
): { center: Point; rotation: number; scale: number } | null {
  const [anchor, outer] = fixture.footprint;
  if (!anchor || !outer) return null;
  const a = hexToPixel(anchor.q, anchor.r, hexSize);
  const o = hexToPixel(outer.q, outer.r, hexSize);
  return {
    center: { x: (a.x + o.x) / 2, y: (a.y + o.y) / 2 },
    rotation: Math.atan2(a.y - o.y, a.x - o.x),
    scale: fixtureScale(hexSize),
  };
}

/** A point of the track art in board pixels. */
export function fixturePoint(fixture: RenderFixture, hexSize: number, art: Point): Point | null {
  const frame = fixtureFrame(fixture, hexSize);
  if (!frame) return null;
  const dx = (art.x - TRACK_ART.center.x) * frame.scale;
  const dy = (art.y - TRACK_ART.center.y) * frame.scale;
  const cos = Math.cos(frame.rotation);
  const sin = Math.sin(frame.rotation);
  return { x: frame.center.x + dx * cos - dy * sin, y: frame.center.y + dx * sin + dy * cos };
}

/** The board pixel of the barbarian ship at `step` (0 is the start, `TRACK_ART.points.length - 1` the landing). */
export function barbarianStepPoint(
  fixture: RenderFixture,
  hexSize: number,
  step: number,
): Point | null {
  const index = Math.min(TRACK_ART.points.length - 1, Math.max(0, Math.trunc(step)));
  const point = TRACK_ART.points[index];
  return point ? fixturePoint(fixture, hexSize, point) : null;
}

/** Board pixel and eased position of the ship between two steps, for the sailing motion. */
export function sailPosition(
  fixture: RenderFixture,
  hexSize: number,
  from: number,
  to: number,
  progress: number,
): Point | null {
  const start = barbarianStepPoint(fixture, hexSize, from);
  const end = barbarianStepPoint(fixture, hexSize, to);
  if (!start || !end) return null;
  const t = Math.min(1, Math.max(0, progress));
  const eased = t * t * (3 - 2 * t);
  const bob = Math.sin(t * Math.PI) * hexSize * 0.09;
  return {
    x: start.x + (end.x - start.x) * eased,
    y: start.y + (end.y - start.y) * eased - bob,
  };
}
