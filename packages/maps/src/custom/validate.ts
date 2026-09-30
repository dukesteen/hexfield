import { detectIslands, engineForConfig, frameHexes, isLandTerrain } from '@cp2p/engine';
import type { BoardHex, BoardState } from '@cp2p/engine';
import { buildBoardGraph, hexId } from '@cp2p/engine/geometry';
import { adjacentLandPairs, harborIssues } from '../scenarios/seafaring/layout.js';
import type { HarborIssue } from '../scenarios/seafaring/layout.js';
import { mapBoard, mapConfig, mapSeatCounts } from './board.js';
import { SEAFARING_MAP_TERRAINS } from './schema.js';
import type { MapDef, MapTerrain } from './schema.js';

/** Problem codes. Errors block export and play; warnings are advice. */
export type MapProblemCode =
  | 'no-land'
  | 'terrain-needs-seafaring'
  | 'missing-token'
  | 'token-on-tokenless'
  | 'too-many-of-number'
  | 'unreachable-land'
  | 'harbor-not-coastal'
  | 'harbor-shared-water'
  | 'harbor-shared-vertex'
  | 'harbor-duplicate'
  | 'robber-missing'
  | 'robber-not-land'
  | 'pirate-not-sea'
  | 'setup-needs-seafaring'
  | 'setup-not-land'
  | 'setup-too-small'
  | 'fog-stack-mismatch'
  | 'fog-tokens-mismatch'
  | 'fog-beside-land'
  | 'seats-too-few'
  | 'engine-rejected'
  | 'adjacent-red'
  | 'adjacent-equal'
  | 'missing-resource'
  | 'robber-on-number'
  | 'no-harbors'
  | 'setup-tight';

/** One finding, located on the board where it can be. `values` fill the message. */
export interface MapProblem {
  readonly code: MapProblemCode;
  readonly hexes?: readonly string[];
  readonly edges?: readonly string[];
  readonly values?: Readonly<Record<string, string | number>>;
}

export interface MapReport {
  readonly errors: readonly MapProblem[];
  readonly warnings: readonly MapProblem[];
}

const RESOURCE_TERRAINS: readonly MapTerrain[] = [
  'forest',
  'hills',
  'pasture',
  'fields',
  'mountains',
];

/** Terrains that never carry a number token. */
export function isTokenless(terrain: string): boolean {
  return terrain === 'desert' || !isLandTerrain(terrain);
}

const isWater = (terrain: string): boolean => terrain === 'sea' || terrain === 'fog';
const red = (hex: BoardHex): boolean => hex.token === 6 || hex.token === 8;

const HARBOR_CODES: readonly (readonly [HarborIssue['kind'], MapProblemCode])[] = [
  ['not-coastal', 'harbor-not-coastal'],
  ['shared-water', 'harbor-shared-water'],
  ['shared-vertex', 'harbor-shared-vertex'],
  ['duplicate', 'harbor-duplicate'],
];

/** The board with a sea ring around a land-only (base) map, so harbors can be checked for water. */
function harborBoard(board: BoardState): BoardState {
  if (board.hexes.some((hex) => hex.terrain === 'sea')) return board;
  const ring: BoardHex[] = frameHexes(board.hexes).map(({ q, r }) => ({
    id: hexId({ q, r }),
    q,
    r,
    terrain: 'sea',
    token: null,
  }));
  return { ...board, hexes: [...board.hexes, ...ring] };
}

/** Land that no seat can reach: other islands without ships, or islands no route of water reaches. */
function unreachableLand(map: MapDef, board: BoardState): string[] {
  const islands = detectIslands(board.hexes);
  if (islands.length < 2) return [];
  if (!map.modules.includes('seafaring')) {
    // The largest island (ties by id) is where play happens; roads cannot cross water.
    const main = islands.toSorted((a, b) => b.hexes.length - a.hexes.length)[0];
    return islands.filter((island) => island !== main).flatMap((island) => island.hexes);
  }
  if (map.setupAreas === null) return [];
  const setup = new Set(map.setupAreas);
  const graph = buildBoardGraph(board.hexes);
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root)
      root = parent.get(root) ?? root;
    parent.set(id, root);
    return root;
  };
  const join = (a: string, b: string) => parent.set(find(a), find(b));
  const terrain = new Map(board.hexes.map((hex) => [hex.id, hex.terrain]));
  // Ships sail along edges beside water (fog may turn out to be sea); roads join an island's corners.
  graph.edgeIds.forEach((_edge, index) => {
    const owners = graph.edgeHexes[index] ?? [];
    const [a, b] = graph.edgeVertices[index] ?? [];
    if (a && b && owners.some((id) => isWater(terrain.get(id) ?? 'sea'))) join(a, b);
  });
  const corners = (hexes: readonly string[]) =>
    hexes.flatMap((id) => graph.hexVertices[graph.hexIndex[id] ?? -1] ?? []);
  for (const island of islands) {
    const [first, ...rest] = corners(island.hexes);
    if (first) for (const vertex of rest) join(first, vertex);
  }
  const homes = new Set(
    islands
      .filter((island) => island.hexes.some((id) => setup.has(id)))
      .flatMap((island) => corners(island.hexes).map(find)),
  );
  return islands
    .filter((island) => !corners(island.hexes).some((vertex) => homes.has(find(vertex))))
    .flatMap((island) => island.hexes);
}

