import {
  SEAFARING_TERRAINS,
  coastalEdges,
  isLandTerrain,
  isTokenlessTerrain,
} from '../../../../core/board/index.js';
import { buildBoardGraph, hexId } from '../../../../core/geometry/index.js';
import type { BoardGraph, HexCoord, HexId } from '../../../../core/geometry/index.js';
import type { BoardShapeSpec, GenesisRandom } from '../../../../core/modules/types.js';
import type { BoardHex, BoardState, HarborState } from '../../../../core/state/types.js';
import type { MapLayout } from '../../config.js';
import { STANDARD_BOARD, STANDARD_HEXES } from '../../board/shapes.js';

export { STANDARD_HEXES };

/** Board generation options resolved from the base module config. */
export interface BoardOptions {
  mapLayout: MapLayout;
  strictBalance: boolean;
}

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

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new BoardGenerationError('Incomplete board graph');
  return value;
}

interface ShapeData {
  graph: BoardGraph;
  coords: ReadonlyMap<string, HexCoord>;
  ids: ReadonlySet<string>;
  adjacent: ReadonlyMap<string, readonly HexId[]>;
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

const shapes = new WeakMap<BoardShapeSpec, ShapeData>();

function shapeData(spec: BoardShapeSpec): ShapeData {
  let data = shapes.get(spec);
  if (!data) {
    const graph = buildBoardGraph(spec.hexes);
    data = {
      graph,
      coords: new Map(spec.hexes.map((hex) => [hexId(hex), hex])),
      ids: new Set<string>(graph.hexIds),
      adjacent: new Map(graph.hexIds.map((hex) => [hex, adjacentHexes(graph, hex)])),
    };
    shapes.set(spec, data);
  }
  return data;
}

/** Nine disjoint positions around the thirty-edge coast, in perimeter order. */
export function standardHarborSlots(): string[] {
  return [...STANDARD_BOARD.harborSlots];
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

/** Check every fixed-board component against a shape before accepting external map data. */
export function validateFixedBoard(board: BoardState, spec: BoardShapeSpec): void {
  const { ids } = shapeData(spec);
  const size = spec.hexes.length;
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
    board.hexes.length !== size ||
    board.hexes.some(
      (hex) =>
        !hex ||
        !Number.isSafeInteger(hex.q) ||
        !Number.isSafeInteger(hex.r) ||
        hex.id !== hexId(hex) ||
        !ids.has(hex.id),
    ) ||
    new Set(board.hexes.map((hex) => hex.id)).size !== size
  ) {
    throw new BoardGenerationError(`Fixed board must have the ${size} ${spec.id} hexes`);
  }
  const seafaring = spec.seafaring === true;
  const tokenless = (terrain: string) =>
    seafaring ? isTokenlessTerrain(terrain) : terrain === 'desert';
  if (
    (!seafaring && board.hexes.some((hex) => SEAFARING_TERRAINS.includes(hex.terrain))) ||
    !sameCounts(
      board.hexes.map((hex) => hex.terrain),
      spec.terrains,
    ) ||
    !sameCounts(
      board.hexes
        .filter((hex) => !tokenless(hex.terrain))
        .flatMap((hex) => (hex.token === null ? [] : [hex.token])),
      spec.tokens,
    ) ||
    board.hexes.some((hex) => tokenless(hex.terrain) !== (hex.token === null))
  ) {
    throw new BoardGenerationError('Fixed board has incorrect terrain or tokens');
  }
  const robber = board.hexes.find((hex) => hex.id === board.robberHex);
  const robberOk = seafaring
    ? robber && isLandTerrain(robber.terrain)
    : robber?.terrain === 'desert';
  if (!robberOk || board.roads.length !== 0 || board.buildings.length !== 0) {
    throw new BoardGenerationError(
      seafaring
        ? 'Fixed board must start empty with robber on land'
        : 'Fixed board must start empty with robber on desert',
    );
  }
  // A seafaring board's coast depends on its sea hexes, so harbors need only be coastal.
  const slots = new Set<string>(seafaring ? coastalEdges(board.hexes) : spec.harborSlots);
  if (
    board.harbors.length !== spec.harbors.length ||
    board.harbors.some((harbor) => !harbor || !slots.has(harbor.edge)) ||
    new Set(board.harbors.map((harbor) => harbor.edge)).size !== spec.harbors.length ||
    !sameCounts(
      board.harbors.map((harbor) => harbor.kind),
      spec.harbors,
    )
  ) {
    throw new BoardGenerationError('Fixed board has incorrect harbor positions or kinds');
  }
}

/** Check every fixed-board component before accepting external standard map data. */
export function validateStandardBoard(board: BoardState): void {
  validateFixedBoard(board, STANDARD_BOARD);
}

function balancedTokens(
  rng: GenesisRandom,
  spec: BoardShapeSpec,
  hexes: readonly BoardHex[],
  strict: boolean,
): number[] | null {
  const { adjacent } = shapeData(spec);
  const positions = hexes
    .map((hex, index) => ({ hex, index }))
    .filter(({ hex }) => hex.terrain !== 'desert');
  const byId = new Map(hexes.map((hex, index) => [hex.id, index]));
  const randomOrder = rng.shuffle(positions);
  randomOrder.sort(
    (a, b) => (adjacent.get(b.hex.id)?.length ?? 0) - (adjacent.get(a.hex.id)?.length ?? 0),
  );
  const remaining = counts(spec.tokens);
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
      const neighbors = adjacent.get(hex.id) ?? [];
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
      const cap = spec.pipCaps[hex.terrain] ?? Number.MAX_SAFE_INTEGER;
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

/** Generate a board for a shape from genesis randomness, or validate a supplied fixed board. */
export function generateBoard(
  rng: GenesisRandom,
  options: BoardOptions,
  providedBoard?: BoardState,
  spec: BoardShapeSpec = STANDARD_BOARD,
): BoardState {
  if (options.mapLayout === 'standard-fixed') {
    if (!providedBoard) throw new BoardGenerationError('Fixed layout requires config.board');
    validateFixedBoard(providedBoard, spec);
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
  if (spec.seafaring === true)
    throw new BoardGenerationError('Seafaring shapes need a fixed board');
  if (options.mapLayout !== 'random' && options.mapLayout !== 'balanced-random') {
    throw new BoardGenerationError('Unknown map layout');
  }
  const { graph, coords } = shapeData(spec);
  for (let retry = 0; retry < (options.mapLayout === 'random' ? 1 : 100); retry++) {
    const terrains = rng.shuffle(spec.terrains);
    const hexes: BoardHex[] = graph.hexIds.map((id, index) => {
      const coord = required(coords.get(id));
      return { id, q: coord.q, r: coord.r, terrain: required(terrains[index]), token: null };
    });
    const numbers =
      options.mapLayout === 'random'
        ? rng.shuffle(spec.tokens)
        : balancedTokens(rng, spec, hexes, options.strictBalance);
    if (!numbers) continue;
    let tokenIndex = 0;
    for (const hex of hexes)
      if (hex.terrain !== 'desert') {
        hex.token =
          options.mapLayout === 'random'
            ? required(numbers[tokenIndex++])
            : required(numbers[required(graph.hexIndex[hex.id])]);
      }
    const kinds = rng.shuffle(spec.harbors);
    const harbors: HarborState[] = spec.harborSlots.map((edge, index) => ({
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
