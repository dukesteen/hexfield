import { expect, test } from 'vitest';
import { createBaseEngine, knightsConfig, knightsEngine, knightsExt } from '@cp2p/engine';
import type { GameState, KnightsExt } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { toRenderModel } from './toRenderModel.js';

const genesis = knightsEngine().createGame(knightsConfig({ seats: 3 }), new Uint8Array(32).fill(3));
const graph = buildBoardGraph(genesis.board.hexes);
const [a = '', b = '', c = ''] = graph.vertexIds;

function withExt(patch: Partial<KnightsExt>, buildings: GameState['board']['buildings'] = []) {
  const state: GameState = {
    ...genesis,
    board: { ...genesis.board, buildings },
    ext: { ...genesis.ext, knights: { ...knightsExt(genesis), ...patch } },
  };
  return toRenderModel(state, 'spectator');
}

test('a knights model carries the slice and the base keys, with the barbarian ship on its track', () => {
  const model = toRenderModel(genesis, 'spectator');
  expect(model.knights).toEqual({
    pieces: [],
    merchant: null,
    sideways: [],
    barbarians: { fixture: 'barbarian-track', step: 0, steps: 7 },
  });
  expect(model.fixtures?.map((fixture) => fixture.id)).toEqual(['barbarian-track']);
});

test('a base model has no knights slice at all', () => {
  const base = createBaseEngine().createGame(
    { modules: [{ id: 'base', version: '1.0.0' }], seats: [0, 1], options: {} },
    new Uint8Array(32),
  );
  expect(toRenderModel(base, 'spectator')).not.toHaveProperty('knights');
});

test('knights become pieces with a level of one to three and their state', () => {
  const model = withExt({
    knights: [
      { seat: 0, vertex: a, level: 1, active: false, ready: false, promotedTurn: null },
      { seat: 1, vertex: b, level: 2, active: true, ready: true, promotedTurn: 4 },
      { seat: 2, vertex: c, level: 3, active: true, ready: false, promotedTurn: null },
    ],
  });
  expect(model.knights?.pieces).toEqual([
    { vertex: a, seat: 0, level: 1, active: false, ready: false },
    { vertex: b, seat: 1, level: 2, active: true, ready: true },
    { vertex: c, seat: 2, level: 3, active: true, ready: false },
  ]);
});

test('a knight on a vertex that is not on the board is left out', () => {
  const model = withExt({
    knights: [
      { seat: 0, vertex: 'v:99,99,N', level: 1, active: true, ready: true, promotedTurn: null },
    ],
  });
  expect(model.knights?.pieces).toEqual([]);
});

test('the merchant is a seat on a hex, and a merchant on an unknown hex is dropped', () => {
  const hex = genesis.board.hexes[3]?.id ?? '';
  expect(withExt({ merchant: { seat: 1, hex } }).knights?.merchant).toEqual({ hex, seat: 1 });
  expect(withExt({ merchant: { seat: 1, hex: 'h:99,99' } }).knights?.merchant).toBeNull();
});

test('sideways city pieces are carried by vertex and seat', () => {
  expect(withExt({ sideways: [{ seat: 2, vertex: b }] }).knights?.sideways).toEqual([
    { vertex: b, seat: 2 },
  ]);
});

test('a city shows its wall and its metropolis; a settlement shows neither', () => {
  const model = withExt(
    {
      walls: [
        { seat: 0, vertex: a },
        { seat: 1, vertex: b },
      ],
      metropolises: { trade: null, politics: { seat: 0, vertex: a }, science: null },
    },
    [
      { vertex: a, seat: 0, kind: 'city' },
      { vertex: b, seat: 1, kind: 'city' },
      { vertex: c, seat: 2, kind: 'settlement' },
    ],
  );
  expect(model.buildings).toEqual([
    { vertex: a, seat: 0, kind: 'city', wall: true, metropolis: 'politics' },
    { vertex: b, seat: 1, kind: 'city', wall: true },
    { vertex: c, seat: 2, kind: 'settlement' },
  ]);
});

test('the barbarian step is the ship position, and the model holds no engine objects', () => {
  const model = withExt({ barbarians: { step: 5 } });
  expect(model.knights?.barbarians).toEqual({ fixture: 'barbarian-track', step: 5, steps: 7 });
  expect(model.knights).not.toBe(knightsExt(genesis));
  expect(JSON.stringify(model)).not.toMatch(/hand|slot|hidden|private|bottom/i);
});
