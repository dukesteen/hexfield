import { describe, expect, test } from 'vitest';
import type { GameState } from '../../core/state/index.js';
import { boardGraph } from '../base/board/index.js';
import { longestRoadLength } from '../base/awards/index.js';
import { seafaringEngine } from './testing.js';
import {
  edgeId,
  edgesAt,
  inMain,
  newGame,
  otherEnd,
  pathVertices,
  seaPath,
  submit,
  vertexId,
  withBuildings,
  withHand,
  withRoads,
  withShips,
} from './support.js';

const engine = seafaringEngine();
const ctx = { hooks: engine.hooks };
const V0 = vertexId({ q: 2, r: -1 }, 'NE');
const X = vertexId({ q: 2, r: -1 }, 'N');
const COAST_EDGE = edgeId({ q: 2, r: -1 }, 'NE');

const length = (state: GameState, seat: 0 | 1 = 0) => longestRoadLength(state, seat, ctx);

/** The road that continues inland from X, and a ship path leaving V0 over open water. */
function pieces(state: GameState, shipCount: number): { road: string; ships: string[] } {
  const graph = boardGraph(state);
  const terrain = new Map(state.board.hexes.map((hex) => [hex.id, hex.terrain]));
  const road = edgesAt(state, X).find((edge) => {
    const owners = graph.edgeHexes[graph.edgeIndex[edge] ?? -1] ?? [];
    return edge !== COAST_EDGE && owners.some((id) => terrain.get(id) !== 'sea');
  });
  const first = edgesAt(state, V0).find((edge) => {
    const owners = graph.edgeHexes[graph.edgeIndex[edge] ?? -1] ?? [];
    return owners.every((id) => terrain.get(id) === 'sea');
  });
  if (!road || !first) throw new Error('Fixture geometry changed');
  const rest =
    shipCount > 1
      ? seaPath(state, otherEnd(state, first, V0), shipCount - 1, {
          keepClear: ['h:3,0'],
          avoid: new Set([first]),
        })
      : [];
  return { road, ships: [first, ...rest] };
}

const base = () => inMain(newGame(engine));

describe('longest trade route', () => {
  test('a road, an own settlement and a ship chain count as one route', () => {
    const start = withBuildings(base(), [{ vertex: V0, seat: 0 }]);
    const { road, ships } = pieces(start, 2);
    const state = withShips(withRoads(start, 0, [COAST_EDGE, road]), 0, ships);
    expect(length(state)).toBe(4);
  });
  test('a road meeting a ship at an empty vertex does not connect', () => {
    const start = base();
    const { road, ships } = pieces(start, 2);
    const state = withShips(withRoads(start, 0, [COAST_EDGE, road]), 0, ships);
    // The pieces touch at V0, which is empty: two separate routes of two.
    expect(length(state)).toBe(2);
    // An opponent's settlement there does not connect them either.
    expect(length(withBuildings(state, [{ vertex: V0, seat: 1 }]))).toBe(2);
    // Nor does a settlement elsewhere on the route.
    expect(length(withBuildings(state, [{ vertex: X, seat: 0 }]))).toBe(2);
  });
  test('a city joins the pieces like a settlement', () => {
    const start = withBuildings(base(), [{ vertex: V0, seat: 0, kind: 'city' }]);
    const { road, ships } = pieces(start, 2);
    expect(length(withShips(withRoads(start, 0, [COAST_EDGE, road]), 0, ships))).toBe(4);
  });
  test('ships alone form a route, and it passes any vertex without an opponent building', () => {
    const start = base();
    const { ships } = pieces(start, 5);
    expect(length(withShips(start, 0, ships))).toBe(5);
  });
  test('an opponent building breaks the route, but a trail may end there', () => {
    const start = withBuildings(base(), [{ vertex: V0, seat: 0 }]);
    const { ships } = pieces(start, 4);
    const state = withShips(withRoads(start, 0, [COAST_EDGE]), 0, ships);
    expect(length(state)).toBe(5);
    const middle = pathVertices(state, V0, ships)[2] ?? '';
    const broken = withBuildings(state, [{ vertex: middle, seat: 1 }]);
    // Road and two ships end at the opponent's settlement: 3. The other two ships: 2.
    expect(length(broken)).toBe(3);
  });
  test('base rules are unchanged for a seat without ships', () => {
    const start = withBuildings(base(), [{ vertex: V0, seat: 0 }]);
    const { road } = pieces(start, 1);
    const state = withRoads(start, 0, [COAST_EDGE, road]);
    expect(length(state)).toBe(2);
    expect(longestRoadLength(state, 0)).toBe(2);
  });
  test('the award goes to the seat whose road-and-ship route reaches five, and is taken on a longer one', () => {
    const start = withHand(
      withBuildings(inMain(newGame(engine, { seats: 2 })), [{ vertex: V0, seat: 0 }]),
      0,
      { lumber: 1, wool: 1 },
    );
    const { ships } = pieces(start, 4);
    let state = withShips(withRoads(start, 0, [COAST_EDGE]), 0, ships.slice(0, 3));
    expect(state.awards.longestRoad).toBeNull();
    state = submit(engine, state, 0, { type: 'BUILD_SHIP', edge: ships[3] });
    expect(state.awards.longestRoad).toBe(0);
    expect(state.seats[0]?.publicVp).toBe(3);
    expect(engine.computeVictoryPoints(state, 0).public).toBe(3);
    expect(engine.checkInvariants(state)).toEqual([]);
  });
  test('the route award survives base checks: roads-only games keep the same result', () => {
    const state = withRoads(base(), 0, [COAST_EDGE]);
    expect(length(state)).toBe(1);
  });
});
