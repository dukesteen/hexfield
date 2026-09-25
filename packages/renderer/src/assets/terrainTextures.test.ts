import { expect, test } from 'vitest';
import { getResourceIconUrl, rasterResolution } from './terrainTextures.js';

test('terrain rasterization fits physical pixels to the SVG viewBox at max zoom', () => {
  expect(rasterResolution(1, 2, 3.2, Math.sqrt(3) * 54, 108, 200, 231)).toBeCloseTo(1.496);
  expect(rasterResolution(2, 2, 3.2, Math.sqrt(3) * 54, 108, 200, 231)).toBeCloseTo(2.992);
  expect(rasterResolution(3, 2, 3.2, Math.sqrt(3) * 54, 108, 200, 231)).toBeCloseTo(2.992);
});

test('resource icons resolve to emitted static same-origin SVG URLs', () => {
  for (const resource of ['brick', 'lumber', 'wool', 'grain', 'ore'] as const) {
    expect(getResourceIconUrl(resource)).toContain('.svg');
    expect(getResourceIconUrl(resource)).not.toContain('data:image');
  }
});
