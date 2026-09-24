/** Pointy-top axial hex coordinate. */
export interface HexCoord {
  readonly q: number;
  readonly r: number;
}

/** Stable identifiers used in state and commands. */
export type HexId = `h:${number},${number}`;
export type VertexId = `v:${number},${number},${'N' | 'S'}`;
export type EdgeId = `e:${number},${number},${'NE' | 'NW' | 'W'}`;
export type HexIdx = number;
export type VertexIdx = number;
export type EdgeIdx = number;

/** Hex corners, clockwise from the northern point. */
export type Corner = 'N' | 'NE' | 'SE' | 'S' | 'SW' | 'NW';
/** Hex sides, clockwise from the north-east side. */
export type Side = 'NE' | 'E' | 'SE' | 'SW' | 'W' | 'NW';

/** Coordinates in the renderer's two-dimensional plane. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Pixel position and direction of an edge. The angle is in radians. */
export interface EdgePixel {
  readonly midpoint: Point;
  readonly angle: number;
}

/**
 * Board connectivity. Each adjacency array is indexed by the corresponding
 * dense index; its entries are canonical string IDs. IDs and memberships are
 * sorted by UTF-16 code unit order, independent of input hex order.
 */
export interface BoardGraph {
  readonly hexIds: readonly HexId[];
  readonly vertexIds: readonly VertexId[];
  readonly edgeIds: readonly EdgeId[];
  readonly hexIndex: Readonly<Record<string, HexIdx>>;
  readonly vertexIndex: Readonly<Record<string, VertexIdx>>;
  readonly edgeIndex: Readonly<Record<string, EdgeIdx>>;
  readonly hexVertices: readonly (readonly VertexId[])[];
  readonly hexEdges: readonly (readonly EdgeId[])[];
  readonly vertexHexes: readonly (readonly HexId[])[];
  readonly vertexEdges: readonly (readonly EdgeId[])[];
  readonly vertexNeighbors: readonly (readonly VertexId[])[];
  readonly edgeVertices: readonly (readonly [VertexId, VertexId])[];
  readonly edgeHexes: readonly (readonly HexId[])[];
}

