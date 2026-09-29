import { describe, expect, test } from 'vitest';
import type { CommandShape } from '../../core/pipeline/index.js';
import type { Seat } from '../../core/types/index.js';
import { knightsEngine } from './testing.js';
import { setKnights } from './pieces.js';
import { knightsExt } from './types.js';
import {
  handOf,
  inDice,
  inMain,
  newGame,
  rejection,
  ringLayout,
  roll,
  setRobber,
  submit,
  top,
  unlockRobber,
  withBuildings,
  withHand,
  withKnights,
  withLevels,
  withRoads,
  withStep,
} from './support.js';

const engine = knightsEngine();
const fiveSix = knightsEngine(true);
const at = (list: readonly string[], index: number): string => list[index] ?? '';
const types = (commands: readonly CommandShape[]) => new Set(commands.map((item) => item.type));

/** Seat 0 has a settlement, roads out to and along the ring, and two knights on the ring. */
function position(e = engine, options: { fiveSix?: boolean } = {}) {
  const base = newGame(e, options.fiveSix ? { fiveSix: true } : { seats: 3 });
  const { ring, out, hex } = ringLayout(base);
  let state = withBuildings(base, [
    { vertex: at(out, 0), seat: 0 },
    { vertex: at(ring, 5), seat: 1, kind: 'city' },
  ]);
  state = withRoads(state, 0, [at(out, 0), ...ring.slice(0, 5)]);
  state = withKnights(state, [
    { seat: 0, vertex: at(ring, 1) },
    { seat: 0, vertex: at(ring, 2), active: false, ready: false, level: 2 },
  ]);
  return { state: inMain(state), ring, out, hex };
}

describe('legal commands for knights', () => {
  test('the main phase lists every affordable knight command, and only those', () => {
    const { state, ring } = position();
    const poor = engine.getLegalCommands(state, 0).commands;
    expect(types(poor)).toEqual(new Set(['END_TURN', 'MOVE_KNIGHT']));
    const rich = withHand(withLevels(state, 0, { politics: 3 }), 0, {
      wool: 3,
      ore: 3,
      grain: 1,
      brick: 2,
    });
    const legal = engine.getLegalCommands(rich, 0).commands;
    expect(types(legal)).toEqual(
      new Set(['END_TURN', 'MOVE_KNIGHT', 'BUILD_KNIGHT', 'ACTIVATE_KNIGHT', 'PROMOTE_KNIGHT']),
    );
    expect(legal.filter((item) => item.type === 'ACTIVATE_KNIGHT')).toEqual([
      { type: 'ACTIVATE_KNIGHT', vertex: at(ring, 2) },
    ]);
    // The ready knight can step to any empty vertex its roads reach, never onto a piece.
    const moves = legal.filter((item) => item.type === 'MOVE_KNIGHT').map((item) => item.to);
    expect(new Set(moves)).toEqual(new Set([at(ring, 0), at(ring, 3), at(ring, 4)]));
    expect(legal.every((item) => rejection(engine, rich, 0, item) === null)).toBe(true);
  });

  test('walls appear under cities, displacements against weaker knights, chases beside the robber', () => {
    const { state, ring, hex } = position();
    const cityState = withHand(
      withBuildings(state, [{ vertex: at(ring, 0), seat: 0, kind: 'city' }]),
      0,
      { brick: 2 },
    );
    expect(
      engine
        .getLegalCommands(cityState, 0)
        .commands.filter((item) => item.type === 'BUILD_CITY_WALL'),
    ).toEqual([{ type: 'BUILD_CITY_WALL', vertex: at(ring, 0) }]);
    const guarded = withKnights(state, [
      { seat: 1, vertex: at(ring, 4), active: false, ready: false },
    ]);
    const strong = setKnights(guarded, (list) =>
      list.map((knight) => (knight.vertex === at(ring, 1) ? { ...knight, level: 2 } : knight)),
    );
    expect(
      engine.getLegalCommands(strong, 0).commands.filter((item) => item.type === 'DISPLACE_KNIGHT'),
    ).toEqual([{ type: 'DISPLACE_KNIGHT', from: at(ring, 1), to: at(ring, 4) }]);
    const chase = setRobber(unlockRobber(state), hex);
    expect(
      engine.getLegalCommands(chase, 0).commands.filter((item) => item.type === 'CHASE_ROBBER'),
    ).toEqual([{ type: 'CHASE_ROBBER', vertex: at(ring, 1) }]);
    const locked = setRobber(state, hex);
    expect(types(engine.getLegalCommands(locked, 0).commands).has('CHASE_ROBBER')).toBe(false);
  });

  test('another seat sees no knight commands, and neither does a seat before it can pay', () => {
    const { state } = position();
    expect(types(engine.getLegalCommands(state, 1).commands).has('MOVE_KNIGHT')).toBe(false);
    const priv = engine.createPrivateState(0);
    expect(types(engine.getLegalCommands(state, 0, priv).commands).has('BUILD_KNIGHT')).toBe(false);
  });

  test('the main phase pending lists the knight commands for the active seat only', () => {
    const { state } = position();
    const [active] = engine.getPending(state);
    expect(active).toMatchObject({ kind: 'player', seat: 0 });
    const allowed = active?.kind === 'player' ? active.allowed : [];
    for (const type of [
      'BUILD_KNIGHT',
      'ACTIVATE_KNIGHT',
      'PROMOTE_KNIGHT',
      'MOVE_KNIGHT',
      'DISPLACE_KNIGHT',
      'CHASE_ROBBER',
      'BUILD_CITY_WALL',
      'UPGRADE_SIDEWAYS_CITY',
    ])
      expect(allowed).toContain(type);
    const others = engine
      .getPending(state)
      .filter((item) => item.kind === 'player' && item.seat !== 0)
      .flatMap((item) => (item.kind === 'player' ? item.allowed : []));
    expect(others).not.toContain('MOVE_KNIGHT');
  });
});

