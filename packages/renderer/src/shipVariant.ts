import { vertexId } from '@cp2p/engine/geometry';
import type { Corner, EdgeId, VertexId } from '@cp2p/engine/geometry';
import type { Seat } from '@cp2p/engine';
import type { RenderModel } from './types.js';

/**
 * The six authored ship SVGs are hull headings in the art's dimetric view (bow at the pointed
 * end, stern castle at the other): 1 southeast, 2 north, 3 northeast, 4 south, 5 southwest,
 * 6 northwest. On screen a canonical `NE` edge runs from the hex's north corner down to its
 * north-east corner, a `W` edge from its south-west corner up to its north-west corner and an
 * `NW` edge from its north-west corner up to its north corner. `forward` is the heading from the
 * first of those corners to the second, `back` the reverse, so every hull lies along its edge.
 */
const HEADINGS = {
  NE: { forward: 1, back: 6, corners: ['N', 'NE'] },
  W: { forward: 2, back: 4, corners: ['SW', 'NW'] },
  NW: { forward: 3, back: 5, corners: ['NW', 'N'] },
} as const satisfies Record<
  string,
  { forward: ShipVariant; back: ShipVariant; corners: readonly [Corner, Corner] }
>;

export type ShipVariant = 1 | 2 | 3 | 4 | 5 | 6;
/** Which end of an edge, in the order above, the bow points at. */
export type ShipBow = 'forward' | 'back';

type Pieces = Pick<RenderModel, 'roads' | 'buildings' | 'ships'>;

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1)
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0;
}

function parse(id: EdgeId): { q: number; r: number; side: keyof typeof HEADINGS } {
  const match = /^e:(-?\d+),(-?\d+),(NE|NW|W)$/.exec(id);
  if (!match) throw new Error(`Invalid edge ID ${id}`);
  const side = match[3] === 'NE' ? 'NE' : match[3] === 'NW' ? 'NW' : 'W';
  return { q: Number(match[1]), r: Number(match[2]), side };
}

/** An edge's two corners in travel order: the `forward` bow points at the second. */
export function shipEdgeEnds(id: EdgeId): readonly [VertexId, VertexId] {
  const { q, r, side } = parse(id);
  const [from, to] = HEADINGS[side].corners;
  return [vertexId({ q, r }, from), vertexId({ q, r }, to)];
}

/** The hull for a ship on an edge whose bow points at one of its ends. */
export function shipVariant(id: EdgeId, bow: ShipBow): ShipVariant {
  return HEADINGS[parse(id).side][bow];
}

/** A stable heading for a ship that has no route to follow. */
export function shipVariantForEdge(id: EdgeId): ShipVariant {
  return shipVariant(id, ((hash(id) >>> 7) & 1) === 0 ? 'forward' : 'back');
}

/**
 * Every ship's hull, heading away from its owner's buildings along its route: the stern sits at
 * the end nearer a settlement or city through that player's roads and ships, so a line of ships
 * sails outward in one direction. A ship with both ends equally near keeps its stable heading.
 */
export function shipHeadings(pieces: Pieces): Map<EdgeId, ShipVariant> {
  const headings = new Map<EdgeId, ShipVariant>();
  const ships = pieces.ships ?? [];
  const seats = new Set(ships.map((ship) => ship.seat));
  for (const seat of seats) {
    const distance = routeDistances(pieces, seat);
    for (const ship of ships) {
      if (ship.seat !== seat) continue;
      const [from, to] = shipEdgeEnds(ship.edge);
      const near = distance.get(from) ?? Infinity;
      const far = distance.get(to) ?? Infinity;
      headings.set(
        ship.edge,
        near < far
          ? shipVariant(ship.edge, 'forward')
          : far < near
            ? shipVariant(ship.edge, 'back')
            : shipVariantForEdge(ship.edge),
      );
    }
  }
  return headings;
}

/** The hull for one ship of `seat` on `edge`, as if it stood there among the other pieces. */
export function shipVariantAmong(pieces: Pieces, edge: EdgeId, seat: Seat): ShipVariant {
  const ships = pieces.ships ?? [];
  const present = ships.some((ship) => ship.edge === edge && ship.seat === seat);
  const withShip = present
    ? pieces
    : {
        ...pieces,
        ships: [...ships.filter((ship) => ship.edge !== edge), { edge, seat }],
      };
  return shipHeadings(withShip).get(edge) ?? shipVariantForEdge(edge);
}

/** Steps from each vertex to the nearest of the seat's buildings along its roads and ships. */
function routeDistances(pieces: Pieces, seat: Seat): Map<VertexId, number> {
  const links = new Map<VertexId, VertexId[]>();
  const link = (a: VertexId, b: VertexId) => {
    const list = links.get(a);
    if (list) list.push(b);
    else links.set(a, [b]);
  };
  for (const piece of [...pieces.roads, ...(pieces.ships ?? [])]) {
    if (piece.seat !== seat) continue;
    const [a, b] = shipEdgeEnds(piece.edge);
    link(a, b);
    link(b, a);
  }
  const distance = new Map<VertexId, number>();
  let frontier: VertexId[] = [];
  for (const building of pieces.buildings) {
    if (building.seat !== seat || distance.has(building.vertex)) continue;
    distance.set(building.vertex, 0);
    frontier.push(building.vertex);
  }
  for (let step = 1; frontier.length > 0; step += 1) {
    const next: VertexId[] = [];
    for (const vertex of frontier)
      for (const neighbor of links.get(vertex) ?? []) {
        if (distance.has(neighbor)) continue;
        distance.set(neighbor, step);
        next.push(neighbor);
      }
    frontier = next;
  }
  return distance;
}
