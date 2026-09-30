import { describe, expect, test } from 'vitest';
import { hexId } from '../../../core/geometry/index.js';
import { createRng } from '../../../core/rng/index.js';
import type { BoardState, GameConfig } from '../../../core/state/index.js';
import { engineForConfig, moduleSelection } from '../../catalogue.js';
import { solveTokens } from '../setup/board/index.js';
import { customShapeOf } from './custom.js';

/** A seven-hex flower with no desert: the robber starts on the centre forest. */
function flower(): BoardState {
  const cells: [number, number, string, number][] = [
    [0, 0, 'forest', 5],
    [1, 0, 'hills', 9],
    [1, -1, 'pasture', 4],
    [0, -1, 'fields', 10],
    [-1, 0, 'mountains', 3],
    [-1, 1, 'forest', 11],
    [0, 1, 'fields', 8],
  ];
  return {
    hexes: cells.map(([q, r, terrain, token]) => ({ id: hexId({ q, r }), q, r, terrain, token })),
    harbors: [
      { edge: 'e:1,-1,NE', kind: 'generic' },
      { edge: 'e:-1,1,W', kind: 'ore' },
    ],
    roads: [],
    buildings: [],
    robberHex: 'h:0,0',
  };
}

function customConfig(modules: string[], seats: number, board = flower()): GameConfig {
  return {
    modules: moduleSelection(modules),
    seats: ([0, 1, 2, 3, 4, 5] as const).slice(0, seats),
    options: { base: { mapLayout: 'custom', vpTarget: 8 } },
    board,
  };
}

const near = (a: { q: number; r: number }, b: { q: number; r: number }) =>
  Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(a.q + a.r - b.q - b.r)) === 1;

const create = (config: GameConfig) =>
  engineForConfig(config).createGame(config, new Uint8Array(32));

describe('custom (editor) maps', () => {
  test('a base game starts on any land shape with the robber on land', () => {
    const state = create(customConfig(['base'], 3));
    expect(state.board.hexes).toHaveLength(7);
    expect(state.board.robberHex).toBe('h:0,0');
    expect(state.board.harbors.map((harbor) => harbor.kind).toSorted()).toEqual(['generic', 'ore']);
  });

  test('five-six keeps the editor shape', () => {
    const state = create(customConfig(['base', 'five-six'], 5));
    expect(state.board.hexes).toHaveLength(7);
  });

  test('knights puts its track just outside the perimeter', () => {
    const state = create(customConfig(['base', 'knights'], 3));
    expect(state.board.fixtures).toHaveLength(1);
    const cells = new Set(state.board.hexes.map((hex) => hex.id));
    for (const cell of state.board.fixtures?.[0]?.footprint ?? [])
      expect(cells.has(hexId(cell))).toBe(false);
  });

  test('without the custom layout the fixed board must match the standard shape', () => {
    const config = customConfig(['base'], 3);
    const fixed = { ...config, options: { base: { mapLayout: 'standard-fixed' } } };
    expect(() => create(fixed)).toThrow(/19 standard hexes/);
    expect(customShapeOf(fixed)).toBeNull();
  });

  test('rejects a robber off land, a harbor off the coast and a seafaring terrain', () => {
    const noRobber = { ...flower(), robberHex: null };
    expect(() => create(customConfig(['base'], 3, noRobber))).toThrow(/robber on land/);
    const inland = { ...flower(), harbors: [{ edge: 'e:0,0,NE', kind: 'generic' }] };
    expect(() => create(customConfig(['base'], 3, inland))).toThrow(/harbor/);
    const gold = flower();
    gold.hexes = gold.hexes.map((hex, i) => (i === 1 ? { ...hex, terrain: 'gold' } : hex));
    expect(() => create(customConfig(['base'], 3, gold))).toThrow(/terrain or tokens/);
    const bare = flower();
    bare.hexes = bare.hexes.map((hex, i) => (i === 1 ? { ...hex, token: null } : hex));
    expect(() => create(customConfig(['base'], 3, bare))).toThrow(/terrain or tokens/);
  });
});

describe('solveTokens', () => {
  test('places a bag with no adjacent equal or red numbers, deterministically per seed', () => {
    const slots = flower().hexes;
    const tokens = [6, 8, 6, 8, 5, 9, 4];
    // The centre touches every petal, so two sixes and two eights cannot fit: the search fails.
    expect(solveTokens(createRng(new Uint8Array(32)), slots, tokens)).toBeNull();
    const fair = [6, 8, 5, 9, 4, 10, 3];
    const first = solveTokens(createRng(new Uint8Array(32)), slots, fair);
    expect(first).not.toBeNull();
    expect([...(first?.values() ?? [])].toSorted((a, b) => a - b)).toEqual(
      fair.toSorted((a, b) => a - b),
    );
    const red = (id: string) => [6, 8].includes(first?.get(id) ?? 0);
    const pairs = slots.flatMap((a) => slots.filter((b) => near(a, b)).map((b) => [a.id, b.id]));
    expect(pairs.filter(([a = '', b = '']) => red(a) && red(b))).toEqual([]);
    expect(pairs.filter(([a = '', b = '']) => first?.get(a) === first?.get(b))).toEqual([]);
    expect(solveTokens(createRng(new Uint8Array(32)), slots, fair)).toEqual(first);
  });
});
