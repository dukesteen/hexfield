import { describe, expect, test } from 'vitest';
import type { GameState } from '../../../core/state/index.js';
import { knightAt, knightsOf } from '../pieces.js';
import { rejection, submit, top, withLevels } from '../support.js';
import { at, engine, held, knightsOn, play, refusal, scene, system, withCards } from './testing.js';

/** Seat 1 has a strong active knight at ring 1 and a basic inactive one at ring 2. */
function position(cards: string[] = ['deserter']) {
  const { state, ring } = scene();
  let next = knightsOn(state, 1, [at(ring, 1)], { level: 2, active: true, ready: false });
  next = knightsOn(next, 1, [at(ring, 2)], { level: 1, active: false, ready: false });
  return { state: withCards(next, 0, ...cards), ring };
}

const remove = (state: GameState, vertex: string) =>
  submit(engine, state, 1, { type: 'DESERTER_REMOVE', vertex });

describe('Deserter', () => {
  test('the target removes a knight of its choice and the player places one in its stead', () => {
    const { state, ring } = position();
    const played = play(state, 0, 'deserter', { target: 1 });
    expect(top(played)).toMatchObject({ id: 'deserter', data: { stage: 'remove', target: 1 } });
    const removed = remove(played, at(ring, 1));
    expect(knightAt(removed, at(ring, 1))).toBeUndefined();
    expect(top(removed)).toMatchObject({ data: { stage: 'place', level: 2, active: true } });
    const placed = submit(engine, removed, 0, {
      type: 'DESERTER_PLACE',
      vertex: at(ring, 3),
      level: 2,
    });
    expect(knightAt(placed, at(ring, 3))).toMatchObject({ seat: 0, level: 2, active: true });
    expect(knightsOf(placed, 1)).toHaveLength(1);
    expect(top(placed)?.id).toBe('main');
    expect(held(placed, 0)).toEqual([]);
  });

  test('the new knight has the removed knight’s state, and an active one can act this turn', () => {
    const { state, ring } = position();
    const removed = remove(play(state, 0, 'deserter', { target: 1 }), at(ring, 1));
    const placed = submit(engine, removed, 0, {
      type: 'DESERTER_PLACE',
      vertex: at(ring, 3),
      level: 1,
    });
    expect(knightAt(placed, at(ring, 3))).toMatchObject({ level: 1, active: true, ready: true });
    expect(
      engine
        .getLegalCommands(placed, 0)
        .commands.some((item) => item.type === 'MOVE_KNIGHT' && item.from === at(ring, 3)),
    ).toBe(true);
    const inactive = remove(play(state, 0, 'deserter', { target: 1 }), at(ring, 2));
    const idle = submit(engine, inactive, 0, { type: 'DESERTER_PLACE', vertex: at(ring, 3) });
    expect(knightAt(idle, at(ring, 3))).toMatchObject({ level: 1, active: false, ready: false });
  });

  test('the level may be the removed level or lower, never higher', () => {
    const { state, ring } = position();
    const basic = remove(play(state, 0, 'deserter', { target: 1 }), at(ring, 2));
    expect(
      rejection(engine, basic, 0, { type: 'DESERTER_PLACE', vertex: at(ring, 3), level: 2 }),
    ).toBe('invalid-level');
    const strong = remove(play(state, 0, 'deserter', { target: 1 }), at(ring, 1));
    const lower = submit(engine, strong, 0, {
      type: 'DESERTER_PLACE',
      vertex: at(ring, 3),
      level: 1,
    });
    expect(knightAt(lower, at(ring, 3))?.level).toBe(1);
    expect(
      rejection(engine, strong, 0, { type: 'DESERTER_PLACE', vertex: at(ring, 3), level: 3 }),
    ).toBe('invalid-level');
  });

  test('a mighty knight needs no Fortress', () => {
    const { state, ring } = position();
    const mighty = knightsOn(state, 1, [at(ring, 4)], { level: 3, active: true, ready: false });
    const removed = remove(play(mighty, 0, 'deserter', { target: 1 }), at(ring, 4));
    const placed = submit(engine, removed, 0, {
      type: 'DESERTER_PLACE',
      vertex: at(ring, 3),
      level: 3,
    });
    expect(knightAt(placed, at(ring, 3))?.level).toBe(3);
    expect(withLevels(mighty, 0, {}).ext).toBeDefined();
  });

  test('the site is an empty vertex where one of the player’s roads ends', () => {
    const { state, ring } = position();
    const removed = remove(play(state, 0, 'deserter', { target: 1 }), at(ring, 1));
    // The vertex the removed knight stood on is free again, and is a road end.
    expect(
      rejection(engine, removed, 0, { type: 'DESERTER_PLACE', vertex: at(ring, 5), level: 1 }),
    ).toBe('illegal-knight-site');
    expect(
      rejection(engine, removed, 0, { type: 'DESERTER_PLACE', vertex: at(ring, 2), level: 1 }),
    ).toBe('illegal-knight-site');
    expect(
      rejection(engine, removed, 0, { type: 'DESERTER_PLACE', vertex: at(ring, 1), level: 1 }),
    ).toBeNull();
  });

  test('the player may leave the place empty', () => {
    const { state, ring } = position();
    const removed = remove(play(state, 0, 'deserter', { target: 1 }), at(ring, 1));
    const done = submit(engine, removed, 0, { type: 'DESERTER_SKIP' });
    expect(top(done)?.id).toBe('main');
    expect(knightsOf(done, 0)).toHaveLength(0);
    expect(knightsOf(done, 1)).toHaveLength(1);
  });

  test('when the player cannot place a knight the victim still loses its own', () => {
    const { state, ring } = position();
    // Both basic pieces of seat 0 are on the board, and the strong knight is removed: a strong or
    // basic replacement needs a piece of level 1 or 2, and seat 0 holds the strong ones.
    let crowded = knightsOn(state, 0, [at(ring, 3), at(ring, 4)], { level: 1 });
    crowded = knightsOn(crowded, 0, [at(ring, 0)], { level: 2 });
    const plain = knightsOn(crowded, 0, [at(ring, 5)], { level: 2 });
    const removed = remove(play(plain, 0, 'deserter', { target: 1 }), at(ring, 2));
    expect(top(removed)?.id).toBe('main');
    expect(knightAt(removed, at(ring, 2))).toBeUndefined();
  });

  test('the target needs a knight on the board, and cannot be the player', () => {
    const { state } = position();
    expect(refusal(state, 0, 'deserter', { target: 2 })).toBe('no-target');
    expect(refusal(state, 0, 'deserter', { target: 0 })).toBe('no-target');
    expect(refusal(state, 0, 'deserter', { target: 9 })).toBe('invalid-seat');
    expect(refusal(state, 0, 'deserter')).toBe('invalid-params');
  });

  test('the frames list the choices and time out to a public default', () => {
    const { state, ring } = position();
    const played = play(state, 0, 'deserter', { target: 1 });
    expect(
      engine.getLegalCommands(played, 1).commands.filter((item) => item.type === 'DESERTER_REMOVE'),
    ).toHaveLength(2);
    expect(
      engine.getLegalCommands(played, 0).commands.some((item) => item.type === 'DESERTER_REMOVE'),
    ).toBe(false);
    const timed = system(played, { kind: 'system', type: 'TIMEOUT', seat: 1, phase: 'deserter' });
    // The lowest vertex id is removed.
    expect(knightsOf(timed, 1)).toHaveLength(1);
    const removed = remove(played, at(ring, 1));
    const listed = engine.getLegalCommands(removed, 0).commands;
    expect(listed.some((item) => item.type === 'DESERTER_SKIP')).toBe(true);
    expect(listed.some((item) => item.type === 'DESERTER_PLACE')).toBe(true);
    const placed = system(removed, { kind: 'system', type: 'TIMEOUT', seat: 0, phase: 'deserter' });
    expect(knightsOf(placed, 0)).toHaveLength(1);
  });
});
