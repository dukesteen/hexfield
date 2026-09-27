import type { RenderModel } from '../types.js';

/** Assign each terrain's three illustrations from independently shuffled bags. */
export function assignTerrainVariants(hexes: RenderModel['hexes']): ReadonlyMap<string, 1 | 2 | 3> {
  const ordered = hexes.toSorted((a, b) => a.q - b.q || a.r - b.r || a.id.localeCompare(b.id));
  const identity = ordered
    .map((hex) => `${hex.q},${hex.r}:${hex.terrain}:${hex.token ?? ''}`)
    .join('|');
  const byTerrain = new Map<string, typeof ordered>();
  for (const hex of ordered) {
    const group = byTerrain.get(hex.terrain) ?? [];
    group.push(hex);
    byTerrain.set(hex.terrain, group);
  }

  const result = new Map<string, 1 | 2 | 3>();
  for (const [terrain, group] of byTerrain) {
    let random = hash(`${identity}:${terrain}`);
    for (let index = 0; index < group.length; index += 3) {
      const bag: (1 | 2 | 3)[] = [1, 2, 3];
      for (let i = bag.length - 1; i > 0; i -= 1) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        const swap = random % (i + 1);
        const picked = bag[i];
        const replacement = bag[swap];
        if (picked === undefined || replacement === undefined) continue;
        bag[i] = replacement;
        bag[swap] = picked;
      }
      for (let i = 0; i < 3 && index + i < group.length; i += 1) {
        const hex = group[index + i];
        const variant = bag[i];
        if (hex && variant) result.set(hex.id, variant);
      }
    }
  }
  return result;
}

function hash(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  }
  return result >>> 0;
}
