import { describe, expect, test } from 'vitest';
import { BASE_COSTS } from '../base/constants.js';
import { checkModuleSelection, moduleSelection } from '../catalogue.js';
import { createBaseEngine } from '../base/index.js';
import { boardGraph } from '../base/board/index.js';
import { PIECES_START } from '../base/constants.js';
import { canPlaceShip, legalShipEdges, seafaringExt } from './index.js';
import {
  ARCHIPELAGO_MAIN,
  explicitBoard,
  seafaringConfig,
  seafaringEngine,
  testArchipelago,
} from './testing.js';
import {
  edgeId,
  edgesAt,
  edgesOfHex,
  inMain,
  newGame,
  otherEnd,
  rejection,
  submit,
  vertexId,
  withBuildings,
  withHand,
  withRoads,
} from './support.js';

const engine = seafaringEngine();
/** A vertex on the east coast of the main island, with one land hex and two sea hexes. */
const V0 = vertexId({ q: 2, r: -1 }, 'NE');
/** The next coastal vertex along the coast, joined to V0 by a coastal edge. */
const X = vertexId({ q: 2, r: -1 }, 'N');
const COAST_EDGE = edgeId({ q: 2, r: -1 }, 'NE');

const reject = (config: ReturnType<typeof seafaringConfig>, pattern: RegExp) =>
  expect(() => engine.createGame(config, new Uint8Array(32))).toThrow(pattern);

const start = () =>
  withHand(inMain(withBuildings(newGame(engine), [{ vertex: V0, seat: 0 }])), 0, {
    lumber: 2,
    wool: 2,
  });

describe('genesis', () => {
  test('a seafaring game starts with an empty ships list, ship supply and pirate', () => {
    const state = newGame(engine);
    expect(state.board.ships).toEqual([]);
    expect(state.seats.every((seat) => seat.piecesLeft.ship === 15)).toBe(true);
    expect(seafaringExt(state)).toEqual({
      pirateHex: 'h:3,0',
      builtThisTurn: [],
      shipMovedTurn: null,
      homeRegions: [[], [], []],
      bonus: [],
    });
    expect(state.board.hexes.find((hex) => hex.id === state.board.robberHex)?.terrain).toBe(
      'desert',
    );
    expect(engine.checkInvariants(state)).toEqual([]);
    expect(engine.hooks.costs(state.config, BASE_COSTS).ship).toEqual({ lumber: 1, wool: 1 });
    expect(engine.hooks.pieceLimits(state.config, PIECES_START).ship).toBe(15);
  });
  test('a base game has no ship list, no seafaring state and the same piece limits', () => {
    const base = createBaseEngine();
    const state = base.createGame(
      {
        modules: moduleSelection(['base']),
        seats: [0, 1, 2],
        options: { base: { mapLayout: 'random' } },
      },
      new Uint8Array(32),
    );
    expect('ships' in state.board).toBe(false);
    expect(Object.keys(state.ext)).toEqual(['base']);
    expect(state.seats[0]?.piecesLeft).toEqual({ settlement: 5, city: 4, road: 15 });
  });
  test('the catalogue accepts seafaring alone and with five-six', () => {
    expect(checkModuleSelection(moduleSelection(['base', 'seafaring'])).ok).toBe(true);
    expect(checkModuleSelection(moduleSelection(['base', 'five-six', 'seafaring'])).ok).toBe(true);
  });
  test('genesis rejects a missing board, fog, fog with a bonus, a land pirate and unknown hexes', () => {
    const missing = { ...seafaringConfig() };
    delete missing.board;
    expect(() => engine.createGame(missing, new Uint8Array(32))).toThrow(/config.board/);
    const fogged = testArchipelago();
    fogged.hexes = fogged.hexes.map((hex) =>
      hex.id === 'h:3,1' ? { ...hex, terrain: 'fog', token: null } : hex,
    );
    reject(seafaringConfig({ board: fogged }), /fog with the island bonus/);
    reject(seafaringConfig({ board: fogged, seafaring: { islandBonus: null } }), /fog reveals/);
    reject(
      seafaringConfig({
        seafaring: { fog: { terrains: { sea: 1 }, tokens: {} }, islandBonus: null },
      }),
      /fog reveals/,
    );
    reject(
      seafaringConfig({ seafaring: { pirateHex: 'h:0,0' } }),
      /pirate must start on a sea hex/,
    );
    reject(seafaringConfig({ seafaring: { setupAreas: ['h:9,9'] } }), /Unknown hex/);
    reject(seafaringConfig({ seafaring: { bonusRegions: [['h:9,9']] } }), /Unknown hex/);
  });
  test('the fixed board is validated: tokens follow terrain and the robber stands on land', () => {
    const board = testArchipelago();
    const bad = { ...board, robberHex: 'h:3,0' };
    expect(() => engine.createGame(seafaringConfig({ board: bad }), new Uint8Array(32))).toThrow(
      /robber/,
    );
    const offBoard = engine.createGame(
      seafaringConfig({ board: { ...board, robberHex: null } }),
      new Uint8Array(32),
    );
    expect(offBoard.board.robberHex).toBeNull();
    expect(engine.checkInvariants(offBoard)).toEqual([]);
  });
  test('a small explicit board works', () => {
    const tiny = explicitBoard(
      [
        [0, 0, 'forest', 5],
        [1, 0, 'sea'],
        [2, 0, 'gold', 6],
      ],
      'h:0,0',
    );
    const state = engine.createGame(
      seafaringConfig({
        board: tiny,
        seats: 2,
        seafaring: { pirateHex: 'h:1,0', setupAreas: null },
      }),
      new Uint8Array(32),
    );
    expect(state.board.hexes.map((hex) => hex.terrain)).toEqual(['forest', 'sea', 'gold']);
  });
});

