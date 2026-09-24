import { expect, test } from 'vitest';
import { createBaseEngine } from '@cp2p/engine';
import { toRenderModel } from './toRenderModel.js';

const engine = createBaseEngine();
const state = engine.createGame(
  { modules: [{ id: 'base', version: '1.0.0' }], seats: [0, 1], options: {} },
  new Uint8Array(32),
);

test('render model contains board-only public primitives and is viewer independent', () => {
  const seatView = toRenderModel(state, 0);
  const spectatorView = toRenderModel(state, 'spectator');
  expect(seatView).toEqual(spectatorView);
  expect(seatView.hexes).toHaveLength(state.board.hexes.length);
  expect(seatView).toHaveProperty('robberHex', state.board.robberHex);
  expect(Object.keys(seatView).toSorted()).toEqual([
    'buildings',
    'harbors',
    'hexes',
    'roads',
    'robberHex',
  ]);
  expect(JSON.stringify(seatView)).not.toMatch(/hand|slot|hidden|private/i);
  expect(seatView.hexes[0]).toMatchObject({
    id: state.board.hexes[0]?.id,
    terrain: state.board.hexes[0]?.terrain,
  });
});

test('render model contains no mutable engine objects or hidden-state references', () => {
  const model = toRenderModel(state, 'spectator');
  expect(model).not.toBe(state.board);
  expect(model.hexes).not.toBe(state.board.hexes);
  expect(model.hexes[0]).not.toBe(state.board.hexes[0]);
  expect(Object.values(model).some((value) => value instanceof Map || value instanceof Set)).toBe(
    false,
  );
});

function boardSnapshot(model: ReturnType<typeof toRenderModel>) {
  return {
    hexes: model.hexes.map(
      (hex) => `${hex.id}@${hex.q},${hex.r}:${hex.terrain}/${hex.token ?? '-'}`,
    ),
    harbors: model.harbors.map((harbor) => `${harbor.edge}=${harbor.kind}`),
    roads: model.roads,
    buildings: model.buildings,
    robberHex: model.robberHex,
  };
}

