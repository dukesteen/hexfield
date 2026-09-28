import { describe, expect, test } from 'vitest';
import { detectIslands, isLandTerrain } from '../../core/board/index.js';
import { createRng } from '../../core/rng/index.js';
import {
  ARCHIPELAGO_LARGE,
  ARCHIPELAGO_STANDARD,
  archipelagoParamsFor,
  archipelagoProblems,
  generateArchipelago,
  generateArchipelagoLayout,
  pirateStartHex,
  settlementSites,
} from './archipelago.js';
import type { ArchipelagoParams } from './archipelago.js';

function rngFor(seed: number) {
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, seed, true);
  return createRng(bytes);
}

const PRESETS: [string, ArchipelagoParams, number][] = [
  ['standard', ARCHIPELAGO_STANDARD, 200],
  ['large', ARCHIPELAGO_LARGE, 100],
];

describe.each(PRESETS)('archipelago %s', (_name, params, seeds) => {
  test(`constraints hold over ${seeds} seeds`, () => {
    for (let seed = 1; seed <= seeds; seed++) {
      const layout = generateArchipelagoLayout(rngFor(seed), params);
      expect(archipelagoProblems(layout.board, params), `seed ${seed}`).toEqual([]);
      const { board } = layout;
      expect(board.hexes).toHaveLength(params.cols * params.rows);
      const islands = detectIslands(board.hexes);
      expect(islands).toHaveLength(layout.islands.length);
      expect(layout.homeHexes).toEqual(layout.islands[0]);
      const home = islands.find((island) => island.hexes.some((id) => id === layout.homeHexes[0]));
      expect(home?.hexes).toEqual(layout.homeHexes);
      expect(
        settlementSites(board.hexes.filter((hex) => layout.homeHexes.includes(hex.id))),
      ).toBeGreaterThanOrEqual(params.homeSites);
      const pirate = board.hexes.find((hex) => hex.id === layout.pirateHex);
      expect(pirate && isLandTerrain(pirate.terrain)).toBe(false);
      expect(layout.pirateHex).toBe(pirateStartHex(board.hexes));
      expect(board.hexes.find((hex) => hex.id === board.robberHex)?.terrain).toBe('desert');
      expect(board.roads).toEqual([]);
      expect(board.buildings).toEqual([]);
    }
  }, 120_000);

  test('the same random stream gives the same board', () => {
    for (const seed of [3, 17, 92]) {
      const a = generateArchipelago(rngFor(seed), params);
      const b = generateArchipelago(rngFor(seed), params);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  test('different seeds give different boards', () => {
    const boards = new Set<string>();
    for (let seed = 1; seed <= 20; seed++)
      boards.add(
        JSON.stringify(generateArchipelago(rngFor(seed), params).hexes.map((h) => h.terrain)),
      );
    expect(boards.size).toBeGreaterThan(15);
  });
});

describe('archipelago presets', () => {
  test('the large frame starts at five seats', () => {
    expect(archipelagoParamsFor(4)).toBe(ARCHIPELAGO_STANDARD);
    expect(archipelagoParamsFor(5)).toBe(ARCHIPELAGO_LARGE);
  });

  test('a home island always outsizes the other islands', () => {
    for (const params of [ARCHIPELAGO_STANDARD, ARCHIPELAGO_LARGE])
      expect(params.homeSize.min).toBeGreaterThan(params.islandSize.max);
  });

  test('the problem checker flags a broken board', () => {
    const board = generateArchipelago(rngFor(5), ARCHIPELAGO_STANDARD);
    const gold = board.hexes.find((hex) => hex.terrain === 'gold');
    if (!gold) throw new Error('no gold');
    const broken = {
      ...board,
      hexes: board.hexes.map((hex) => (hex === gold ? { ...hex, terrain: 'fields' } : hex)),
    };
    expect(archipelagoProblems(broken, ARCHIPELAGO_STANDARD)).toContain('2 gold fields');
  });
});
