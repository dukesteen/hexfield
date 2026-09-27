import { expect, test } from 'vitest';
import type { HexId } from '@cp2p/engine/geometry';
import { assignTerrainVariants } from './terrainVariants.js';

const hexes = Array.from({ length: 19 }, (_, index) => ({
  id: `h:${index},0` as HexId,
  q: index,
  r: 0,
  terrain: index < 4 ? 'forest' : index < 7 ? 'hills' : 'sea',
  token: index < 7 ? index + 2 : null,
}));

test('terrain variants are stable across render order and balanced per terrain', () => {
  const first = assignTerrainVariants(hexes);
  const reordered = assignTerrainVariants(hexes.toReversed());
  expect(first).toEqual(reordered);
  for (const terrain of ['forest', 'hills', 'sea']) {
    const counts = [1, 2, 3].map(
      (variant) =>
        hexes.filter((hex) => hex.terrain === terrain && first.get(hex.id) === variant).length,
    );
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  }
  expect(new Set(hexes.slice(0, 4).map((hex) => first.get(hex.id))).size).toBe(3);
});
