import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  KNIGHTS_GOLDEN_CASES,
  KNIGHTS_GOLDEN_DIRECTORY,
  updateKnightsGoldens,
} from './knights-golden.js';

describe('knights golden replays', () => {
  test('refuses to write without the explicit update flag', () => {
    expect(() => updateKnightsGoldens({})).toThrow('explicit update mode');
  });

  test('has five cases: 3, 4 and 4 (progress) seats, then 5 and 6 on knights-56', () => {
    expect(KNIGHTS_GOLDEN_CASES.map((item) => item.name)).toEqual([
      'knights-3p',
      'knights-4p',
      'knights-4p-progress',
      'knights-56-5p',
      'knights-56-6p',
    ]);
  });

  test('regenerating every case reproduces the committed fixtures and manifest byte for byte', () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'cp2p-golden-knights-'));
    try {
      updateKnightsGoldens({ update: true, outputDirectory });
      const files = [
        ...KNIGHTS_GOLDEN_CASES.map((item) => `${item.name}.replay.json`),
        'manifest.json',
      ];
      for (const file of files)
        expect(readFileSync(join(outputDirectory, file), 'utf8')).toBe(
          readFileSync(join(KNIGHTS_GOLDEN_DIRECTORY, file), 'utf8'),
        );
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }, 240_000);
});
