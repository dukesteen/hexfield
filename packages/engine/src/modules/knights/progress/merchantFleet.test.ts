import { describe, expect, test } from 'vitest';
import { handOf, submit, withHand } from '../support.js';
import { knightsExt } from '../types.js';
import { engine, held, play, refusal, scene, withCards } from './testing.js';

function position(cards: string[] = ['merchantFleet']) {
  const { state } = scene();
  return withHand(withCards(state, 0, ...cards), 0, { wool: 8, cloth: 4, ore: 2 });
}

const trade = (state: ReturnType<typeof position>, give: Record<string, number>, get: string) =>
  submit(engine, state, 0, { type: 'MARITIME_TRADE', give, get: { [get]: 1 } });

describe('Merchant Fleet', () => {
  test('a named resource trades 2:1 any number of times for the rest of the turn', () => {
    const after = play(position(), 0, 'merchantFleet', { kind: 'wool' });
    expect(knightsExt(after).fleet).toEqual({ seat: 0, kinds: ['wool'] });
    const once = trade(after, { wool: 2 }, 'grain');
    const twice = trade(once, { wool: 2 }, 'lumber');
    const thrice = trade(twice, { wool: 2 }, 'brick');
    expect(handOf(thrice, 0)).toMatchObject({ wool: 2, grain: 1, lumber: 1, brick: 1 });
    expect(held(after, 0)).toEqual([]);
    // Other kinds keep their rate.
    expect(
      engine.validate(after, {
        kind: 'command',
        seat: 0,
        command: { type: 'MARITIME_TRADE', give: { ore: 2 }, get: { grain: 1 } },
      }).ok,
    ).toBe(false);
  });

  test('a commodity may be named, and it trades 2:1', () => {
    const after = play(position(), 0, 'merchantFleet', { kind: 'cloth' });
    const traded = trade(after, { cloth: 2 }, 'coin');
    expect(handOf(traded, 0)).toMatchObject({ cloth: 2, coin: 1 });
  });

  test('two fleets in a turn name two kinds, and one kind cannot be named twice', () => {
    const state = position(['merchantFleet', 'merchantFleet']);
    const first = play(state, 0, 'merchantFleet', { kind: 'wool' });
    expect(refusal(first, 0, 'merchantFleet', { kind: 'wool' })).toBe('already-named');
    const second = play(first, 0, 'merchantFleet', { kind: 'ore' });
    expect(knightsExt(second).fleet?.kinds).toEqual(['wool', 'ore']);
    expect(engine.hooks.bankRate(second, 0, 'ore', 4)).toBe(2);
    expect(engine.hooks.bankRate(second, 0, 'wool', 4)).toBe(2);
  });

  test('the window ends with the turn and belongs to the player', () => {
    const after = play(position(), 0, 'merchantFleet', { kind: 'wool' });
    expect(engine.hooks.bankRate(after, 1, 'wool', 4)).toBe(4);
    const ended = submit(engine, after, 0, { type: 'END_TURN' });
    expect(knightsExt(ended).fleet).toBeNull();
    expect(engine.hooks.bankRate(ended, 0, 'wool', 4)).toBe(4);
  });

  test('a better harbor rate is kept, and the kind must exist', () => {
    const after = play(position(), 0, 'merchantFleet', { kind: 'wool' });
    expect(engine.hooks.bankRate(after, 0, 'wool', 2)).toBe(2);
    expect(refusal(position(), 0, 'merchantFleet', { kind: 'gold' })).toBe('invalid-kind');
    expect(refusal(position(), 0, 'merchantFleet')).toBe('invalid-params');
  });

  test('every kind is listed', () => {
    const listed = engine
      .getLegalCommands(position(), 0)
      .commands.filter((item) => item.type === 'PLAY_PROGRESS_CARD');
    expect(listed).toHaveLength(8);
  });
});
