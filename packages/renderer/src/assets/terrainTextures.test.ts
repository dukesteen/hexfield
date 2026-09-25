import { expect, test } from 'vitest';
import {
  getDevelopmentCardUrl,
  getResourceCardUrl,
  getResourceIconUrl,
  rasterResolution,
} from './terrainTextures.js';

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

test('resource cards resolve to emitted static same-origin SVG URLs', () => {
  const urls = (['brick', 'lumber', 'wool', 'grain', 'ore'] as const).map(getResourceCardUrl);
  expect(new Set(urls).size).toBe(5);
  for (const url of urls) {
    expect(url).toContain('.svg');
    expect(url).not.toContain('data:image');
  }
});

test('development cards resolve to emitted static same-origin SVG URLs', () => {
  const urls = (
    ['knight', 'roadBuilding', 'yearOfPlenty', 'monopoly', 'victoryPoint'] as const
  ).map(getDevelopmentCardUrl);
  expect(new Set(urls).size).toBe(5);
  for (const url of urls) {
    expect(url).toContain('.svg');
    expect(url).not.toContain('data:image');
  }
});
