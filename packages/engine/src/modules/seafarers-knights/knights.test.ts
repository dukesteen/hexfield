import { describe, expect, test } from 'vitest';
import type { GameState } from '../../core/state/index.js';
import { hexesForVertex, vertexOnLand } from '../base/board/index.js';
import { recruitSites } from '../knights/pieces.js';
import { knightsExt } from '../knights/types.js';
import {
  COAST,
  FAR,
  HOME,
  R1,
  S1,
  S2,
  S3,
  SEA,
  SHORE,
  edgeBetween,
  engine,
  handOf,
  inMain,
  isSeaVertex,
  legal,
  newGame,
  rejection,
  submit,
  top,
  withBuildings,
  withHand,
  withKnights,
  withRoads,
  withShips,
} from './support.js';

/** Seat 0: the settlement at HOME and the three ships out to the sea vertex. */
function fleet(ships: readonly string[] = [S1, S2, S3]): GameState {
  const state = withBuildings(newGame(), [{ vertex: HOME, seat: 0 }]);
  return inMain(withShips(state, 0, ships));
}

const knightsOf = (state: GameState) => knightsExt(state).knights;

describe('the test position', () => {
  test('the ship chain runs from the coast over two island corners to open water', () => {
    const state = fleet();
    expect(vertexOnLand(state, COAST)).toBe(true);
    expect(vertexOnLand(state, FAR)).toBe(true);
    expect(isSeaVertex(state, SEA)).toBe(true);
    expect(engine.checkInvariants(state)).toEqual([]);
  });
});

describe('recruiting next to ships', () => {
  test('a knight is recruited on a land vertex where only a ship ends', () => {
    const state = withHand(fleet(), 0, { wool: 1, ore: 1 });
    expect(recruitSites(state, 0)).toEqual([COAST, FAR].toSorted());
    const built = submit(state, 0, { type: 'BUILD_KNIGHT', vertex: COAST });
    expect(knightsOf(built)).toMatchObject([{ seat: 0, vertex: COAST, level: 1 }]);
    expect(handOf(built, 0)).toMatchObject({ wool: 0, ore: 0 });
    expect(engine.checkInvariants(built)).toEqual([]);
  });

  test('never on a sea vertex, even at the end of a ship', () => {
    const state = withHand(fleet(), 0, { wool: 1, ore: 1 });
    expect(rejection(state, 0, { type: 'BUILD_KNIGHT', vertex: SEA })).not.toBeNull();
    expect(legal(state, 0, 'BUILD_KNIGHT').map((command) => command.vertex)).not.toContain(SEA);
  });
});

describe('knights on the water', () => {
  test('a knight moves along ships to a sea vertex and to another island', () => {
    const state = withKnights(fleet(), [{ seat: 0, vertex: COAST }]);
    const targets = legal(state, 0, 'MOVE_KNIGHT').map((command) => command.to);
    expect(targets).toEqual(expect.arrayContaining([FAR, SEA]));
    const moved = submit(state, 0, { type: 'MOVE_KNIGHT', from: COAST, to: SEA });
    expect(knightsOf(moved)).toMatchObject([{ vertex: SEA, active: false }]);
    expect(engine.checkInvariants(moved)).toEqual([]);
  });

  test('a road and a ship join only at an own settlement or city, never at an empty vertex', () => {
    // A road from HOME to SHORE, and a ship from SHORE out to sea that no building anchors.
    let state = withRoads(fleet([S1]), 0, [R1]);
    state = withShips(state, 0, [edgeBetween(state, SHORE, 'v:3,-1,S')]);
    // From COAST: along S1 to HOME, then on along the road to SHORE, but not onto the far ship.
    state = withKnights(state, [{ seat: 0, vertex: COAST }]);
    const targets = legal(state, 0, 'MOVE_KNIGHT').map((command) => command.to);
    expect(targets).toContain(SHORE);
    expect(targets).not.toContain('v:3,-1,S');
  });

  test('a knight at sea stops at another seat’s knight, and displaces it only when stronger', () => {
    let state = withKnights(fleet(), [
      { seat: 0, vertex: COAST, level: 2 },
      { seat: 1, vertex: FAR, level: 1 },
    ]);
    // Seat 1 has a settlement and ships of its own that reach FAR from the other side.
    state = withBuildings(state, [{ vertex: 'v:4,-1,N', seat: 1 }]);
    state = withShips(state, 1, [edgeBetween(state, 'v:4,-1,N', FAR)]);
    expect(legal(state, 0, 'MOVE_KNIGHT').map((command) => command.to)).not.toContain(SEA);
    expect(legal(state, 0, 'DISPLACE_KNIGHT')).toEqual([
      { type: 'DISPLACE_KNIGHT', from: COAST, to: FAR },
    ]);
  });
});

