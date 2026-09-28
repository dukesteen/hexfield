import { describe, expect, test } from 'vitest';
import type { GameState } from '../../core/state/index.js';
import { frame } from '../base/shared.js';
import { legalRobberHexes } from '../base/robber.js';
import { legalPirateHexes, seafaringExt } from './index.js';
import { seafaringEngine } from './testing.js';
import {
  edgesOfHex,
  inPhase,
  newGame,
  rejection,
  submit,
  vertexId,
  withBuildings,
  withHand,
  withShips,
} from './support.js';

const engine = seafaringEngine();
const TARGET = 'h:3,-1';
const V0 = vertexId({ q: 2, r: -1 }, 'NE');

/** A seven has been rolled: the active seat must move the robber or the pirate. */
function robberPhase(state: GameState, returnTo: 'main' | 'pop' = 'main'): GameState {
  const phase = inPhase(state, 'moveRobber', { returnTo });
  return { ...phase, turn: { number: 5, activeSeat: 0, phase: phase.turn.phase } };
}

const fixture = () => {
  let state = newGame(engine);
  state = withShips(state, 1, [
    edgesOfHex(state, TARGET)[0] ?? '',
    edgesOfHex(state, TARGET)[1] ?? '',
  ]);
  state = withShips(state, 2, [edgesOfHex(state, TARGET)[3] ?? '']);
  state = withBuildings(state, [{ vertex: V0, seat: 2 }]);
  state = withHand(state, 1, { brick: 2 });
  state = withHand(state, 2, { wool: 1 });
  return robberPhase(state);
};

