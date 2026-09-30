import { coastalEdges, detectIslands, isLandTerrain, isTokenlessTerrain } from '@cp2p/engine';
import type { BoardHex, BoardShapeSpec, BoardState } from '@cp2p/engine';
import { buildBoardGraph, hexId } from '@cp2p/engine/geometry';

/**
 * Seafaring layouts are drawn as text. One cell is two characters, a terrain letter and a token
 * character, and cells are separated by spaces. Rows are in "odd-r" offset order: odd rows sit half
 * a hex to the right. Terrain letters: `~` sea, `F` forest, `H` hills, `P` pasture, `A` fields,
 * `M` mountains, `D` desert, `G` gold, `?` fog placeholder. Token characters: `.` none, `2`-`9`,
 * `a` 10, `b` 11, `c` 12.
 */
const TERRAIN_LETTERS: Readonly<Record<string, string>> = {
  '~': 'sea',
  F: 'forest',
  H: 'hills',
  P: 'pasture',
  A: 'fields',
  M: 'mountains',
  D: 'desert',
  G: 'gold',
  '?': 'fog',
};

const TOKEN_CHARS = '..23456789abc';

/** Axial coordinates of an offset cell (odd rows shifted right). */
export function cellCoord(col: number, row: number): { q: number; r: number } {
  return { q: col - (row - (row & 1)) / 2, r: row };
}

/** Hex id of an offset cell, for authoring pirate, robber and region lists. */
export function cellId(col: number, row: number): string {
  return hexId(cellCoord(col, row));
}

/** Parse a text layout into board hexes, in row-major order. */
export function parseRows(rows: readonly string[]): BoardHex[] {
  return rows.flatMap((line, row) =>
    line
      .trim()
      .split(/\s+/)
      .map((cell, col) => {
        const terrain = TERRAIN_LETTERS[cell[0] ?? ''];
        const digit = TOKEN_CHARS.indexOf(cell[1] ?? '');
        if (terrain === undefined || cell.length !== 2 || digit < 0)
          throw new Error(`Bad layout cell "${cell}" at column ${col}, row ${row}`);
        const coord = cellCoord(col, row);
        const token = cell[1] === '.' ? null : digit;
        return { id: hexId(coord), ...coord, terrain, token };
      }),
  );
}

/** Render hexes back to layout text (used by tooling and tests). */
export function renderRows(hexes: readonly BoardHex[]): string[] {
  const letters = Object.fromEntries(Object.entries(TERRAIN_LETTERS).map(([k, v]) => [v, k]));
  const byRow = new Map<number, BoardHex[]>();
  for (const hex of hexes) byRow.set(hex.r, [...(byRow.get(hex.r) ?? []), hex]);
  return [...byRow.keys()]
    .toSorted((a, b) => a - b)
    .map((row) => {
      const cells = (byRow.get(row) ?? [])
        .toSorted((a, b) => a.q - b.q)
        .map(
          (hex) =>
            `${letters[hex.terrain] ?? '?'}${hex.token === null ? '.' : TOKEN_CHARS[hex.token]}`,
        );
      return `${row % 2 ? '  ' : ''}${cells.join(' ')}`;
    });
}

/** A scenario board: text layout, harbor slots with kinds, and the robber's start hex. */
export interface SeafaringLayout {
  readonly rows: readonly string[];
  readonly harbors: readonly (readonly [edge: string, kind: string])[];
  readonly robberHex: string;
}

export function boardFromLayout(layout: SeafaringLayout): BoardState {
  return {
    hexes: parseRows(layout.rows),
    harbors: layout.harbors.map(([edge, kind]) => ({ edge, kind })),
    roads: [],
    buildings: [],
    robberHex: layout.robberHex,
  };
}

/** The shape spec that matches a fixed seafaring board: every hex, sea included, and its bags. */
export function shapeFromBoard(id: string, board: BoardState): BoardShapeSpec {
  return Object.freeze({
    id,
    seafaring: true,
    hexes: Object.freeze(board.hexes.map(({ q, r }) => ({ q, r }))),
    terrains: Object.freeze(board.hexes.map((hex) => hex.terrain)),
    tokens: Object.freeze(
      board.hexes
        .filter((hex) => !isTokenlessTerrain(hex.terrain))
        .flatMap((hex) => (hex.token === null ? [] : [hex.token])),
    ),
    harbors: Object.freeze(board.harbors.map((harbor) => harbor.kind)),
    harborSlots: Object.freeze(board.harbors.map((harbor) => harbor.edge)),
    fixtureSlots: Object.freeze([]),
    pipCaps: Object.freeze({}),
  });
}

