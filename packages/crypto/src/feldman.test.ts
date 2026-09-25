import { describe, expect, test } from 'vitest';
import {
  createFeldmanShares,
  recoverSecret,
  verifyFeldmanShare,
  type FeldmanShare,
} from './feldman.js';
import { G, SCALAR_ORDER, encodePoint, scalePoint } from './group.js';

const ENTROPY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const CONTEXT = { ceremonyId: 'attempt-7', dealerSeat: 0, recipientSeats: [1, 2, 3, 4] };

function combinations<T>(values: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  return values.flatMap((value, index) =>
    combinations(values.slice(index + 1), size - 1).map((rest) => [value, ...rest]),
  );
}

describe('Feldman-verified Shamir sharing', () => {
  test('any threshold subset recovers the same canonical secret', () => {
    for (let n = 1; n <= 6; n += 1) {
      const indices = Array.from({ length: n }, (_, index) => index + 1);
      for (let threshold = 1; threshold <= n; threshold += 1) {
        const secret = BigInt(100 + n * 10 + threshold);
        const distributed = createFeldmanShares(secret, indices, threshold, ENTROPY, CONTEXT);
        expect(distributed.commitments).toHaveLength(threshold);
        expect(distributed.commitments[0]).toBe(encodePoint(scalePoint(G, secret)));
        for (const share of distributed.shares)
          expect(verifyFeldmanShare(share, distributed.commitments)).toBe(true);
        for (const subset of combinations(distributed.shares, threshold))
          expect(recoverSecret(subset, threshold)).toBe(secret);
      }
    }
  });

  test('matches an independent polynomial with a zero coefficient and identity commitment', () => {
    // f(x) = 7 + 0·x + 2·x², independently evaluated at x=1,2,3.
    const commitments = [7n, 0n, 2n].map((coefficient) => encodePoint(scalePoint(G, coefficient)));
    const shares: FeldmanShare[] = [
      { index: 1, value: 9n },
      { index: 2, value: 15n },
      { index: 3, value: 25n },
    ];
    expect(commitments[1]).toBe(encodePoint(scalePoint(G, 0n)));
    expect(shares.every((share) => verifyFeldmanShare(share, commitments))).toBe(true);
    expect(recoverSecret(shares, 3)).toBe(7n);

    const zero = createFeldmanShares(0n, [1, 4, 9], 2, ENTROPY, CONTEXT);
    expect(zero.commitments[0]).toBe(encodePoint(scalePoint(G, 0n)));
    expect(zero.shares.every((share) => verifyFeldmanShare(share, zero.commitments))).toBe(true);
    expect(recoverSecret(zero.shares.slice(1), 2)).toBe(0n);
  });

  test('binds coefficients to the full public statement without mutating caller inputs', () => {
    const indices = [5, 1, 3];
    const originalEntropy = ENTROPY.slice();
    const first = createFeldmanShares(42n, indices, 3, ENTROPY, CONTEXT);
    const reordered = createFeldmanShares(42n, [1, 3, 5], 3, ENTROPY, CONTEXT);
    expect(first.commitments).toEqual(reordered.commitments);
    expect(first.shares.map((share) => share.index)).toEqual(indices);
    expect(first.shares.find((share) => share.index === 5)?.value).toBe(
      reordered.shares.find((share) => share.index === 5)?.value,
    );
    expect(ENTROPY).toEqual(originalEntropy);
    expect(indices).toEqual([5, 1, 3]);
    expect(
      createFeldmanShares(42n, indices, 3, ENTROPY, { ...CONTEXT, ceremonyId: 'attempt-8' })
        .commitments,
    ).not.toEqual(first.commitments);
    expect(createFeldmanShares(42n, indices, 2, ENTROPY, CONTEXT).commitments[1]).not.toBe(
      first.commitments[1],
    );
    expect(createFeldmanShares(43n, indices, 3, ENTROPY, CONTEXT).commitments[1]).not.toBe(
      first.commitments[1],
    );
  });

  test('rejects a changed share, commitment, malformed encoding and hostile shape', () => {
    const { shares, commitments } = createFeldmanShares(19n, [1, 2, 3], 2, ENTROPY, CONTEXT);
    const first = shares[0];
    if (!first) throw new Error('Missing test share');
    expect(
      verifyFeldmanShare({ ...first, value: (first.value + 1n) % SCALAR_ORDER }, commitments),
    ).toBe(false);
    expect(verifyFeldmanShare(first, [encodePoint(G), ...commitments.slice(1)])).toBe(false);
    expect(verifyFeldmanShare(first, [`${commitments[0]}=`, ...commitments.slice(1)])).toBe(false);
    expect(verifyFeldmanShare(first, [])).toBe(false);
    expect(
      verifyFeldmanShare(
        first,
        Array.from({ length: 7 }, () => commitments[0]),
      ),
    ).toBe(false);
    for (const bad of [null, {}, { index: 0, value: first.value }, { ...first, extra: 1 }])
      expect(verifyFeldmanShare(bad, commitments)).toBe(false);
    expect(verifyFeldmanShare({ index: 1, value: -1n }, commitments)).toBe(false);
    expect(verifyFeldmanShare({ index: 1, value: SCALAR_ORDER }, commitments)).toBe(false);
    expect(verifyFeldmanShare({ index: 1, value: '1' }, commitments)).toBe(false);
    const accessor = Object.defineProperty({ index: 1 }, 'value', {
      enumerable: true,
      get: () => first.value,
    });
    expect(verifyFeldmanShare(accessor, commitments)).toBe(false);
    expect(verifyFeldmanShare(Object.create(first), commitments)).toBe(false);
    const sparse = commitments.slice(0, 1);
    sparse.length = commitments.length;
    expect(verifyFeldmanShare(first, sparse)).toBe(false);
    const extra = commitments.slice();
    Object.defineProperty(extra, 'extra', { value: 1 });
    expect(verifyFeldmanShare(first, extra)).toBe(false);
  });

  test('rejects invalid distribution and recovery parameters before scalar arithmetic', () => {
    const badIndices = [[0, 2], [1, 1], [1, 65_536], [-1, 2], [1.5, 2], []];
    for (const indices of badIndices)
      expect(() => createFeldmanShares(1n, indices, 1, ENTROPY, CONTEXT)).toThrow(/indices/);
    expect(() => createFeldmanShares(1n, [1, 2], 0, ENTROPY, CONTEXT)).toThrow(/threshold/);
    expect(() => createFeldmanShares(1n, [1, 2], 3, ENTROPY, CONTEXT)).toThrow(/threshold/);
    expect(() => createFeldmanShares(SCALAR_ORDER, [1], 1, ENTROPY, CONTEXT)).toThrow(/secret/);
    expect(() => createFeldmanShares(-1n, [1], 1, ENTROPY, CONTEXT)).toThrow(/secret/);
    expect(() => createFeldmanShares(1n, [1], 1, ENTROPY.subarray(1), CONTEXT)).toThrow(/entropy/);
    expect(() => createFeldmanShares(1n, [1, 2], 2, ENTROPY, { invalid: undefined })).toThrow(
      /undefined/,
    );
    expect(() => createFeldmanShares(1n, [1], 1, ENTROPY, { invalid: undefined })).toThrow(
      /undefined/,
    );

    const shares = createFeldmanShares(17n, [1, 2, 3], 3, ENTROPY, CONTEXT).shares;
    expect(() => recoverSecret(shares.slice(0, 2), 3)).toThrow(/insufficient/);
    expect(() =>
      recoverSecret(
        [
          { index: 1, value: 1n },
          { index: 1, value: 2n },
        ],
        2,
      ),
    ).toThrow(/distinct/);
    expect(() => recoverSecret([{ index: 0, value: 1n }], 1)).toThrow(/indices/);
    expect(() => recoverSecret([{ index: 1, value: SCALAR_ORDER }], 1)).toThrow(/canonical/);
    expect(() => recoverSecret([{ index: 1, value: -1n }], 1)).toThrow(/canonical/);
  });
});