/**
 * Seat 1's knight sits at SEA: a ship joins it to seat 1's settlement on the hills' coast, and a
 * second ship leads on to open water.
 */
function duel(): { state: GameState; path: string[] } {
  let state = withKnights(fleet(), [{ seat: 0, vertex: FAR, level: 2 }]);
  state = withBuildings(state, [{ vertex: 'v:3,-1,S', seat: 1 }]);
  const path = [edgeBetween(state, SEA, 'v:4,-1,S'), edgeBetween(state, 'v:3,-1,S', SEA)];
  state = withShips(state, 1, path);
  state = withKnights(state, [{ seat: 1, vertex: SEA, level: 1 }]);
  return { state, path };
}

describe('displacement at sea', () => {
  test('the displaced owner relocates along its own ships', () => {
    const { state } = duel();
    const after = submit(state, 0, { type: 'DISPLACE_KNIGHT', from: FAR, to: SEA });
    expect(top(after)).toMatchObject({ id: 'displaced', module: 'knights', data: { seat: 1 } });
    expect(legal(after, 1, 'RELOCATE_KNIGHT')).toEqual([
      { type: 'RELOCATE_KNIGHT', to: 'v:4,-1,S' },
    ]);
    const placed = submit(after, 1, { type: 'RELOCATE_KNIGHT', to: 'v:4,-1,S' });
    expect(knightsOf(placed)).toMatchObject([
      { seat: 0, vertex: SEA, level: 2 },
      { seat: 1, vertex: 'v:4,-1,S', level: 1 },
    ]);
    expect(engine.checkInvariants(placed)).toEqual([]);
  });

  test('a displaced knight with no empty vertex on its network is lost', () => {
    const { state, path } = duel();
    // Without the onward ship, SEA's only neighbour on seat 1's network is its settlement.
    const lone = {
      ...state,
      board: {
        ...state.board,
        ships: (state.board.ships ?? []).filter((ship) => ship.edge !== path[0]),
      },
    };
    const after = submit(lone, 0, { type: 'DISPLACE_KNIGHT', from: FAR, to: SEA });
    expect(knightsOf(after).filter((knight) => knight.seat === 1)).toEqual([]);
    expect(top(after)?.id).toBe('main');
  });

  test('a knight never stands beside unrevealed fog: the pair checks it as an invariant', () => {
    const placed = withKnights(fleet(), [{ seat: 0, vertex: SEA }]);
    expect(engine.checkInvariants(placed)).toEqual([]);
    // Turn a sea hex at the knight's vertex back into fog, as if nothing had revealed it.
    const [hex] = hexesForVertex(placed, SEA);
    const fogged = {
      ...placed,
      board: {
        ...placed.board,
        hexes: placed.board.hexes.map((item) =>
          item.id === hex ? { ...item, terrain: 'fog', token: null } : item,
        ),
      },
    };
    expect(engine.checkInvariants(fogged)).toContain(
      `knight at ${SEA} stands beside unrevealed fog`,
    );
  });
});
