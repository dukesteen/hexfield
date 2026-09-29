import { edgeToPixel, hexToPixel, vertexToPixel } from '@cp2p/engine/geometry';
import type { BoardGraph, EdgeId, Point, VertexId } from '@cp2p/engine/geometry';
import { harborOnBoard } from './harborLayout.js';
import type { RenderModel } from './types.js';

/** Bonus chit diameter, and how far from its settlement it stands, in hex sizes. */
export const BONUS_CHIT_SIZE = 0.4;
const CHIT_DISTANCE = 0.5;
/** Two spots scoring within this much clearance count as equal, so the preferred one wins. */
const TIE = 0.01;

/** A capsule other art occupies: a segment from `a` to `b` widened by `radius`, in hex sizes. */
interface Obstacle {
  readonly a: Point;
  readonly b: Point;
  readonly radius: number;
}

type Pieces = Pick<
  RenderModel,
  'hexes' | 'harbors' | 'roads' | 'ships' | 'buildings' | 'islandBonuses' | 'knights'
>;

function along(from: Point, to: Point, t: number): Point {
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

function segmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

function circle(point: Point, radius: number): Obstacle {
  return { a: point, b: point, radius };
}

/** The part of an edge a road or ship covers, between the buildings at its ends. */
function edgeSpan(graph: BoardGraph, edge: EdgeId, from: number, to: number): [Point, Point] {
  const ends = graph.edgeVertices[graph.edgeIndex[edge] ?? -1];
  if (!ends) {
    const midpoint = edgeToPixel(edge, 1).midpoint;
    return [midpoint, midpoint];
  }
  const first = vertexToPixel(ends[0], 1);
  const second = vertexToPixel(ends[1], 1);
  return [along(first, second, from), along(first, second, to)];
}

/** Everything a bonus chit should keep clear of, in units of one hex size. */
function obstacles(pieces: Pieces, graph: BoardGraph): Obstacle[] {
  const result: Obstacle[] = [];
  for (const hex of pieces.hexes)
    if (hex.token !== null) result.push(circle(hexToPixel(hex.q, hex.r, 1), 0.32));
  for (const harbor of pieces.harbors) {
    const placed = harborOnBoard(pieces, graph, harbor.edge, 1);
    if (!placed) continue;
    const { midpoint, hub } = placed.layout;
    result.push({ a: midpoint, b: hub, radius: 0.12 }, circle(hub, 0.34));
  }
  for (const road of pieces.roads) {
    const [a, b] = edgeSpan(graph, road.edge, 0.22, 0.78);
    result.push({ a, b, radius: 0.07 });
  }
  for (const ship of pieces.ships ?? []) {
    const [a, b] = edgeSpan(graph, ship.edge, 0.3, 0.7);
    result.push({ a, b, radius: 0.16 });
  }
  for (const building of pieces.buildings)
    result.push(circle(vertexToPixel(building.vertex, 1), 0.27));
  for (const knight of pieces.knights?.pieces ?? [])
    result.push(circle(vertexToPixel(knight.vertex, 1), 0.27));
  return result;
}

function unit(degrees: number): Point {
  return { x: Math.cos((degrees * Math.PI) / 180), y: Math.sin((degrees * Math.PI) / 180) };
}

/** Upper right first, then clockwise on screen. */
function order(a: number, b: number): number {
  return ((a + 390) % 360) - ((b + 390) % 360);
}

/**
 * The six spots around a vertex, as unit directions: first the three pointing into its hexes
 * (between its edges), the upper right one first, then the three along its edges.
 */
function directions(vertex: VertexId): { readonly direction: Point; readonly onEdge: boolean }[] {
  const north = vertex.endsWith(',N');
  const into = north ? [-30, 90, 210] : [30, 150, 270];
  const edges = north ? [30, 150, 270] : [-30, 90, 210];
  return [
    ...into.toSorted(order).map((degrees) => ({ direction: unit(degrees), onEdge: false })),
    ...edges.toSorted(order).map((degrees) => ({ direction: unit(degrees), onEdge: true })),
  ];
}

/**
 * Where each island bonus chit is drawn, in board pixels. A chit sits beside its settlement,
 * in whichever of the settlement's hexes leaves it most room from number tokens, harbor piers
 * and tokens, roads, ships, buildings and the chits already placed. It moves onto an edge only
 * when no hex beside the settlement has room and the edge has clearly more.
 */
export function islandBonusPoints(
  pieces: Pieces,
  graph: BoardGraph,
  hexSize: number,
): Map<VertexId, Point> {
  const placed = new Map<VertexId, Point>();
  const avoid = obstacles(pieces, graph);
  const chit = BONUS_CHIT_SIZE / 2;
  for (const bonus of pieces.islandBonuses ?? []) {
    if (placed.has(bonus.vertex)) continue;
    const vertex = vertexToPixel(bonus.vertex, 1);
    const others = [
      ...avoid.filter((item) => item.a.x !== vertex.x || item.a.y !== vertex.y),
      ...[...placed.values()].map((point) =>
        circle({ x: point.x / hexSize, y: point.y / hexSize }, chit),
      ),
    ];
    let best: { point: Point; room: number; onEdge: boolean } | null = null;
    for (const { direction, onEdge } of directions(bonus.vertex)) {
      const point = {
        x: vertex.x + direction.x * CHIT_DISTANCE,
        y: vertex.y + direction.y * CHIT_DISTANCE,
      };
      const room = Math.min(
        Infinity,
        ...others.map((item) => segmentDistance(point, item.a, item.b) - item.radius - chit),
      );
      if (onEdge && best && best.room >= 0) break;
      // An edge spot must beat every crowded hex spot clearly, as a road may yet go there.
      const margin = onEdge && best && !best.onEdge ? 0.1 : TIE;
      if (!best || room > best.room + margin) best = { point, room, onEdge };
    }
    if (best) placed.set(bonus.vertex, { x: best.point.x * hexSize, y: best.point.y * hexSize });
  }
  return placed;
}
