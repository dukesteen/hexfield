import { describe, expect, test } from 'vitest';
import { createRng } from '../../../../core/rng/index.js';
import { generateBoard, standardHarborSlots, validateStandardBoard } from './index.js';

function seed(index: number): Uint8Array {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, index, true);
  return bytes;
}

const terrains = { forest: 4, pasture: 4, fields: 4, hills: 3, mountains: 3, desert: 1 };
const tokens = { 2: 1, 3: 2, 4: 2, 5: 2, 6: 2, 8: 2, 9: 2, 10: 2, 11: 2, 12: 1 };
const pip = new Map([
  [2, 1],
  [3, 2],
  [4, 3],
  [5, 4],
  [6, 5],
  [8, 5],
  [9, 4],
  [10, 3],
  [11, 2],
  [12, 1],
]);
function count(values: readonly (string | number)[]): Record<string, number> {
  const output: Record<string, number> = {};
  for (const value of values) output[value] = (output[value] ?? 0) + 1;
  return output;
}
function assertComponents(board: ReturnType<typeof generateBoard>): void {
  expect(board.hexes).toHaveLength(19);
  expect(count(board.hexes.map((hex) => hex.terrain))).toEqual(terrains);
  expect(count(board.hexes.flatMap((hex) => (hex.token === null ? [] : [hex.token])))).toEqual(
    tokens,
  );
  expect(count(board.harbors.map((harbor) => harbor.kind))).toEqual({
    generic: 4,
    brick: 1,
    lumber: 1,
    wool: 1,
    grain: 1,
    ore: 1,
  });
  expect(board.harbors.map((harbor) => harbor.edge).toSorted()).toEqual(
    standardHarborSlots().toSorted(),
  );
  expect(board.robberHex).toBe(board.hexes.find((hex) => hex.terrain === 'desert')?.id);
  expect(board.roads).toEqual([]);
  expect(board.buildings).toEqual([]);
}

function assertBalance(board: ReturnType<typeof generateBoard>, strict: boolean): void {
  const byCoord = new Map(board.hexes.map((hex) => [`${hex.q},${hex.r}`, hex]));
  const directions = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
  ];
  const violations: string[] = [];
  for (const hex of board.hexes) {
    for (const [dq, dr] of directions) {
      const next = byCoord.get(`${hex.q + (dq ?? 0)},${hex.r + (dr ?? 0)}`);
      if (!next || hex.token === null || next.token === null) continue;
      if (next.token === hex.token) violations.push('duplicate number');
      if ([6, 8].includes(hex.token) && [6, 8].includes(next.token))
        violations.push('adjacent red');
      if (strict && [2, 12].includes(hex.token) && [2, 12].includes(next.token))
        violations.push('adjacent low');
    }
  }
  if (strict)
    for (const [terrain, amount] of Object.entries(terrains)) {
      if (terrain === 'desert') continue;
      const pips = board.hexes
        .filter((hex) => hex.terrain === terrain)
        .reduce((sum, hex) => sum + (pip.get(hex.token ?? 0) ?? 0), 0);
      if (pips > (amount === 4 ? 14 : 11)) violations.push(`pip cap ${terrain}`);
    }
  expect(violations).toEqual([]);
}

describe('standard board generation', () => {
  test('nine harbor slots have no shared vertex', async () => {
    const { buildBoardGraph } = await import('../../../../core/geometry/index.js');
    const graph = buildBoardGraph(
      Array.from({ length: 5 }, (_, q) => q - 2).flatMap((q) =>
        Array.from({ length: 5 }, (_, r) => r - 2)
          .filter((r) => Math.abs(q + r) <= 2)
          .map((r) => ({ q, r })),
      ),
    );
    const vertices = standardHarborSlots().flatMap(
      (edge) => graph.edgeVertices[graph.edgeIndex[edge] ?? -1] ?? [],
    );
    expect(new Set(vertices).size).toBe(18);
  });

  test.each(['random', 'balanced-random'] as const)(
    '%s is seeded and has exact components',
    (mapLayout) => {
      const first = generateBoard(createRng(seed(42)), { mapLayout, strictBalance: false });
      assertComponents(first);
      expect(generateBoard(createRng(seed(42)), { mapLayout, strictBalance: false })).toEqual(
        first,
      );
      if (mapLayout === 'balanced-random') assertBalance(first, false);
    },
  );

  test.each([false, true])(
    '10,000 balanced seeds with strictBalance=%s',
    (strictBalance) => {
      let checked = 0;
      for (let index = 0; index < 10_000; index++) {
        const board = generateBoard(createRng(seed(index)), {
          mapLayout: 'balanced-random',
          strictBalance,
        });
        assertComponents(board);
        assertBalance(board, strictBalance);
        checked++;
      }
      expect(checked).toBe(10_000);
    },
    120_000,
  );

  test('fixed layout rejects absent and malformed components', () => {
    const board = generateBoard(createRng(seed(11)), {
      mapLayout: 'balanced-random',
      strictBalance: true,
    });
    validateStandardBoard(board);
    expect(() =>
      generateBoard(createRng(seed(11)), { mapLayout: 'standard-fixed', strictBalance: false }),
    ).toThrow('Fixed layout requires config.board');
    expect(() =>
      validateStandardBoard({ ...board, roads: [{ edge: 'e:0,0,W', seat: 0 }] }),
    ).toThrow('Fixed board must start empty');
    expect(() => validateStandardBoard({ ...board, robberHex: 'h:0,0' })).toThrow(
      'Fixed board must start empty',
    );
    expect(() => validateStandardBoard({ ...board, hexes: board.hexes.slice(1) })).toThrow(
      '19 standard hexes',
    );
    expect(() =>
      validateStandardBoard({
        ...board,
        hexes: board.hexes.map((hex, index) => (index === 0 ? { ...hex, token: 99 } : hex)),
      }),
    ).toThrow('incorrect terrain or tokens');
    expect(() => validateStandardBoard({ ...board, harbors: board.harbors.slice(1) })).toThrow(
      'incorrect harbor positions or kinds',
    );
  });
});