describe('the pirate', () => {
  test('after a seven the seat may move either blocker, each to its own kind of hex', () => {
    const state = fixture();
    const [pending] = engine.getPending(state);
    expect(pending).toMatchObject({ kind: 'player', seat: 0 });
    expect(pending?.kind === 'player' && pending.allowed).toEqual(
      expect.arrayContaining(['MOVE_ROBBER', 'MOVE_PIRATE']),
    );
    const commands = engine.getLegalCommands(state, 0).commands;
    const pirate = commands.filter((command) => command.type === 'MOVE_PIRATE');
    const robber = commands.filter((command) => command.type === 'MOVE_ROBBER');
    expect(pirate.length).toBeGreaterThan(0);
    expect(robber.length).toBeGreaterThan(0);
    const terrain = new Map(state.board.hexes.map((hex) => [hex.id, hex.terrain]));
    expect(pirate.every((command) => terrain.get(String(command.hex)) === 'sea')).toBe(true);
    expect(pirate.some((command) => command.hex === 'h:3,0')).toBe(false);
    expect(
      robber.every((command) => !['sea', 'fog'].includes(terrain.get(String(command.hex)) ?? '')),
    ).toBe(true);
    expect(rejection(engine, state, 0, { type: 'MOVE_ROBBER', hex: TARGET })).toBe(
      'illegal-robber-hex',
    );
    expect(rejection(engine, state, 0, { type: 'MOVE_PIRATE', hex: 'h:0,0' })).toBe(
      'illegal-pirate-hex',
    );
    expect(rejection(engine, state, 0, { type: 'MOVE_PIRATE', hex: 'h:3,0' })).toBe(
      'illegal-pirate-hex',
    );
    expect(rejection(engine, state, 0, { type: 'MOVE_PIRATE' })).toBe('illegal-pirate-hex');
    expect(rejection(engine, state, 1, { type: 'MOVE_PIRATE', hex: TARGET })).toBe('not-pending');
    expect(rejection(engine, state, 0, { type: 'MOVE_PIRATE', hex: TARGET })).toBeNull();
    expect(legalRobberHexes(state)).not.toContain(TARGET);
    expect(legalPirateHexes(state)).toContain(TARGET);
  });
  test('moving the pirate steals from a seat with a ship there, once, and never from a shore settlement', () => {
    let state = submit(engine, fixture(), 0, { type: 'MOVE_PIRATE', hex: TARGET });
    expect(seafaringExt(state).pirateHex).toBe(TARGET);
    const top = state.turn.phase.at(-1);
    expect(top?.id).toBe('steal');
    // Seat 1 has two ships and cards; seat 2 has a ship but no cards... it holds one wool.
    expect(top?.data).toMatchObject({ targets: [1, 2], thief: 0, returnTo: 'main' });
    state = withHand(state, 2, {});
    state = {
      ...state,
      turn: {
        ...state.turn,
        phase: [{ ...(top ?? frame('steal')), data: { targets: [1], thief: 0, returnTo: 'main' } }],
      },
    };
    state = submit(engine, state, 0, { type: 'STEAL', victim: 1 });
    const result = engine.apply(state, {
      kind: 'system',
      type: 'STEAL_RESULT',
      thief: 0,
      victim: 1,
      resource: 'brick',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.turn.phase.at(-1)?.id).toBe('main');
    expect(result.value.state.seats[0]?.resources.total).toBe(1);
    expect(engine.checkInvariants(result.value.state)).toEqual([]);
  });
  test('only opponents with a ship on the hex and a card are victims', () => {
    const state = fixture();
    const noCards = withHand(state, 2, {});
    expect(
      submit(engine, noCards, 0, { type: 'MOVE_PIRATE', hex: TARGET }).turn.phase.at(-1)?.data,
    ).toMatchObject({
      targets: [1],
    });
    // The seat with only a settlement beside the hex, and the thief's own ships, are not victims.
    const shoreOnly = withHand(withBuildings(newGame(engine), [{ vertex: V0, seat: 2 }]), 2, {
      wool: 3,
    });
    const moved = submit(
      engine,
      robberPhase(withShips(shoreOnly, 0, [edgesOfHex(shoreOnly, TARGET)[0] ?? ''])),
      0,
      {
        type: 'MOVE_PIRATE',
        hex: TARGET,
      },
    );
    expect(moved.turn.phase.at(-1)?.id).toBe('main');
  });
  test('a knight’s move returns to the phase below', () => {
    const state = robberPhase(
      withHand(withShips(newGame(engine), 1, [edgesOfHex(newGame(engine), TARGET)[0] ?? '']), 1, {
        ore: 1,
      }),
      'pop',
    );
    const withMain = {
      ...state,
      turn: { ...state.turn, phase: [frame('main'), ...state.turn.phase] },
    };
    const moved = submit(engine, withMain, 0, { type: 'MOVE_PIRATE', hex: TARGET });
    expect(moved.turn.phase.map((item) => item.id)).toEqual(['main', 'steal']);
    const done = submit(engine, moved, 0, { type: 'STEAL', victim: 1 });
    const answered = engine.apply(done, {
      kind: 'system',
      type: 'STEAL_RESULT',
      thief: 0,
      victim: 1,
      resource: 'ore',
    });
    expect(answered.ok && answered.value.state.turn.phase.map((item) => item.id)).toEqual(['main']);
  });
  test('friendlyRobber keeps the pirate away from ships of seats with two points or fewer', () => {
    const base = newGame(engine, { base: { friendlyRobber: true } });
    let state = withShips(base, 1, [edgesOfHex(base, TARGET)[0] ?? '']);
    state = robberPhase(state);
    expect(legalPirateHexes(state)).not.toContain(TARGET);
    expect(legalPirateHexes(state).length).toBeGreaterThan(0);
    expect(rejection(engine, state, 0, { type: 'MOVE_PIRATE', hex: TARGET })).toBe(
      'illegal-pirate-hex',
    );
    // A seat above two points may be targeted.
    const strong = {
      ...state,
      seats: state.seats.map((seat) => (seat.seat === 1 ? { ...seat, publicVp: 3 } : seat)),
    };
    expect(legalPirateHexes(strong)).toContain(TARGET);
    // If every sea hex is restricted, every other sea hex is legal.
    const seaHexes = state.board.hexes.filter((hex) => hex.terrain === 'sea').map((hex) => hex.id);
    const everywhere = withShips(
      state,
      2,
      seaHexes
        .map((hex) => edgesOfHex(state, hex)[0] ?? '')
        .filter(
          (edge, i, all) =>
            all.indexOf(edge) === i && !state.board.ships?.some((s) => s.edge === edge),
        ),
    );
    expect(legalPirateHexes(everywhere).length).toBe(seaHexes.length - 1);
  });
  test('a pirate that starts off the board may go to any sea hex', () => {
    const state = robberPhase(newGame(engine, { seafaring: { pirateHex: null } }));
    expect(seafaringExt(state).pirateHex).toBeNull();
    expect(legalPirateHexes(state)).toContain('h:3,0');
    const moved = submit(engine, state, 0, { type: 'MOVE_PIRATE', hex: 'h:3,0' });
    expect(seafaringExt(moved).pirateHex).toBe('h:3,0');
    expect(engine.checkInvariants(moved)).toEqual([]);
  });
  test('a timeout in the blocker phase still moves the robber', () => {
    const state = robberPhase(newGame(engine));
    expect(
      engine.validate(state, { kind: 'system', type: 'TIMEOUT', seat: 0, phase: 'moveRobber' }).ok,
    ).toBe(true);
    const timed = engine.apply(state, {
      kind: 'system',
      type: 'TIMEOUT',
      seat: 0,
      phase: 'moveRobber',
    });
    expect(timed.ok && timed.value.state.turn.phase.at(-1)?.id).toBe('main');
    expect(timed.ok && timed.value.state.board.robberHex).not.toBe(state.board.robberHex);
  });
});
