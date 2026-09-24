import { describe, expect, test } from 'vitest';
import { performance as clock } from 'node:perf_hooks';
import { buildBoardGraph } from '../../../core/geometry/index.js';
import type { BoardState, GameState } from '../../../core/state/types.js';
import type { Seat } from '../../../core/types/index.js';
import {
  longestRoadLength,
  longestTrailLength,
  recomputeLargestArmyAward,
  recomputeLongestRoadAward,
} from './index.js';
import type { TrailEdge } from './index.js';

const coords = Array.from({ length: 5 }, (_, q) => q - 2).flatMap((q) =>
  Array.from({ length: 5 }, (_, r) => r - 2)
    .filter((r) => Math.abs(q + r) <= 2)
    .map((r) => ({ q, r })),
);
const graph = buildBoardGraph(coords);
function state(
  roads: readonly { edge: string; seat: Seat }[] = [],
  buildings: BoardState['buildings'] = [],
  awards: GameState['awards'] = { longestRoad: null, largestArmy: null },
  knightsPlayed = [0, 0, 0],
): GameState {
  return {
    schema: 1,
    engineVersion: 'test',
    config: { modules: [], seats: [0, 1, 2, 3], options: {} },
    board: {
      hexes: coords.map(({ q, r }) => ({ id: `h:${q},${r}`, q, r, terrain: 'forest', token: 3 })),
      harbors: [],
      roads: [...roads],
      buildings,
      robberHex: 'h:0,0',
    },
    seats: [],
    bank: {},
    decks: {},
    turn: { number: 0, activeSeat: 0, phase: [] },
    awards,
    counters: { nextOfferId: 0, nextSlotId: 0, inputSeq: 0 },
    ext: { base: { knightsPlayed } },
    result: null,
  };
}
function trail(edges: readonly [string, string][]): TrailEdge[] {
  return edges.map(([a, b], index) => ({ id: String(index), vertices: [a, b] }));
}
function endpoints(edge: string): readonly [string, string] {
  const index = graph.edgeIndex[edge];
  const result = index === undefined ? undefined : graph.edgeVertices[index];
  if (!result) throw new Error('Unknown edge');
  return result;
}
function pathOf(
  length: number,
  excluded: ReadonlySet<string> = new Set(),
  forbiddenVertices: ReadonlySet<string> = new Set(),
): string[] {
  function search(vertex: string, edges: string[], seen: Set<string>): string[] | null {
    if (edges.length === length) return edges;
    const incident = graph.vertexEdges[graph.vertexIndex[vertex] ?? -1] ?? [];
    for (const edge of incident) {
      if (excluded.has(edge) || edges.includes(edge)) continue;
      const [a, b] = endpoints(edge);
      const next = a === vertex ? b : a;
      if (seen.has(next) || forbiddenVertices.has(next)) continue;
      const found = search(next, [...edges, edge], new Set([...seen, next]));
      if (found) return found;
    }
    return null;
  }
  for (const vertex of graph.vertexIds) {
    if (forbiddenVertices.has(vertex)) continue;
    const found = search(vertex, [], new Set([vertex]));
    if (found) return found;
  }
  throw new Error(`No path of ${length}`);
}

function pathVertices(edges: readonly string[]): string[] {
  const first = endpoints(edges[0] ?? '');
  const second = endpoints(edges[1] ?? '');
  const start = first.find((vertex) => !second.includes(vertex));
  if (!start) throw new Error('No path start');
  let current = start;
  const vertices = [current];
  for (const edge of edges) {
    const [a, b] = endpoints(edge);
    current = a === current ? b : a;
    vertices.push(current);
  }
  return vertices;
}

