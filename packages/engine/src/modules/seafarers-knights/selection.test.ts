import { describe, expect, test } from 'vitest';
import { fixtureSlotProblem } from '../../core/board/index.js';
import { checkModuleSelection, moduleSelection } from '../catalogue.js';
import { checkModuleCombination } from '../compat.js';
import { perimeterFixtureSlot } from '../seafaring/fixture.js';
import { seafaringConfig, seafaringEngine, testArchipelago } from '../seafaring/testing.js';
import { seafaringExt } from '../seafaring/types.js';
import { COMBO_ID, comboExt } from './types.js';
import { engine, newGame } from './support.js';
import { seafarersKnightsConfig } from './testing.js';

describe('selecting the pair', () => {
  test('seafaring with knights is a scenario-only combination', () => {
    expect(checkModuleCombination(['base', 'seafaring', 'knights']).ok).toBe(false);
    expect(checkModuleCombination(['base', 'seafaring', 'knights'], { viaScenario: true }).ok).toBe(
      true,
    );
  });

  test('the pair needs its rules module, and the rules module needs the pair', () => {
    expect(checkModuleSelection(moduleSelection(['base', 'seafaring', 'knights'])).ok).toBe(false);
    expect(checkModuleSelection(moduleSelection(['base', 'seafaring', COMBO_ID])).ok).toBe(false);
    expect(checkModuleSelection(moduleSelection(['base', 'knights', COMBO_ID])).ok).toBe(false);
    expect(
      checkModuleSelection(moduleSelection(['base', 'seafaring', 'knights', COMBO_ID])).ok,
    ).toBe(true);
    expect(
      checkModuleSelection(moduleSelection(['base', 'five-six', 'seafaring', 'knights', COMBO_ID]))
        .ok,
    ).toBe(true);
  });

  test('a generated archipelago gets its track slot from the board built at genesis', () => {
    const { board: _board, ...config } = seafarersKnightsConfig();
    const generated = {
      ...config,
      options: { ...config.options, seafaring: { layout: 'archipelago-v2', pirateHex: null } },
    };
    for (const seed of [0, 7, 42]) {
      const state = engine.createGame(generated, new Uint8Array(32).fill(seed));
      const [fixture] = state.board.fixtures ?? [];
      expect(fixture).toMatchObject({ id: 'barbarian-track', slot: 'perimeter' });
      const onBoard = new Set(state.board.hexes.map((hex) => hex.id));
      for (const { q, r } of fixture?.footprint ?? [])
        expect(onBoard.has(`h:${q},${r}`)).toBe(false);
      // The pirate waits off the board on the generator's own start hex.
      expect(seafaringExt(state).pirateHex).toBeNull();
      expect(comboExt(state).pirateStart).not.toBeNull();
      expect(engine.checkInvariants(state)).toEqual([]);
    }
  });
});

describe('the barbarian track on an explicit board', () => {
  test('genesis puts the fixture just outside the perimeter, on a harbor-free spot', () => {
    const state = newGame();
    expect(state.board.fixtures).toEqual([
      {
        id: 'barbarian-track',
        module: 'knights',
        slot: 'perimeter',
        footprint: [
          { q: 2, r: -5 },
          { q: 3, r: -6 },
        ],
        orientation: 1,
        art: 'barbarian-track',
      },
    ]);
    const board = testArchipelago();
    const onBoard = new Set(board.hexes.map((hex) => hex.id));
    for (const { q, r } of state.board.fixtures?.[0]?.footprint ?? [])
      expect(onBoard.has(`h:${q},${r}`)).toBe(false);
  });

  test('the slot is a pure function of the board and passes the fixture checks', () => {
    const board = testArchipelago();
    const spec = {
      id: 'test',
      hexes: board.hexes.map(({ q, r }) => ({ q, r })),
      terrains: board.hexes.map((hex) => hex.terrain),
      tokens: [],
      harbors: board.harbors.map((harbor) => harbor.kind),
      harborSlots: board.harbors.map((harbor) => harbor.edge),
      fixtureSlots: [],
      pipCaps: {},
      seafaring: true,
    };
    const slot = perimeterFixtureSlot(spec);
    expect(slot).not.toBeNull();
    expect(perimeterFixtureSlot(spec)).toEqual(slot);
    expect(slot && fixtureSlotProblem(spec, slot)).toBeNull();
    expect(perimeterFixtureSlot({ ...spec, hexes: [], terrains: [] })).toBeNull();
  });

  test('seafaring alone never places a fixture, so its boards hash as before', () => {
    const plain = seafaringEngine().createGame(seafaringConfig(), new Uint8Array(32));
    expect('fixtures' in plain.board).toBe(false);
  });
});
