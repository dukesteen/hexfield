import { describe, expect, test } from 'vitest';
import { checkModuleCombination } from '../compat.js';
import { knightsEngine } from './testing.js';
import { knightsExt } from './types.js';
import {
  handOf,
  hexOf,
  inDice,
  inMain,
  newGame,
  roll,
  submit,
  top,
  verticesOfHex,
  withBuildings,
  withHand,
} from './support.js';

const engine = knightsEngine(true);

describe('knights with five-six', () => {
  test('the combination is allowed, and seafaring stays "later"', () => {
    expect(checkModuleCombination(['base', 'five-six', 'knights']).ok).toBe(true);
    expect(checkModuleCombination(['base', 'knights', 'seafaring']).ok).toBe(false);
  });

  test('the bank holds 18 of each commodity and 24 of each resource', () => {
    const state = newGame(engine, { fiveSix: true });
    expect(state.bank).toMatchObject({ cloth: 18, coin: 18, paper: 18, brick: 24, ore: 24 });
    expect(state.config.seats).toHaveLength(5);
    expect(engine.checkInvariants(state)).toEqual([]);
  });

  test('a roll, a 7 and the robber lock work as in the plain game', () => {
    const state = inDice(newGame(engine, { fiveSix: true }));
    const after = roll(engine, state, [3, 4]);
    expect(top(after)?.id).toBe('main');
    expect(knightsExt(after).robberLocked).toBe(true);
  });

  test('a seat can improve a city in its special build phase, and no trade is allowed there', () => {
    const base = newGame(engine, { fiveSix: true });
    const vertex = verticesOfHex(base, hexOf(base, 'hills'))[0] ?? '';
    let state = withHand(withBuildings(inMain(base), [{ vertex, seat: 1, kind: 'city' }]), 1, {
      cloth: 1,
      ore: 4,
    });
    state = submit(engine, state, 0, { type: 'END_TURN' });
    expect(top(state)).toMatchObject({ id: 'sbp', module: 'five-six', data: { seat: 1 } });
    const commands = engine.getLegalCommands(state, 1).commands.map((command) => command.type);
    expect(commands).toContain('BUILD_IMPROVEMENT');
    const built = submit(engine, state, 1, { type: 'BUILD_IMPROVEMENT', track: 'trade' });
    expect(knightsExt(built).improvements[1]?.trade).toBe(1);
    expect(handOf(built, 1).cloth).toBe(0);
    expect(
      engine.validate(built, {
        kind: 'command',
        seat: 1,
        command: { type: 'MARITIME_TRADE', give: { ore: 4 }, get: { brick: 1 } },
      }).ok,
    ).toBe(false);
  });
});
