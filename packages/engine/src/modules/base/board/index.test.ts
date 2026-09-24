import { expect, test } from 'vitest';
import { createRng } from '../../../core/rng/index.js';
import type { GameState } from '../../../core/state/types.js';
import { generateBoard } from '../setup/board/index.js';
import { boardGraph, edgesForVertex, harborRate, hexesForVertex, verticesForHex } from './index.js';

function state(): GameState {
  return {
    schema: 1,
    engineVersion: 'test',
    config: { modules: [], seats: [0, 1], options: {} },
    board: generateBoard(createRng(new Uint8Array(32)), {
      mapLayout: 'random',
      strictBalance: false,
    }),
    seats: [],
    bank: {},
    decks: {},
    turn: { number: 0, activeSeat: 0, phase: [] },
    awards: {},
    counters: { nextOfferId: 0, nextSlotId: 0, inputSeq: 0 },
    ext: {},
    result: null,
  };
}

test('board queries return sorted geometry and are safe for off-board strings', () => {
  const game = state();
  const graph = boardGraph(game);
  expect(boardGraph(game)).toBe(graph);
  expect(Object.isFrozen(graph.edgeVertices[0])).toBe(true);
  expect(verticesForHex(game, 'h:0,0')).toHaveLength(6);
  const vertex = verticesForHex(game, 'h:0,0')[0];
  if (!vertex) throw new Error('No vertex');
  expect(hexesForVertex(game, vertex)).toContain('h:0,0');
  expect(edgesForVertex(game, vertex)).toHaveLength(3);
  expect(verticesForHex(game, 'toString')).toEqual([]);
  expect(edgesForVertex(game, 'constructor')).toEqual([]);
  expect(hexesForVertex(game, '__proto__')).toEqual([]);
});

test('a harbor grants its generic or matching specific rate at either endpoint', () => {
  const game = state();
  const graph = boardGraph(game);
  const generic = game.board.harbors.find((harbor) => harbor.kind === 'generic');
  const specific = game.board.harbors.find((harbor) => harbor.kind === 'brick');
  if (!generic || !specific) throw new Error('No required harbor');
  expect(harborRate(game, 0, 'brick')).toBe(4);
  const genericVertex = graph.edgeVertices[graph.edgeIndex[generic.edge] ?? -1]?.[0];
  const specificVertex = graph.edgeVertices[graph.edgeIndex[specific.edge] ?? -1]?.[1];
  if (!genericVertex || !specificVertex) throw new Error('No harbor vertex');
  const genericGame = {
    ...game,
    board: {
      ...game.board,
      buildings: [{ vertex: genericVertex, seat: 0 as const, kind: 'settlement' }],
    },
  };
  expect(harborRate(genericGame, 0, 'brick')).toBe(3);
  expect(harborRate(genericGame, 1, 'brick')).toBe(4);
  const specificGame = {
    ...genericGame,
    board: {
      ...genericGame.board,
      buildings: [
        ...genericGame.board.buildings,
        { vertex: specificVertex, seat: 0 as const, kind: 'city' },
      ],
    },
  };
  expect(harborRate(specificGame, 0, 'brick')).toBe(2);
  expect(harborRate(specificGame, 0, 'ore')).toBe(3);
});
