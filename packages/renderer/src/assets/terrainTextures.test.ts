import { expect, test } from 'vitest';
import {
  getAwardCardUrl,
  getDevelopmentCardUrl,
  getDieUrl,
  getFactionUrl,
  getGameArtUrl,
  getPieceIconUrl,
  getResourceCardUrl,
  getResourceIconUrl,
  rasterResolution,
} from './terrainTextures.js';

test('terrain rasterization fits physical pixels to the SVG viewBox at max zoom', () => {
  expect(rasterResolution(1, 2, 3.2, Math.sqrt(3) * 54, 108, 200, 231)).toBeCloseTo(1.496);
  expect(rasterResolution(2, 2, 3.2, Math.sqrt(3) * 54, 108, 200, 231)).toBeCloseTo(2.992);
  expect(rasterResolution(3, 2, 3.2, Math.sqrt(3) * 54, 108, 200, 231)).toBeCloseTo(2.992);
});

test('redesign art helpers resolve variants and legacy color names', () => {
  expect(getFactionUrl('magenta')).toBe(getFactionUrl('black'));
  expect(getFactionUrl('yellow')).toBe(getFactionUrl('white'));
  expect(getDieUrl(6)).toContain('die-6.svg');
  expect(getAwardCardUrl('longestRoad')).toContain('card-longest-road.svg');
  expect(getGameArtUrl('preview')).toContain('board-preview.svg');
  expect(getPieceIconUrl('city', 'magenta')).toContain('city-black.svg');
});

test('all six animated die faces resolve to their authored SVGs', () => {
  const faces = [1, 2, 3, 4, 5, 6].map(getDieUrl);
  expect(new Set(faces).size).toBe(6);
  faces.forEach((url, index) => expect(url).toContain(`die-${index + 1}.svg`));
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
