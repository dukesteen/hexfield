import { expect, test } from 'vitest';
import { edgeToPixel } from '@cp2p/engine/geometry';
import { roadVariantForEdge } from './roadVariant.js';

test('each canonical edge uses its fixed SVG orientation', () => {
  const cases = [
    ['e:0,0,NE', 0, Math.PI / 6],
    ['e:0,0,W', 1, -Math.PI / 2],
    ['e:0,0,NW', 2, -Math.PI / 6],
  ] as const;
  for (const [edge, variant, angle] of cases) {
    expect(roadVariantForEdge(edge)).toBe(variant);
    expect(edgeToPixel(edge, 80).angle).toBeCloseTo(angle);
  }
});
