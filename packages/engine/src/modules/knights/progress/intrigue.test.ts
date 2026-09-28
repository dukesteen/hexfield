import { describe, expect, test } from 'vitest';
import { knightAt, knightsOf } from '../pieces.js';
import { rejection, submit, top, withRoads } from '../support.js';
import { at, engine, held, knightsOn, play, refusal, scene, withCards } from './testing.js';

/** Seat 1 has a strong active knight on ring 2, where seat 0's roads pass, and one on ring 4. */
function position() {
  const { state, ring, out } = scene();
  let next = knightsOn(state, 1, [at(ring, 2)], { level: 2, active: true, ready: false });
  next = knightsOn(next, 1, [at(ring, 4)], { level: 1, active: false, ready: false });
  // Seat 1 owns a road from ring 2 to ring 5 the other way round, so it has somewhere to go.
  next = withRoads(next, 1, [at(ring, 2), at(out, 2)]);
  return { state: withCards(next, 0, 'intrigue'), ring, out };
}

describe('Intrigue', () => {
  test('displaces an opposing knight at the end of the player’s road, whatever its strength', () => {
    const { state, ring } = position();
    const played = play(state, 0, 'intrigue', { vertex: at(ring, 2) });
    expect(knightAt(played, at(ring, 2))).toBeUndefined();
    // No knight of the player moved, and the strong knight is not compared with anything.
    expect(knightsOf(played, 0)).toHaveLength(0);
    expect(top(played)).toMatchObject({
      module: 'knights',
      id: 'displaced',
      data: { seat: 1, level: 2 },
    });
    expect(held(played, 0)).toEqual([]);
  });

  test('the owner relocates the knight as after any displacement, keeping its state', () => {
    const { state, ring, out } = position();
    const played = play(state, 0, 'intrigue', { vertex: at(ring, 2) });
    const legal = engine.getLegalCommands(played, 1).commands;
    expect(legal.every((item) => item.type === 'RELOCATE_KNIGHT')).toBe(true);
    expect(legal.map((item) => item.to)).toContain(at(out, 2));
    // The vertex it stood on is never a destination.
    expect(legal.map((item) => item.to)).not.toContain(at(ring, 2));
    const placed = submit(engine, played, 1, { type: 'RELOCATE_KNIGHT', to: at(out, 2) });
    expect(knightAt(placed, at(out, 2))).toMatchObject({ seat: 1, level: 2, active: true });
    expect(top(placed)?.id).toBe('main');
  });

  test('a knight with nowhere to go is removed at once', () => {
    const { state, ring } = position();
    const played = play(state, 0, 'intrigue', { vertex: at(ring, 4) });
    expect(knightAt(played, at(ring, 4))).toBeUndefined();
    expect(top(played)?.id).toBe('main');
    expect(knightsOf(played, 1)).toHaveLength(1);
  });

  test('the knight must stand where one of the player’s roads ends', () => {
    const { state, ring } = position();
    const far = knightsOn(state, 1, [at(ring, 0)], { level: 1 });
    expect(refusal(withCards(far, 0, 'intrigue'), 0, 'intrigue', { vertex: at(ring, 5) })).toBe(
      'no-target',
    );
    expect(refusal(state, 0, 'intrigue', { vertex: at(ring, 1) })).toBe('no-target');
    expect(refusal(state, 0, 'intrigue', { vertex: 'v:nowhere' })).toBe('no-target');
    expect(refusal(state, 0, 'intrigue')).toBe('invalid-params');
  });

  test('the player’s own knight is not a target', () => {
    const { state, ring } = position();
    const own = knightsOn(state, 0, [at(ring, 3)], { level: 1 });
    expect(refusal(own, 0, 'intrigue', { vertex: at(ring, 3) })).toBe('no-target');
    expect(
      rejection(engine, own, 0, { type: 'DISPLACE_KNIGHT', from: at(ring, 3), to: at(ring, 2) }),
    ).not.toBeNull();
  });

  test('every target is listed', () => {
    const { state, ring } = position();
    const listed = engine
      .getLegalCommands(state, 0)
      .commands.filter((item) => item.type === 'PLAY_PROGRESS_CARD')
      .map((item) => item.params);
    expect(listed).toEqual(
      expect.arrayContaining([{ vertex: at(ring, 2) }, { vertex: at(ring, 4) }]),
    );
  });
});
