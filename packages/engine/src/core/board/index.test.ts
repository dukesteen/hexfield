import { describe, expect, test } from 'vitest';
import { buildBoardGraph, edgeId, hexId, vertexId } from '../geometry/index.js';
import type { BoardHex } from '../state/types.js';
import {
  classifyEdge,
  coastalEdges,
  detectIslands,
  isFogTerrain,
  isLandTerrain,
  isSeaTerrain,
  isTokenlessTerrain,
  landHexes,
  vertexTouchesLand,
} from './index.js';

/** One row: two land hexes, two sea hexes, one land hex, one fog hex. */
function row(fog = 'fog'): BoardHex[] {
  const terrains: [string, number | null][] = [
    ['forest', 5],
    ['gold', 6],
    ['sea', null],
    ['sea', null],
    ['fields', 9],
    [fog, null],
  ];
  return terrains.map(([terrain, token], q) => ({
    id: hexId({ q, r: 0 }),
    q,
    r: 0,
    terrain,
    token,
  }));
}
const ids = (hexes: readonly BoardHex[]) => new Set(landHexes(hexes).map((hex) => hex.id));

describe('terrain classification', () => {
  test('land is anything except sea and fog', () => {
    expect(['forest', 'desert', 'gold', 'hills'].every(isLandTerrain)).toBe(true);
    expect(isLandTerrain('sea')).toBe(false);
    expect(isLandTerrain('fog')).toBe(false);
    expect(isSeaTerrain('sea')).toBe(true);
    expect(isFogTerrain('fog')).toBe(true);
    expect(['desert', 'sea', 'fog'].every(isTokenlessTerrain)).toBe(true);
    expect(isTokenlessTerrain('gold')).toBe(false);
  });
});

describe('edge classification', () => {
  const hexes = row();
  const graph = buildBoardGraph(hexes);
  const land = ids(hexes);
  const kind = (edge: ReturnType<typeof edgeId>) => classifyEdge(graph, edge, land);

  test('land, coastal and sea edges', () => {
    expect(kind(edgeId({ q: 1, r: 0 }, 'W'))).toBe('land');
    expect(kind(edgeId({ q: 2, r: 0 }, 'W'))).toBe('coastal');
    expect(kind(edgeId({ q: 3, r: 0 }, 'W'))).toBe('sea');
    expect(kind(edgeId({ q: 2, r: 0 }, 'NE'))).toBe('sea');
  });
  test('a rim edge of a land hex is coastal, and fog counts as not land', () => {
    expect(kind(edgeId({ q: 0, r: 0 }, 'W'))).toBe('coastal');
    expect(kind(edgeId({ q: 0, r: 0 }, 'NE'))).toBe('coastal');
    expect(kind(edgeId({ q: 5, r: 0 }, 'W'))).toBe('coastal');
    expect(kind(edgeId({ q: 5, r: 0 }, 'NE'))).toBe('sea');
  });
  test('an unknown edge has no class', () => {
    expect(kind(edgeId({ q: 9, r: 9 }, 'W'))).toBeNull();
  });
  test('coastalEdges lists exactly the edges with one land side', () => {
    const coastal = coastalEdges(hexes);
    expect(coastal).toEqual([...coastal].toSorted());
    expect(coastal).toContain(edgeId({ q: 2, r: 0 }, 'W'));
    expect(coastal).not.toContain(edgeId({ q: 1, r: 0 }, 'W'));
    expect(coastal).not.toContain(edgeId({ q: 3, r: 0 }, 'W'));
    expect(coastal.every((edge) => kind(edge) === 'coastal')).toBe(true);
  });
  test('a vertex touches land when any hex around it is land', () => {
    expect(vertexTouchesLand(graph, vertexId({ q: 2, r: 0 }, 'NW'), land)).toBe(true);
    expect(vertexTouchesLand(graph, vertexId({ q: 3, r: 0 }, 'N'), land)).toBe(false);
    expect(vertexTouchesLand(graph, vertexId({ q: 5, r: 0 }, 'NE'), land)).toBe(false);
    expect(vertexTouchesLand(graph, 'v:99,99,N', land)).toBe(false);
  });
});

describe('island detection', () => {
  test('islands are connected land components named by their least hex id', () => {
    expect(detectIslands(row())).toEqual([
      { id: 'h:0,0', hexes: ['h:0,0', 'h:1,0'] },
      { id: 'h:4,0', hexes: ['h:4,0'] },
    ]);
  });
  test('a fog reveal that becomes land joins the island, and input order does not matter', () => {
    const revealed = detectIslands(row('pasture'));
    expect(revealed[1]).toEqual({ id: 'h:4,0', hexes: ['h:4,0', 'h:5,0'] });
    expect(detectIslands(row('pasture').toReversed())).toEqual(revealed);
  });
  test('land separated by sea is a separate island', () => {
    const hexes: BoardHex[] = [
      { id: 'h:0,0', q: 0, r: 0, terrain: 'hills', token: 4 },
      { id: 'h:1,0', q: 1, r: 0, terrain: 'sea', token: null },
      { id: 'h:2,0', q: 2, r: 0, terrain: 'hills', token: 4 },
      { id: 'h:0,1', q: 0, r: 1, terrain: 'desert', token: null },
    ];
    expect(detectIslands(hexes).map((island) => island.hexes)).toEqual([
      ['h:0,0', 'h:0,1'],
      ['h:2,0'],
    ]);
  });
  test('a board with no land has no islands', () => {
    expect(detectIslands([{ id: 'h:0,0', q: 0, r: 0, terrain: 'sea', token: null }])).toEqual([]);
  });
});