/**
 * How many setup settlements fit at once under the distance rule, found greedily (fewest
 * neighbours first). The greedy count is a lower bound, so a map it accepts always has room.
 */
export function setupSpots(map: MapDef, board: BoardState = mapBoard(map)): number {
  const graph = buildBoardGraph(board.hexes);
  const land = new Set(
    board.hexes.filter((hex) => isLandTerrain(hex.terrain)).map((hex) => hex.id),
  );
  const setup = map.setupAreas === null ? null : new Set(map.setupAreas);
  const allowed = new Set(
    graph.vertexIds.filter((_vertex, index) => {
      const hexes = graph.vertexHexes[index] ?? [];
      return (
        hexes.some((id) => land.has(id)) && (setup === null || hexes.some((id) => setup.has(id)))
      );
    }),
  );
  const neighbours = (vertex: string) =>
    (graph.vertexNeighbors[graph.vertexIndex[vertex] ?? -1] ?? []).filter((id) => allowed.has(id));
  const order = [...allowed].toSorted(
    (a, b) => neighbours(a).length - neighbours(b).length || (a < b ? -1 : a > b ? 1 : 0),
  );
  const blocked = new Set<string>();
  let spots = 0;
  for (const vertex of order) {
    if (blocked.has(vertex)) continue;
    spots += 1;
    blocked.add(vertex);
    for (const next of neighbours(vertex)) blocked.add(next);
  }
  return spots;
}

function engineProblems(map: MapDef): MapProblem[] {
  const counts = mapSeatCounts(map);
  // One genesis per rule set: 2–4 seats and 5–6 seats play different modules.
  const samples = [counts.find((count) => count <= 4), counts.find((count) => count > 4)];
  for (const seats of samples) {
    if (seats === undefined) continue;
    const config = mapConfig(map, seats);
    if (!config.ok) return [{ code: 'engine-rejected', values: { message: config.error.message } }];
    try {
      engineForConfig(config.value).createGame(config.value, new Uint8Array(32));
    } catch (error) {
      return [
        {
          code: 'engine-rejected',
          values: { message: error instanceof Error ? error.message : String(error) },
        },
      ];
    }
  }
  return [];
}

/**
 * Check a map for play. Errors: missing or misplaced tokens, too many of one number, land no seat
 * can reach, harbors off the coast or sharing water, a missing robber, not enough room to set up,
 * a fog stack that does not fit, and (with `engine`, a genesis dry run of a few hundred ms, run
 * before export and play) anything the engine refuses. Warnings: numbers
 * side by side, a missing resource, the robber blocking a number, no harbors, a tight setup.
 */
