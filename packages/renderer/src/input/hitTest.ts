import type { BoardGraph, EdgeId, HexId, Point, VertexId } from '@cp2p/engine/geometry';
import { hexId, hexToPixel, vertexToPixel } from '@cp2p/engine/geometry';
import type { BoardHit, HitMode } from '../types.js';

export interface HitTestOptions {
  readonly graph: BoardGraph;
  readonly point: Point;
  readonly hexSize: number;
  readonly worldUnitsPerCssPixel: number;
  readonly mode: HitMode;
  readonly legalVertices?: ReadonlySet<VertexId>;
  readonly legalEdges?: ReadonlySet<EdgeId>;
  readonly legalHexes?: ReadonlySet<HexId>;
  readonly minimumTargetPixels?: number;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function segmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(point, start);
  const t = Math.max(
    0,
    Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
  return distance(point, { x: start.x + t * dx, y: start.y + t * dy });
}

function axialRound(
  x: number,
  y: number,
  size: number,
): { readonly q: number; readonly r: number } {
  const q = ((Math.sqrt(3) / 3) * x - y / 3) / size;
  const r = ((2 / 3) * y) / size;
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const qError = Math.abs(rq - q);
  const rError = Math.abs(rr - r);
  const sError = Math.abs(rs - s);
  if (qError > rError && qError > sError) rq = -rr - rs;
  else if (rError > sError) rr = -rq - rs;
  return { q: rq, r: rr };
}

function insideHex(point: Point, center: Point, size: number): boolean {
  const x = Math.abs(point.x - center.x);
  const y = Math.abs(point.y - center.y);
  return x <= (Math.sqrt(3) * size) / 2 && y <= size && x + Math.sqrt(3) * y <= Math.sqrt(3) * size;
}

function allowed<T extends string>(
  ids: readonly T[],
  legal: ReadonlySet<T> | undefined,
): readonly T[] {
  return legal ? ids.filter((id) => legal.has(id)) : ids;
}

/** Resolve a world point to its nearest legal target, using CSS-pixel touch tolerances. */
export function hitTestBoard(options: HitTestOptions): BoardHit | null {
  const { graph, point, hexSize, worldUnitsPerCssPixel, mode } = options;
  const legal =
    options.legalVertices !== undefined ||
    options.legalEdges !== undefined ||
    options.legalHexes !== undefined;
  const radius = Math.max(
    hexSize * 0.25,
    ((options.minimumTargetPixels ?? 44) * worldUnitsPerCssPixel) / 2,
  );
  const candidates: { hit: BoardHit; distance: number; priority: number }[] = [];

  if (mode === 'vertex' || mode === 'any') {
    for (const id of legal
      ? options.legalVertices
        ? allowed(graph.vertexIds, options.legalVertices)
        : []
      : graph.vertexIds) {
      const d = distance(point, vertexToPixel(id, hexSize));
      if (d <= radius) candidates.push({ hit: { kind: 'vertex', id }, distance: d, priority: 0 });
    }
  }
  if (mode === 'edge' || mode === 'any') {
    for (const id of legal
      ? options.legalEdges
        ? allowed(graph.edgeIds, options.legalEdges)
        : []
      : graph.edgeIds) {
      const index = graph.edgeIndex[id];
      const endpoints = index === undefined ? undefined : graph.edgeVertices[index];
      if (!endpoints) continue;
      const d = segmentDistance(
        point,
        vertexToPixel(endpoints[0], hexSize),
        vertexToPixel(endpoints[1], hexSize),
      );
      if (d <= radius) candidates.push({ hit: { kind: 'edge', id }, distance: d, priority: 1 });
    }
  }
  if (mode === 'hex' || mode === 'any') {
    const axial = axialRound(point.x, point.y, hexSize);
    const id = hexId(axial);
    if (graph.hexIndex[id] !== undefined && (!legal || options.legalHexes?.has(id))) {
      const center = hexToPixel(axial.q, axial.r, hexSize);
      const d = distance(point, center);
      if (
        insideHex(point, center, hexSize) ||
        (legal && options.legalHexes?.has(id) && d <= hexSize + radius)
      ) {
        candidates.push({ hit: { kind: 'hex', id }, distance: d, priority: 2 });
      }
    }
  }

  candidates.sort(
    (a, b) =>
      a.distance - b.distance || a.priority - b.priority || a.hit.id.localeCompare(b.hit.id),
  );
  return candidates[0]?.hit ?? null;
}
