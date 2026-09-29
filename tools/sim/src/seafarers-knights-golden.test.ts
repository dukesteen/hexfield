import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { SCENARIOS } from '@cp2p/maps';
import {
  SEAFARERS_KNIGHTS_GOLDEN_CASES,
  SEAFARERS_KNIGHTS_GOLDEN_DIRECTORY,
  updateSeafarersKnightsGoldens,
} from './seafarers-knights-golden.js';

describe('seafaring with knights golden replays', () => {
  test('refuses to write without the explicit update flag', () => {
    expect(() => updateSeafarersKnightsGoldens({})).toThrow('explicit update mode');
  });

  test('has one case per combined scenario id', () => {
    const combined = SCENARIOS.filter(
      (scenario) => scenario.modules.includes('seafaring') && scenario.modules.includes('knights'),
    ).map((scenario) => scenario.id);
    expect(SEAFARERS_KNIGHTS_GOLDEN_CASES.map((item) => item.scenario)).toEqual(combined);
  });

  test('regenerating a case reproduces the committed fixture byte for byte', () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'cp2p-golden-seafarers-knights-'));
    try {
      const name = 'desert-crossing-knights';
      const cases = SEAFARERS_KNIGHTS_GOLDEN_CASES.filter((item) => item.name === name);
      updateSeafarersKnightsGoldens({ update: true, outputDirectory, cases });
      const file = `${name}.replay.json`;
      expect(readFileSync(join(outputDirectory, file), 'utf8')).toBe(
        readFileSync(join(SEAFARERS_KNIGHTS_GOLDEN_DIRECTORY, file), 'utf8'),
      );
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }, 240_000);
});
