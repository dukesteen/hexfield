import { hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, test } from 'vitest';
import { DERIVATION_LABELS, deriveBytes } from './derivation.js';
import { uniformInt } from './uniform.js';

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index);

describe('uniform integer derivation', () => {
  test('pins big-endian sampling and binds label, bound, and context', () => {
    const context = { game: 'kat', round: 3 };
    expect(uniformInt(SEED, 'dice', 6, context)).toBe(2);
    expect(uniformInt(SEED, 'dice', Number.MAX_SAFE_INTEGER, context)).toBe(7_465_448_900_385_618);
    expect(uniformInt(SEED, 'other', Number.MAX_SAFE_INTEGER, context)).not.toBe(
      uniformInt(SEED, 'dice', Number.MAX_SAFE_INTEGER, context),
    );
    expect(uniformInt(SEED, 'dice', 6, { round: 3, game: 'kat' })).toBe(
      uniformInt(SEED, 'dice', 6, context),
    );
    expect(uniformInt(SEED, 'dice', Number.MAX_SAFE_INTEGER, { ...context, round: 4 })).not.toBe(
      uniformInt(SEED, 'dice', Number.MAX_SAFE_INTEGER, context),
    );
  });

  test('retries a pinned out-of-range 64-bit candidate using the next counter domain', () => {
    const seed = hexToBytes('0000053a00000000000000000000000000000000000000000000000000000000');
    const label = 'reject';
    const context = { fixture: 'pinned' };
    const bound = 4_503_599_627_370_497;
    const twoTo64 = 1n << 64n;
    const bigBound = BigInt(bound);
    const limit = twoTo64 - (twoTo64 % bigBound);
    const first = deriveBytes(
      seed,
      DERIVATION_LABELS.uniformInt,
      { label, context, counter: 0 },
      8,
    );
    const firstValue = first.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
    expect(firstValue).toBeGreaterThanOrEqual(limit);

    const retry = deriveBytes(
      seed,
      DERIVATION_LABELS.uniformInt,
      { label, context, counter: 1 },
      8,
    );
    const retryValue = retry.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
    expect(uniformInt(seed, label, bound, context)).toBe(Number(retryValue % bigBound));
    expect(uniformInt(seed, label, bound, context)).toBe(1_436_789_928_787_501);
  });

  test('validates seed, nonempty label, and safe positive exclusive bound', () => {
    for (const bound of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Infinity])
      expect(() => uniformInt(SEED, 'dice', bound, null)).toThrow(/bound/);
    for (const label of ['', '   '])
      expect(() => uniformInt(SEED, label, 6, null)).toThrow(/label/);
    expect(() => uniformInt(SEED, 'x'.repeat(129), 6, null)).toThrow(/label/);
    expect(() => uniformInt(new Uint8Array(31), 'dice', 6, null)).toThrow(/32 bytes/);
    expect(() => uniformInt(SEED, 'dice', 6, { unsupported: undefined })).toThrow(/undefined/);
    expect(uniformInt(SEED, 'singleton', 1, null)).toBe(0);
  });
});
