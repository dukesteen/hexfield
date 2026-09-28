import { describe, expect, test } from 'vitest';
import { knightsExt } from '../types.js';
import {
  handOf,
  inMain,
  newGame,
  rejection,
  submit,
  top,
  withBuildings,
  withHand,
  withTokens,
  hexOf,
  verticesOfHex,
  withLevels,
} from '../support.js';
import { engine, inPreRoll, play, refusal, withCards } from './testing.js';

function start() {
  const base = newGame(engine, { seats: 3 });
  return inPreRoll(withCards(base, 0, 'alchemist', 'alchemist'));
}

function dicePending(state: ReturnType<typeof start>) {
  return engine.getPending(state).find((item) => item.kind === 'random');
}

describe('Alchemist', () => {
  test('sets both production dice and only the event die is rolled', () => {
    const played = play(start(), 0, 'alchemist', { dice: [3, 5] });
    expect(knightsExt(played).alchemist).toEqual([3, 5]);
    const rolling = submit(engine, played, 0, { type: 'ROLL_DICE' });
    const pending = dicePending(rolling);
    expect(pending).toMatchObject({
      systemType: 'DICE_RESULT',
      request: { mode: 'fixed', dice: [3, 5] },
    });
    const done = engine.apply(rolling, {
      kind: 'system',
      type: 'DICE_RESULT',
      dice: [3, 5],
      extra: { event: 'ship' },
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.events).toContainEqual(
      expect.objectContaining({ type: 'diceRolled', roll: 8 }),
    );
    // The chosen dice are used up by the roll.
    expect(knightsExt(done.value.state).alchemist).toBeNull();
    expect(top(done.value.state)?.id).toBe('main');
  });

  test('a roll that differs from the chosen dice is refused', () => {
    const rolling = submit(engine, play(start(), 0, 'alchemist', { dice: [3, 5] }), 0, {
      type: 'ROLL_DICE',
    });
    const result = engine.validate(rolling, {
      kind: 'system',
      type: 'DICE_RESULT',
      dice: [3, 4],
      extra: { event: 'ship' },
    });
    expect(result.ok ? null : result.error.code).toBe('fixed-dice-mismatch');
    // The event die is still required.
    expect(engine.validate(rolling, { kind: 'system', type: 'DICE_RESULT', dice: [3, 5] }).ok).toBe(
      false,
    );
  });

  test('a 7 can be chosen, and produces nothing', () => {
    const base = withBuildings(start(), []);
    const played = play(base, 0, 'alchemist', { dice: [3, 4] });
    const rolling = submit(engine, played, 0, { type: 'ROLL_DICE' });
    const done = engine.apply(rolling, {
      kind: 'system',
      type: 'DICE_RESULT',
      dice: [3, 4],
      extra: { event: 'ship' },
    });
    expect(done.ok).toBe(true);
    expect(done.ok && handOf(done.value.state, 0)).toEqual(handOf(base, 0));
  });

  test('the chosen red die is the one the progress card check reads', () => {
    let state = withLevels(start(), 1, { science: 1 });
    // Seat 1 draws on a science gate only when the red die shows 1 or 2.
    state = play(state, 0, 'alchemist', { dice: [5, 1] });
    const rolling = submit(engine, state, 0, { type: 'ROLL_DICE' });
    const done = engine.apply(rolling, {
      kind: 'system',
      type: 'DICE_RESULT',
      dice: [5, 1],
      extra: { event: 'science' },
    });
    expect(done.ok && top(done.value.state)?.id).toBe('main');
    const again = play(withLevels(start(), 1, { science: 1 }), 0, 'alchemist', { dice: [2, 5] });
    const draws = engine.apply(submit(engine, again, 0, { type: 'ROLL_DICE' }), {
      kind: 'system',
      type: 'DICE_RESULT',
      dice: [2, 5],
      extra: { event: 'science' },
    });
    expect(draws.ok && top(draws.value.state)?.id).toBe('drawDev');
  });

  test('only one Alchemist per roll, only before the roll, only faces 1 to 6', () => {
    const played = play(start(), 0, 'alchemist', { dice: [1, 1] });
    expect(refusal(played, 0, 'alchemist', { dice: [2, 2] })).toBe('dice-already-set');
    expect(refusal(start(), 0, 'alchemist', { dice: [0, 6] })).toBe('invalid-dice');
    expect(refusal(start(), 0, 'alchemist', { dice: [1, 7] })).toBe('invalid-dice');
    expect(refusal(start(), 0, 'alchemist', { dice: [1] })).toBe('invalid-dice');
    expect(refusal(start(), 0, 'alchemist')).toBe('invalid-params');
    expect(refusal(start(), 0, 'alchemist', { dice: [1, 2], extra: 1 })).toBe('unknown-field');
    const main = inMain(withCards(newGame(engine, { seats: 3 }), 0, 'alchemist'));
    expect(refusal(main, 0, 'alchemist', { dice: [1, 2] })).toBe('not-before-roll');
    // Another seat cannot play it in seat 0's pre-roll phase.
    const foreign = inPreRoll(withCards(newGame(engine, { seats: 3 }), 1, 'alchemist'));
    expect(refusal(foreign, 1, 'alchemist', { dice: [1, 2] })).not.toBeNull();
  });

  test('its dice choices and the play are listed before the roll only', () => {
    const state = start();
    const legal = engine.getLegalCommands(state, 0).commands;
    expect(legal.filter((item) => item.type === 'PLAY_PROGRESS_CARD')).toHaveLength(72);
    expect(legal.some((item) => item.type === 'ROLL_DICE')).toBe(true);
    const main = inMain(withCards(newGame(engine, { seats: 3 }), 0, 'alchemist'));
    expect(
      engine
        .getLegalCommands(main, 0)
        .commands.filter((item) => item.type === 'PLAY_PROGRESS_CARD'),
    ).toEqual([]);
    expect(rejection(engine, state, 0, { type: 'ROLL_DICE' })).toBeNull();
  });

  test('production follows the chosen dice on every seat', () => {
    const base = newGame(engine, { seats: 3 });
    const forest = hexOf(base, 'forest');
    let state = withTokens(base, { [forest]: 8 });
    state = withBuildings(state, [{ vertex: verticesOfHex(state, forest)[0] ?? '', seat: 1 }]);
    state = inPreRoll(withCards(withHand(state, 1, {}), 0, 'alchemist'));
    const played = play(state, 0, 'alchemist', { dice: [4, 4] });
    const done = engine.apply(submit(engine, played, 0, { type: 'ROLL_DICE' }), {
      kind: 'system',
      type: 'DICE_RESULT',
      dice: [4, 4],
      extra: { event: 'ship' },
    });
    expect(done.ok && handOf(done.value.state, 1).lumber).toBe(1);
  });
});