export function validateMap(map: MapDef, options: { readonly engine?: boolean } = {}): MapReport {
  const errors: MapProblem[] = [];
  const warnings: MapProblem[] = [];
  const board = mapBoard(map);
  const seafaring = map.modules.includes('seafaring');
  const knights = map.modules.includes('knights');
  const land = board.hexes.filter((hex) => isLandTerrain(hex.terrain));
  if (land.length === 0) return { errors: [{ code: 'no-land' }], warnings: [] };
  const byId = new Map(board.hexes.map((hex) => [hex.id, hex]));
  const counts = mapSeatCounts(map);
  if (counts.length === 0) errors.push({ code: 'seats-too-few' });

  const foreign = board.hexes.filter((hex) =>
    (SEAFARING_MAP_TERRAINS as readonly string[]).includes(hex.terrain),
  );
  if (!seafaring && foreign.length > 0)
    errors.push({ code: 'terrain-needs-seafaring', hexes: foreign.map((hex) => hex.id) });

  const missing = land.filter((hex) => !isTokenless(hex.terrain) && hex.token === null);
  if (missing.length > 0)
    errors.push({ code: 'missing-token', hexes: missing.map((hex) => hex.id) });
  const extra = board.hexes.filter((hex) => isTokenless(hex.terrain) && hex.token !== null);
  if (extra.length > 0)
    errors.push({ code: 'token-on-tokenless', hexes: extra.map((hex) => hex.id) });
  const numbered = board.hexes.filter((hex) => hex.token !== null && !isTokenless(hex.terrain));
  // A number may cover at most a quarter of the numbered hexes (at least three), like the base set.
  const limit = Math.max(3, Math.ceil(numbered.length / 4));
  for (const token of new Set(numbered.map((hex) => hex.token))) {
    const same = numbered.filter((hex) => hex.token === token);
    if (same.length > limit)
      errors.push({
        code: 'too-many-of-number',
        hexes: same.map((hex) => hex.id),
        values: { number: token ?? 0, count: same.length, limit },
      });
  }

  const unreachable = unreachableLand(map, board);
  if (unreachable.length > 0) errors.push({ code: 'unreachable-land', hexes: unreachable });

  const issues = harborIssues(harborBoard(board));
  for (const [kind, code] of HARBOR_CODES) {
    const edges = issues.filter((issue) => issue.kind === kind).map((issue) => issue.edge);
    if (edges.length > 0) errors.push({ code, edges: [...new Set(edges)] });
  }
  if (map.harbors.length === 0) warnings.push({ code: 'no-harbors' });

  const robber = map.robber === null ? undefined : byId.get(map.robber);
  if (map.robber === null) {
    if (!seafaring) errors.push({ code: 'robber-missing' });
  } else if (!robber || !isLandTerrain(robber.terrain))
    errors.push({ code: 'robber-not-land', hexes: [map.robber] });
  else if (robber.token !== null) warnings.push({ code: 'robber-on-number', hexes: [robber.id] });

  if (map.pirate !== null && (!seafaring || byId.get(map.pirate)?.terrain !== 'sea'))
    errors.push({ code: 'pirate-not-sea', hexes: [map.pirate] });

  if (map.setupAreas !== null) {
    if (!seafaring) errors.push({ code: 'setup-needs-seafaring' });
    const off = map.setupAreas.filter((id) => !isLandTerrain(byId.get(id)?.terrain ?? 'sea'));
    if (off.length > 0) errors.push({ code: 'setup-not-land', hexes: off });
  }
  const seats = counts.at(-1) ?? map.seats.max;
  const spots = setupSpots(map, board);
  if (spots < seats * 2)
    errors.push({ code: 'setup-too-small', values: { spots, needed: seats * 2 } });
  else if (spots < seats * 3)
    warnings.push({ code: 'setup-tight', values: { spots, players: seats } });

  const fogHexes = board.hexes.filter((hex) => hex.terrain === 'fog');
  if (fogHexes.length > 0 || map.fog !== null) {
    const tiles = Object.values(map.fog?.terrains ?? {}).reduce((sum, value) => sum + value, 0);
    if (tiles !== fogHexes.length)
      errors.push({
        code: 'fog-stack-mismatch',
        hexes: fogHexes.map((hex) => hex.id),
        values: { tiles, hexes: fogHexes.length },
      });
    const takers = Object.entries(map.fog?.terrains ?? {})
      .filter(([terrain]) => !isTokenless(terrain))
      .reduce((sum, [, value]) => sum + value, 0);
    const tokens = Object.values(map.fog?.tokens ?? {}).reduce((sum, value) => sum + value, 0);
    if (tokens !== takers)
      errors.push({ code: 'fog-tokens-mismatch', values: { tokens, needed: takers } });
    const landIds = new Set(land.map((hex) => hex.id));
    const graph = buildBoardGraph(board.hexes);
    const beside = fogHexes.filter((hex) =>
      (graph.hexVertices[graph.hexIndex[hex.id] ?? -1] ?? []).some((vertex) =>
        (graph.vertexHexes[graph.vertexIndex[vertex] ?? -1] ?? []).some((id) => landIds.has(id)),
      ),
    );
    // A knight must never stand beside unrevealed fog; with knights, fog keeps a sea hex from land.
    if (beside.length > 0)
      (knights ? errors : warnings).push({
        code: 'fog-beside-land',
        hexes: beside.map((hex) => hex.id),
      });
  }

  const reds: string[] = [];
  const equal: string[] = [];
  for (const [a, b] of adjacentLandPairs(board.hexes)) {
    if (red(a) && red(b)) reds.push(a.id, b.id);
    else if (a.token !== null && a.token === b.token) equal.push(a.id, b.id);
  }
  if (reds.length > 0) warnings.push({ code: 'adjacent-red', hexes: [...new Set(reds)] });
  if (equal.length > 0) warnings.push({ code: 'adjacent-equal', hexes: [...new Set(equal)] });
  for (const terrain of RESOURCE_TERRAINS)
    if (!numbered.some((hex) => hex.terrain === terrain))
      warnings.push({ code: 'missing-resource', values: { terrain } });

  if (options.engine === true && errors.length === 0) errors.push(...engineProblems(map));
  return { errors, warnings };
}

/** The hex ids and edges a report points at, for the editor's markers. */
export function problemLocations(problems: readonly MapProblem[]): {
  hexes: string[];
  edges: string[];
} {
  return {
    hexes: [...new Set(problems.flatMap((problem) => problem.hexes ?? []))],
    edges: [...new Set(problems.flatMap((problem) => problem.edges ?? []))],
  };
}
