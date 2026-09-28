import { HEX_DIRECTIONS, buildBoardGraph, hexId } from '../geometry/index.js';
import type { BoardGraph, EdgeId, HexCoord, HexId } from '../geometry/index.js';
import type { BoardShapeSpec, FixtureSlot } from '../modules/types.js';
import type { BoardHex } from '../state/types.js';

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

/** Terrains that only a seafaring board may contain. Base shapes never accept them. */
export const SEAFARING_TERRAINS: readonly string[] = Object.freeze(['sea', 'gold', 'fog']);

/** Open water. It never holds a base piece and always has a null token. */
export function isSeaTerrain(terrain: string): boolean {
  return terrain === 'sea';
}

/** An unrevealed placeholder. It counts as water until a reveal replaces it. */
export function isFogTerrain(terrain: string): boolean {
  return terrain === 'fog';
}

/** Land is any terrain that is neither sea nor fog, including desert and gold. */
export function isLandTerrain(terrain: string): boolean {
  return !isSeaTerrain(terrain) && !isFogTerrain(terrain);
}

/** Terrains that never carry a number token: desert, sea and fog. */
export function isTokenlessTerrain(terrain: string): boolean {
  return terrain === 'desert' || !isLandTerrain(terrain);
}

/** The land hexes of a board, in the given order. Coast helpers below take this list. */
export function landHexes(hexes: readonly BoardHex[]): BoardHex[] {
  return hexes.filter((hex) => isLandTerrain(hex.terrain));
}

/** Where an edge sits relative to land. */
export type EdgeKind = 'land' | 'coastal' | 'sea';

/**
 * Classify an edge by how many of its (one or two) owner hexes are land. A rim edge has one owner,
 * so a land rim edge is coastal. Fog and hexes missing from the graph count as not land.
 */
export function classifyEdge(
  graph: BoardGraph,
  edge: string,
  land: ReadonlySet<string>,
): EdgeKind | null {
  const index = graph.edgeIndex[edge];
  if (index === undefined) return null;
  const owners = (graph.edgeHexes[index] ?? []).filter((id) => land.has(id)).length;
  return owners >= 2 ? 'land' : owners === 1 ? 'coastal' : 'sea';
}

/** True when at least one hex around the vertex is land. */
export function vertexTouchesLand(
  graph: BoardGraph,
  vertex: string,
  land: ReadonlySet<string>,
): boolean {
  const index = graph.vertexIndex[vertex];
  return index !== undefined && (graph.vertexHexes[index] ?? []).some((id) => land.has(id));
}

/** Every coastal edge of a board (land on exactly one side), in id order. */
export function coastalEdges(hexes: readonly BoardHex[]): EdgeId[] {
  const graph = buildBoardGraph(hexes);
  const land = new Set<string>(landHexes(hexes).map((hex) => hex.id));
  return graph.edgeIds.filter((edge) => classifyEdge(graph, edge, land) === 'coastal');
}

/** An island: a connected group of land hexes, named by its least hex id. */
export interface Island {
  id: HexId;
  hexes: HexId[];
}

/**
 * Islands are the connected components of land hexes (not sea, not fog), sorted by id, with each
 * island's hex ids sorted. Recompute after a fog reveal.
 */