test('board DTO snapshots cover genesis, placed pieces, city, and moved robber', () => {
  expect(boardSnapshot(toRenderModel(state, 'spectator'))).toMatchInlineSnapshot(`
    {
      "buildings": [],
      "harbors": [
        "e:-1,-1,NW=brick",
        "e:-2,0,W=wool",
        "e:-2,3,NE=lumber",
        "e:-3,2,NE=generic",
        "e:0,3,NW=ore",
        "e:1,-2,NW=generic",
        "e:2,-2,NE=generic",
        "e:2,1,W=grain",
        "e:3,-1,W=generic",
      ],
      "hexes": [
        "h:-1,-1@-1,-1:mountains/10",
        "h:-1,0@-1,0:mountains/11",
        "h:-1,1@-1,1:desert/-",
        "h:-1,2@-1,2:fields/9",
        "h:-2,0@-2,0:forest/8",
        "h:-2,1@-2,1:fields/5",
        "h:-2,2@-2,2:forest/10",
        "h:0,-1@0,-1:hills/9",
        "h:0,-2@0,-2:pasture/6",
        "h:0,0@0,0:fields/6",
        "h:0,1@0,1:hills/11",
        "h:0,2@0,2:hills/4",
        "h:1,-1@1,-1:forest/3",
        "h:1,-2@1,-2:pasture/12",
        "h:1,0@1,0:mountains/4",
        "h:1,1@1,1:pasture/3",
        "h:2,-1@2,-1:fields/2",
        "h:2,-2@2,-2:pasture/8",
        "h:2,0@2,0:forest/5",
      ],
      "roads": [],
      "robberHex": "h:-1,1",
    }
  `);

  const started = engine.apply(state, { kind: 'system', type: 'START_SEAT', seat: 0 });
  if (!started.ok) throw new Error(started.error.message);
  const settlement = engine
    .getLegalCommands(started.value.state, 0)
    .commands.find((command) => command.type === 'PLACE_SETTLEMENT');
  if (!settlement || typeof settlement.vertex !== 'string') throw new Error('No setup settlement');
  const settled = engine.apply(started.value.state, {
    kind: 'command',
    seat: 0,
    command: settlement,
  });
  if (!settled.ok) throw new Error(settled.error.message);
  const road = engine
    .getLegalCommands(settled.value.state, 0)
    .commands.find((command) => command.type === 'PLACE_ROAD');
  if (!road || typeof road.edge !== 'string') throw new Error('No setup road');
  const placed = engine.apply(settled.value.state, {
    kind: 'command',
    seat: 0,
    command: road,
  });
  if (!placed.ok) throw new Error(placed.error.message);
  expect(boardSnapshot(toRenderModel(placed.value.state, 0))).toMatchInlineSnapshot(`
    {
      "buildings": [
        {
          "kind": "settlement",
          "seat": 0,
          "vertex": "v:-1,-1,N",
        },
      ],
      "harbors": [
        "e:-1,-1,NW=brick",
        "e:-2,0,W=wool",
        "e:-2,3,NE=lumber",
        "e:-3,2,NE=generic",
        "e:0,3,NW=ore",
        "e:1,-2,NW=generic",
        "e:2,-2,NE=generic",
        "e:2,1,W=grain",
        "e:3,-1,W=generic",
      ],
      "hexes": [
        "h:-1,-1@-1,-1:mountains/10",
        "h:-1,0@-1,0:mountains/11",
        "h:-1,1@-1,1:desert/-",
        "h:-1,2@-1,2:fields/9",
        "h:-2,0@-2,0:forest/8",
        "h:-2,1@-2,1:fields/5",
        "h:-2,2@-2,2:forest/10",
        "h:0,-1@0,-1:hills/9",
        "h:0,-2@0,-2:pasture/6",
        "h:0,0@0,0:fields/6",
        "h:0,1@0,1:hills/11",
        "h:0,2@0,2:hills/4",
        "h:1,-1@1,-1:forest/3",
        "h:1,-2@1,-2:pasture/12",
        "h:1,0@1,0:mountains/4",
        "h:1,1@1,1:pasture/3",
        "h:2,-1@2,-1:fields/2",
        "h:2,-2@2,-2:pasture/8",
        "h:2,0@2,0:forest/5",
      ],
      "roads": [
        {
          "edge": "e:-1,-1,NE",
          "seat": 0,
        },
      ],
      "robberHex": "h:-1,1",
    }
  `);

  // These are board presentation fixtures: city upgrade and robber movement have
  // separate turn/resource rules, while this adapter reads only public board data.
  const destination = placed.value.state.board.hexes.find(
    (hex) => hex.id !== placed.value.state.board.robberHex,
  )?.id;
  if (!destination) throw new Error('No robber destination');
  const cityAndRobber = {
    ...placed.value.state,
    board: {
      ...placed.value.state.board,
      buildings: placed.value.state.board.buildings.map((building) => ({
        ...building,
        kind: 'city',
      })),
      robberHex: destination,
    },
  };
  expect(boardSnapshot(toRenderModel(cityAndRobber, 'spectator'))).toMatchInlineSnapshot(`
    {
      "buildings": [
        {
          "kind": "city",
          "seat": 0,
          "vertex": "v:-1,-1,N",
        },
      ],
      "harbors": [
        "e:-1,-1,NW=brick",
        "e:-2,0,W=wool",
        "e:-2,3,NE=lumber",
        "e:-3,2,NE=generic",
        "e:0,3,NW=ore",
        "e:1,-2,NW=generic",
        "e:2,-2,NE=generic",
        "e:2,1,W=grain",
        "e:3,-1,W=generic",
      ],
      "hexes": [
        "h:-1,-1@-1,-1:mountains/10",
        "h:-1,0@-1,0:mountains/11",
        "h:-1,1@-1,1:desert/-",
        "h:-1,2@-1,2:fields/9",
        "h:-2,0@-2,0:forest/8",
        "h:-2,1@-2,1:fields/5",
        "h:-2,2@-2,2:forest/10",
        "h:0,-1@0,-1:hills/9",
        "h:0,-2@0,-2:pasture/6",
        "h:0,0@0,0:fields/6",
        "h:0,1@0,1:hills/11",
        "h:0,2@0,2:hills/4",
        "h:1,-1@1,-1:forest/3",
        "h:1,-2@1,-2:pasture/12",
        "h:1,0@1,0:mountains/4",
        "h:1,1@1,1:pasture/3",
        "h:2,-1@2,-1:fields/2",
        "h:2,-2@2,-2:pasture/8",
        "h:2,0@2,0:forest/5",
      ],
      "roads": [
        {
          "edge": "e:-1,-1,NE",
          "seat": 0,
        },
      ],
      "robberHex": "h:-1,-1",
    }
  `);
  expect(toRenderModel({ ...cityAndRobber, seats: [], ext: {} }, 0)).toEqual(
    toRenderModel(cityAndRobber, 'spectator'),
  );
});
