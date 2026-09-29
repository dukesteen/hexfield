import { describe, expect, test } from 'vitest';
import type { GameState } from '../../core/state/index.js';
import { knightsEngine } from './testing.js';
import {
  handOf,
  hexOf,
  inDice,
  newGame,
  rejection,
  roll,
  setRobber,
  submit,
  top,
  verticesOfHex,
  withBuildings,
  withHand,
  withLevels,
  withTokens,
} from './support.js';

const engine = knightsEngine();

/**
 * Seat 0 (active) and seat 1 both have an Aqueduct. Seat 0 has a city on a forest token 8;
 * seat 1 stands on nothing. Roll 8 pays seat 0 only.
 */
function scene(opts: { seat0Aqueduct?: boolean; seat0Kind?: string } = {}): GameState {
  const base = newGame(engine, { seats: 3 });
  const forest = hexOf(base, 'forest');
  const other = hexOf(base, 'hills');
  let state = withTokens(setRobber(base, hexOf(base, 'desert')), { [forest]: 8 });
  state = withBuildings(state, [
    { vertex: verticesOfHex(base, forest)[0] ?? '', seat: 0, kind: opts.seat0Kind ?? 'settlement' },
    { vertex: verticesOfHex(base, other)[0] ?? '', seat: 1 },
    { vertex: verticesOfHex(base, other)[3] ?? '', seat: 2 },
  ]);
  state = withLevels(state, 1, { science: 3 });
  state = withLevels(state, 2, { science: 3 });
  if (opts.seat0Aqueduct) state = withLevels(state, 0, { science: 3 });
  return inDice(state);
}

const EIGHT: [number, number] = [4, 4];

describe('Aqueduct', () => {
  test('seats with an Aqueduct and no card take one resource, in turn order from the active seat', () => {
    const after = roll(engine, scene(), EIGHT);
    expect(top(after)).toMatchObject({
      id: 'aqueduct',
      module: 'knights',
      data: { queue: [1, 2] },
    });
    const [pending] = engine.getPending(after);
    expect(pending).toMatchObject({ kind: 'player', seat: 1 });
    expect(rejection(engine, after, 2, { type: 'CHOOSE_AQUEDUCT', resource: 'ore' })).toBe(
      'not-pending',
    );
    expect(rejection(engine, after, 1, { type: 'CHOOSE_AQUEDUCT', resource: 'paper' })).toBe(
      'invalid-aqueduct-choice',
    );
    const first = submit(engine, after, 1, { type: 'CHOOSE_AQUEDUCT', resource: 'ore' });
    expect(handOf(first, 1).ore).toBe(1);
    expect(top(first)).toMatchObject({ id: 'aqueduct', data: { queue: [2] } });
    const second = submit(engine, first, 2, { type: 'CHOOSE_AQUEDUCT', resource: 'grain' });
    expect(top(second)?.id).toBe('main');
    expect(handOf(second, 2).grain).toBe(1);
    expect(engine.checkInvariants(second)).toEqual([]);
  });

  test('a seat that received any card does not qualify', () => {
    const after = roll(engine, scene({ seat0Aqueduct: true }), EIGHT);
    expect(top(after)).toMatchObject({ id: 'aqueduct', data: { queue: [1, 2] } });
  });

  test('a commodity alone counts as production', () => {
    const state = withLevels(scene({ seat0Kind: 'city' }), 0, { science: 3 });
    const after = roll(engine, withHand(state, 0, {}), EIGHT);
    expect(handOf(after, 0)).toMatchObject({ lumber: 1, paper: 1 });
    expect(top(after)).toMatchObject({ data: { queue: [1, 2] } });
    // Lumber gone from the bank, so seat 0 gets only paper: still production.
    const short = roll(engine, { ...state, bank: { ...state.bank, lumber: 0 } }, EIGHT);
    expect(handOf(short, 0)).toMatchObject({ lumber: 0, paper: 1 });
    expect(top(short)).toMatchObject({ data: { queue: [1, 2] } });
  });

  test('a seat blocked by the robber, or by a bank shortage, still qualifies', () => {
    const state = withLevels(scene(), 0, { science: 3 });
    const forest = hexOf(state, 'forest');
    const blocked = roll(engine, setRobber(state, forest), EIGHT);
    expect(top(blocked)).toMatchObject({ data: { queue: [0, 1, 2] } });
    const short = roll(engine, { ...state, bank: { ...state.bank, lumber: 0 } }, EIGHT);
    expect(top(short)).toMatchObject({ data: { queue: [0, 1, 2] } });
  });

  test('a roll that pays nobody opens the choice for every Aqueduct seat', () => {
    const after = roll(engine, scene(), [1, 1]);
    expect(top(after)).toMatchObject({ data: { queue: [1, 2] } });
  });

  test('a 7 never triggers it', () => {
    const after = roll(engine, scene(), [3, 4]);
    expect(top(after)?.id).toBe('main');
  });

  test('without level 3 there is no choice', () => {
    const state = withLevels(withLevels(scene(), 1, { science: 2 }), 2, { science: 2 });
    expect(top(roll(engine, state, EIGHT))?.id).toBe('main');
    // Other tracks at level 3 do not count.
    const wrong = withLevels(withLevels(state, 1, { trade: 3 }), 2, { politics: 3 });
    expect(top(roll(engine, wrong, EIGHT, 'ship'))?.id).toBe('main');
  });

  test('an empty resource bank opens nothing, and a bank running dry ends the queue', () => {
    const state = scene();
    const empty = {
      ...state,
      bank: { ...state.bank, brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 },
    };
    expect(top(roll(engine, empty, [1, 1]))?.id).toBe('main');
    const one = { ...empty, bank: { ...empty.bank, ore: 1 } };
    const after = roll(engine, one, [1, 1]);
    expect(
      engine.getLegalCommands(after, 1).commands.filter((c) => c.type === 'CHOOSE_AQUEDUCT'),
    ).toEqual([{ type: 'CHOOSE_AQUEDUCT', resource: 'ore' }]);
    const done = submit(engine, after, 1, { type: 'CHOOSE_AQUEDUCT', resource: 'ore' });
    expect(top(done)?.id).toBe('main');
    expect(handOf(done, 2).ore).toBe(0);
  });

  test('a timeout takes the first resource the bank holds', () => {
    const after = roll(engine, scene(), [1, 1]);
    const timed = engine.apply(after, {
      kind: 'system',
      type: 'TIMEOUT',
      seat: 1,
      phase: 'aqueduct',
    });
    if (!timed.ok) throw new Error(timed.error.message);
    expect(handOf(timed.value.state, 1).brick).toBe(1);
  });
});
