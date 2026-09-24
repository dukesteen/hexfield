import { describe, expect, test } from 'vitest';
import { runBatch } from './batch.js';
import { emptySummary, mergeSummary } from './stats.js';

describe('simulation batches', () => {
  test('strided workers cover each seeded game exactly once', () => {
    const options = { seed: 918, games: 8, players: 3, baseOptions: { vpTarget: 3 } };
    const serial = runBatch(options);
    const combined = emptySummary();
    const failures = [];
    for (let startIndex = 0; startIndex < 3; startIndex++) {
      const part = runBatch({ ...options, startIndex, stride: 3 });
      mergeSummary(combined, part.summary);
      failures.push(...part.failures);
    }
    expect(serial.failures).toEqual([]);
    expect(failures).toEqual([]);
    expect(combined).toMatchObject({
      games: serial.summary.games,
      turns: serial.summary.turns,
      inputs: serial.summary.inputs,
      wins: serial.summary.wins,
      dice: serial.summary.dice,
      commands: serial.summary.commands,
      awardSwingGames: serial.summary.awardSwingGames,
      applyCount: serial.summary.applyCount,
    });
  });
});
