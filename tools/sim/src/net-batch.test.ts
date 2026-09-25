import { describe, expect, test } from 'vitest';
import { parseNetBatchOptions, partitionGameIndices } from './net-batch.js';

describe('network simulation CLI options', () => {
  test('defaults to one seed, scenario one, seed 42, and one worker', () => {
    expect(parseNetBatchOptions([])).toEqual({
      seeds: 1,
      startIndex: 0,
      scenario: 1,
      seed: 42,
      parallel: 1,
    });
  });

  test('parses deterministic scenario and bounded parallelism', () => {
    expect(
      parseNetBatchOptions([
        '--scenario',
        '9',
        '--seeds',
        '12',
        '--start-index',
        '200',
        '--seed',
        '2026',
        '--parallel',
        '4',
      ]),
    ).toEqual({ seeds: 12, startIndex: 200, scenario: 9, seed: 2026, parallel: 4 });
  });

  test('shards use distinct deterministic game indices within the requested range', () => {
    const shards = partitionGameIndices({
      seeds: 10,
      startIndex: 40,
      scenario: 3,
      seed: 42,
      parallel: 3,
    });
    expect(shards).toEqual([
      [40, 43, 46, 49],
      [41, 44, 47],
      [42, 45, 48],
    ]);
    expect(shards.flat().toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 10 }, (_, index) => 40 + index),
    );
  });

  test.each([
    [['--scenario'], /--scenario needs an integer value/],
    [['--scenario', '1.5'], /--scenario needs an integer value/],
    [['--scenario', '0'], /--scenario must be between 1 and 9/],
    [['--scenario', '10'], /--scenario must be between 1 and 9/],
    [['--seeds', '0'], /--seeds must be positive/],
    [['--start-index', '-1'], /--start-index must be non-negative/],
    [['--start-index', '9007199254740991', '--seeds', '2'], /safe game-index range/],
    [['--seed', '-1'], /--seed must be non-negative/],
    [['--parallel', '17'], /--parallel must be between 1 and 16/],
    [['--unknown', '1'], /Unknown network option --unknown/],
    [['--seed', '1', '--seed', '2'], /Duplicate network option --seed/],
  ] as const)('rejects malformed arguments %j', (args, message) => {
    expect(() => parseNetBatchOptions(args)).toThrow(message);
  });
});
