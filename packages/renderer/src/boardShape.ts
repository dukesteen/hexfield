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

/**
 * The closed outlines of a union of hexes. Each loop lists corner points with the hexes on its
 * right, so an outer outline runs clockwise on screen and the outline of a hole runs the other
 * way. Hexes on a grid never touch at a lone corner, so every loop is simple.
 */
export function hexUnionLoops(
  cells: readonly { readonly q: number; readonly r: number }[],
  hexSize: number,
): Point[][] {
  const inside = new Set(cells.map(({ q, r }) => `${q},${r}`));
  // Corners are keyed on the unit grid, so the float coordinates of neighbours always agree.
  const cornerKey = (point: Point): string =>
    `${Math.round((point.x / hexSize) * 1e4)},${Math.round((point.y / hexSize) * 1e4)}`;
  const next = new Map<string, { readonly point: Point; readonly to: string }>();
  for (const key of inside) {
    const [q = 0, r = 0] = key.split(',').map(Number);
    const corners = hexCornerPoints(hexToPixel(q, r, hexSize), hexSize);
    for (const [index, offset] of HEX_EDGE_NEIGHBORS.entries()) {
      if (inside.has(`${q + offset.q},${r + offset.r}`)) continue;
      const from = corners[index];
      const to = corners[(index + 1) % 6];
      if (from && to) next.set(cornerKey(from), { point: from, to: cornerKey(to) });
    }
  }
  const loops: Point[][] = [];
  const seen = new Set<string>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: Point[] = [];
    for (let edge = next.get(start); edge && !seen.has(cornerKey(edge.point));) {
      seen.add(cornerKey(edge.point));
      loop.push(edge.point);
      edge = next.get(edge.to);
    }
    loops.push(loop);
  }
  return loops;
}

/** Twice the signed area of a loop: positive for a loop that runs clockwise on screen. */
export function loopArea(loop: readonly Point[]): number {
  let sum = 0;
  for (const [index, point] of loop.entries()) {
    const following = loop[(index + 1) % loop.length] ?? point;
    sum += point.x * following.y - following.x * point.y;
  }
  return sum;
}

/** The unit normal on the right of the direction from `from` to `to` (outward from the hexes). */
function outwardNormal(from: Point, to: Point): Point {
  const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
  return { x: (to.y - from.y) / length, y: -(to.x - from.x) / length };
}

/**
 * Moves every side of a `hexUnionLoops` loop `distance` away from its hexes, with mitred
 * corners. For hex outlines that is the outline of the same hexes drawn larger.
 */
export function growLoop(loop: readonly Point[], distance: number): Point[] {
  return loop.map((point, index) => {
    const before = loop[(index + loop.length - 1) % loop.length] ?? point;
    const after = loop[(index + 1) % loop.length] ?? point;
    const a = outwardNormal(before, point);
    const b = outwardNormal(point, after);
    const scale = distance / (1 + a.x * b.x + a.y * b.y);
    return { x: point.x + (a.x + b.x) * scale, y: point.y + (a.y + b.y) * scale };
  });
}

/**
 * The parts of the segment from `from` to `to` that lie inside the loops (even-odd), as pairs
 * of points. Clips decoration to an outline without a mask.
 */
export function clipSegmentToLoops(
  from: Point,
  to: Point,
  loops: readonly (readonly Point[])[],
): [Point, Point][] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const hits: number[] = [];
  for (const loop of loops)
    for (const [index, a] of loop.entries()) {
      const b = loop[(index + 1) % loop.length] ?? a;
      // A side of the loop crosses the line when its ends lie on different sides. Counting a
      // corner on the line as one side keeps a touch at a corner from counting as a crossing.
      const sideA = dx * (a.y - from.y) - dy * (a.x - from.x) > 0;
      const sideB = dx * (b.y - from.y) - dy * (b.x - from.x) > 0;
      if (sideA === sideB) continue;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      hits.push(((a.x - from.x) * ey - (a.y - from.y) * ex) / (dx * ey - dy * ex));
    }
  hits.sort((a, b) => a - b);
  const at = (t: number): Point => ({ x: from.x + dx * t, y: from.y + dy * t });
  const pieces: [Point, Point][] = [];
  for (let index = 0; index + 1 < hits.length; index += 2) {
    const start = Math.max(0, hits[index] ?? 0);
    const end = Math.min(1, hits[index + 1] ?? 0);
    if (end > start) pieces.push([at(start), at(end)]);
  }
  return pieces;
}
