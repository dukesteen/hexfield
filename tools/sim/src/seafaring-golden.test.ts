import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  SEAFARING_GOLDEN_CASES,
  SEAFARING_GOLDEN_DIRECTORY,
  updateSeafaringGoldens,
} from './seafaring-golden.js';

describe('seafaring golden replays', () => {
  test('refuses to write without the explicit update flag', () => {
    expect(() => updateSeafaringGoldens({})).toThrow('explicit update mode');
  });

  test('has one case per seafaring scenario id', () => {
    expect(SEAFARING_GOLDEN_CASES.map((item) => item.scenario)).toEqual([
      'new-horizons',
      'new-horizons-56',
      'four-isles',
      'four-isles-56',
      'fogbound',
      'fogbound-56',
      'desert-crossing',
      'desert-crossing-56',
      'open-sea',
      'open-sea-56',
    ]);
  });

  test('regenerating a case reproduces the committed fixture byte for byte', () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'cp2p-golden-seafaring-'));
    try {
      const fogbound = SEAFARING_GOLDEN_CASES.filter((item) => item.name === 'fogbound');
      updateSeafaringGoldens({ update: true, outputDirectory, cases: fogbound });
      const file = 'fogbound.replay.json';
      expect(readFileSync(join(outputDirectory, file), 'utf8')).toBe(
        readFileSync(join(SEAFARING_GOLDEN_DIRECTORY, file), 'utf8'),
      );
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }, 240_000);
});
