import type { Point } from '@cp2p/engine/geometry';
import { hexToPixel } from '@cp2p/engine/geometry';

interface Cell {
  readonly id: string;
  readonly q: number;
  readonly r: number;
  readonly terrain: string;
}

/** Neighbor offsets in the order of the six hex corners: the edge from corner i to corner i + 1. */
export const HEX_EDGE_NEIGHBORS = [
  { q: 1, r: -1 },
  { q: 1, r: 0 },
  { q: 0, r: 1 },
  { q: -1, r: 1 },
  { q: -1, r: 0 },
  { q: 0, r: -1 },
] as const;

/** A hex of any terrain except sea and unrevealed fog. */
export function isLandTerrain(terrain: string): boolean {
  return terrain !== 'sea' && terrain !== 'fog';
}

/** Corner points of a pointy-top hex, starting at the top and going clockwise. */
export function hexCornerPoints(center: Point, size: number): Point[] {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = ((-90 + index * 60) * Math.PI) / 180;
    return { x: center.x + Math.cos(angle) * size, y: center.y + Math.sin(angle) * size };
  });
}

/** Connected groups of land hexes. Each group is sorted by id, and the groups by first id. */
export function landIslands(hexes: readonly Cell[]): string[][] {
  const land = hexes.filter((hex) => isLandTerrain(hex.terrain));
  const byCell = new Map(land.map((hex) => [`${hex.q},${hex.r}`, hex]));
  const seen = new Set<string>();
  const islands: string[][] = [];
  for (const start of land) {
    if (seen.has(start.id)) continue;
    const group: string[] = [];
    const stack = [start];
    seen.add(start.id);
    for (let hex = stack.pop(); hex !== undefined; hex = stack.pop()) {
      group.push(hex.id);
      for (const offset of HEX_EDGE_NEIGHBORS) {
        const next = byCell.get(`${hex.q + offset.q},${hex.r + offset.r}`);
        if (next && !seen.has(next.id)) {
          seen.add(next.id);
          stack.push(next);
        }
      }
    }
    islands.push(group.toSorted());
  }
  return islands.toSorted((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
}

/** Coastline segments of every island, for the debug outline. */
export function islandBoundarySegments(
  hexes: readonly Cell[],
  hexSize: number,
): readonly { readonly island: number; readonly from: Point; readonly to: Point }[] {
  const owner = new Map<string, number>();
  const byId = new Map(hexes.map((hex) => [hex.id, hex]));
  for (const [index, ids] of landIslands(hexes).entries())
    for (const id of ids) {
      const hex = byId.get(id);
      if (hex) owner.set(`${hex.q},${hex.r}`, index);
    }
  const segments: { island: number; from: Point; to: Point }[] = [];
  for (const hex of hexes) {
    const island = owner.get(`${hex.q},${hex.r}`);
    if (island === undefined) continue;
    const corners = hexCornerPoints(hexToPixel(hex.q, hex.r, hexSize), hexSize);
    for (const [index, offset] of HEX_EDGE_NEIGHBORS.entries()) {
      if (owner.get(`${hex.q + offset.q},${hex.r + offset.r}`) === island) continue;
      const from = corners[index];
      const to = corners[(index + 1) % 6];
      if (from && to) segments.push({ island, from, to });
    }
  }
  return segments;
}

export interface Bounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** The exact pixel extents of pointy-top hexes, each grown by `margin` on every side. */
export function hexExtents(
  hexes: readonly { readonly q: number; readonly r: number }[],
  hexSize: number,
  margin = 0,
): Bounds | null {
  if (hexes.length === 0) return null;
  const halfWidth = (Math.sqrt(3) / 2) * hexSize;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const { q, r } of hexes) {
    const center = hexToPixel(q, r, hexSize);
    minX = Math.min(minX, center.x - halfWidth);
    maxX = Math.max(maxX, center.x + halfWidth);
    minY = Math.min(minY, center.y - hexSize);
    maxY = Math.max(maxY, center.y + hexSize);
  }
  return { minX: minX - margin, maxX: maxX + margin, minY: minY - margin, maxY: maxY + margin };
}
