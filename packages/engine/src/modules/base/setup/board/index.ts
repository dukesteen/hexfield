import { buildBoardGraph, hexId } from '../../../../core/geometry/index.js';
import type { BoardGraph, EdgeId, HexCoord, HexId } from '../../../../core/geometry/index.js';
import type { GenesisRandom } from '../../../../core/modules/types.js';
import type { BoardHex, BoardState, HarborState } from '../../../../core/state/types.js';
import type { MapLayout } from '../../config.js';

/** Board generation options resolved from the base module config. */
export interface BoardOptions {
  mapLayout: MapLayout;
  strictBalance: boolean;
}

const TERRAINS = [
  'forest',
  'forest',
  'forest',
  'forest',
  'pasture',
  'pasture',
  'pasture',
  'pasture',
  'fields',
  'fields',
  'fields',
  'fields',
  'hills',
  'hills',
  'hills',
  'mountains',
  'mountains',
  'mountains',
  'desert',
] as const;
const TOKENS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12] as const;
const HARBORS = [
  'generic',
  'generic',
  'generic',
  'generic',
  'brick',
  'lumber',
  'wool',
  'grain',
  'ore',
] as const;
const TOKEN_PIPS: Readonly<Record<number, number>> = {
  2: 1,
  3: 2,
  4: 3,
  5: 4,
  6: 5,
  8: 5,
  9: 4,
  10: 3,
  11: 2,
  12: 1,
};

/** A deterministic genesis failure with a stable machine-readable code. */
export class BoardGenerationError extends Error {
  readonly code = 'BOARD_GENERATION_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'BoardGenerationError';
  }
}

/** The 19 axial positions of the standard radius-two island. */
export const STANDARD_HEXES: readonly HexCoord[] = Array.from(
  { length: 5 },
  (_, row) => row - 2,
).flatMap((q) =>
  Array.from({ length: 5 }, (_, row) => row - 2)
    .filter((r) => Math.abs(q + r) <= 2)
    .map((r) => ({ q, r })),
);
const GRAPH = buildBoardGraph(STANDARD_HEXES);
const HEX_COORDS = new Map(STANDARD_HEXES.map((hex) => [hexId(hex), hex]));
const STANDARD_IDS = new Set<string>(GRAPH.hexIds);

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new BoardGenerationError('Incomplete board graph');
  return value;
}

function computeStandardHarborSlots(): EdgeId[] {
  const coast = new Set(
    GRAPH.edgeIds.filter(
      (edge) => required(GRAPH.edgeHexes[required(GRAPH.edgeIndex[edge])]).length === 1,
    ),
  );
  const around = new Map<string, EdgeId[]>();
  for (const edge of coast) {
    for (const vertex of required(GRAPH.edgeVertices[required(GRAPH.edgeIndex[edge])])) {
      const edges = around.get(vertex) ?? [];
      edges.push(edge);
      around.set(vertex, edges);
    }
  }
  const first = required([...coast].toSorted()[0]);
  let previous: EdgeId | undefined;
  let current = first;
  const cycle: EdgeId[] = [];
  do {
    cycle.push(current);
    const ends = required(GRAPH.edgeVertices[required(GRAPH.edgeIndex[current])]);
    const candidates = ends
      .flatMap((vertex) => around.get(vertex) ?? [])
      .filter((edge) => edge !== current && edge !== previous)
      .toSorted();
    const next = required(candidates[0]);
    previous = current;
    current = next;
  } while (current !== first && cycle.length <= coast.size);
  if (cycle.length !== 30 || current !== first)
    throw new BoardGenerationError('Invalid standard coast');
  const offsets = [0, 3, 6, 10, 13, 16, 20, 23, 26];
  return offsets.map((offset) => required(cycle[offset]));
}

const HARBOR_SLOTS = computeStandardHarborSlots();

/** Nine disjoint positions around the thirty-edge coast, in perimeter order. */
export function standardHarborSlots(): EdgeId[] {
  return [...HARBOR_SLOTS];
}

