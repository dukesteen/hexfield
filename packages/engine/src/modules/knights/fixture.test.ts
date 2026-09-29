import { describe, expect, test } from 'vitest';
import { BARBARIAN_FIXTURE } from './config.js';
import { knightsConfig, knightsEngine } from './testing.js';

/** A knights game starts, before any random input, with the barbarian track on its board. */
describe('barbarian track fixture', () => {
  test.each([
    { name: 'base', fiveSix: false, slot: 'north' },
    { name: 'five-six', fiveSix: true, slot: 'north-west' },
  ])('$name boards carry it in the declared slot', ({ fiveSix, slot }) => {
    const engine = knightsEngine(fiveSix);
    const state = engine.createGame(knightsConfig({ fiveSix }), new Uint8Array(32).fill(7));
    expect(state.board.fixtures).toHaveLength(1);
    const fixture = state.board.fixtures?.[0];
    expect(fixture).toMatchObject({
      id: BARBARIAN_FIXTURE,
      module: 'knights',
      art: 'barbarian-track',
      slot,
    });
    expect(fixture?.footprint).toHaveLength(2);
  });
});
