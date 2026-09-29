import { describe, expect, test } from 'vitest';
import { knightAt } from '../pieces.js';
import { handOf, submit, withHand, withLevels } from '../support.js';
import { at, engine, held, knightsOn, play, refusal, scene, withCards } from './testing.js';

function position(cards: string[] = ['smith']) {
  const { state, ring } = scene();
  const knights = knightsOn(state, 0, [at(ring, 1)], { level: 1, active: true });
  const more = knightsOn(knights, 0, [at(ring, 2)], { level: 1, active: false, ready: false });
  return { state: withHand(withCards(more, 0, ...cards), 0, {}), ring };
}

describe('Smith', () => {
  test('promotes two knights one level each for free, keeping their state', () => {
    const { state, ring } = position();
    const after = play(state, 0, 'smith', { vertices: [at(ring, 1), at(ring, 2)] });
    expect(knightAt(after, at(ring, 1))).toMatchObject({ level: 2, active: true, ready: true });
    expect(knightAt(after, at(ring, 2))).toMatchObject({ level: 2, active: false, ready: false });
    expect(handOf(after, 0)).toEqual(handOf(state, 0));
    expect(held(after, 0)).toEqual([]);
  });

  test('one knight is enough', () => {
    const { state, ring } = position();
    const after = play(state, 0, 'smith', { vertices: [at(ring, 2)] });
    expect(knightAt(after, at(ring, 1))?.level).toBe(1);
    expect(knightAt(after, at(ring, 2))?.level).toBe(2);
  });

  test('strong to mighty needs the Fortress, and a mighty knight cannot be promoted', () => {
    const { state, ring } = position();
    const strong = play(state, 0, 'smith', { vertices: [at(ring, 1)] });
    const again = withCards(strong, 0, 'smith');
    expect(refusal(again, 0, 'smith', { vertices: [at(ring, 1)] })).toBe('already-promoted');
    // A later turn: the strong knight may become mighty only with politics level 3.
    const later = { ...again, turn: { ...again.turn, number: again.turn.number + 3 } };
    expect(refusal(later, 0, 'smith', { vertices: [at(ring, 1)] })).toBe('no-fortress');
    const fortress = withLevels(later, 0, { politics: 3 });
    const mighty = play(fortress, 0, 'smith', { vertices: [at(ring, 1)] });
    expect(knightAt(mighty, at(ring, 1))?.level).toBe(3);
    const third = { ...withCards(mighty, 0, 'smith'), turn: { ...mighty.turn, number: 20 } };
    expect(refusal(third, 0, 'smith', { vertices: [at(ring, 1)] })).toBe('max-knight');
  });

  test('a knight promoted this turn, by purchase or by Smith, is not promoted again', () => {
    const { state, ring } = position();
    const bought = submit(engine, withHand(state, 0, { wool: 1, ore: 1 }), 0, {
      type: 'PROMOTE_KNIGHT',
      vertex: at(ring, 1),
    });
    expect(refusal(bought, 0, 'smith', { vertices: [at(ring, 1)] })).toBe('already-promoted');
    expect(refusal(bought, 0, 'smith', { vertices: [at(ring, 1), at(ring, 2)] })).toBe(
      'already-promoted',
    );
    expect(refusal(bought, 0, 'smith', { vertices: [at(ring, 2)] })).toBeNull();
  });

  test('the next piece must be in the supply, judged one promotion after the other', () => {
    const { state, ring } = position();
    const crowded = knightsOn(state, 0, [at(ring, 3), at(ring, 4)], { level: 2 });
    // Both strong pieces are on the board, so no basic knight can become strong.
    expect(refusal(crowded, 0, 'smith', { vertices: [at(ring, 1)] })).toBe('no-knight-piece');
  });

  test('bad parameters and other seats’ knights are refused', () => {
    const { state, ring } = position();
    expect(refusal(state, 0, 'smith')).toBe('invalid-params');
    expect(refusal(state, 0, 'smith', { vertices: [] })).toBe('invalid-vertices');
    expect(refusal(state, 0, 'smith', { vertices: [at(ring, 1), at(ring, 1)] })).toBe(
      'invalid-vertices',
    );
    expect(refusal(state, 0, 'smith', { vertices: [at(ring, 1), at(ring, 2), at(ring, 3)] })).toBe(
      'invalid-vertices',
    );
    expect(refusal(state, 0, 'smith', { vertices: [at(ring, 5)] })).toBe('no-knight');
  });

  test('single and paired promotions are listed', () => {
    const { state } = position();
    const listed = engine
      .getLegalCommands(state, 0)
      .commands.filter((item) => item.type === 'PLAY_PROGRESS_CARD');
    expect(listed).toHaveLength(3);
  });
});
