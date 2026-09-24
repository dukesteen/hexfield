import { expect, test } from 'vitest';
import { buildBoardGraph } from '../../../core/geometry/index.js';
import type { GameState } from '../../../core/state/types.js';
import {
  canPlaceRoad,
  canPlaceSettlement,
  legalRoadEdges,
  legalSettlementVertices,
} from './index.js';

const coords = Array.from({ length: 5 }, (_, q) => q - 2).flatMap((q) =>
  Array.from({ length: 5 }, (_, r) => r - 2)
    .filter((r) => Math.abs(q + r) <= 2)
    .map((r) => ({ q, r })),
);
const graph = buildBoardGraph(coords);
const board = {
  hexes: coords.map(({ q, r }) => ({ id: `h:${q},${r}`, q, r, terrain: 'forest', token: 3 })),
  harbors: [],
  robberHex: 'h:0,0',
};

test('batched placement lists match standalone verdicts across occupied boards', () => {
  for (let sample = 0; sample < 80; sample++) {
    const state: GameState = {
      schema: 1,
      engineVersion: 'test',
      config: { modules: [], seats: [0, 1], options: {} },
      board: {
        ...board,
        roads: graph.edgeIds
          .filter((_, index) => (index * 19 + sample * 7) % 13 < 3)
          .map((edge, index) => ({ edge, seat: index % 2 === 0 ? 0 : 1 })),
        buildings: graph.vertexIds
          .filter((_, index) => (index * 11 + sample * 5) % 17 === 0)
          .map((vertex, index) => ({ vertex, seat: index % 2 === 0 ? 0 : 1, kind: 'settlement' })),
      },
      seats: [],
      bank: {},
      decks: {},
      turn: { number: 0, activeSeat: 0, phase: [] },
      awards: {},
      counters: { nextOfferId: 0, nextSlotId: 0, inputSeq: 0 },
      ext: {},
      result: null,
    };
    for (const seat of [0, 1] as const) {
      expect(legalRoadEdges(state, seat)).toEqual(
        graph.edgeIds.filter((edge) => canPlaceRoad(state, seat, edge)),
      );
      expect(legalSettlementVertices(state, seat)).toEqual(
        graph.vertexIds.filter((vertex) => canPlaceSettlement(state, seat, vertex)),
      );
      expect(legalSettlementVertices(state, seat, { setup: true })).toEqual(
        graph.vertexIds.filter((vertex) =>
          canPlaceSettlement(state, seat, vertex, { setup: true }),
        ),
      );
    }
  }
});