describe('longest road', () => {
  test('simple line of five and Y branch count edges without repeating them', () => {
    const line = pathOf(5);
    expect(longestRoadLength(state(line.map((edge) => ({ edge, seat: 0 }))), 0)).toBe(5);
    expect(
      longestTrailLength(
        trail([
          ['c', 'a'],
          ['a', 'a2'],
          ['c', 'b'],
          ['b', 'b2'],
          ['c', 'd'],
          ['d', 'd2'],
        ]),
        new Set(),
      ),
    ).toBe(4);
  });
  test('loop plus two-edge tail counts eight and may revisit its junction', () => {
    const loop = graph.hexEdges[graph.hexIndex['h:0,0'] ?? -1] ?? [];
    const loopVertices = new Set(loop.flatMap((edge) => endpoints(edge)));
    const tail = pathOf(2, new Set(loop));
    // Find a tail from a loop vertex whose last vertex stays outside the loop.
    let chosen: string[] | null = null;
    for (const vertex of loopVertices) {
      const one = (graph.vertexEdges[graph.vertexIndex[vertex] ?? -1] ?? []).filter(
        (edge) => !loop.includes(edge),
      );
      for (const first of one) {
        const [a, b] = endpoints(first);
        const middle = a === vertex ? b : a;
        for (const second of graph.vertexEdges[graph.vertexIndex[middle] ?? -1] ?? []) {
          if (second !== first && !loop.includes(second)) {
            chosen = [first, second];
            break;
          }
        }
        if (chosen) break;
      }
      if (chosen) break;
    }
    expect(tail).toHaveLength(2);
    if (!chosen) throw new Error('No loop tail');
    expect(
      longestRoadLength(state([...loop, ...chosen].map((edge) => ({ edge, seat: 0 }))), 0),
    ).toBe(8);
  });
  test('figure eight traverses both loops through the shared vertex', () => {
    const figureEight = trail([
      ['c', 'a'],
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'e'],
      ['e', 'c'],
    ]);
    expect(longestTrailLength(figureEight, new Set())).toBe(6);
    expect(longestTrailLength(figureEight, new Set(['c']))).toBe(3);
  });
  test('opponent settlement cuts a seven-road line while own settlement does not', () => {
    const line = pathOf(7);
    const middle = pathVertices(line)[3];
    if (!middle) throw new Error('No middle vertex');
    expect(
      longestRoadLength(
        state(
          line.map((edge) => ({ edge, seat: 0 })),
          [{ vertex: middle, seat: 1, kind: 'settlement' }],
        ),
        0,
      ),
    ).toBe(4);
    expect(
      longestRoadLength(
        state(
          line.map((edge) => ({ edge, seat: 0 })),
          [{ vertex: middle, seat: 0, kind: 'settlement' }],
        ),
        0,
      ),
    ).toBe(7);
  });
  test('award tie, strictly longer transfer, and army threshold', () => {
    const first = pathOf(5);
    const second = pathOf(5, new Set(first));
    let board = state([
      ...first.map((edge) => ({ edge, seat: 0 as const })),
      ...second.map((edge) => ({ edge, seat: 1 as const })),
    ]);
    expect(recomputeLongestRoadAward(board).awards.longestRoad).toBeNull();
    board = state(board.board.roads, [], { longestRoad: 0, largestArmy: null });
    expect(recomputeLongestRoadAward(board).awards.longestRoad).toBe(0);
    const bigger = pathOf(6, new Set(first));
    board = state(
      [
        ...first.map((edge) => ({ edge, seat: 0 as const })),
        ...bigger.map((edge) => ({ edge, seat: 1 as const })),
      ],
      [],
      { longestRoad: 0, largestArmy: null },
    );
    expect(recomputeLongestRoadAward(board).awards.longestRoad).toBe(1);
    expect(
      recomputeLargestArmyAward(state([], [], { largestArmy: null }, [3, 3, 0])).awards.largestArmy,
    ).toBeNull();
    expect(
      recomputeLargestArmyAward(state([], [], { largestArmy: 0 }, [3, 3, 0])).awards.largestArmy,
    ).toBe(0);
    expect(
      recomputeLargestArmyAward(state([], [], { largestArmy: 0 }, [3, 4, 0])).awards.largestArmy,
    ).toBe(1);
  });
  test('a cut holder yields to one leader, clears on rival tie or no qualifying road', () => {
    const holder = pathOf(7);
    const cut = pathVertices(holder)[3];
    if (!cut) throw new Error('No cut vertex');
    const rivalA = pathOf(5, new Set(holder), new Set([cut]));
    const rivalB = pathOf(5, new Set([...holder, ...rivalA]), new Set([cut]));
    const buildings = [{ vertex: cut, seat: 2 as const, kind: 'settlement' }];
    const roads = [
      ...holder.map((edge) => ({ edge, seat: 0 as const })),
      ...rivalA.map((edge) => ({ edge, seat: 1 as const })),
      ...rivalB.map((edge) => ({ edge, seat: 2 as const })),
    ];
    const formerHolder = { longestRoad: 0 as const, largestArmy: null };
    expect(
      recomputeLongestRoadAward(state(roads, buildings, formerHolder)).awards.longestRoad,
    ).toBeNull();
    expect(
      recomputeLongestRoadAward(state(roads.slice(0, 12), buildings, formerHolder)).awards
        .longestRoad,
    ).toBe(1);
    expect(
      recomputeLongestRoadAward(state(roads.slice(0, 4), [], formerHolder)).awards.longestRoad,
    ).toBeNull();
  });
  test('fifteen roads compute in under one millisecond after warmup', () => {
    const junction = graph.vertexIds.find(
      (vertex) => graph.vertexHexes[graph.vertexIndex[vertex] ?? -1]?.length === 3,
    );
    if (!junction) throw new Error('No three-hex junction');
    const hexes = graph.vertexHexes[graph.vertexIndex[junction] ?? -1] ?? [];
    const edges = [
      ...new Set(hexes.flatMap((hex) => graph.hexEdges[graph.hexIndex[hex] ?? -1] ?? [])),
    ];
    expect(edges).toHaveLength(15);
    const roads = edges.map((edge) => ({ edge, seat: 0 as const }));
    const fixture = state(roads);
    // Four odd-degree vertices make a 15-edge Euler trail impossible.
    expect(longestRoadLength(fixture, 0)).toBe(14);
    for (let index = 0; index < 100; index++) longestRoadLength(fixture, 0);
    const start = clock.now();
    for (let index = 0; index < 100; index++) longestRoadLength(fixture, 0);
    expect((clock.now() - start) / 100).toBeLessThan(1);
    for (let index = 0; index < 100; index++) recomputeLongestRoadAward(fixture);
    const awardStart = clock.now();
    for (let index = 0; index < 100; index++) recomputeLongestRoadAward(fixture);
    expect((clock.now() - awardStart) / 100).toBeLessThan(1);
  });
});