function counts<T extends string | number>(values: readonly T[]): Map<T, number> {
  const result = new Map<T, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}
function sameCounts(
  actual: readonly (string | number)[],
  expected: readonly (string | number)[],
): boolean {
  const left = counts(actual);
  const right = counts(expected);
  return (
    left.size === right.size && [...left].every(([value, count]) => right.get(value) === count)
  );
}

/** Check every fixed-board component before accepting external map data. */
export function validateStandardBoard(board: BoardState): void {
  if (
    !board ||
    !Array.isArray(board.hexes) ||
    !Array.isArray(board.harbors) ||
    !Array.isArray(board.roads) ||
    !Array.isArray(board.buildings)
  ) {
    throw new BoardGenerationError('Malformed fixed board');
  }
  if (
    board.hexes.length !== 19 ||
    board.hexes.some(
      (hex) =>
        !hex ||
        !Number.isSafeInteger(hex.q) ||
        !Number.isSafeInteger(hex.r) ||
        hex.id !== hexId(hex) ||
        !STANDARD_IDS.has(hex.id),
    ) ||
    new Set(board.hexes.map((hex) => hex.id)).size !== 19
  ) {
    throw new BoardGenerationError('Fixed board must have the 19 standard hexes');
  }
  if (
    !sameCounts(
      board.hexes.map((hex) => hex.terrain),
      TERRAINS,
    ) ||
    !sameCounts(
      board.hexes
        .filter((hex) => hex.terrain !== 'desert')
        .flatMap((hex) => (hex.token === null ? [] : [hex.token])),
      TOKENS,
    ) ||
    board.hexes.some((hex) => (hex.terrain === 'desert') !== (hex.token === null))
  ) {
    throw new BoardGenerationError('Fixed board has incorrect terrain or tokens');
  }
  const desert = board.hexes.find((hex) => hex.terrain === 'desert');
  if (board.robberHex !== desert?.id || board.roads.length !== 0 || board.buildings.length !== 0) {
    throw new BoardGenerationError('Fixed board must start empty with robber on desert');
  }
  const slots = new Set<string>(HARBOR_SLOTS);
  if (
    board.harbors.length !== 9 ||
    board.harbors.some((harbor) => !harbor || !slots.has(harbor.edge)) ||
    new Set(board.harbors.map((harbor) => harbor.edge)).size !== 9 ||
    !sameCounts(
      board.harbors.map((harbor) => harbor.kind),
      HARBORS,
    )
  ) {
    throw new BoardGenerationError('Fixed board has incorrect harbor positions or kinds');
  }
}

function adjacentHexes(graph: BoardGraph, hex: HexId): HexId[] {
  const index = required(graph.hexIndex[hex]);
  const neighbors = new Set<HexId>();
  for (const edge of required(graph.hexEdges[index])) {
    for (const other of required(graph.edgeHexes[required(graph.edgeIndex[edge])])) {
      if (other !== hex) neighbors.add(other);
    }
  }
  return [...neighbors].toSorted();
}
const ADJACENT: ReadonlyMap<string, readonly HexId[]> = new Map(
  GRAPH.hexIds.map((hex) => [hex, adjacentHexes(GRAPH, hex)]),
);

