import { describe, expect, test } from 'vitest';
import type { GameState } from '../../core/state/index.js';
import { knightAt } from '../knights/pieces.js';
import { isOpenShip } from '../knights/progress/diplomat.js';
import { play, refusal, withCards } from '../knights/progress/testing.js';
import { seafaringExt } from '../seafaring/types.js';
import {
  COAST,
  FAR,
  FIELDS,
  GOLD,
  HOME,
  R1,
  S1,
  S2,
  S3,
  SEA,
  SHORE,
  afterFirstAttack,
  edgeBetween,
  engine,
  inMain,
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

function fleet(ships: readonly string[] = [S1, S2, S3]): GameState {
  const state = withBuildings(newGame(), [{ vertex: HOME, seat: 0 }]);
  return inMain(withShips(state, 0, ships));
}

const shipsOf = (state: GameState, seat: number) =>
  (state.board.ships ?? []).filter((ship) => ship.seat === seat).map((ship) => ship.edge);
const piecesLeft = (state: GameState, seat: number, kind: string) =>
  state.seats.find((item) => item.seat === seat)?.piecesLeft[kind];

describe('Road Building', () => {
  test('two free pieces: a ship and a road, one after another', () => {
    const state = withCards(fleet([S1]), 0, 'roadBuilding');
    const started = play(state, 0, 'roadBuilding', undefined, engine);
    expect(top(started)).toMatchObject({ id: 'roadBuilding', module: 'base' });
    expect(legal(started, 0, 'PLACE_FREE_SHIP').map((command) => command.edge)).toContain(S2);
    expect(legal(started, 0, 'PLACE_FREE_ROAD').map((command) => command.edge)).toContain(R1);
    const shipped = submit(started, 0, { type: 'PLACE_FREE_SHIP', edge: S2 });
    const done = submit(shipped, 0, { type: 'PLACE_FREE_ROAD', edge: R1 });
    expect(shipsOf(done, 0)).toEqual([S1, S2]);
    expect(done.board.roads).toContainEqual({ edge: R1, seat: 0 });
    expect(top(done)?.id).toBe('main');
    expect(engine.checkInvariants(done)).toEqual([]);
  });

  test('the card is playable when only a ship can be placed', () => {
    const state = withCards(fleet([S1]), 0, 'roadBuilding');
    const noRoads = {
      ...state,
      seats: state.seats.map((seat) =>
        seat.seat === 0 ? { ...seat, piecesLeft: { ...seat.piecesLeft, road: 0 } } : seat,
      ),
    };
    expect(refusal(noRoads, 0, 'roadBuilding', undefined, engine)).toBeNull();
  });
});

/** Seat 1 has a settlement on the hills' coast and one ship out to SEA, with a free end. */
function rivals(): GameState {
  let state = withBuildings(fleet([S1, S2]), [{ vertex: 'v:3,-1,S', seat: 1 }]);
  state = withShips(state, 1, [edgeBetween(state, 'v:3,-1,S', SEA)]);
  return withCards(state, 0, 'diplomat');
}

describe('Diplomat', () => {
  const theirs = 'e:3,0,NW';

  test('removes another seat’s open ship, which returns to its supply', () => {
    const state = rivals();
    expect(isOpenShip(state, theirs)).toBe(true);
    const after = play(state, 0, 'diplomat', { edge: theirs, build: null }, engine);
    expect(shipsOf(after, 1)).toEqual([]);
    expect(piecesLeft(after, 1, 'ship')).toBe((piecesLeft(state, 1, 'ship') ?? 0) + 1);
    expect(refusal(state, 0, 'diplomat', { edge: theirs, build: S3 }, engine)).toBe('not-own-road');
  });

  test('removing an own ship allows one free ship elsewhere, and never a road', () => {
    const base = withRoads(rivals(), 0, [R1]);
    const land = edgeBetween(base, SHORE, 'v:2,-1,S');
    const elsewhere = edgeBetween(base, COAST, 'v:4,-3,S');
    const after = play(base, 0, 'diplomat', { edge: S2, build: elsewhere }, engine);
    expect(shipsOf(after, 0)).toEqual([S1, elsewhere]);
    expect(piecesLeft(after, 0, 'ship')).toBe(piecesLeft(base, 0, 'ship'));
    expect(refusal(base, 0, 'diplomat', { edge: S2, build: land }, engine)).toBe('illegal-road');
    expect(refusal(base, 0, 'diplomat', { edge: S2, build: S2 }, engine)).toBe('illegal-road');
  });

  test('a ship leading to a knight is closed and cannot be removed', () => {
    const state = withKnights(withCards(fleet(), 0, 'diplomat'), [{ seat: 0, vertex: SEA }]);
    expect(isOpenShip(state, S3)).toBe(false);
    expect(refusal(state, 0, 'diplomat', { edge: S3, build: null }, engine)).toBe('not-open');
  });

  test('the Diplomat ignores the pirate and a ship built this turn', () => {
    const state = afterFirstAttack(withCards(fleet(), 0, 'diplomat'), 'h:4,-1');
    // S3 is a side of the pirate's hex, so it cannot move, but it can be removed.
    expect(legal(state, 0, 'MOVE_SHIP')).toEqual([]);
    const after = play(state, 0, 'diplomat', { edge: S3, build: null }, engine);
    expect(shipsOf(after, 0)).toEqual([S1, S2]);
  });
});

describe('Diplomat and ships built this turn', () => {
  test('an own ship built this turn and removed is forgotten, so invariants hold', () => {
    const state = withCards(fleet([S1, S2]), 0, 'diplomat');
    const rich = withHand(state, 0, { lumber: 1, wool: 1 });
    const built = submit(rich, 0, { type: 'BUILD_SHIP', edge: S3 });
    expect(seafaringExt(built).builtThisTurn).toEqual([S3]);
    const after = play(built, 0, 'diplomat', { edge: S3, build: null }, engine);
    expect(seafaringExt(after).builtThisTurn).toEqual([]);
    expect(engine.checkInvariants(after)).toEqual([]);
  });
});

describe('Intrigue and Deserter', () => {
  test('Intrigue displaces a knight standing where one of the player’s ships ends', () => {
    let state = withKnights(fleet([S1, S2]), [{ seat: 1, vertex: FAR }]);
    state = withCards(state, 0, 'intrigue');
    const played = play(state, 0, 'intrigue', { vertex: FAR }, engine);
    expect(knightAt(played, FAR)).toBeUndefined();
  });

  test('the Deserter’s knight goes on land where a road or ship ends, never at sea', () => {
    let state = withKnights(fleet(), [{ seat: 1, vertex: 'v:2,-1,S' }]);
    state = withCards(state, 0, 'deserter');
    const played = play(state, 0, 'deserter', { target: 1 }, engine);
    const removed = submit(played, 1, { type: 'DESERTER_REMOVE', vertex: 'v:2,-1,S' });
    const sites = legal(removed, 0, 'DESERTER_PLACE').map((command) => command.vertex);
    expect(new Set(sites)).toEqual(new Set([COAST, FAR]));
    expect(rejection(removed, 0, { type: 'DESERTER_PLACE', vertex: SEA, level: 1 })).not.toBeNull();
    const placed = submit(removed, 0, { type: 'DESERTER_PLACE', vertex: COAST, level: 1 });
    expect(knightAt(placed, COAST)).toMatchObject({ seat: 0 });
  });
});

/** Seat 0 has a settlement touching the fields island and its gold hex. */
function island(): GameState {
  return inMain(withBuildings(newGame(), [{ vertex: 'v:4,-2,N', seat: 0 }]));
}

describe('Merchant, Inventor and Bishop', () => {
  test('the merchant never stands on a gold hex', () => {
    const state = withCards(island(), 0, 'merchant');
    expect(refusal(state, 0, 'merchant', { hex: GOLD }, engine)).not.toBeNull();
    expect(refusal(state, 0, 'merchant', { hex: FIELDS }, engine)).toBeNull();
  });

  test('the Inventor may swap a gold hex’s number token', () => {
    const base = island();
    const state = withCards(
      {
        ...base,
        board: {
          ...base.board,
          hexes: base.board.hexes.map((hex) => (hex.id === GOLD ? { ...hex, token: 5 } : hex)),
        },
      },
      0,
      'inventor',
    );
    const after = play(state, 0, 'inventor', { hexes: [GOLD, FIELDS] }, engine);
    const token = (id: string) => after.board.hexes.find((hex) => hex.id === id)?.token;
    expect([token(GOLD), token(FIELDS)]).toEqual([9, 5]);
  });

  test('the Bishop moves the robber only: a sea hex is refused', () => {
    const state = withCards(afterFirstAttack(fleet()), 0, 'bishop');
    expect(refusal(state, 0, 'bishop', { hex: 'h:3,-1' }, engine)).toBe('illegal-robber-hex');
    expect(refusal(state, 0, 'bishop', { hex: FIELDS }, engine)).toBeNull();
  });
});
