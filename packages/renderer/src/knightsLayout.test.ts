import { describe, expect, test } from 'vitest';
import { hexToPixel } from '@cp2p/engine/geometry';
import { KNIGHTS_ART } from './assets/knightsArt.js';
import { hitTestFixture } from './fixtures.js';
import {
  TRACK_LANDING_KEY,
  TRACK_START_KEY,
  TRACK_STEP_TOKENS,
  TRACK_TILE_ART,
  TRACK_TOKEN_ART,
  TRACK_TOKEN_SCALE,
  barbarianStepPoint,
  barbarianTrackLayout,
  decoratedCity,
  knightArtKey,
  knightsBoardArtKeys,
  metropolisArtKey,
  routeDots,
  sailPosition,
  trackArtKeys,
  trackAxis,
  trackStepKey,
  trackTileKey,
} from './knightsLayout.js';
import type { RenderFixture } from './types.js';

const HEX = 54;
const north: RenderFixture = {
  id: 'barbarian-track',
  module: 'knights',
  footprint: [
    { q: 0, r: -3 },
    { q: 0, r: -4 },
  ],
  orientation: 2,
  art: 'barbarian-track',
};
const northWest: RenderFixture = {
  ...north,
  footprint: [
    { q: 1, r: -4 },
    { q: 1, r: -5 },
  ],
};

const distance = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

describe('knights art keys', () => {
  test('every key the board preloads is a shipped art file', () => {
    const keys = knightsBoardArtKeys();
    // one ship, ten dice faces, and per colour: a walled city, a merchant, six knights and six metropolises
    expect(keys).toHaveLength(1 + 6 + 4 + 6 * 14);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(Object.keys(KNIGHTS_ART)).toContain(key);
  });

  test('strengths are clamped and an active knight has its own art', () => {
    expect(knightArtKey('red', 2, true)).toBe('ck-knight-red-2-active');
    expect(knightArtKey('white', 9, false)).toBe('ck-knight-white-3-inactive');
    expect(knightArtKey('blue', 0, true)).toBe('ck-knight-blue-1-active');
    expect(metropolisArtKey('trade', true, 'green')).toBe('ck-metropolis-trade-walled-green');
  });

  test('a city is drawn specially only with a wall or a metropolis', () => {
    expect(decoratedCity(false, undefined)).toBeNull();
    expect(decoratedCity(true, undefined)?.art.width).toBeCloseTo(91.6);
    expect(decoratedCity(false, 'science')?.art.height).toBe(70);
    expect(decoratedCity(true, 'science')?.art.width).toBeCloseTo(108.4);
  });
});

/** A footprint whose outer hex lies `direction` (an axial step) from its anchor. */
const DIRECTIONS = [
  { name: 'east', q: 1, r: 0 },
  { name: 'south-east', q: 0, r: 1 },
  { name: 'south-west', q: -1, r: 1 },
  { name: 'west', q: -1, r: 0 },
  { name: 'north-west', q: 0, r: -1 },
  { name: 'north-east', q: 1, r: -1 },
] as const;
const toward = (anchor: { q: number; r: number }, step: { q: number; r: number }) => ({
  ...north,
  footprint: [anchor, { q: anchor.q + step.q, r: anchor.r + step.r }],
});
const EVERY_ORIENTATION: [string, RenderFixture][] = [
  ['standard north slot', north],
  ['five-six north-west slot', northWest],
  ...DIRECTIONS.map((step): [string, RenderFixture] => [
    `outer hex ${step.name}`,
    toward({ q: 2, r: -1 }, step),
  ]),
];

/** Sixteen points round an ellipse. */
const ring = (at: { x: number; y: number }, rx: number, ry: number) =>
  Array.from({ length: 16 }, (_, index) => ({
    x: at.x + rx * Math.cos((index / 16) * Math.PI * 2),
    y: at.y + ry * Math.sin((index / 16) * Math.PI * 2),
  }));

function cells(fixture: RenderFixture) {
  const [anchor, outer] = fixture.footprint.map(({ q, r }) => hexToPixel(q, r, HEX));
  if (!anchor || !outer) throw new Error('a two-hex footprint');
  return { anchor, outer };
}

function layoutOf(fixture: RenderFixture, steps = 7) {
  const layout = barbarianTrackLayout(fixture, HEX, steps);
  if (!layout) throw new Error('a track layout');
  return layout;
}

