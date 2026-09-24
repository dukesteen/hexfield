import { describe, expect, test } from 'vitest';
import { createRng } from './index.js';

const seed = Uint8Array.from({ length: 32 }, (_, index) => index);

describe('genesis RNG', () => {
  test('pins the first ten xoshiro128** outputs for bytes 0..31', () => {
    const rng = createRng(seed);
    expect(Array.from({ length: 10 }, () => rng.nextU32())).toEqual([
      2083430046, 2906622144, 3403839221, 2518765844, 2869047265, 859522000, 3766780940, 1019937043,
      2136295971, 2954162452,
    ]);
    expect(createRng(seed).nextU32()).toBe(2083430046);
  });

  test('all seed bytes affect the stream and a subarray uses its own offset', () => {
    const baseline = createRng(seed);
    const expected = Array.from({ length: 10 }, () => baseline.nextU32());
    for (let byte = 0; byte < seed.length; byte++) {
      const changed = Uint8Array.from(seed);
      changed[byte] = (changed[byte] ?? 0) ^ 1;
      const rng = createRng(changed);
      expect(Array.from({ length: 10 }, () => rng.nextU32())).not.toEqual(expected);
    }
    const padded = new Uint8Array(40);
    padded.set(seed, 4);
    const sliced = createRng(padded.subarray(4, 36));
    expect(Array.from({ length: 10 }, () => sliced.nextU32())).toEqual(expected);
  });

  test('int(6) stays within one percent per bucket over 600,000 draws', () => {
    const rng = createRng(seed);
    const counts = [0, 0, 0, 0, 0, 0];
    for (let draw = 0; draw < 600_000; draw++) {
      const bucket = rng.int(6);
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    for (const count of counts) expect(Math.abs(count - 100_000)).toBeLessThanOrEqual(1_000);
  });

  test('shuffle returns a permutation without changing its input', () => {
    const input = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7]);
    const rng = createRng(seed);
    const shuffled = rng.shuffle(input);
    expect(shuffled).not.toBe(input);
    expect(shuffled.toSorted((a, b) => a - b)).toEqual(input);
    expect(input).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(input).toContain(rng.pick(input));
  });

  test('rejects invalid seed and ranges', () => {
    expect(() => createRng(new Uint8Array(31))).toThrow(RangeError);
    const rng = createRng(seed);
    for (const max of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x1_0000_0001]) {
      expect(() => rng.int(max)).toThrow(RangeError);
    }
    expect(() => rng.pick([])).toThrow(RangeError);
    expect(rng.int(1)).toBe(0);
    expect(createRng(seed).int(0x1_0000_0000)).toBe(createRng(seed).nextU32());
  });
});
