import { describe, expect, test } from 'vitest';
import {
  handOf,
  hexOf,
  inMain,
  newGame,
  roll,
  setRobber,
  unlockRobber,
  verticesOfHex,
  withBuildings,
  withHand,
  withTokens,
} from '../support.js';
import { engine, play, refusal, withCards } from './testing.js';

/** Five hexes carrying the tokens 3, 4, 5, 9 and 6, with a desert and a fixed token kept apart. */
function board() {
  const base = newGame(engine, { seats: 3 });
  const ids = base.board.hexes.filter((hex) => hex.terrain !== 'sea').map((hex) => hex.id);
  const [a, b, c, d, e, desert] = ids;
  if (!a || !b || !c || !d || !e || !desert) throw new Error('board too small');
  const state = withTokens(base, { [a]: 3, [b]: 4, [c]: 5, [d]: 9, [e]: 6 });
  return { state: withCards(inMain(state), 0, 'inventor'), a, b, c, d, e, desert };
}

const tokens = (state: ReturnType<typeof board>['state']) =>
  Object.fromEntries(state.board.hexes.map((hex) => [hex.id, hex.token]));

describe('Inventor', () => {
  test('swaps two tokens, wherever they are and without any building', () => {
    const { state, a, b } = board();
    const after = play(state, 0, 'inventor', { hexes: [a, b] });
    expect(tokens(after)[a]).toBe(4);
    expect(tokens(after)[b]).toBe(3);
    expect(after.board.hexes.filter((hex) => hex.token !== null)).toHaveLength(5);
  });

  test('the 2, 6, 8 and 12 tokens stay where they are', () => {
    const { state, a, e } = board();
    expect(refusal(state, 0, 'inventor', { hexes: [a, e] })).toBe('fixed-token');
    const eight = withTokens(state, { [a]: 8, [e]: 3 });
    expect(refusal(eight, 0, 'inventor', { hexes: [a, e] })).toBe('fixed-token');
    for (const fixed of [2, 12]) {
      const other = withTokens(state, { [a]: fixed, [e]: 3 });
      expect(refusal(other, 0, 'inventor', { hexes: [e, a] })).toBe('fixed-token');
    }
  });

  test('equal values, one hex twice, a desert and a missing token are refused', () => {
    const { state, a, b, c, desert } = board();
    const same = withTokens(state, { [a]: 4, [b]: 4 });
    expect(refusal(same, 0, 'inventor', { hexes: [a, b] })).toBe('same-token');
    expect(refusal(state, 0, 'inventor', { hexes: [a, a] })).toBe('same-hex');
    expect(refusal(state, 0, 'inventor', { hexes: [a, desert] })).toBe('no-token');
    expect(refusal(state, 0, 'inventor', { hexes: [a, 'h:nowhere'] })).toBe('not-land');
    expect(refusal(state, 0, 'inventor', { hexes: [a] })).toBe('invalid-hexes');
    expect(refusal(state, 0, 'inventor', { hexes: [a, c, b] })).toBe('invalid-hexes');
  });

  test('the robber stays on its hex and blocks the number that arrives', () => {
    const { state, a, b } = board();
    const forest = hexOf(state, 'forest');
    const scene = withTokens(state, { [forest]: 5, [a]: 3, [b]: 9 });
    const built = withBuildings(scene, [
      { vertex: verticesOfHex(scene, forest)[0] ?? '', seat: 1 },
    ]);
    const guarded = setRobber(unlockRobber(withHand(built, 1, {})), forest);
    // Swap the robber's 5 for a 3: the robber still sits on the forest, which now carries the 3.
    const after = play(withCards(guarded, 0, 'inventor'), 0, 'inventor', { hexes: [forest, a] });
    expect(after.board.robberHex).toBe(forest);
    const rolled = roll(
      engine,
      { ...after, turn: { ...after.turn, phase: [{ id: 'dice', module: 'base', data: null }] } },
      [1, 2],
    );
    expect(handOf(rolled, 1).lumber).toBe(0);
  });

  test('every legal swap is listed', () => {
    const { state, a, b, c, d } = board();
    const listed = engine
      .getLegalCommands(state, 0)
      .commands.filter((item) => item.type === 'PLAY_PROGRESS_CARD')
      .map((item) => JSON.stringify(item.params));
    // Tokens 3, 4, 5 and 9 pair up six ways; the 6 never moves.
    expect(listed).toHaveLength(6);
    for (const pair of [
      [a, b],
      [a, c],
      [a, d],
      [b, c],
      [b, d],
      [c, d],
    ]) {
      const key = JSON.stringify({ hexes: pair.toSorted() });
      expect(listed).toContain(key);
    }
  });
});