describe('the knight rules under a 7 and other interrupts', () => {
  test('no knight command is legal before the roll or during a discard', () => {
    const { state, ring } = position();
    const dice = inDice(state);
    expect(
      rejection(engine, dice, 0, { type: 'MOVE_KNIGHT', from: at(ring, 1), to: at(ring, 3) }),
    ).not.toBeNull();
    const after = roll(engine, withHand(dice, 0, { brick: 9 }), [3, 4]);
    expect(top(after)?.id).toBe('discard');
    expect(
      rejection(engine, after, 0, { type: 'MOVE_KNIGHT', from: at(ring, 1), to: at(ring, 3) }),
    ).toBe('not-pending');
  });
});

/** Seat 1 owns roads and a knight on the ring; seat 0 has just ended its turn. */
function special() {
  const base = newGame(fiveSix, { fiveSix: true });
  const { ring, out } = ringLayout(base);
  let state = withBuildings(base, [
    { vertex: at(out, 0), seat: 1 },
    { vertex: at(ring, 5), seat: 1, kind: 'city' },
  ]);
  state = withRoads(state, 1, [at(out, 0), ...ring.slice(0, 5)]);
  state = withKnights(state, [
    { seat: 1, vertex: at(ring, 1), active: false, ready: false },
    { seat: 1, vertex: at(ring, 2), active: true, ready: true, level: 2 },
  ]);
  state = withHand(withLevels(inMain(state), 1, { politics: 3 }), 1, {
    wool: 4,
    ore: 4,
    grain: 2,
    brick: 2,
  });
  return { state: submit(fiveSix, state, 0, { type: 'END_TURN' }), ring };
}

