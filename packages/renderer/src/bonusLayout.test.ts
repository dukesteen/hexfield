import { describe, expect, it } from 'vitest';
import {
  buildBoardGraph,
  edgeToPixel,
  hexId,
  hexToPixel,
  vertexToPixel,
} from '@cp2p/engine/geometry';
import type { Point } from '@cp2p/engine/geometry';
import { BONUS_CHIT_SIZE, islandBonusPoints } from './bonusLayout.js';
import { harborOnBoard } from './harborLayout.js';
import type { RenderModel } from './types.js';

const SIZE = 54;
const CHIT = (BONUS_CHIT_SIZE / 2) * SIZE;

function board(land: Readonly<Record<string, number>>): RenderModel['hexes'] {
  const cells: { q: number; r: number }[] = [];
  for (let q = -2; q <= 5; q++) for (let r = -4; r <= 2; r++) cells.push({ q, r });
  const graph = buildBoardGraph(cells);
  return cells.map((cell) => {
    const id = graph.hexIds.find((candidate) => candidate === hexId(cell));
    if (!id) throw new Error('Missing hex');
    const token = land[id];
    return { id, ...cell, terrain: token === undefined ? 'sea' : 'fields', token: token ?? null };
  });
}

function segmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t));
}

describe('island bonus chits', () => {
  it('stand beside a lone settlement, up and to the right', () => {
    const hexes = board({ 'h:0,0': 6 });
    const model = {
      hexes,
      harbors: [],
      roads: [],
      buildings: [{ vertex: 'v:0,0,N' as const, seat: 0 as const, kind: 'settlement' as const }],
      islandBonuses: [{ vertex: 'v:0,0,N' as const, seat: 0 as const, vp: 1 }],
    };
    const point = islandBonusPoints(model, buildBoardGraph(hexes), SIZE).get('v:0,0,N');
    const vertex = vertexToPixel('v:0,0,N', SIZE);
    if (!point) throw new Error('No chit');
    expect(point.x).toBeGreaterThan(vertex.x);
    expect(point.y).toBeLessThan(vertex.y);
  });

  it('keep clear of a harbor, its pier, a road, a ship and the number token (phone report)', () => {
    // The reported corner: a city on the coast of a fields hex, a 2:1 harbor on the coast edge
    // beside it, a road down the other coast edge and a ship sailing off its third edge.
    const hexes = board({ 'h:3,-1': 9 });
    const model = {
      hexes,
      harbors: [{ edge: 'e:3,-1,NW' as const, kind: 'grain' }],
      roads: [{ edge: 'e:3,-1,W' as const, seat: 1 as const }],
      ships: [{ edge: 'e:2,-1,NE' as const, seat: 1 as const }],
      buildings: [{ vertex: 'v:3,-2,S' as const, seat: 1 as const, kind: 'city' as const }],
      islandBonuses: [{ vertex: 'v:3,-2,S' as const, seat: 1 as const, vp: 1 }],
    };
    const graph = buildBoardGraph(hexes);
    const point = islandBonusPoints(model, graph, SIZE).get('v:3,-2,S');
    if (!point) throw new Error('No chit');
    const harbor = harborOnBoard(model, graph, 'e:3,-1,NW', SIZE)?.layout;
    if (!harbor) throw new Error('No harbor');
    expect(Math.hypot(point.x - harbor.hub.x, point.y - harbor.hub.y)).toBeGreaterThan(
      0.34 * SIZE + CHIT,
    );
    expect(segmentDistance(point, harbor.midpoint, harbor.hub)).toBeGreaterThan(0.12 * SIZE + CHIT);
    const token = hexToPixel(3, -1, SIZE);
    expect(Math.hypot(point.x - token.x, point.y - token.y)).toBeGreaterThan(0.3125 * SIZE + CHIT);
    for (const edge of ['e:3,-1,W', 'e:2,-1,NE'] as const) {
      const midpoint = edgeToPixel(edge, SIZE).midpoint;
      expect(Math.hypot(point.x - midpoint.x, point.y - midpoint.y)).toBeGreaterThan(
        0.2 * SIZE + CHIT,
      );
    }
    // The old fixed spot, up and to the right of the city, sat on the harbor's pier.
    const vertex = vertexToPixel('v:3,-2,S', SIZE);
    const old = { x: vertex.x + 0.3 * SIZE, y: vertex.y - 0.32 * SIZE };
    expect(segmentDistance(old, harbor.midpoint, harbor.hub)).toBeLessThan(0.12 * SIZE + CHIT);
  });

  it('never stack two chits on each other', () => {
    const hexes = board({ 'h:0,0': 6, 'h:1,-1': 5 });
    const model = {
      hexes,
      harbors: [],
      roads: [],
      buildings: [
        { vertex: 'v:0,0,N' as const, seat: 0 as const, kind: 'settlement' as const },
        { vertex: 'v:1,-1,S' as const, seat: 1 as const, kind: 'settlement' as const },
      ],
      islandBonuses: [
        { vertex: 'v:0,0,N' as const, seat: 0 as const, vp: 1 },
        { vertex: 'v:1,-1,S' as const, seat: 1 as const, vp: 1 },
      ],
    };
    const points = [...islandBonusPoints(model, buildBoardGraph(hexes), SIZE).values()];
    expect(points).toHaveLength(2);
    const [a, b] = points;
    if (!a || !b) throw new Error('Missing chits');
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(2 * CHIT);
  });
});
