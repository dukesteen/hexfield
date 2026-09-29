import { describe, expect, test } from 'vitest';
import { hexToPixel } from '@cp2p/engine/geometry';
import { fixtureBounds, fixtureCellIds, hitTestFixture } from './fixtures.js';
import type { RenderFixture } from './types.js';

const track: RenderFixture = {
  id: 'track',
  module: 'knights',
  footprint: [
    { q: 0, r: -3 },
    { q: 0, r: -4 },
  ],
  orientation: 2,
  art: 'barbarian-track',
};

describe('fixture geometry', () => {
  test('bounds cover both footprint cells', () => {
    const outer = hexToPixel(0, -4, 10);
    const anchor = hexToPixel(0, -3, 10);
    expect(fixtureBounds([track], 10)).toEqual({
      minX: Math.min(outer.x, anchor.x) - 10,
      maxX: Math.max(outer.x, anchor.x) + 10,
      minY: outer.y - 10,
      maxY: anchor.y + 10,
    });
    expect(fixtureBounds([], 10)).toBeNull();
  });

  test('taps inside either cell select the fixture; others miss', () => {
    expect(hitTestFixture(hexToPixel(0, -3, 10), [track], 10)).toBe('track');
    expect(hitTestFixture(hexToPixel(0, -4, 10), [track], 10)).toBe('track');
    expect(hitTestFixture(hexToPixel(0, 0, 10), [track], 10)).toBeNull();
  });

  test('both footprint cells are covered by the art', () => {
    expect([...fixtureCellIds([track])]).toEqual(['h:0,-3', 'h:0,-4']);
  });
});