describe('ships: building and connecting', () => {
  test('a ship connects to an own settlement and lists only sea-side edges next to it', () => {
    const state = start();
    const legal = legalShipEdges(state, 0);
    const incident = edgesAt(state, V0);
    expect(legal.length).toBeGreaterThan(0);
    expect(legal.every((edge) => incident.includes(edge))).toBe(true);
    expect(legal).toContain(COAST_EDGE);
    for (const edge of legal)
      expect(rejection(engine, state, 0, { type: 'BUILD_SHIP', edge })).toBeNull();
    expect(legalShipEdges(state, 1)).toEqual([]);
  });
  test('BUILD_SHIP costs 1 lumber and 1 wool, uses supply, and counts as built this turn', () => {
    const state = submit(engine, start(), 0, { type: 'BUILD_SHIP', edge: COAST_EDGE });
    expect(state.board.ships).toEqual([{ edge: COAST_EDGE, seat: 0 }]);
    expect(state.seats[0]?.resources.total).toBe(2);
    expect(state.seats[0]?.piecesLeft.ship).toBe(14);
    expect(state.bank.lumber).toBe(18);
    expect(seafaringExt(state).builtThisTurn).toEqual([COAST_EDGE]);
    expect(engine.checkInvariants(state)).toEqual([]);
  });
  test('a ship needs the cards, the supply and a legal edge', () => {
    const state = start();
    expect(
      rejection(engine, withHand(state, 0, { lumber: 1 }), 0, {
        type: 'BUILD_SHIP',
        edge: COAST_EDGE,
      }),
    ).toBe('insufficient-resources');
    const empty = {
      ...state,
      seats: state.seats.map((seat) =>
        seat.seat === 0 ? { ...seat, piecesLeft: { ...seat.piecesLeft, ship: 0 } } : seat,
      ),
    };
    expect(rejection(engine, empty, 0, { type: 'BUILD_SHIP', edge: COAST_EDGE })).toBe('no-ships');
    expect(rejection(engine, state, 0, { type: 'BUILD_SHIP', edge: 'e:9,9,W' })).toBe(
      'illegal-ship',
    );
    expect(rejection(engine, state, 0, { type: 'BUILD_SHIP' })).toBe('invalid-edge');
    expect(rejection(engine, state, 0, { type: 'BUILD_SHIP', edge: COAST_EDGE, extra: 1 })).toBe(
      'unknown-field',
    );
  });
  test('ships need the main phase, and only the active seat may build', () => {
    const state = start();
    expect(rejection(engine, state, 1, { type: 'BUILD_SHIP', edge: COAST_EDGE })).toBe(
      'not-pending',
    );
    const preRoll = {
      ...state,
      turn: { ...state.turn, phase: [{ id: 'preRoll', module: 'base', data: null }] },
    };
    expect(rejection(engine, preRoll, 0, { type: 'BUILD_SHIP', edge: COAST_EDGE })).toBe(
      'not-pending',
    );
    expect(
      rejection(engine, preRoll, 0, { type: 'MOVE_SHIP', from: COAST_EDGE, to: COAST_EDGE }),
    ).toBe('not-pending');
  });
  test('a ship never goes on a land edge, and a road cannot use a ship edge', () => {
    const state = start();
    const graph = boardGraph(state);
    const landEdge = graph.edgeIds.find((edge) => {
      const owners = graph.edgeHexes[graph.edgeIndex[edge] ?? -1] ?? [];
      return owners.length === 2 && owners.every((owner) => ARCHIPELAGO_MAIN.includes(owner));
    });
    expect(landEdge).toBeDefined();
    expect(canPlaceShip(state, 0, landEdge ?? '')).toBe(false);
    const withShip = submit(engine, state, 0, { type: 'BUILD_SHIP', edge: COAST_EDGE });
    const road = { type: 'BUILD_ROAD', edge: COAST_EDGE };
    expect(rejection(engine, withHand(withShip, 0, { brick: 1, lumber: 1 }), 0, road)).toBe(
      'illegal-road',
    );
  });
  test('an own road does not connect a ship, but it does connect at an own settlement', () => {
    const roaded = withRoads(start(), 0, [COAST_EDGE]);
    const atV0 = new Set(edgesAt(roaded, V0));
    const atX = edgesAt(roaded, X).filter((edge) => !atV0.has(edge));
    const legal = legalShipEdges(roaded, 0);
    expect(atX.length).toBeGreaterThan(0);
    // Ships at X, the far end of the road, would need the road to connect them.
    expect(legal.some((edge) => atX.includes(edge))).toBe(false);
    expect(legal.length).toBeGreaterThan(0);
  });
  test('a ship connects to an own ship, but not through an opponent building', () => {
    let state = submit(engine, start(), 0, { type: 'BUILD_SHIP', edge: COAST_EDGE });
    const far = otherEnd(state, COAST_EDGE, V0);
    const atFar = new Set(edgesAt(state, far).filter((edge) => edge !== COAST_EDGE));
    expect(legalShipEdges(state, 0).some((edge) => atFar.has(edge))).toBe(true);
    state = withBuildings(state, [{ vertex: far, seat: 1 }]);
    expect(legalShipEdges(state, 0).some((edge) => atFar.has(edge))).toBe(false);
    // The opponent may still build its own ships there.
    expect(legalShipEdges(state, 1).length).toBeGreaterThan(0);
  });
  test('the pirate blocks ships on its hex edges, including a starting hex', () => {
    const state = start();
    const pirateEdges = edgesOfHex(state, 'h:3,0');
    for (const edge of pirateEdges) expect(canPlaceShip(state, 0, edge)).toBe(false);
    // A settlement on a vertex of the pirate's hex may still not launch a ship along that hex.
    const graph = boardGraph(state);
    const vertex = graph.hexVertices[graph.hexIndex['h:2,0'] ?? -1]?.find((candidate) =>
      (graph.vertexHexes[graph.vertexIndex[candidate] ?? -1] ?? []).includes('h:3,0'),
    );
    const near = withBuildings(state, [{ vertex: vertex ?? V0, seat: 1 }]);
    const legal = legalShipEdges(near, 1);
    expect(legal.length).toBeGreaterThan(0);
    expect(legal.every((edge) => !pirateEdges.includes(edge))).toBe(true);
  });
});
