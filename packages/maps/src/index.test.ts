import { expect, test } from 'vitest';
import { baseModule, createBaseEngine } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { PACKAGE_NAME, standardFixedBoard } from './index.js';

test('maps package exposes an original, reusable standard fixed island', () => {
  expect(PACKAGE_NAME).toBe('@cp2p/maps');
  const board = standardFixedBoard();
  const graph = buildBoardGraph(board.hexes);
  expect(graph.hexIds).toHaveLength(19);
  expect(graph.vertexIds).toHaveLength(54);
  expect(graph.edgeIds).toHaveLength(72);
  expect(board.hexes.filter((hex) => hex.terrain === 'desert')).toHaveLength(1);
  expect(board.hexes.find((hex) => hex.terrain === 'desert')?.id).toBe(board.robberHex);
  expect(board.harbors).toHaveLength(9);
  expect(new Set(board.harbors.map((harbor) => harbor.edge)).size).toBe(9);
  expect(board.harbors.every((harbor) => graph.edgeIndex[harbor.edge] !== undefined)).toBe(true);
  const first = board.hexes[0];
  if (!first) throw new Error('Missing first hex');
  first.terrain = 'changed';
  expect(standardFixedBoard().hexes[0]?.terrain).not.toBe('changed');
});

test('the fixed map starts a base game through the public engine API', () => {
  const board = standardFixedBoard();
  const engine = createBaseEngine();
  const config = {
    modules: [{ id: 'base', version: baseModule().version }],
    seats: [0, 1] as const,
    options: { base: { mapLayout: 'standard-fixed' } },
    board,
  };
  const game = engine.createGame({ ...config, seats: [...config.seats] }, new Uint8Array(32));
  expect(game.board).toEqual({
    ...board,
    hexes: board.hexes.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    harbors: board.harbors.toSorted((a, b) => (a.edge < b.edge ? -1 : a.edge > b.edge ? 1 : 0)),
  });
  expect(engine.getPending(game)).toEqual([
    { kind: 'random', request: { type: 'startSeat', max: 2 }, systemType: 'START_SEAT' },
  ]);
});