export function detectIslands(hexes: readonly BoardHex[]): Island[] {
  const land = new Map<string, HexCoord>(
    landHexes(hexes).map((hex) => [hexId(hex), { q: hex.q, r: hex.r }]),
  );
  const seen = new Set<string>();
  const islands: Island[] = [];
  for (const start of [...land.keys()].toSorted()) {
    if (seen.has(start)) continue;
    const members: HexId[] = [];
    const queue: string[] = [start];
    seen.add(start);
    for (let head = 0; head < queue.length; head++) {
      const id = required(queue[head], 'island queue');
      const at = required(land.get(id), 'island hex');
      members.push(hexId(at));
      for (const direction of HEX_DIRECTIONS) {
        const next = hexId({ q: at.q + direction.q, r: at.r + direction.r });
        if (!land.has(next) || seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    members.sort();
    islands.push({ id: required(members[0], 'island'), hexes: members });
  }
  return islands.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Coastal edges (edges with exactly one listed hex), in perimeter order from the least id.
 * Pass land hexes only (`landHexes`); a multi-island board has no single cycle and throws.
 */
export function coastEdgeCycle(hexes: readonly HexCoord[]): EdgeId[] {
  const graph = buildBoardGraph(hexes);
  const coast = new Set(
    graph.edgeIds.filter(
      (edge) =>
        required(graph.edgeHexes[required(graph.edgeIndex[edge], 'edge')], 'edge').length === 1,
    ),
  );
  const around = new Map<string, EdgeId[]>();
  for (const edge of coast) {
    for (const vertex of required(
      graph.edgeVertices[required(graph.edgeIndex[edge], 'edge')],
      'edge',
    )) {
      const edges = around.get(vertex) ?? [];
      edges.push(edge);
      around.set(vertex, edges);
    }
  }
  const first = required([...coast].toSorted()[0], 'Board has no coast');
  let previous: EdgeId | undefined;
  let current = first;
  const cycle: EdgeId[] = [];
  do {
    cycle.push(current);
    const ends = required(graph.edgeVertices[required(graph.edgeIndex[current], 'edge')], 'edge');
    const candidates = ends
      .flatMap((vertex) => around.get(vertex) ?? [])
      .filter((edge) => edge !== current && edge !== previous)
      .toSorted();
    const next = required(candidates[0], 'Coast is not a single cycle');
    previous = current;
    current = next;
  } while (current !== first && cycle.length <= coast.size);
  if (current !== first || cycle.length !== coast.size)
    throw new Error('Coast is not a single cycle');
  return cycle;
}

/** Positions of the sea frame: non-land hexes that share an edge with a land hex. */
export function frameHexes(hexes: readonly HexCoord[]): HexCoord[] {
  const land = new Set(hexes.map((hex) => hexId(hex)));
  const frame = new Map<string, HexCoord>();
  for (const hex of hexes)
    for (const direction of HEX_DIRECTIONS) {
      const neighbour = { q: hex.q + direction.q, r: hex.r + direction.r };
      const id = hexId(neighbour);
      if (!land.has(id)) frame.set(id, neighbour);
    }
  return [...frame.keys()].toSorted().map((id) => required(frame.get(id), 'frame'));
}

/** The frame hex on the sea side of a coastal land edge. */
export function seaSideOfEdge(hexes: readonly HexCoord[], edge: string): HexCoord | null {
  const land = new Set(hexes.map((hex) => hexId(hex)));
  const graph = buildBoardGraph(hexes);
  const index = graph.edgeIndex[edge];
  if (index === undefined) return null;
  const owners = graph.edgeHexes[index] ?? [];
  if (owners.length !== 1) return null;
  const match = /^e:(-?\d+),(-?\d+),(NE|NW|W)$/.exec(edge);
  if (!match) return null;
  const q = Number(match[1]);
  const r = Number(match[2]);
  const side = match[3];
  // An edge id names its owner hex and one of its NE, NW or W sides.
  const across =
    side === 'NE' ? { q: q + 1, r: r - 1 } : side === 'NW' ? { q, r: r - 1 } : { q: q - 1, r };
  const owner = { q, r };
  return land.has(hexId(owner)) ? across : owner;
}

/** Explain why a two-hex fixture slot breaks the board-shape rules, or return null. */
export function fixtureSlotProblem(spec: BoardShapeSpec, slot: FixtureSlot): string | null {
  const land = new Set(spec.hexes.map((hex) => hexId(hex)));
  const frame = new Set(frameHexes(spec.hexes).map((hex) => hexId(hex)));
  const anchor = hexId(slot.anchor);
  const outer = hexId(slot.outer);
  if (!frame.has(anchor)) return `${slot.id}: anchor is not a sea-frame hex`;
  const harborFrames = new Set(
    spec.harborSlots.flatMap((edge) => {
      const sea = seaSideOfEdge(spec.hexes, edge);
      return sea ? [hexId(sea)] : [];
    }),
  );
  if (harborFrames.has(anchor)) return `${slot.id}: anchor carries a harbor`;
  const direction = HEX_DIRECTIONS.findIndex(
    (step) => slot.anchor.q + step.q === slot.outer.q && slot.anchor.r + step.r === slot.outer.r,
  );
  if (direction < 0) return `${slot.id}: outer hex is not next to the anchor`;
  if (land.has(outer) || frame.has(outer)) return `${slot.id}: outer hex is not beyond the frame`;
  const step = required(HEX_DIRECTIONS[direction], 'direction');
  const inward = hexId({ q: slot.anchor.q - step.q, r: slot.anchor.r - step.r });
  if (!land.has(inward)) return `${slot.id}: outer hex is not directly outward from the island`;
  return null;
}

/**
 * A seafaring shape lists every board hex including sea, so coast and fixture geometry depend on the
 * fixed board and are checked against it. Only the bags are checked here.
 */
function seafaringShapeProblems(spec: BoardShapeSpec): string[] {
  const problems: string[] = [];
  if (spec.terrains.length !== spec.hexes.length)
    problems.push(`${spec.id}: tile bag does not fill the board`);
  const tokenless = spec.terrains.filter((terrain) => isTokenlessTerrain(terrain)).length;
  if (spec.tokens.length !== spec.hexes.length - tokenless)
    problems.push(`${spec.id}: token bag does not match productive hexes`);
  if (spec.fixtureSlots.length > 0)
    problems.push(`${spec.id}: seafaring shapes take no fixture slots`);
  return problems;
}

/** Check every declared fixture slot and the shape's harbor slots against each other. */
export function boardShapeProblems(spec: BoardShapeSpec): string[] {
  if (spec.seafaring === true) return seafaringShapeProblems(spec);
  const problems: string[] = [];
  const coast = new Set<string>(coastEdgeCycle(spec.hexes));
  if (spec.harborSlots.length !== spec.harbors.length)
    problems.push(`${spec.id}: harbor slots and kinds differ in number`);
  for (const edge of spec.harborSlots)
    if (!coast.has(edge)) problems.push(`${spec.id}: harbor ${edge} is not coastal`);
  if (spec.terrains.length !== spec.hexes.length)
    problems.push(`${spec.id}: tile bag does not fill the board`);
  const deserts = spec.terrains.filter((terrain) => terrain === 'desert').length;
  if (spec.tokens.length !== spec.hexes.length - deserts)
    problems.push(`${spec.id}: token bag does not match productive hexes`);
  if (new Set(spec.fixtureSlots.map((slot) => slot.id)).size !== spec.fixtureSlots.length)
    problems.push(`${spec.id}: duplicate fixture slot id`);
  for (const slot of spec.fixtureSlots) {
    const problem = fixtureSlotProblem(spec, slot);
    if (problem) problems.push(`${spec.id}: ${problem}`);
  }
  return problems;
}
