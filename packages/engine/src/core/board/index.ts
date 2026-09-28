import { HEX_DIRECTIONS, buildBoardGraph, hexId } from '../geometry/index.js';
import type { EdgeId, HexCoord } from '../geometry/index.js';
import type { BoardShapeSpec, FixtureSlot } from '../modules/types.js';

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

/** Coastal land edges (edges with exactly one land hex), in perimeter order from the least id. */
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

/** Check every declared fixture slot and the shape's harbor slots against each other. */
export function boardShapeProblems(spec: BoardShapeSpec): string[] {
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
