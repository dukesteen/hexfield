import { expect, test } from 'vitest';
import { createBaseEngine, seafaringConfig, seafaringEngine } from '@cp2p/engine';
import type { GameState } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { toRenderModel } from './toRenderModel.js';

const engine = seafaringEngine();
const genesis = engine.createGame(seafaringConfig({ seats: 3 }), new Uint8Array(32).fill(2));

test('a seafaring model carries its sea and gold hexes, no ships yet, and the pirate', () => {
  const model = toRenderModel(genesis, 'spectator');
  expect(model.ships).toEqual([]);
  expect(model.pirateHex).toBe('h:3,0');
  expect(model.islandBonuses).toEqual([]);
  const terrains = new Set(model.hexes.map((hex) => hex.terrain));
  expect(terrains).toContain('sea');
  expect(terrains).toContain('gold');
  expect(model.hexes.find((hex) => hex.id === 'h:3,0')?.terrain).toBe('sea');
});

test('ships and island bonus tokens come from the board and the render hints', () => {
  const graph = buildBoardGraph(genesis.board.hexes);
  const edge = graph.edgeIds[10];
  const vertex = graph.vertexIds[4];
  if (!edge || !vertex) throw new Error('The board needs edges and vertices');
  const seafaring: unknown = genesis.ext.seafaring;
  if (typeof seafaring !== 'object' || seafaring === null) throw new Error('No seafaring state');
  const state: GameState = {
    ...genesis,
    board: { ...genesis.board, ships: [{ edge, seat: 1 }] },
    ext: {
      ...genesis.ext,
      seafaring: {
        ...seafaring,
        pirateHex: 'h:-4,4',
        bonus: [{ seat: 2, region: 'h:4,-3', vertex }],
      },
    },
  };
  const model = toRenderModel(state, 'spectator');
  expect(model.ships).toEqual([{ edge, seat: 1 }]);
  expect(model.pirateHex).toBe('h:-4,4');
  // The option `islandBonus: { vp: 2 }` of the test config is what each chit is worth.
  expect(model.islandBonuses).toEqual([{ vertex, seat: 2, vp: 2 }]);
});

test('an off-board pirate has no hex', () => {
  const seafaring: unknown = genesis.ext.seafaring;
  if (typeof seafaring !== 'object' || seafaring === null) throw new Error('No seafaring state');
  const state: GameState = {
    ...genesis,
    ext: { ...genesis.ext, seafaring: { ...seafaring, pirateHex: null } },
  };
  expect(toRenderModel(state, 'spectator').pirateHex).toBeNull();
});

test('a game without ships has none of the seafaring keys', () => {
  const base = createBaseEngine().createGame(
    { modules: [{ id: 'base', version: '1.0.0' }], seats: [0, 1], options: {} },
    new Uint8Array(32),
  );
  const model = toRenderModel(base, 'spectator');
  expect(model).not.toHaveProperty('ships');
  expect(model).not.toHaveProperty('pirateHex');
  expect(model).not.toHaveProperty('islandBonuses');
});