describe('barbarian track layout', () => {
  test.each(EVERY_ORIENTATION)(
    'the %s keeps the tile and every marker upright',
    (_name, fixture) => {
      const layout = layoutOf(fixture);
      expect(layout.tile.rotation).toBe(0);
      for (const marker of layout.markers) expect(marker.rotation).toBe(0);
      expect(layout.markers.map((marker) => marker.key)).toEqual([
        TRACK_START_KEY,
        ...[1, 2, 3, 4, 5, 6].map(trackStepKey),
        TRACK_LANDING_KEY,
      ]);
    },
  );

  test.each(EVERY_ORIENTATION)('the %s uses the tile of its grid axis', (_name, fixture) => {
    const { anchor, outer } = cells(fixture);
    const layout = layoutOf(fixture);
    expect(layout.tile.key).toBe(trackTileKey(layout.axis));
    // Turning the tile's axis onto the footprint's is a whole number of half turns.
    const angle =
      Math.atan2(anchor.y - outer.y, anchor.x - outer.x) - (layout.axis * Math.PI) / 180;
    expect(Math.abs(Math.sin(angle))).toBeCloseTo(0);
    expect(layout.tile.at.x).toBeCloseTo((anchor.x + outer.x) / 2);
    expect(layout.tile.at.y).toBeCloseTo((anchor.y + outer.y) / 2);
    expect(layout.tile.width).toBeCloseTo((TRACK_TILE_ART[layout.axis].width * HEX) / 80);
  });

  test('the six directions use the three axes, each for a direction and its reverse', () => {
    const axes = DIRECTIONS.map((step) => layoutOf(toward({ q: 0, r: 0 }, step)).axis);
    expect(axes).toEqual([0, 60, 120, 0, 60, 120]);
  });

  test.each(EVERY_ORIENTATION)('the %s runs from the outer hex to the island', (_name, fixture) => {
    const { anchor, outer } = cells(fixture);
    const layout = layoutOf(fixture);
    const along = (point: { x: number; y: number }) =>
      (point.x - outer.x) * layout.direction.x + (point.y - outer.y) * layout.direction.y;
    for (let index = 1; index < layout.route.length; index += 1)
      expect(along(layout.route[index] ?? outer)).toBeGreaterThan(
        along(layout.route[index - 1] ?? anchor),
      );
    const start = layout.markers[0]?.at ?? anchor;
    const island = layout.markers.at(-1)?.at ?? outer;
    expect(distance(start, outer)).toBeLessThan(distance(start, anchor));
    expect(distance(island, anchor)).toBeLessThan(HEX * 0.7);
    // The ship's stops are the markers, and it docks on the island.
    for (const [index, stop] of layout.stops.slice(0, -1).entries())
      expect(stop).toEqual(layout.markers[index]?.at);
    expect(distance(layout.stops.at(-1) ?? outer, island)).toBeLessThan(HEX * 0.25);
  });

  test.each(EVERY_ORIENTATION)(
    'the %s keeps every marker whole inside its hexes',
    (_name, fixture) => {
      const layout = layoutOf(fixture);
      const unit = HEX / 80;
      const radius = TRACK_TOKEN_ART.radius * TRACK_TOKEN_SCALE * unit;
      const tokens = layout.markers.slice(0, -1);
      const island = layout.markers.at(-1);
      const outline = [
        ...tokens.flatMap((token) => ring(token.at, radius, radius)),
        // The island's sand is about 50 by 36 art units round its centre.
        ...(island ? ring(island.at, 26 * unit, 18 * unit) : []),
      ];
      for (const point of outline) expect(hitTestFixture(point, [fixture], HEX)).toBe(fixture.id);
    },
  );

  test.each(EVERY_ORIENTATION)('the %s leaves room between the tokens', (_name, fixture) => {
    const tokens = layoutOf(fixture).markers.slice(0, -1);
    const clearance = ((2 * TRACK_TOKEN_ART.radius * TRACK_TOKEN_SCALE) / 80) * HEX;
    for (const [index, token] of tokens.entries())
      for (const other of tokens.slice(index + 1))
        expect(distance(token.at, other.at)).toBeGreaterThan(clearance);
  });

  test('the ship turns its bow to the island when the island lies west', () => {
    const facing = DIRECTIONS.map((step) => layoutOf(toward({ q: 0, r: 0 }, step)).shipFacesWest);
    // The outer hex east of the anchor puts the island west of the start, and so on.
    expect(facing).toEqual([true, true, false, false, false, true]);
    expect(layoutOf(north).shipFacesWest).toBe(false);
  });

  test('the number of steps follows the engine and is capped by the art', () => {
    expect(layoutOf(north, 4).markers).toHaveLength(5);
    expect(layoutOf(north, 4).stops).toHaveLength(5);
    expect(layoutOf(north, 40).markers).toHaveLength(TRACK_STEP_TOKENS + 2);
    expect(barbarianTrackLayout({ ...north, footprint: [] }, HEX)).toBeNull();
  });

  test('every track art key is a shipped art file', () => {
    for (const key of trackArtKeys()) expect(Object.keys(KNIGHTS_ART)).toContain(key);
    expect(trackAxis({ x: -1, y: 0 })).toBe(0);
    expect(trackAxis({ x: -0.5, y: -Math.sqrt(3) / 2 })).toBe(60);
  });

  test('the route is dotted at an even spacing', () => {
    const dots = routeDots(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      4,
    );
    expect(dots.map(({ x, y }) => [x, y])).toEqual([
      [0, 0],
      [4, 0],
      [8, 0],
      [10, 2],
      [10, 6],
      [10, 10],
    ]);
  });
});

describe('barbarian ship on the track', () => {
  test('sailing ends on the steps and bobs above the line between them', () => {
    const start = barbarianStepPoint(north, HEX, 2);
    const end = barbarianStepPoint(north, HEX, 3);
    expect(sailPosition(north, HEX, 2, 3, 0)).toEqual(start);
    const arrival = sailPosition(north, HEX, 2, 3, 1);
    expect(arrival?.x).toBeCloseTo(end?.x ?? 0);
    expect(arrival?.y).toBeCloseTo(end?.y ?? 0);
    const middle = sailPosition(north, HEX, 2, 3, 0.5);
    const straight = {
      x: ((start?.x ?? 0) + (end?.x ?? 0)) / 2,
      y: ((start?.y ?? 0) + (end?.y ?? 0)) / 2,
    };
    expect(middle?.x).toBeCloseTo(straight.x);
    expect(middle?.y ?? 0).toBeLessThan(straight.y);
  });

  test('steps past the landing stay on the island', () => {
    expect(barbarianStepPoint(north, HEX, 99)).toEqual(barbarianStepPoint(north, HEX, 7));
    expect(barbarianStepPoint(north, HEX, 4, 4)).toEqual(layoutOf(north, 4).stops.at(-1));
    expect(barbarianStepPoint(north, HEX, -2)).toEqual(layoutOf(north).stops[0]);
  });
});
