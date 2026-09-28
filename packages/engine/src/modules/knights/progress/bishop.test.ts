import { describe, expect, test } from 'vitest';
import type { GameState } from '../../../core/state/index.js';
import {
  handOf,
  hexOf,
  setRobber,
  top,
  unlockRobber,
  verticesOfHex,
  withBuildings,
  withHand,
} from '../support.js';
import { knightsExt } from '../types.js';
import { engine, held, play, refusal, scene, system, withCards } from './testing.js';

/**
 * The ring hex carries a city of seat 1, two settlements of seat 2 and none of seat 0. The robber is
 * free (the first attack has happened) and stands on the desert.
 */
function position() {
  const { state, hex, ring } = scene();
  let next = withBuildings(state, [
    { vertex: ring[3] ?? '', seat: 2 },
    { vertex: ring[1] ?? '', seat: 2 },
  ]);
  next = withHand(withHand(withHand(next, 0, {}), 1, { brick: 1, cloth: 2 }), 2, { ore: 1 });
  next = setRobber(unlockRobber(next), hexOf(next, 'desert'));
  return { state: withCards(next, 0, 'bishop'), hex, ring };
}

const steal = (state: GameState, victim: number, resource: string) =>
  system(state, { kind: 'system', type: 'STEAL_RESULT', thief: 0, victim, resource });

describe('Bishop', () => {
  test('moves the robber and steals one card from each seat with a building on the hex', () => {
    const { state, hex } = position();
    const played = play(state, 0, 'bishop', { hex });
    expect(played.board.robberHex).toBe(hex);
    // Seat 1 first, in turn order from the player, then seat 2, however many buildings it has there.
    expect(top(played)).toMatchObject({
      id: 'stealResult',
      data: { thief: 0, victim: 1, returnTo: 'pop' },
    });
    expect(engine.getPending(played)).toContainEqual(
      expect.objectContaining({
        systemType: 'STEAL_RESULT',
        request: expect.objectContaining({ victim: 1 }),
      }),
    );
    const one = steal(played, 1, 'cloth');
    expect(handOf(one, 1)).toMatchObject({ brick: 1, cloth: 1 });
    expect(top(one)).toMatchObject({ id: 'stealResult', data: { victim: 2 } });
    const two = steal(one, 2, 'ore');
    expect(top(two)?.id).toBe('main');
    expect(handOf(two, 0)).toMatchObject({ cloth: 1, ore: 1 });
    expect(held(two, 0)).toEqual([]);
  });

  test('a hidden steal is proved as in base: only the count is public', () => {
    const { state, hex } = position();
    const played = play(state, 0, 'bishop', { hex });
    const result = engine.apply(played, {
      kind: 'system',
      type: 'STEAL_RESULT',
      thief: 0,
      victim: 1,
      resource: 'hidden',
    });
    expect(result.ok && result.value.effects).toEqual([
      { type: 'hidden-resource-transfer', from: 1, to: 0, count: 1 },
    ]);
  });

  test('the robber may go to a hex with no building: nobody is robbed', () => {
    const { state } = position();
    const empty = state.board.hexes.find(
      (hex) =>
        hex.id !== state.board.robberHex &&
        !verticesOfHex(state, hex.id).some((vertex) =>
          state.board.buildings.some((piece) => piece.vertex === vertex),
        ),
    );
    if (!empty) throw new Error('No empty hex');
    const played = play(state, 0, 'bishop', { hex: empty.id });
    expect(played.board.robberHex).toBe(empty.id);
    expect(top(played)?.id).toBe('main');
  });

  test('a seat with no card, or a building elsewhere, is not robbed', () => {
    const { state, hex } = position();
    const played = play(withHand(state, 1, {}), 0, 'bishop', { hex });
    expect(top(played)).toMatchObject({ data: { victim: 2 } });
    const only = steal(played, 2, 'ore');
    expect(top(only)?.id).toBe('main');
  });

  test('it needs a free robber, a different land hex, and never takes a progress card', () => {
    const { state, hex } = position();
    const locked = withCards(
      {
        ...state,
        ext: { ...state.ext, knights: { ...knightsExt(state), robberLocked: true } },
      },
      0,
    );
    expect(refusal(locked, 0, 'bishop', { hex })).toBe('illegal-robber-hex');
    const there = setRobber(state, hex);
    expect(refusal(there, 0, 'bishop', { hex })).toBe('illegal-robber-hex');
    expect(refusal(state, 0, 'bishop', { hex: 'nowhere' })).toBe('illegal-robber-hex');
    expect(refusal(state, 0, 'bishop')).toBe('invalid-params');
    // A seat holding only progress cards has an empty resource hand, so it is not a victim.
    const cards = withCards(withHand(state, 1, {}), 1, 'merchant', 'spy');
    expect(top(play(cards, 0, 'bishop', { hex }))).toMatchObject({ data: { victim: 2 } });
  });

  test('every legal hex is listed once the robber is free, and none before', () => {
    const { state } = position();
    const listed = engine
      .getLegalCommands(state, 0)
      .commands.filter((item) => item.type === 'PLAY_PROGRESS_CARD');
    expect(listed).toHaveLength(
      state.board.hexes.filter((hex) => hex.id !== state.board.robberHex).length,
    );
  });
});
