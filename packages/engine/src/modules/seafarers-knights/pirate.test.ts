import { describe, expect, test } from 'vitest';
import type { GameState } from '../../core/state/index.js';
import { knightsExt } from '../knights/types.js';
import { seafaringExt } from '../seafaring/types.js';
import { comboExt } from './types.js';
import {
  COAST,
  FAR,
  FIELDS,
  HOME,
  PIRATE_START,
  S1,
  S2,
  S3,
  SEA,
  afterFirstAttack,
  engine,
  inDice,
  inMain,
  legal,
  newGame,
  rejection,
  roll,
  setRobber,
  submit,
  top,
  withBuildings,
  withKnights,
  withShips,
  withStep,
} from './support.js';

function fleet(): GameState {
  const state = withBuildings(newGame(), [{ vertex: HOME, seat: 0 }]);
  return withShips(state, 0, [S1, S2, S3]);
}

const hexes = (state: GameState, type: string) =>
  legal(state, 0, type).map((command) => String(command.hex));

describe('the pirate before the first attack', () => {
  test('genesis keeps the scenario’s pirate hex off the board', () => {
    const state = newGame();
    expect(seafaringExt(state).pirateHex).toBeNull();
    expect(comboExt(state)).toEqual({ pirateStart: PIRATE_START, pirateEntered: false });
    expect(engine.checkInvariants(state)).toEqual([]);
  });

  test('a 7 moves neither piece and steals nothing, and the pirate stays off the board', () => {
    const after = roll(engine, inDice(fleet()), [3, 4], 'trade');
    expect(top(after)?.id).toBe('main');
    expect(legal(after, 0, 'MOVE_PIRATE')).toEqual([]);
    expect(legal(after, 0, 'MOVE_ROBBER')).toEqual([]);
    expect(seafaringExt(after).pirateHex).toBeNull();
  });

  test('no knight can chase either piece while the robber is locked', () => {
    const state = inMain(withKnights(fleet(), [{ seat: 0, vertex: SEA }]));
    expect(legal(state, 0, 'CHASE_ROBBER')).toEqual([]);
    expect(rejection(state, 0, { type: 'CHASE_ROBBER', vertex: SEA })).toBe('robber-locked');
  });

  test('the pirate never blocks ships before it enters', () => {
    const state = inMain(fleet());
    // SEA is a corner of the pirate's start hex, and the ship out of it may still move.
    expect(legal(state, 0, 'MOVE_SHIP').length).toBeGreaterThan(0);
  });
});

describe('the first attack', () => {
  test('the attack puts the pirate on its start hex and unlocks the robber', () => {
    const after = roll(engine, withStep(inDice(fleet()), 6), [2, 3], 'ship');
    expect(knightsExt(after).lastAttack).not.toBeNull();
    expect(knightsExt(after).robberLocked).toBe(false);
    expect(seafaringExt(after).pirateHex).toBe(PIRATE_START);
    expect(comboExt(after).pirateEntered).toBe(true);
    expect(engine.checkInvariants(after)).toEqual([]);
  });

  test('an attack and a 7 on one roll: the attack comes first, then either piece may move', () => {
    const after = roll(engine, withStep(inDice(fleet()), 6), [3, 4], 'ship');
    expect(seafaringExt(after).pirateHex).toBe(PIRATE_START);
    expect(top(after)?.id).toBe('moveRobber');
    expect(hexes(after, 'MOVE_PIRATE').length).toBeGreaterThan(0);
    expect(hexes(after, 'MOVE_ROBBER').length).toBeGreaterThan(0);
  });

  test('a scenario without a pirate hex keeps the pirate off the board after the attack', () => {
    const base = newGame({ seafaring: { pirateHex: null } });
    const after = roll(engine, withStep(inDice(base), 6), [3, 4], 'ship');
    expect(seafaringExt(after).pirateHex).toBeNull();
    // It enters at its first move, wherever the seat puts it.
    expect(hexes(after, 'MOVE_PIRATE').length).toBeGreaterThan(0);
  });
});

describe('chasing the pirate', () => {
  test('a knight on a sea vertex of the pirate’s hex moves the pirate, and only the pirate', () => {
    const state = inMain(afterFirstAttack(withKnights(fleet(), [{ seat: 0, vertex: SEA }])));
    expect(legal(state, 0, 'CHASE_ROBBER')).toEqual([{ type: 'CHASE_ROBBER', vertex: SEA }]);
    const chased = submit(state, 0, { type: 'CHASE_ROBBER', vertex: SEA });
    expect(top(chased)?.id).toBe('moveRobber');
    expect(hexes(chased, 'MOVE_ROBBER')).toEqual([]);
    const targets = hexes(chased, 'MOVE_PIRATE');
    expect(targets.length).toBeGreaterThan(0);
    const moved = submit(chased, 0, { type: 'MOVE_PIRATE', hex: targets[0] });
    expect(seafaringExt(moved).pirateHex).toBe(targets[0]);
    expect(knightsExt(moved).knights).toMatchObject([{ vertex: SEA, active: false }]);
  });

  test('a knight on a coast vertex beside the pirate may chase it too', () => {
    const state = inMain(
      afterFirstAttack(withKnights(fleet(), [{ seat: 0, vertex: COAST }]), 'h:3,-2'),
    );
    const robber = state.board.robberHex;
    expect(legal(state, 0, 'CHASE_ROBBER')).toEqual([{ type: 'CHASE_ROBBER', vertex: COAST }]);
    const chased = submit(state, 0, { type: 'CHASE_ROBBER', vertex: COAST });
    expect(hexes(chased, 'MOVE_ROBBER')).toEqual([]);
    expect(hexes(chased, 'MOVE_PIRATE').length).toBeGreaterThan(0);
    expect(chased.board.robberHex).toBe(robber);
  });

  test('a knight beside both pieces chooses which one to move', () => {
    const state = inMain(
      setRobber(
        afterFirstAttack(withKnights(fleet(), [{ seat: 0, vertex: FAR }]), 'h:4,-1'),
        FIELDS,
      ),
    );
    const chased = submit(state, 0, { type: 'CHASE_ROBBER', vertex: FAR });
    expect(hexes(chased, 'MOVE_ROBBER').length).toBeGreaterThan(0);
    expect(hexes(chased, 'MOVE_PIRATE').length).toBeGreaterThan(0);
  });
});
