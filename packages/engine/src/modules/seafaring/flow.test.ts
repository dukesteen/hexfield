import { describe, expect, test } from 'vitest';
import type { GameState, PrivateState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { frame } from '../base/shared.js';
import { seafaringExt } from './index.js';
import { seafaringConfig, seafaringEngine } from './testing.js';
import {
  edgeId,
  edgesAt,
  edgesOfHex,
  inMain,
  newGame,
  rejection,
  submit,
  vertexId,
  withBuildings,
  withHand,
  withShips,
} from './support.js';

const engine = seafaringEngine();
const fiveSix = seafaringEngine(true);
const V0 = vertexId({ q: 2, r: -1 }, 'NE');
const COAST_EDGE = edgeId({ q: 2, r: -1 }, 'NE');

function withFrame(state: GameState, ...frames: GameState['turn']['phase']): GameState {
  return { ...state, turn: { number: 5, activeSeat: 0, phase: [...frames] } };
}

const start = (remaining = 2) =>
  withFrame(
    withBuildings(newGame(engine), [{ vertex: V0, seat: 0 }]),
    frame('main'),
    frame('roadBuilding', { remaining }),
  );

const sbpState = (seat: Seat = 1) => {
  let state = newGame(fiveSix, { seats: 5, fiveSix: true });
  state = withBuildings(state, [{ vertex: V0, seat }]);
  return {
    ...state,
    turn: {
      number: 5,
      activeSeat: 0 as Seat,
      phase: [frame('turnEnd'), { id: 'sbp', module: 'five-six', data: { seat } }],
    },
  };
};

const hands = (state: GameState, seat: Seat, hand: Record<string, number>) => {
  const priv = fiveSix.createPrivateState(seat);
  const full: PrivateState = { ...priv, hand: { ...priv.hand, ...hand } };
  return new Map<Seat, PrivateState>(
    state.config.seats.map((item) => [
      item,
      item === seat ? full : fiveSix.createPrivateState(item),
    ]),
  );
};

describe('Road Building with ships', () => {
  test('the two free pieces may be ships, roads, or one of each', () => {
    const state = start();
    const [pending] = engine.getPending(state);
    expect(pending?.kind === 'player' && pending.allowed).toEqual(
      expect.arrayContaining(['PLACE_FREE_ROAD', 'PLACE_FREE_SHIP', 'SKIP']),
    );
    const commands = engine.getLegalCommands(state, 0).commands;
    expect(commands.some((c) => c.type === 'PLACE_FREE_SHIP')).toBe(true);
    expect(commands.some((c) => c.type === 'PLACE_FREE_ROAD')).toBe(true);
    let next = submit(engine, state, 0, { type: 'PLACE_FREE_SHIP', edge: COAST_EDGE });
    expect(next.board.ships).toEqual([{ edge: COAST_EDGE, seat: 0 }]);
    expect(next.turn.phase.at(-1)?.data).toEqual({ remaining: 1 });
    // No cards were paid, and the ship counts as built this turn.
    expect(next.seats[0]?.resources.total).toBe(0);
    expect(seafaringExt(next).builtThisTurn).toEqual([COAST_EDGE]);
    const road = engine
      .getLegalCommands(next, 0)
      .commands.find((c) => c.type === 'PLACE_FREE_ROAD');
    expect(road).toBeDefined();
    next = submit(engine, next, 0, road ?? { type: 'PLACE_FREE_ROAD' });
    expect(next.turn.phase.map((item) => item.id)).toEqual(['main']);
    expect(engine.checkInvariants(next)).toEqual([]);
  });
  test('two free ships end the phase, and a free ship obeys the ship rules', () => {
    let state = start();
    expect(
      rejection(engine, state, 0, { type: 'PLACE_FREE_SHIP', edge: edgeId({ q: 0, r: 0 }, 'W') }),
    ).toBe('illegal-ship');
    const first = edgesAt(state, V0)[0] ?? '';
    state = submit(engine, state, 0, { type: 'PLACE_FREE_SHIP', edge: first });
    const second = engine
      .getLegalCommands(state, 0)
      .commands.find((c) => c.type === 'PLACE_FREE_SHIP');
    state = submit(engine, state, 0, second ?? { type: 'PLACE_FREE_SHIP' });
    expect(state.turn.phase.map((item) => item.id)).toEqual(['main']);
    expect(state.board.ships).toHaveLength(2);
    expect(state.seats[0]?.piecesLeft.ship).toBe(13);
  });
  test('the phase ends when no legal piece is left', () => {
    let state = start();
    state = {
      ...state,
      seats: state.seats.map((seat) =>
        seat.seat === 0 ? { ...seat, piecesLeft: { ...seat.piecesLeft, ship: 1, road: 0 } } : seat,
      ),
    };
    state = submit(engine, state, 0, { type: 'PLACE_FREE_SHIP', edge: COAST_EDGE });
    expect(state.turn.phase.map((item) => item.id)).toEqual(['main']);
  });
  test('SKIP ends the phase, and the pirate’s hex edges are refused', () => {
    const state = start();
    expect(submit(engine, state, 0, { type: 'SKIP' }).turn.phase.map((item) => item.id)).toEqual([
      'main',
    ]);
    const guarded = {
      ...state,
      ext: { ...state.ext, seafaring: { ...seafaringExt(state), pirateHex: 'h:3,-1' } },
    };
    const blocked = edgesOfHex(guarded, 'h:3,-1');
    const free = engine
      .getLegalCommands(guarded, 0)
      .commands.filter((c) => c.type === 'PLACE_FREE_SHIP');
    expect(free.length).toBeGreaterThan(0);
    expect(free.every((command) => !blocked.includes(String(command.edge)))).toBe(true);
    expect(
      engine
        .getLegalCommands(state, 0)
        .commands.some((c) => c.type === 'PLACE_FREE_SHIP' && blocked.includes(String(c.edge))),
    ).toBe(true);
  });
  test('free ships cannot be moved in the same turn', () => {
    let state = start();
    state = submit(engine, state, 0, { type: 'PLACE_FREE_SHIP', edge: COAST_EDGE });
    state = submit(engine, state, 0, { type: 'SKIP' });
    expect(engine.getLegalCommands(state, 0).commands.some((c) => c.type === 'MOVE_SHIP')).toBe(
      false,
    );
  });
});

describe('the five-six special build phase', () => {
  test('a seat may buy ships but not move them', () => {
    const state = withHand(sbpState(), 1, { lumber: 1, wool: 1 });
    const [pending] = fiveSix.getPending(state);
    expect(pending).toMatchObject({ kind: 'player', seat: 1 });
    expect(pending?.kind === 'player' && pending.allowed).toContain('BUILD_SHIP');
    expect(pending?.kind === 'player' && pending.allowed).not.toContain('MOVE_SHIP');
    expect(
      rejection(fiveSix, state, 1, { type: 'MOVE_SHIP', from: COAST_EDGE, to: COAST_EDGE }),
    ).toBe('not-pending');
    expect(rejection(fiveSix, state, 0, { type: 'BUILD_SHIP', edge: COAST_EDGE })).toBe(
      'not-pending',
    );
    const priv = hands(state, 1, { lumber: 1, wool: 1 }).get(1);
    const commands = fiveSix.getLegalCommands(state, 1, priv).commands;
    expect(commands.some((c) => c.type === 'BUILD_SHIP')).toBe(true);
    const built = submit(fiveSix, state, 1, { type: 'BUILD_SHIP', edge: COAST_EDGE });
    expect(built.board.ships).toEqual([{ edge: COAST_EDGE, seat: 1 }]);
    expect(built.seats[1]?.resources.total).toBe(0);
  });
  test('the automatic end of the phase counts a ship as an affordable build', () => {
    const state = withHand(sbpState(), 1, { lumber: 1, wool: 1 });
    expect(fiveSix.getAutomaticInput(state, hands(state, 1, { lumber: 1, wool: 1 }))).toBeNull();
    expect(fiveSix.getAutomaticInput(state, hands(state, 1, { lumber: 1 }))).toEqual({
      kind: 'command',
      seat: 1,
      command: { type: 'END_SBP' },
    });
    // With cards but no seat of its own to connect to, nothing can be built: the phase ends.
    const lonely = { ...state, board: { ...state.board, buildings: [] } };
    expect(fiveSix.getAutomaticInput(lonely, hands(lonely, 1, { lumber: 1, wool: 1 }))).toEqual({
      kind: 'command',
      seat: 1,
      command: { type: 'END_SBP' },
    });
  });
  test('five and six seats start on the archipelago with the larger bank', () => {
    for (const seats of [5, 6]) {
      const state = newGame(fiveSix, { seats, fiveSix: true });
      expect(state.config.seats).toHaveLength(seats);
      expect(state.bank.brick).toBe(24);
      expect(state.decks.dev?.remaining).toBe(34);
      expect(state.seats.every((seat) => seat.piecesLeft.ship === 15)).toBe(true);
      expect(fiveSix.checkInvariants(state)).toEqual([]);
    }
    expect(() => engine.createGame(seafaringConfig({ seats: 5 }), new Uint8Array(32))).toThrow(
      /seats/,
    );
  });
});

describe('main phase', () => {
  test('ships and moves are offered only in the main phase, to the active seat', () => {
    const state = inMain(
      withHand(withBuildings(newGame(engine), [{ vertex: V0, seat: 0 }]), 0, {
        lumber: 1,
        wool: 1,
      }),
    );
    expect(engine.getLegalCommands(state, 0).commands.some((c) => c.type === 'BUILD_SHIP')).toBe(
      true,
    );
    expect(engine.getLegalCommands(state, 1).commands.some((c) => c.type === 'BUILD_SHIP')).toBe(
      false,
    );
    const ready = withShips(state, 0, [COAST_EDGE]);
    expect(engine.getLegalCommands(ready, 0).commands.some((c) => c.type === 'MOVE_SHIP')).toBe(
      true,
    );
  });
});
