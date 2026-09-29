import { describe, expect, test } from 'vitest';
import { hexToPixel } from '@cp2p/engine/geometry';
import { KNIGHTS_ART } from './assets/knightsArt.js';
import { hitTestFixture } from './fixtures.js';
import {
  TRACK_ART,
  barbarianStepPoint,
  decoratedCity,
  fixtureFrame,
  knightArtKey,
  knightsBoardArtKeys,
  metropolisArtKey,
  sailPosition,
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

describe('barbarian track geometry', () => {
  test.each([
    ['north slot', north],
    ['north-west slot', northWest],
  ])('the %s puts the landing by the island and the start outside', (_name, fixture) => {
    const [first, second] = fixture.footprint;
    const anchor = hexToPixel(first?.q ?? 0, first?.r ?? 0, HEX);
    const outer = hexToPixel(second?.q ?? 0, second?.r ?? 0, HEX);
    const points = TRACK_ART.points.map((_point, step) => barbarianStepPoint(fixture, HEX, step));
    expect(points.every((point) => point !== null)).toBe(true);
    // Progress along the axis from the outer hex to the anchor hex grows with every step.
    const axis = { x: anchor.x - outer.x, y: anchor.y - outer.y };
    const along = points.map((point) =>
      point ? ((point.x - outer.x) * axis.x + (point.y - outer.y) * axis.y) / (HEX * HEX * 3) : -1,
    );
    for (let step = 1; step < along.length; step += 1)
      expect(along[step] ?? 0).toBeGreaterThan(along[step - 1] ?? 0);
    const last = points.at(-1);
    expect(last ? distance(last, anchor) : Infinity).toBeLessThan(HEX * 1.1);
    const start = points[0];
    expect(start ? distance(start, anchor) : 0).toBeGreaterThan(HEX * 1.4);
  });

  test('every step is drawn on the two hexes of the fixture', () => {
    for (let step = 0; step < TRACK_ART.points.length; step += 1) {
      const point = barbarianStepPoint(north, HEX, step);
      expect(point && hitTestFixture(point, [north], HEX)).toBe(north.id);
    }
  });

  test('the base slot turns the art a sixth of a turn', () => {
    const frame = fixtureFrame(north, HEX);
    expect(frame?.rotation).toBeCloseTo(Math.PI / 3);
    expect(frame?.scale).toBeCloseTo(HEX / 80);
    expect(fixtureFrame({ ...north, footprint: [] }, HEX)).toBeNull();
  });

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
});