describe('knights in the special build phase (five-six)', () => {
  test('building, activating and promoting are allowed there, knight actions are not', () => {
    const { state, ring } = special();
    expect(top(state)).toMatchObject({ id: 'sbp', data: { seat: 1 } });
    const legal = types(fiveSix.getLegalCommands(state, 1).commands);
    for (const type of ['BUILD_KNIGHT', 'ACTIVATE_KNIGHT', 'PROMOTE_KNIGHT', 'BUILD_CITY_WALL'])
      expect(legal.has(type)).toBe(true);
    for (const type of ['MOVE_KNIGHT', 'DISPLACE_KNIGHT', 'CHASE_ROBBER'])
      expect(legal.has(type)).toBe(false);
    const attempt = (command: CommandShape) => rejection(fiveSix, state, 1, command);
    expect(attempt({ type: 'MOVE_KNIGHT', from: at(ring, 2), to: at(ring, 3) })).toBe(
      'not-pending',
    );
    expect(attempt({ type: 'CHASE_ROBBER', vertex: at(ring, 2) })).toBe('not-pending');
    expect(attempt({ type: 'BUILD_KNIGHT', vertex: at(ring, 3) })).toBeNull();
    expect(attempt({ type: 'ACTIVATE_KNIGHT', vertex: at(ring, 1) })).toBeNull();
    expect(attempt({ type: 'PROMOTE_KNIGHT', vertex: at(ring, 2) })).toBeNull();
    expect(attempt({ type: 'BUILD_CITY_WALL', vertex: at(ring, 5) })).toBeNull();
  });

  test('other seats cannot buy in someone else’s special build phase', () => {
    const { state, ring } = special();
    expect(rejection(fiveSix, state, 2, { type: 'BUILD_KNIGHT', vertex: at(ring, 3) })).toBe(
      'not-pending',
    );
  });

  test('a knight activated in the phase is ready on its owner’s next turn', () => {
    const { state, ring } = special();
    let next = submit(fiveSix, state, 1, { type: 'ACTIVATE_KNIGHT', vertex: at(ring, 1) });
    expect(knightsExt(next).knights.find((k) => k.vertex === at(ring, 1))).toMatchObject({
      active: true,
      ready: false,
    });
    expect(handOf(next, 1).grain).toBe(1);
    for (const seat of [1, 2, 3, 4] as const) {
      expect(top(next)).toMatchObject({ id: 'sbp', data: { seat } });
      next = submit(fiveSix, next, seat, { type: 'END_SBP' });
    }
    // The turn passes to seat 1, whose active knights are ready as soon as the turn begins.
    expect(next.turn.activeSeat).toBe(1);
    expect(
      knightsExt(next)
        .knights.filter((k) => k.seat === 1)
        .every((k) => k.ready),
    ).toBe(true);
    next = roll(fiveSix, submit(fiveSix, next, 1, { type: 'ROLL_DICE' }), [2, 3], 'trade');
    expect(
      rejection(fiveSix, next, 1, { type: 'MOVE_KNIGHT', from: at(ring, 1), to: at(ring, 3) }),
    ).toBeNull();
  });

  test('a knight promoted in the phase may be promoted again in the owner’s own turn', () => {
    const { state, ring } = special();
    let next = submit(fiveSix, state, 1, { type: 'PROMOTE_KNIGHT', vertex: at(ring, 1) });
    expect(rejection(fiveSix, next, 1, { type: 'PROMOTE_KNIGHT', vertex: at(ring, 1) })).toBe(
      'already-promoted',
    );
    for (const seat of [1, 2, 3, 4] as const)
      next = submit(fiveSix, next, seat, { type: 'END_SBP' });
    next = roll(fiveSix, submit(fiveSix, next, 1, { type: 'ROLL_DICE' }), [2, 3], 'trade');
    expect(rejection(fiveSix, next, 1, { type: 'PROMOTE_KNIGHT', vertex: at(ring, 1) })).toBeNull();
  });

  test('a five-six attack, pillage and special build phase work together', () => {
    const base = newGame(fiveSix, { fiveSix: true });
    const { ring, out } = ringLayout(base);
    const seats: readonly Seat[] = [0, 1, 2, 3, 4];
    const cities = seats.map((seat) => ({
      vertex: at([...ring, ...out], seat),
      seat,
      kind: 'city',
    }));
    const state = withBuildings(base, cities);
    const attacked = roll(fiveSix, withStep(inDice(state), 6), [2, 3], 'ship');
    expect(knightsExt(attacked).lastAttack).toMatchObject({ strength: 5, outcome: 'pillaged' });
    expect(knightsExt(attacked).robberLocked).toBe(false);
    expect(fiveSix.checkInvariants(attacked)).toEqual([]);
    const ended = submit(fiveSix, attacked, 0, { type: 'END_TURN' });
    expect(top(ended)).toMatchObject({ id: 'sbp' });
  });
});