function balancedTokens(
  rng: GenesisRandom,
  hexes: readonly BoardHex[],
  strict: boolean,
): number[] | null {
  const positions = hexes
    .map((hex, index) => ({ hex, index }))
    .filter(({ hex }) => hex.terrain !== 'desert');
  const byId = new Map(hexes.map((hex, index) => [hex.id, index]));
  const randomOrder = rng.shuffle(positions);
  randomOrder.sort(
    (a, b) => (ADJACENT.get(b.hex.id)?.length ?? 0) - (ADJACENT.get(a.hex.id)?.length ?? 0),
  );
  const remaining = counts(TOKENS);
  const assigned = Array.from({ length: hexes.length }, () => 0);
  const pips = new Map<string, number>();
  let attempts = 0;
  function search(depth: number): boolean {
    if (depth === randomOrder.length) return true;
    if (attempts >= 10_000) return false;
    const { hex, index } = required(randomOrder[depth]);
    for (const token of rng.shuffle([...remaining.keys()])) {
      if (attempts >= 10_000) return false;
      if ((remaining.get(token) ?? 0) === 0) continue;
      attempts++;
      const neighbors = ADJACENT.get(hex.id) ?? [];
      if (
        neighbors.some((neighbor) => {
          const value = assigned[required(byId.get(neighbor))];
          return (
            value === token ||
            ((token === 6 || token === 8) && (value === 6 || value === 8)) ||
            (strict && (token === 2 || token === 12) && (value === 2 || value === 12))
          );
        })
      )
        continue;
      const nextPips = (pips.get(hex.terrain) ?? 0) + required(TOKEN_PIPS[token]);
      const cap = ['forest', 'pasture', 'fields'].includes(hex.terrain) ? 14 : 11;
      if (strict && nextPips > cap) continue;
      assigned[index] = token;
      pips.set(hex.terrain, nextPips);
      remaining.set(token, required(remaining.get(token)) - 1);
      if (search(depth + 1)) return true;
      remaining.set(token, required(remaining.get(token)) + 1);
      pips.set(hex.terrain, nextPips - required(TOKEN_PIPS[token]));
      assigned[index] = 0;
      if (attempts >= 10_000) return false;
    }
    return false;
  }
  return search(0) ? assigned : null;
}

/** Generate a base board from genesis randomness or validate a supplied fixed board. */
export function generateBoard(
  rng: GenesisRandom,
  options: BoardOptions,
  providedBoard?: BoardState,
): BoardState {
  if (options.mapLayout === 'standard-fixed') {
    if (!providedBoard) throw new BoardGenerationError('Fixed layout requires config.board');
    validateStandardBoard(providedBoard);
    return {
      hexes: providedBoard.hexes
        .map((hex) => ({ ...hex }))
        .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
      harbors: providedBoard.harbors
        .map((harbor) => ({ ...harbor }))
        .toSorted((a, b) => (a.edge < b.edge ? -1 : a.edge > b.edge ? 1 : 0)),
      roads: [],
      buildings: [],
      robberHex: providedBoard.robberHex,
    };
  }
  if (options.mapLayout !== 'random' && options.mapLayout !== 'balanced-random') {
    throw new BoardGenerationError('Unknown map layout');
  }
  for (let retry = 0; retry < (options.mapLayout === 'random' ? 1 : 100); retry++) {
    const terrains = rng.shuffle(TERRAINS);
    const hexes: BoardHex[] = GRAPH.hexIds.map((id, index) => {
      const coord = required(HEX_COORDS.get(id));
      return { id, q: coord.q, r: coord.r, terrain: required(terrains[index]), token: null };
    });
    const numbers =
      options.mapLayout === 'random'
        ? rng.shuffle(TOKENS)
        : balancedTokens(rng, hexes, options.strictBalance);
    if (!numbers) continue;
    let tokenIndex = 0;
    for (const hex of hexes)
      if (hex.terrain !== 'desert') {
        hex.token =
          options.mapLayout === 'random'
            ? required(numbers[tokenIndex++])
            : required(numbers[required(GRAPH.hexIndex[hex.id])]);
      }
    const kinds = rng.shuffle(HARBORS);
    const harbors: HarborState[] = HARBOR_SLOTS.map((edge, index) => ({
      edge,
      kind: required(kinds[index]),
    }));
    harbors.sort((a, b) => (a.edge < b.edge ? -1 : a.edge > b.edge ? 1 : 0));
    return {
      hexes,
      harbors,
      roads: [],
      buildings: [],
      robberHex: required(hexes.find((hex) => hex.terrain === 'desert')).id,
    };
  }
  throw new BoardGenerationError('Balanced board search exhausted');
}