/** The six axial neighbors, ordered E, NE, NW, W, SW, SE. */
export const HEX_DIRECTIONS: readonly HexCoord[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

/** Return the stable ID of an axial hex. */
export function hexId({ q, r }: HexCoord): HexId {
  return `h:${q},${r}`;
}

/** Return the owner-based ID of a corner on a hex. */
export function vertexId({ q, r }: HexCoord, corner: Corner): VertexId {
  switch (corner) {
    case 'N':
    case 'S':
      return `v:${q},${r},${corner}`;
    case 'NE':
      return `v:${q + 1},${r - 1},S`;
    case 'SE':
      return `v:${q},${r + 1},N`;
    case 'SW':
      return `v:${q - 1},${r + 1},N`;
    case 'NW':
      return `v:${q},${r - 1},S`;
  }
  throw new Error('Invalid corner');
}

/** Return the owner-based ID of a side on a hex. */
export function edgeId({ q, r }: HexCoord, side: Side): EdgeId {
  switch (side) {
    case 'NE':
    case 'NW':
    case 'W':
      return `e:${q},${r},${side}`;
    case 'E':
      return `e:${q + 1},${r},W`;
    case 'SE':
      return `e:${q},${r + 1},NW`;
    case 'SW':
      return `e:${q - 1},${r + 1},NE`;
  }
  throw new Error('Invalid side');
}

const CORNERS = ['N', 'NE', 'SE', 'S', 'SW', 'NW'] as const;
const SIDES = ['NE', 'E', 'SE', 'SW', 'W', 'NW'] as const;

function addMember<K, V>(members: Map<K, Set<V>>, key: K, value: V): void {
  let values = members.get(key);
  if (!values) {
    values = new Set<V>();
    members.set(key, values);
  }
  values.add(value);
}

function sortedMembers<K, V extends string>(members: Map<K, Set<V>>, key: K): V[] {
  return [...(members.get(key) ?? [])].toSorted();
}

function indexOfIds(ids: readonly string[]): Record<string, number> {
  const indices: Record<string, number> = {};
  Object.setPrototypeOf(indices, null);
  ids.forEach((id, index) => {
    indices[id] = index;
  });
  return indices;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Board graph has missing connectivity');
  return value;
}

/**
 * Build a deterministic graph from the listed hexes. A duplicate or invalid
 * coordinate is rejected because it cannot define a distinct board tile.
 */
export function buildBoardGraph(hexes: readonly HexCoord[]): BoardGraph {
  const hexById = new Map<HexId, HexCoord>();
  for (const hex of hexes) {
    if (!Number.isSafeInteger(hex.q) || !Number.isSafeInteger(hex.r)) {
      throw new RangeError('Hex coordinates must be safe integers');
    }
    const id = hexId(hex);
    if (hexById.has(id)) throw new Error(`Duplicate hex ${id}`);
    hexById.set(id, hex);
  }

  const hexIds = [...hexById.keys()].toSorted();
  const hexVertices: VertexId[][] = [];
  const hexEdges: EdgeId[][] = [];
  const vertexHexes = new Map<VertexId, Set<HexId>>();
  const edgeHexes = new Map<EdgeId, Set<HexId>>();
  const vertexEdges = new Map<VertexId, Set<EdgeId>>();
  const vertexNeighbors = new Map<VertexId, Set<VertexId>>();
  const edgeVertices = new Map<EdgeId, readonly [VertexId, VertexId]>();

  for (const id of hexIds) {
    const hex = required(hexById.get(id));
    const corners = CORNERS.map((corner) => vertexId(hex, corner));
    const sides = SIDES.map((side) => edgeId(hex, side));
    hexVertices.push(corners);
    hexEdges.push(sides);

    for (const corner of corners) addMember(vertexHexes, corner, id);
    for (let side = 0; side < 6; side++) {
      const edge = required(sides[side]);
      const first = required(corners[side]);
      const second = required(corners[(side + 1) % 6]);
      const existing = edgeVertices.get(edge);
      if (existing && !(existing.includes(first) && existing.includes(second))) {
        throw new Error(`Inconsistent endpoints for ${edge}`);
      }
      const endpoints: readonly [VertexId, VertexId] =
        first < second ? [first, second] : [second, first];
      edgeVertices.set(edge, endpoints);
      addMember(edgeHexes, edge, id);
      addMember(vertexEdges, first, edge);
      addMember(vertexEdges, second, edge);
      addMember(vertexNeighbors, first, second);
      addMember(vertexNeighbors, second, first);
    }
  }

  const vertexIds = [...vertexHexes.keys()].toSorted();
  const edgeIds = [...edgeHexes.keys()].toSorted();
  return {
    hexIds,
    vertexIds,
    edgeIds,
    hexIndex: indexOfIds(hexIds),
    vertexIndex: indexOfIds(vertexIds),
    edgeIndex: indexOfIds(edgeIds),
    hexVertices,
    hexEdges,
    vertexHexes: vertexIds.map((id) => sortedMembers(vertexHexes, id)),
    vertexEdges: vertexIds.map((id) => sortedMembers(vertexEdges, id)),
    vertexNeighbors: vertexIds.map((id) => sortedMembers(vertexNeighbors, id)),
    edgeVertices: edgeIds.map((id) => required(edgeVertices.get(id))),
    edgeHexes: edgeIds.map((id) => sortedMembers(edgeHexes, id)),
  };
}

/** Convert an axial hex center to pointy-top pixel coordinates. */
export function hexToPixel(q: number, r: number, size: number): Point {
  return { x: Math.sqrt(3) * size * (q + r / 2), y: 1.5 * size * r };
}

/** Convert a canonical vertex ID to a pixel point. */
export function vertexToPixel(id: VertexId, size: number): Point {
  const match = /^v:(-?\d+),(-?\d+),(N|S)$/.exec(id);
  if (!match) throw new Error(`Invalid vertex ID ${id}`);
  const center = hexToPixel(Number(match[1]), Number(match[2]), size);
  return { x: center.x, y: center.y + (match[3] === 'N' ? -size : size) };
}

/** Convert a canonical edge ID to its midpoint and direction in pixels. */
export function edgeToPixel(id: EdgeId, size: number): EdgePixel {
  const match = /^e:(-?\d+),(-?\d+),(NE|NW|W)$/.exec(id);
  if (!match) throw new Error(`Invalid edge ID ${id}`);
  const hex = { q: Number(match[1]), r: Number(match[2]) };
  const side = match[3];
  const corners: readonly [Corner, Corner] =
    side === 'NE' ? ['N', 'NE'] : side === 'NW' ? ['NW', 'N'] : ['SW', 'NW'];
  const first = vertexToPixel(vertexId(hex, corners[0]), size);
  const second = vertexToPixel(vertexId(hex, corners[1]), size);
  return {
    midpoint: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    angle: Math.atan2(second.y - first.y, second.x - first.x),
  };
}
