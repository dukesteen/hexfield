import { expect, test } from 'vitest';
import { fogRevealShape } from './fogReveal.js';

test('the fog covers its hex until the flip starts and is gone when it ends', () => {
  const start = fogRevealShape(0);
  expect(start).toMatchObject({ flip: 1, lift: 1, rise: 0, glow: 0 });
  expect(fogRevealShape(-3)).toEqual(start);
  const end = fogRevealShape(1);
  expect(end.flip).toBeLessThan(0.001);
  expect(end.glow).toBeLessThan(0.001);
});

test('the fog narrows steadily as it turns, and the ring glows and fades', () => {
  const flips = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((t) => fogRevealShape(t).flip);
  for (let index = 1; index < flips.length; index++)
    expect(flips[index]).toBeLessThanOrEqual(flips[index - 1] ?? 0);
  expect(fogRevealShape(0.75).glow).toBeGreaterThan(0.5);
  expect(fogRevealShape(0.75).glowScale).toBeGreaterThan(1);
});