/** Pairs of land hexes that share an edge. */
export function adjacentLandPairs(hexes: readonly BoardHex[]): [BoardHex, BoardHex][] {
  const graph = buildBoardGraph(hexes);
  const byId = new Map(hexes.map((hex) => [hex.id, hex]));
  const pairs: [BoardHex, BoardHex][] = [];
  for (const owners of graph.edgeHexes) {
    if (owners.length !== 2) continue;
    const a = byId.get(owners[0] ?? '');
    const b = byId.get(owners[1] ?? '');
    if (a && b && isLandTerrain(a.terrain) && isLandTerrain(b.terrain)) pairs.push([a, b]);
  }
  return pairs;
}

const isRed = (hex: BoardHex): boolean => hex.token === 6 || hex.token === 8;

/** Token rule violations on a board: adjacent red numbers or equal numbers, tokens on the wrong terrain. */
export function tokenProblems(hexes: readonly BoardHex[]): string[] {
  const problems: string[] = [];
  for (const hex of hexes)
    if (isTokenlessTerrain(hex.terrain) !== (hex.token === null))
      problems.push(`${hex.id}: ${hex.terrain} with token ${hex.token}`);
  for (const [a, b] of adjacentLandPairs(hexes)) {
    if (isRed(a) && isRed(b)) problems.push(`${a.id} and ${b.id}: adjacent 6/8`);
    else if (a.token !== null && a.token === b.token)
      problems.push(`${a.id} and ${b.id}: adjacent equal tokens`);
  }
  return problems;
}

/** One harbor rule violation, located at the harbor's edge (the map editor marks it there). */
export type HarborIssue =
  | { readonly kind: 'not-coastal'; readonly edge: string }
  | { readonly kind: 'shared-water'; readonly edge: string; readonly water: string }
  | { readonly kind: 'shared-vertex'; readonly edge: string; readonly vertex: string }
  | { readonly kind: 'duplicate'; readonly edge: string };

/** Harbor rule violations: coastal edges only, one per water hex, no shared vertex or edge. */
export function harborIssues(board: BoardState): HarborIssue[] {
  const issues: HarborIssue[] = [];
  const coast = new Set<string>(coastalEdges(board.hexes));
  const graph = buildBoardGraph(board.hexes);
  const land = new Set(
    board.hexes.filter((hex) => isLandTerrain(hex.terrain)).map((hex) => hex.id),
  );
  const seen = new Set<string>();
  const waters = new Set<string>();
  const edges = new Set<string>();
  for (const { edge } of board.harbors) {
    if (edges.has(edge)) issues.push({ kind: 'duplicate', edge });
    edges.add(edge);
    const index = graph.edgeIndex[edge];
    if (index === undefined || !coast.has(edge)) issues.push({ kind: 'not-coastal', edge });
    // Each harbor's pier and token sit in the water hex it faces, so two harbors must not share one.
    const water = (index === undefined ? [] : (graph.edgeHexes[index] ?? [])).find(
      (id) => !land.has(id),
    );
    if (water !== undefined) {
      if (waters.has(water)) issues.push({ kind: 'shared-water', edge, water });
      waters.add(water);
    }
    for (const vertex of index === undefined ? [] : (graph.edgeVertices[index] ?? [])) {
      if (seen.has(vertex)) issues.push({ kind: 'shared-vertex', edge, vertex });
      seen.add(vertex);
    }
  }
  return issues;
}

/** Harbor rule violations as text: coastal edges only, no shared vertex, no duplicate edge. */
export function harborProblems(board: BoardState): string[] {
  const issues = harborIssues(board);
  const problems = issues.flatMap((issue) =>
    issue.kind === 'not-coastal'
      ? [`${issue.edge}: not a coastal edge`]
      : issue.kind === 'shared-water'
        ? [`${issue.edge}: faces ${issue.water} with another harbor`]
        : issue.kind === 'shared-vertex'
          ? [`${issue.edge}: shares vertex ${issue.vertex} with another harbor`]
          : [],
  );
  if (issues.some((issue) => issue.kind === 'duplicate')) problems.push('duplicate harbor edge');
  return problems;
}

/** Ids of every land hex of the islands that contain any of the given hexes. */
export function islandHexes(board: BoardState, members: readonly string[]): string[] {
  const wanted = new Set(members);
  return detectIslands(board.hexes)
    .filter((island) => island.hexes.some((id) => wanted.has(id)))
    .flatMap((island) => island.hexes)
    .toSorted();
}
