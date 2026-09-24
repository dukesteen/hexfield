/** Deterministic generator for genesis setup, never for live game inputs. */
export interface Rng {
  /** Draw an unsigned 32-bit integer. */
  nextU32(): number;
  /** Draw uniformly from the integers [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Fisher-Yates shuffle into a new array. */
  shuffle<T>(values: readonly T[]): T[];
  /** Draw an element from a non-empty array. */
  pick<T>(values: readonly T[]): T;
}

const U32_RANGE = 0x1_0000_0000;

function rotateLeft(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function splitmix32(value: number): number {
  let mixed = (value + 0x9e37_79b9) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x85eb_ca6b);
  mixed = Math.imul(mixed ^ (mixed >>> 13), 0xc2b2_ae35);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

/**
 * Create xoshiro128** from exactly 32 bytes. Read eight little-endian u32
 * words, fold them in order with splitmix32, then expand four state words by
 * mixing each corresponding pair with the fold. This consumes all seed bytes
 * and defines the same stream in browsers and Node.
 */
export function createRng(seed: Uint8Array): Rng {
  if (seed.length !== 32) throw new RangeError('RNG seed must contain exactly 32 bytes');

  const view = new DataView(seed.buffer, seed.byteOffset, seed.byteLength);
  const words = Array.from({ length: 8 }, (_, index) => view.getUint32(index * 4, true));
  function word(index: number): number {
    const value = words[index];
    if (value === undefined) throw new Error('Missing RNG seed word');
    return value;
  }

  let folded = 0x9e37_79b9;
  for (const seedWord of words) folded = splitmix32(folded ^ seedWord);
  const initial = (index: number): number =>
    splitmix32(folded ^ word(index) ^ rotateLeft(word(index + 4), index + 1) ^ index);
  let s0 = initial(0);
  let s1 = initial(1);
  let s2 = initial(2);
  let s3 = initial(3);
  if ((s0 | s1 | s2 | s3) === 0) s0 = 0x9e37_79b9;

  function nextU32(): number {
    // xoshiro128** 1.1 transition: https://prng.di.unimi.it/xoshiro128starstar.c
    const result = Math.imul(rotateLeft(Math.imul(s1, 5), 7), 9) >>> 0;
    const shift = s1 << 9;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ shift) >>> 0;
    s3 = rotateLeft(s3, 11);
    return result;
  }

  function int(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > U32_RANGE) {
      throw new RangeError('maxExclusive must be an integer from 1 to 2^32');
    }
    const limit = Math.floor(U32_RANGE / maxExclusive) * maxExclusive;
    let value: number;
    do {
      value = nextU32();
    } while (value >= limit);
    return value % maxExclusive;
  }

  function shuffle<T>(values: readonly T[]): T[] {
    const result = [...values];
    for (let i = result.length - 1; i > 0; i--) {
      const j = int(i + 1);
      // Both positions exist; TypeScript cannot infer that from the loop bounds.
      // oxlint-disable-next-line typescript/no-non-null-assertion
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  }

  function pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new RangeError('Cannot pick from an empty array');
    // oxlint-disable-next-line typescript/no-non-null-assertion
    return values[int(values.length)]!;
  }

  return { nextU32, int, shuffle, pick };
}
