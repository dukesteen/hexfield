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

/** The dice of a knights roll: the red production die and the event die. */
export const DIE_ART = { width: 60, height: 60 } as const;
export const EVENT_FACES = ['ship', 'trade', 'politics', 'science'] as const;
export function redDieKey(face: number): string {
  return `ck-red-die-${Math.min(6, Math.max(1, Math.trunc(face) || 1))}`;
}
export function eventDieKey(face: string): string {
  return `ck-event-die-${face}`;
}

/** Every art key the board draws for the six player colours, for one preload. */
export function knightsBoardArtKeys(): string[] {
  const keys = [
    BARBARIAN_SHIP_KEY,
    ...[1, 2, 3, 4, 5, 6].map(redDieKey),
    ...EVENT_FACES.map(eventDieKey),
  ];
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

/** The fixture art key of the knights module's barbarian track. */
export const BARBARIAN_TRACK_ART = 'barbarian-track';
/** Steps of the track when the model does not say: the ship lands on the seventh. */
export const DEFAULT_BARBARIAN_STEPS = 7;
/** Numbered step tokens shipped as art (`ck-barbarian-step-1` to `-9`). */
export const TRACK_STEP_TOKENS = 9;

/** A grid axis of a two-hex footprint, in degrees: east-west, south-east and south-west. */
export type TrackAxis = 0 | 60 | 120;
export const TRACK_AXES: readonly TrackAxis[] = [0, 60, 120];

/**
 * Authored sizes of the joined two-hex sea tile along each grid axis (art units, 80 to a hex
 * radius). Each is centred on the midpoint of its two hexes and lit from the top left, so it is
 * drawn unrotated. From tools/generate-barbarian-track.mjs.
 */
export const TRACK_TILE_ART: Readonly<Record<TrackAxis, { width: number; height: number }>> = {
  0: { width: 284, height: 166 },
  60: { width: 214, height: 286 },
  120: { width: 214, height: 286 },
};
/** A step token's art box, centred on its disc of radius 11. */
export const TRACK_TOKEN_ART = { width: 28, height: 28, radius: 11 } as const;
/** Tokens draw a fifth larger than their art, so the numbers still read on a phone. */
export const TRACK_TOKEN_SCALE = 1.2;
/** The landing island's art box and the island's centre on it. */
export const TRACK_LANDING_ART = { width: 60, height: 54, originX: 30, originY: 30 } as const;

export const TRACK_START_KEY = 'ck-barbarian-start';
export const TRACK_LANDING_KEY = 'ck-barbarian-landing';
export function trackTileKey(axis: TrackAxis): string {
  return `ck-barbarian-track-tile-${axis}`;
}
export function trackStepKey(step: number): string {
  return `ck-barbarian-step-${Math.min(TRACK_STEP_TOKENS, Math.max(1, Math.trunc(step) || 1))}`;
}
/** Every art key of the composed track, for one preload. */
export function trackArtKeys(): string[] {
  return [
    ...TRACK_AXES.map(trackTileKey),
    TRACK_START_KEY,
    TRACK_LANDING_KEY,
    ...Array.from({ length: TRACK_STEP_TOKENS }, (_, index) => trackStepKey(index + 1)),
  ];
}

/**
 * Where the route runs, in art units from the footprint's midpoint along the axis from the outer
 * hex to the anchor: the start space near the outer end, the numbered steps between, zig-zagging
 * across the axis, and the island in the anchor hex. The ship docks a little below the island.
 */
const ROUTE = { start: -112, first: -84, last: 52, island: 92, zigzag: 11, dock: 12 } as const;

/** One upright piece of the track: its art key, where its anchor sits and its board size. */
export interface TrackPiece {
  readonly key: string;
  readonly at: Point;
  readonly width: number;
  readonly height: number;
  /** The art point placed at `at`, as fractions of the art box. */
  readonly anchor: { readonly x: number; readonly y: number };
  /** Always zero: the track's pieces never turn with the fixture. */
  readonly rotation: 0;
}

/** The track composed for one footprint: the tile, the route and its upright markers. */
export interface BarbarianTrackLayout {
  /** Midpoint of the two hexes. */
  readonly center: Point;
  /** Unit vector from the outer hex to the anchor hex, the way the barbarians sail. */
  readonly direction: Point;
  readonly axis: TrackAxis;
  readonly tile: TrackPiece;
  /** The dotted line: the start, every numbered step and the island. */
  readonly route: readonly Point[];
  /** Where the ship stands at each step: 0 is the start, `steps` the landing. */
  readonly stops: readonly Point[];
  /** The start space, the numbered steps in order, then the island. */
  readonly markers: readonly TrackPiece[];
  /** The ship's art faces east; it is mirrored when the island lies to the west. */
  readonly shipFacesWest: boolean;
}

/** The grid axis a direction runs along, whichever way. */
export function trackAxis(direction: Point): TrackAxis {
  const degrees = (Math.atan2(direction.y, direction.x) * 180) / Math.PI;
  const axis = (((Math.round(degrees / 60) * 60) % 180) + 180) % 180;
  return axis === 60 ? 60 : axis === 120 ? 120 : 0;
}

/**
 * Lay the barbarian track on a two-hex footprint (anchor first): the tile for its axis, then the
 * start, `steps - 1` numbered spaces and the island along the axis. Every piece stays upright.
 */
export function barbarianTrackLayout(
  fixture: RenderFixture,
  hexSize: number,
  steps = DEFAULT_BARBARIAN_STEPS,
): BarbarianTrackLayout | null {
  const [anchorCell, outerCell] = fixture.footprint;
  if (!anchorCell || !outerCell) return null;
  const anchor = hexToPixel(anchorCell.q, anchorCell.r, hexSize);
  const outer = hexToPixel(outerCell.q, outerCell.r, hexSize);
  const length = Math.hypot(anchor.x - outer.x, anchor.y - outer.y);
  if (length === 0) return null;
  const direction = { x: (anchor.x - outer.x) / length, y: (anchor.y - outer.y) / length };
  // Across the axis, pointing up the screen, so the first step always zig-zags upwards.
  const flip = direction.x > 0 || (direction.x === 0 && direction.y < 0) ? 1 : -1;
  const across = { x: direction.y * flip, y: -direction.x * flip };
  const center = { x: (anchor.x + outer.x) / 2, y: (anchor.y + outer.y) / 2 };
  const unit = fixtureScale(hexSize);
  const point = (along: number, side = 0): Point => ({
    x: center.x + (direction.x * along + across.x * side) * unit,
    y: center.y + (direction.y * along + across.y * side) * unit,
  });
  const count = Math.min(TRACK_STEP_TOKENS, Math.max(1, Math.trunc(steps) || 1) - 1);
  const numbered = Array.from({ length: count }, (_, index) => {
    const t = count === 1 ? 0.5 : index / (count - 1);
    const along = ROUTE.first + (ROUTE.last - ROUTE.first) * t;
    return point(along, index % 2 === 0 ? ROUTE.zigzag : -ROUTE.zigzag);
  });
  const start = point(ROUTE.start);
  const island = point(ROUTE.island);
  const axis = trackAxis(direction);
  const tileArt = TRACK_TILE_ART[axis];
  const token = (key: string, at: Point): TrackPiece => ({
    key,
    at,
    width: TRACK_TOKEN_ART.width * unit * TRACK_TOKEN_SCALE,
    height: TRACK_TOKEN_ART.height * unit * TRACK_TOKEN_SCALE,
    anchor: { x: 0.5, y: 0.5 },
    rotation: 0,
  });
  return {
    center,
    direction,
    axis,
    tile: {
      key: trackTileKey(axis),
      at: center,
      width: tileArt.width * unit,
      height: tileArt.height * unit,
      anchor: { x: 0.5, y: 0.5 },
      rotation: 0,
    },
    route: [start, ...numbered, island],
    stops: [start, ...numbered, { x: island.x, y: island.y + ROUTE.dock * unit }],
    markers: [
      token(TRACK_START_KEY, start),
      ...numbered.map((at, index) => token(trackStepKey(index + 1), at)),
      {
        key: TRACK_LANDING_KEY,
        at: island,
        width: TRACK_LANDING_ART.width * unit,
        height: TRACK_LANDING_ART.height * unit,
        anchor: {
          x: TRACK_LANDING_ART.originX / TRACK_LANDING_ART.width,
          y: TRACK_LANDING_ART.originY / TRACK_LANDING_ART.height,
        },
        rotation: 0,
      },
    ],
    shipFacesWest: direction.x < -1e-6,
  };
}

/** Evenly spaced dots along the route, `spacing` board pixels apart, for the dotted line. */
export function routeDots(route: readonly Point[], spacing: number): Point[] {
  const dots: Point[] = [];
  let carry = 0;
  for (let index = 1; index < route.length; index += 1) {
    const from = route[index - 1];
    const to = route[index];
    if (!from || !to) continue;
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    let at = carry;
    for (; at <= length; at += spacing) {
      const t = length === 0 ? 0 : at / length;
      dots.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
    carry = at - length;
  }
  return dots;
}

/** The art scale that lets the track's hexes fill their grid cells (art hexes have radius 80). */
export function fixtureScale(hexSize: number): number {
  return hexSize / 80;
}

/** The board pixel of the barbarian ship at `step` (0 is the start, `steps` the landing). */
export function barbarianStepPoint(
  fixture: RenderFixture,
  hexSize: number,
  step: number,
  steps = DEFAULT_BARBARIAN_STEPS,
): Point | null {
  const stops = barbarianTrackLayout(fixture, hexSize, steps)?.stops;
  if (!stops) return null;
  return stops[Math.min(stops.length - 1, Math.max(0, Math.trunc(step)))] ?? null;
}

/** Board pixel and eased position of the ship between two steps, for the sailing motion. */
export function sailPosition(
  fixture: RenderFixture,
  hexSize: number,
  from: number,
  to: number,
  progress: number,
  steps = DEFAULT_BARBARIAN_STEPS,
): Point | null {
  const start = barbarianStepPoint(fixture, hexSize, from, steps);
  const end = barbarianStepPoint(fixture, hexSize, to, steps);
  if (!start || !end) return null;
  const t = Math.min(1, Math.max(0, progress));
  const eased = t * t * (3 - 2 * t);
  const bob = Math.sin(t * Math.PI) * hexSize * 0.09;
  return {
    x: start.x + (end.x - start.x) * eased,
    y: start.y + (end.y - start.y) * eased - bob,
  };
}
