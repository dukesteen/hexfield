import { describe, expect, test } from 'vitest';
import type { GameState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
import { hexesForVertex } from '../base/board/index.js';
import { knightsEngine } from './testing.js';
import { setKnights } from './pieces.js';
import { knightsExt, updateKnights } from './types.js';
import {
  edgeBetween,
  handOf,
  inDice,
  inMain,
  newGame,
  pathVertices,
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
} from './support.js';

const engine = knightsEngine();
const at = (list: readonly string[], index: number): string => list[index] ?? '';

/** Seat 0 owns a settlement off the ring and roads out to the ring corner 0 and along the ring. */
function layout(length = 4) {
  const base = newGame(engine, { seats: 3 });
  const { ring, out, hex } = ringLayout(base);
  let state = withBuildings(base, [{ vertex: at(out, 0), seat: 0 }]);
  state = withRoads(state, 0, [at(out, 0), ...ring.slice(0, length + 1)]);
  return { state: inMain(state), ring, out, hex };
}

const knights = (state: GameState) => knightsExt(state).knights;
const command = (state: GameState, seat: Seat, body: Record<string, unknown>) =>
  submit(engine, state, seat, { type: String(body.type), ...body });
const refused = (state: GameState, seat: Seat, body: Record<string, unknown>) =>
  rejection(engine, state, seat, { type: String(body.type), ...body });

/** Everyone ends and rolls (a harmless 5 with a gate face) until seat 0 is in its main phase again. */
function aroundTheTable(state: GameState): GameState {
  let next = state;
  const order: readonly Seat[] = [0, 1, 2];
  for (const [index, seat] of order.entries()) {
    next = submit(engine, next, seat, { type: 'END_TURN' });
    const upcoming = order[(index + 1) % order.length] ?? 0;
    next = submit(engine, next, upcoming, { type: 'ROLL_DICE' });
    next = roll(engine, next, [2, 3], 'trade');
  }
  return next;
}

describe('recruiting knights', () => {
  test('costs a wool and an ore, and the knight stands inactive where an own road ends', () => {
    const { state, ring } = layout();
    const rich = withHand(state, 0, { wool: 1, ore: 1 });
    const built = command(rich, 0, { type: 'BUILD_KNIGHT', vertex: at(ring, 2) });
    expect(knights(built)).toEqual([
      { seat: 0, vertex: at(ring, 2), level: 1, active: false, ready: false, promotedTurn: null },
    ]);
    expect(handOf(built, 0)).toMatchObject({ wool: 0, ore: 0 });
    expect(engine.checkInvariants(built)).toEqual([]);
  });

  test('there is no distance rule: a knight may stand next to any building', () => {
    const { state, ring, out } = layout();
    const rich = withHand(withBuildings(state, [{ vertex: at(out, 3), seat: 1 }]), 0, {
      wool: 1,
      ore: 1,
    });
    expect(refused(rich, 0, { type: 'BUILD_KNIGHT', vertex: at(ring, 1) })).toBeNull();
    expect(refused(rich, 0, { type: 'BUILD_KNIGHT', vertex: at(ring, 3) })).toBeNull();
  });

  test('it needs an empty vertex where the seat’s own road ends', () => {
    const { state, ring, out } = layout();
    const rich = withHand(state, 0, { wool: 1, ore: 1 });
    const occupied = withKnights(rich, [{ seat: 1, vertex: at(ring, 2) }]);
    expect(refused(rich, 0, { type: 'BUILD_KNIGHT', vertex: at(out, 5) })).toBe(
      'illegal-knight-site',
    );
    expect(refused(rich, 0, { type: 'BUILD_KNIGHT', vertex: at(out, 0) })).toBe(
      'illegal-knight-site',
    );
    expect(refused(occupied, 0, { type: 'BUILD_KNIGHT', vertex: at(ring, 2) })).toBe(
      'illegal-knight-site',
    );
    expect(refused(rich, 0, { type: 'BUILD_KNIGHT', vertex: at(ring, 5) })).toBe(
      'illegal-knight-site',
    );
    expect(refused(state, 0, { type: 'BUILD_KNIGHT', vertex: at(ring, 2) })).toBe(
      'insufficient-resources',
    );
  });

  test('only two basic knights at a time; a promotion returns the piece', () => {
    const { state, ring } = layout();
    const two = withHand(
      withKnights(state, [
        { seat: 0, vertex: at(ring, 1) },
        { seat: 0, vertex: at(ring, 2) },
      ]),
      0,
      { wool: 3, ore: 3 },
    );
    expect(refused(two, 0, { type: 'BUILD_KNIGHT', vertex: at(ring, 3) })).toBe('no-basic-knight');
    const promoted = command(two, 0, { type: 'PROMOTE_KNIGHT', vertex: at(ring, 1) });
    expect(refused(promoted, 0, { type: 'BUILD_KNIGHT', vertex: at(ring, 3) })).toBeNull();
  });

  test('a knight blocks every settlement on its vertex, the owner’s too', () => {
    const { state, ring, out } = layout();
    const standing = withHand(withKnights(state, [{ seat: 0, vertex: at(ring, 4) }]), 0, {
      brick: 1,
      lumber: 1,
      wool: 1,
      grain: 1,
    });
    expect(refused(standing, 0, { type: 'BUILD_SETTLEMENT', vertex: at(ring, 4) })).toBe(
      'illegal-settlement',
    );
    const clear = withHand(state, 0, { brick: 1, lumber: 1, wool: 1, grain: 1 });
    expect(refused(clear, 0, { type: 'BUILD_SETTLEMENT', vertex: at(ring, 4) })).toBeNull();
    expect(out).toHaveLength(6);
  });
});

describe('activating, readiness and promotion', () => {
  test('activation costs a grain and never makes the knight ready that turn', () => {
    const { state, ring } = layout();
    const start = withHand(
      withKnights(state, [{ seat: 0, vertex: at(ring, 2), active: false, ready: false }]),
      0,
      { grain: 1 },
    );
    const active = command(start, 0, { type: 'ACTIVATE_KNIGHT', vertex: at(ring, 2) });
    expect(knights(active)[0]).toMatchObject({ active: true, ready: false });
    expect(handOf(active, 0).grain).toBe(0);
    expect(refused(active, 0, { type: 'MOVE_KNIGHT', from: at(ring, 2), to: at(ring, 3) })).toBe(
      'knight-not-ready',
    );
    expect(refused(active, 0, { type: 'ACTIVATE_KNIGHT', vertex: at(ring, 2) })).toBe(
      'already-active',
    );
    expect(refused(start, 0, { type: 'ACTIVATE_KNIGHT', vertex: at(ring, 3) })).toBe('no-knight');
  });

  test('a knight activated this turn is ready on its next turn', () => {
    const { state, ring } = layout();
    const start = withHand(
      withKnights(state, [{ seat: 0, vertex: at(ring, 2), active: false, ready: false }]),
      0,
      { grain: 1 },
    );
    const active = command(start, 0, { type: 'ACTIVATE_KNIGHT', vertex: at(ring, 2) });
    const later = aroundTheTable(active);
    expect(knights(later)[0]).toMatchObject({ active: true, ready: true });
    expect(
      refused(later, 0, { type: 'MOVE_KNIGHT', from: at(ring, 2), to: at(ring, 3) }),
    ).toBeNull();
  });

  test('a knight that acted may be activated again but cannot act again this turn', () => {
    const { state, ring } = layout();
    const start = withHand(withKnights(state, [{ seat: 0, vertex: at(ring, 2) }]), 0, { grain: 1 });
    let next = command(start, 0, { type: 'MOVE_KNIGHT', from: at(ring, 2), to: at(ring, 3) });
    expect(knights(next)[0]).toMatchObject({ vertex: at(ring, 3), active: false, ready: false });
    next = command(next, 0, { type: 'ACTIVATE_KNIGHT', vertex: at(ring, 3) });
    expect(knights(next)[0]).toMatchObject({ active: true, ready: false });
    expect(refused(next, 0, { type: 'MOVE_KNIGHT', from: at(ring, 3), to: at(ring, 4) })).toBe(
      'knight-not-ready',
    );
  });

  test('promotion costs a wool and an ore, keeps the state, and is once per knight per turn', () => {
    const { state, ring } = layout();
    const start = withHand(
      withKnights(state, [{ seat: 0, vertex: at(ring, 2), active: true, ready: true }]),
      0,
      { wool: 4, ore: 4 },
    );
    const strong = command(start, 0, { type: 'PROMOTE_KNIGHT', vertex: at(ring, 2) });
    expect(knights(strong)[0]).toMatchObject({ level: 2, active: true, ready: true });
    expect(handOf(strong, 0)).toMatchObject({ wool: 3, ore: 3 });
    expect(refused(strong, 0, { type: 'PROMOTE_KNIGHT', vertex: at(ring, 2) })).toBe(
      'already-promoted',
    );
    // A newly recruited knight can be promoted at once.
    const fresh = command(start, 0, { type: 'BUILD_KNIGHT', vertex: at(ring, 3) });
    expect(refused(fresh, 0, { type: 'PROMOTE_KNIGHT', vertex: at(ring, 3) })).toBeNull();
    expect(refused(strong, 0, { type: 'PROMOTE_KNIGHT', vertex: at(ring, 5) })).toBe('no-knight');
  });

  test('a mighty knight needs the Fortress, and each level has two pieces', () => {
    const { state, ring } = layout();
    const strong = withHand(
      withKnights(state, [
        { seat: 0, vertex: at(ring, 1), level: 2 },
        { seat: 0, vertex: at(ring, 2), level: 2 },
        { seat: 0, vertex: at(ring, 3), level: 3 },
        { seat: 0, vertex: at(ring, 4), level: 3 },
      ]),
      0,
      { wool: 4, ore: 4 },
    );
    expect(refused(strong, 0, { type: 'PROMOTE_KNIGHT', vertex: at(ring, 1) })).toBe('no-fortress');
    const fortress = withLevels(strong, 0, { politics: 3 });
    expect(refused(fortress, 0, { type: 'PROMOTE_KNIGHT', vertex: at(ring, 1) })).toBe(
      'no-knight-piece',
    );
    const one = withKnights(
      withLevels(withHand(state, 0, { wool: 4, ore: 4 }), 0, { politics: 3 }),
      [{ seat: 0, vertex: at(ring, 1), level: 2 }],
    );
    const mighty = command(one, 0, { type: 'PROMOTE_KNIGHT', vertex: at(ring, 1) });
    expect(knights(mighty)[0]?.level).toBe(3);
    expect(refused(mighty, 0, { type: 'PROMOTE_KNIGHT', vertex: at(ring, 1) })).toBe('max-knight');
    expect(engine.checkInvariants(strong)).toEqual([]);
  });
});

describe('moving knights', () => {
  test('a knight walks its own roads past its own pieces to an empty vertex and becomes inactive', () => {
    const { state, ring } = layout();
    const start = withKnights(state, [
      { seat: 0, vertex: at(ring, 1) },
      { seat: 0, vertex: at(ring, 2), active: false, ready: false },
    ]);
    const moved = command(start, 0, { type: 'MOVE_KNIGHT', from: at(ring, 1), to: at(ring, 4) });
    expect(knights(moved).map((knight) => knight.vertex)).toEqual(
      [at(ring, 2), at(ring, 4)].toSorted(),
    );
    expect(knights(moved).find((knight) => knight.vertex === at(ring, 4))).toMatchObject({
      active: false,
      ready: false,
    });
    expect(engine.checkInvariants(moved)).toEqual([]);
  });

  test('a ready knight may step back one vertex along its own road, toward its own building', () => {
    const { state, ring } = layout();
    const start = withKnights(state, [{ seat: 0, vertex: at(ring, 3) }]);
    // One vertex back, then (from the start again) back past it to the road's first ring corner.
    const back = command(start, 0, { type: 'MOVE_KNIGHT', from: at(ring, 3), to: at(ring, 2) });
    expect(knights(back).map((knight) => knight.vertex)).toEqual([at(ring, 2)]);
    expect(
      refused(start, 0, { type: 'MOVE_KNIGHT', from: at(ring, 3), to: at(ring, 0) }),
    ).toBeNull();
    // The legal list offers the step back too.
    const legal = engine.getLegalCommands(start, 0).commands;
    expect(
      legal.some(
        (item) =>
          item.type === 'MOVE_KNIGHT' && item.from === at(ring, 3) && item.to === at(ring, 2),
      ),
    ).toBe(true);
    expect(engine.checkInvariants(back)).toEqual([]);
  });

  test('the destination must be empty, different and on the seat’s own roads', () => {
    const { state, ring, out } = layout();
    const start = withKnights(state, [
      { seat: 0, vertex: at(ring, 1) },
      { seat: 0, vertex: at(ring, 2), active: false, ready: false },
    ]);
    const move = (to: string) => ({ type: 'MOVE_KNIGHT', from: at(ring, 1), to });
    expect(refused(start, 0, move(at(ring, 2)))).toBe('unreachable');
    expect(refused(start, 0, move(at(ring, 1)))).toBe('unreachable');
    expect(refused(start, 0, move(at(out, 0)))).toBe('unreachable');
    expect(refused(start, 0, move(at(ring, 5)))).toBe('unreachable');
    expect(refused(start, 1, move(at(ring, 3)))).toBe('not-pending');
  });

  test('another seat’s building or knight stops the walk', () => {
    const { state, ring } = layout();
    const walker = { seat: 0 as const, vertex: at(ring, 1) };
    const walled = withBuildings(withKnights(state, [walker]), [{ vertex: at(ring, 3), seat: 1 }]);
    const move = (to: string) => ({ type: 'MOVE_KNIGHT', from: at(ring, 1), to });
    expect(refused(walled, 0, move(at(ring, 2)))).toBeNull();
    expect(refused(walled, 0, move(at(ring, 3)))).toBe('unreachable');
    expect(refused(walled, 0, move(at(ring, 4)))).toBe('unreachable');
    const guarded = withKnights(withKnights(state, [walker]), [
      { seat: 1, vertex: at(ring, 3), level: 3 },
    ]);
    expect(refused(guarded, 0, move(at(ring, 3)))).toBe('unreachable');
    expect(refused(guarded, 0, move(at(ring, 4)))).toBe('unreachable');
    // The strongest knight cannot be displaced by a basic one either.
    expect(
      refused(guarded, 0, { type: 'DISPLACE_KNIGHT', from: at(ring, 1), to: at(ring, 3) }),
    ).toBe('not-weaker');
  });

  test('a road built this turn is walkable at once', () => {
    const { state, ring } = layout(2);
    const start = withHand(withKnights(state, [{ seat: 0, vertex: at(ring, 1) }]), 0, {
      brick: 1,
      lumber: 1,
    });
    expect(refused(start, 0, { type: 'MOVE_KNIGHT', from: at(ring, 1), to: at(ring, 3) })).toBe(
      'unreachable',
    );
    const built = submit(engine, start, 0, {
      type: 'BUILD_ROAD',
      edge: edgeBetween(start, at(ring, 2), at(ring, 3)),
    });
    expect(
      refused(built, 0, { type: 'MOVE_KNIGHT', from: at(ring, 1), to: at(ring, 3) }),
    ).toBeNull();
  });
});

/** Seat 0 (knight of `level` on ring 0) reaches seat 1's basic knight on ring 2; seat 1 owns the far ring. */
function duel(level = 2) {
  const base = newGame(engine, { seats: 3 });
  const { ring, out } = ringLayout(base);
  let state = withBuildings(base, [
    { vertex: at(out, 0), seat: 0 },
    { vertex: at(out, 3), seat: 1 },
  ]);
  state = withRoads(state, 0, [at(out, 0), at(ring, 0), at(ring, 1), at(ring, 2)]);
  state = withRoads(state, 1, [at(out, 3), at(ring, 3), at(ring, 4), at(ring, 5), at(ring, 0)]);
  state = withRoads(state, 1, [at(ring, 3), at(ring, 2)]);
  state = withKnights(state, [
    { seat: 0, vertex: at(ring, 0), level },
    { seat: 1, vertex: at(ring, 2), active: false, ready: false },
  ]);
  return { state: inMain(state), ring, out };
}

describe('displacing knights', () => {
  test('a stronger knight lands on the vertex, then the owner places its knight on its own roads', () => {
    const { state, ring } = duel();
    const displaced = command(state, 0, {
      type: 'DISPLACE_KNIGHT',
      from: at(ring, 0),
      to: at(ring, 2),
    });
    expect(knights(displaced).find((knight) => knight.vertex === at(ring, 2))).toMatchObject({
      seat: 0,
      level: 2,
      active: false,
      ready: false,
    });
    expect(top(displaced)).toMatchObject({ module: 'knights', id: 'displaced' });
    expect(engine.getPending(displaced)).toEqual([
      expect.objectContaining({ kind: 'player', seat: 1, allowed: ['RELOCATE_KNIGHT'] }),
      expect.objectContaining({ kind: 'player', seat: 0, allowed: ['CLAIM_VICTORY'] }),
    ]);
    const spots = engine
      .getLegalCommands(displaced, 1)
      .commands.filter((item) => item.type === 'RELOCATE_KNIGHT')
      .map((item) => item.to);
    // Seat 1's roads reach its own corners and the vertex the displacer just left.
    expect(spots).toEqual([at(ring, 0), at(ring, 3), at(ring, 4), at(ring, 5)].toSorted());
    expect(refused(displaced, 0, { type: 'RELOCATE_KNIGHT', to: at(ring, 3) })).toBe('not-pending');
    expect(refused(displaced, 1, { type: 'RELOCATE_KNIGHT', to: at(ring, 1) })).toBe(
      'illegal-relocation',
    );
    const relocated = command(displaced, 1, { type: 'RELOCATE_KNIGHT', to: at(ring, 0) });
    expect(knights(relocated).find((knight) => knight.vertex === at(ring, 0))).toMatchObject({
      seat: 1,
      level: 1,
      active: false,
    });
    expect(top(relocated)?.id).toBe('main');
    expect(engine.checkInvariants(relocated)).toEqual([]);
  });

  test('only a strictly weaker knight can be displaced', () => {
    const equal = duel(1).state;
    const { ring } = duel();
    const attempt = { type: 'DISPLACE_KNIGHT', from: at(ring, 0), to: at(ring, 2) };
    expect(refused(equal, 0, attempt)).toBe('not-weaker');
    expect(refused(duel(3).state, 0, attempt)).toBeNull();
    expect(refused(equal, 0, { type: 'MOVE_KNIGHT', from: at(ring, 0), to: at(ring, 2) })).toBe(
      'unreachable',
    );
  });

  test('the displaced knight keeps its active state, and can not chain a displacement', () => {
    const { state, ring } = duel();
    const active = setKnights(state, (list) =>
      list.map((knight) => (knight.seat === 1 ? { ...knight, active: true, ready: true } : knight)),
    );
    const displaced = command(active, 0, {
      type: 'DISPLACE_KNIGHT',
      from: at(ring, 0),
      to: at(ring, 2),
    });
    const kinds = engine.getLegalCommands(displaced, 1).commands.map((item) => item.type);
    expect(new Set(kinds)).toEqual(new Set(['RELOCATE_KNIGHT']));
    const relocated = command(displaced, 1, { type: 'RELOCATE_KNIGHT', to: at(ring, 4) });
    expect(knights(relocated).find((knight) => knight.seat === 1)).toMatchObject({
      vertex: at(ring, 4),
      active: true,
      ready: true,
    });
  });

  test('a knight with no vertex to go to is removed and returns to its owner’s supply', () => {
    const base = newGame(engine, { seats: 3 });
    const { ring, out } = ringLayout(base);
    let state = withBuildings(base, [{ vertex: at(out, 0), seat: 0 }]);
    state = withRoads(state, 0, [at(out, 0), at(ring, 0), at(ring, 1), at(ring, 2)]);
    state = withKnights(state, [
      { seat: 0, vertex: at(ring, 0), level: 3 },
      { seat: 1, vertex: at(ring, 2), active: false, ready: false },
    ]);
    const removed = submit(engine, inMain(state), 0, {
      type: 'DISPLACE_KNIGHT',
      from: at(ring, 0),
      to: at(ring, 2),
    });
    expect(knights(removed).map((knight) => knight.seat)).toEqual([0]);
    expect(top(removed)?.id).toBe('main');
  });

  test('a vertex reachable only through an opposing knight does not count', () => {
    const { state, ring } = duel();
    // Seat 0 also stands on seat 1's corner 3, cutting the rest of the ring off from corner 2.
    const cut = withKnights(state, [
      { seat: 0, vertex: at(ring, 3), level: 3, active: false, ready: false },
    ]);
    const reach = engine.apply(cut, {
      kind: 'command',
      seat: 0,
      command: { type: 'DISPLACE_KNIGHT', from: at(ring, 0), to: at(ring, 2) },
    });
    if (!reach.ok) throw new Error(reach.error.message);
    // Only corner 0 (just vacated) is left, through the roads around the far side of the ring.
    expect(top(reach.value.state)?.id).toBe('main');
    expect(knights(reach.value.state).filter((knight) => knight.seat === 1)).toEqual([]);
  });

  test('a timeout places the knight on the empty vertex with the lowest id', () => {
    const { state, ring } = duel();
    const displaced = command(state, 0, {
      type: 'DISPLACE_KNIGHT',
      from: at(ring, 0),
      to: at(ring, 2),
    });
    const result = engine.apply(displaced, {
      kind: 'system',
      type: 'TIMEOUT',
      seat: 1,
      phase: 'displaced',
    });
    if (!result.ok) throw new Error(result.error.message);
    const lowest = [at(ring, 0), at(ring, 3), at(ring, 4), at(ring, 5)].toSorted()[0];
    expect(
      knights(result.value.state).some((knight) => knight.seat === 1 && knight.vertex === lowest),
    ).toBe(true);
  });
});

function chase() {
  const { state, ring, hex } = layout();
  const robber = setRobber(
    unlockRobber(withKnights(state, [{ seat: 0, vertex: at(ring, 1) }])),
    hex,
  );
  return { robber, ring, hex };
}

describe('chasing the robber', () => {
  test('an active ready knight beside the robber moves it, then steals as on a 7', () => {
    const { robber, ring, hex } = chase();
    const other = hexesForVertex(robber, at(ring, 3)).find((item) => item !== hex) ?? '';
    const victims = withHand(withBuildings(robber, [{ vertex: at(ring, 3), seat: 1 }]), 1, {
      brick: 2,
    });
    const chased = command(victims, 0, { type: 'CHASE_ROBBER', vertex: at(ring, 1) });
    expect(knights(chased)[0]).toMatchObject({ active: false, ready: false });
    expect(top(chased)?.id).toBe('moveRobber');
    const moved = command(chased, 0, { type: 'MOVE_ROBBER', hex: other });
    expect(top(moved)?.id).toBe('steal');
    const stolen = command(moved, 0, { type: 'STEAL', victim: 1 });
    expect(top(stolen)?.id).toBe('stealResult');
  });

  test('it returns to the main phase after the robber move', () => {
    const { robber, ring, hex } = chase();
    const chased = command(robber, 0, { type: 'CHASE_ROBBER', vertex: at(ring, 1) });
    const target = engine
      .getLegalCommands(chased, 0)
      .commands.find((item) => item.type === 'MOVE_ROBBER' && item.hex !== hex);
    const moved = command(chased, 0, { type: 'MOVE_ROBBER', hex: String(target?.hex) });
    expect(top(moved)?.id).toBe('main');
  });

  test('not before the first attack, not away from the robber, and not with a knight that is not ready', () => {
    const { robber, ring } = chase();
    const locked = updateKnights(robber, (old) => ({ ...old, robberLocked: true }));
    expect(refused(locked, 0, { type: 'CHASE_ROBBER', vertex: at(ring, 1) })).toBe('robber-locked');
    const farRobber = setRobber(robber, ringOther(robber, at(ring, 1)));
    expect(refused(farRobber, 0, { type: 'CHASE_ROBBER', vertex: at(ring, 1) })).toBe(
      'not-at-robber',
    );
    const tired = setKnights(robber, (list) => list.map((knight) => ({ ...knight, ready: false })));
    expect(refused(tired, 0, { type: 'CHASE_ROBBER', vertex: at(ring, 1) })).toBe(
      'knight-not-ready',
    );
  });
});

/** A hex that does not touch the vertex. */
function ringOther(state: GameState, vertex: string): string {
  const touching = new Set(hexesForVertex(state, vertex));
  return state.board.hexes.find((hex) => !touching.has(hex.id))?.id ?? '';
}

function chain() {
  const base = newGame(engine, { seats: 3 });
  const { ring, out } = ringLayout(base);
  const side = pathVertices(base, 3, at(ring, 2), [at(ring, 1), at(ring, 3)]);
  let state = withBuildings(base, [
    { vertex: at(out, 0), seat: 0 },
    { vertex: at(side, 1), seat: 1 },
  ]);
  state = withRoads(state, 0, ring.slice(0, 6));
  state = withRoads(state, 1, side);
  const holder: Seat = 0;
  const awarded: GameState = {
    ...inMain(state),
    awards: { ...state.awards, longestRoad: holder },
  };
  return { state: awarded, ring, side: at(side, 2) };
}

describe('knights and the longest road', () => {
  test('an opposing knight breaks the road and leaving restores it, the owner’s own does not', () => {
    const { state, ring, side } = chain();
    expect(engine.checkInvariants(state)).toEqual([]);
    const own = command(withHand(state, 0, { wool: 1, ore: 1 }), 0, {
      type: 'BUILD_KNIGHT',
      vertex: at(ring, 2),
    });
    expect(own.awards.longestRoad).toBe(0);
    const foe = withHand(inMain(state, 1), 1, { wool: 1, ore: 1 });
    const broken = command(foe, 1, { type: 'BUILD_KNIGHT', vertex: at(ring, 2) });
    expect(broken.awards.longestRoad).toBeNull();
    expect(engine.checkInvariants(broken)).toEqual([]);
    // The knight walks off the road along its own road: seat 0 has the longest road again.
    const ready = command(inMain(withKnights(state, [{ seat: 1, vertex: at(ring, 2) }]), 1), 1, {
      type: 'MOVE_KNIGHT',
      from: at(ring, 2),
      to: side,
    });
    expect(ready.awards.longestRoad).toBe(0);
  });

  test('a road cut on both sides by knights stays on the board', () => {
    const { state, ring } = chain();
    const cut = withKnights({ ...state, awards: { ...state.awards, longestRoad: null } }, [
      { seat: 1, vertex: at(ring, 2) },
      { seat: 1, vertex: at(ring, 4) },
    ]);
    expect(cut.board.roads.filter((road) => road.seat === 0)).toHaveLength(5);
    expect(engine.checkInvariants(cut)).toEqual([]);
    // The middle piece cannot end anywhere, so the seat's longest trail is two roads.
    const held = { ...cut, awards: { ...cut.awards, longestRoad: 0 as const } };
    expect(engine.checkInvariants(held)).toContain('longest road holder is below threshold');
  });
});

function cities(count: number) {
  const base = newGame(engine, { seats: 3 });
  const { ring } = ringLayout(base);
  const vertices = ring.slice(0, count);
  const state = withBuildings(
    base,
    vertices.map((vertex) => ({ vertex, seat: 0 as const, kind: 'city' })),
  );
  return { state: inMain(state), vertices, ring };
}

describe('city walls', () => {
  test('a wall costs 2 brick, sits under one of the seat’s own cities, one per city', () => {
    const { state, vertices, ring } = cities(2);
    const rich = withHand(withBuildings(state, [{ vertex: at(ring, 3), seat: 0 }]), 0, {
      brick: 6,
    });
    const walled = command(rich, 0, { type: 'BUILD_CITY_WALL', vertex: at(vertices, 0) });
    expect(knightsExt(walled).walls).toEqual([{ seat: 0, vertex: at(vertices, 0) }]);
    expect(handOf(walled, 0).brick).toBe(4);
    expect(refused(walled, 0, { type: 'BUILD_CITY_WALL', vertex: at(vertices, 0) })).toBe('walled');
    expect(refused(rich, 0, { type: 'BUILD_CITY_WALL', vertex: at(ring, 3) })).toBe('no-city');
    expect(refused(rich, 1, { type: 'BUILD_CITY_WALL', vertex: at(vertices, 1) })).toBe(
      'not-pending',
    );
    expect(refused(state, 0, { type: 'BUILD_CITY_WALL', vertex: at(vertices, 1) })).toBe(
      'insufficient-resources',
    );
    expect(engine.checkInvariants(walled)).toEqual([]);
  });

  test('a seat has three walls, and each adds 2 to the hand limit', () => {
    const base = newGame(engine, { seats: 3 });
    const { ring, out } = ringLayout(base);
    const four = [at(ring, 0), at(ring, 2), at(ring, 4), at(out, 1)];
    let state = inMain(
      withBuildings(
        base,
        four.map((vertex) => ({ vertex, seat: 0 as const, kind: 'city' })),
      ),
    );
    state = withHand(state, 0, { brick: 8 });
    for (const vertex of four.slice(0, 3))
      state = command(state, 0, { type: 'BUILD_CITY_WALL', vertex });
    expect(refused(state, 0, { type: 'BUILD_CITY_WALL', vertex: at(four, 3) })).toBe(
      'no-wall-piece',
    );
    expect(engine.hooks.handLimit(state, 0, 7)).toBe(13);
    expect(engine.hooks.handLimit(state, 1, 7)).toBe(7);
  });

  test('a seat with one wall discards on a 7 only above 9 cards', () => {
    const { state, vertices } = cities(1);
    const walled = updateKnights(state, (old) => ({
      ...old,
      walls: [{ seat: 0 as const, vertex: at(vertices, 0) }],
    }));
    const nine = roll(engine, inDice(withHand(walled, 0, { brick: 9 })), [3, 4]);
    expect(top(nine)?.id).toBe('main');
    const ten = roll(engine, inDice(withHand(walled, 0, { brick: 10 })), [3, 4]);
    expect(top(ten)).toMatchObject({ id: 'discard', data: { remaining: [0] } });
    const plain = roll(engine, inDice(withHand(state, 0, { brick: 8 })), [3, 4]);
    expect(top(plain)?.id).toBe('discard');
  });
});
