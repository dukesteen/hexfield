import { describe, expect, test } from 'vitest';
import type { GameState } from '../../core/state/index.js';
import { longestRoadLength } from '../base/awards/index.js';
import { strandsKnight } from '../knights/pieces.js';
import { legalShipMoves, movableShips, shipContext } from '../seafaring/ships.js';
import {
  COAST,
  FAR,
  HOME,
  S1,
  S2,
  S3,
  SEA,
  edgeBetween,
  engine,
  inMain,
  legal,
  newGame,
  rejection,
  submit,
  withBuildings,
  withKnights,
  withShips,
} from './support.js';

const ctx = { hooks: engine.hooks };

function fleet(ships: readonly string[] = [S1, S2, S3]): GameState {
  const state = withBuildings(newGame(), [{ vertex: HOME, seat: 0 }]);
  return inMain(withShips(state, 0, ships));
}

const movable = (state: GameState) => movableShips(state, 0, shipContext(state, 0, ctx));

describe('knights close shipping routes', () => {
  test('without a knight the ship at the open end may move', () => {
    const state = fleet();
    expect(movable(state)).toEqual([S3]);
    expect(legal(state, 0, 'MOVE_SHIP').every((command) => command.from === S3)).toBe(true);
  });

  test('a route joining the settlement and an own knight is closed, so no ship of it moves', () => {
    const state = withKnights(fleet(), [{ seat: 0, vertex: SEA }]);
    expect(movable(state)).toEqual([]);
    expect(legal(state, 0, 'MOVE_SHIP')).toEqual([]);
    const to = edgeBetween(state, SEA, 'v:4,-1,S');
    expect(rejection(state, 0, { type: 'MOVE_SHIP', from: S3, to })).toBe('ship-cannot-move');
  });

  test('a knight in the middle splits the route, and the part beyond it stays open', () => {
    const state = withKnights(fleet(), [{ seat: 0, vertex: FAR }]);
    // HOME–FAR is closed by the settlement and the knight; FAR–SEA has one anchor and a free end.
    expect(movable(state)).toEqual([S3]);
    // Moving it never cuts the knight off: the knight's link to HOME is the closed part.
    expect(strandsKnight(state, 0, S3)).toBe(false);
    const moves = legalShipMoves(state, 0, ctx);
    expect(moves.length).toBeGreaterThan(0);
    const moved = submit(state, 0, { type: 'MOVE_SHIP', ...moves[0] });
    expect(engine.checkInvariants(moved)).toEqual([]);
  });

  test('no legal ship move ever strands a knight', () => {
    for (const vertex of [COAST, FAR, SEA]) {
      const state = withKnights(fleet(), [{ seat: 0, vertex }]);
      for (const { from } of legalShipMoves(state, 0, ctx))
        expect({ vertex, from, strands: strandsKnight(state, 0, from) }).toEqual({
          vertex,
          from,
          strands: false,
        });
    }
  });
});

describe('another seat’s knight stops ships', () => {
  test('a new ship does not connect through a vertex holding another seat’s knight', () => {
    const state = withKnights(fleet([S1, S2]), [{ seat: 1, vertex: FAR }]);
    const beyond = [S3, edgeBetween(state, FAR, 'v:4,-1,N')];
    for (const edge of beyond)
      expect(rejection(state, 0, { type: 'BUILD_SHIP', edge })).toBe('illegal-ship');
    // Without the knight the same edges are legal again.
    const clear = fleet([S1, S2]);
    expect(rejection(clear, 0, { type: 'BUILD_SHIP', edge: S3 })).not.toBe('illegal-ship');
  });

  test('another seat’s knight breaks the longest trade route; an own knight does not', () => {
    const state = fleet();
    expect(longestRoadLength(state, 0, ctx)).toBe(3);
    expect(longestRoadLength(withKnights(state, [{ seat: 0, vertex: FAR }]), 0, ctx)).toBe(3);
    expect(longestRoadLength(withKnights(state, [{ seat: 1, vertex: FAR }]), 0, ctx)).toBe(2);
    expect(longestRoadLength(withKnights(state, [{ seat: 1, vertex: SEA }]), 0, ctx)).toBe(3);
    expect(
      longestRoadLength(withKnights(state, [{ seat: 1, vertex: COAST }]), 0, ctx),
    ).toBeLessThan(3);
  });
});
