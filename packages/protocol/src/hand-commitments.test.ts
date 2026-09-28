import { encodeScalar, pedersenCommit, SCALAR_ORDER } from '@cp2p/crypto';
import { toBase64Url } from '@cp2p/codec';
import { RESOURCES } from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import * as crypto from '@cp2p/crypto';
import {
  applyPublicResourceEffect,
  emptyHandCommitments,
  MAX_HAND_RESOURCE_COUNT,
  validateHandCommitments,
  verifyHandOpening,
} from './hand-commitments.js';

const seats = [0, 2] as const;

function value<T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

function opening(counts: readonly number[], blindings: readonly bigint[]) {
  return {
    counts: Object.fromEntries(RESOURCES.map((resource, index) => [resource, counts[index]])),
    blindings: Object.fromEntries(
      RESOURCES.map((resource, index) => [resource, encodeScalar(blindings[index] ?? 0n)]),
    ),
  };
}

function noncanonicalScalar(scalar: bigint): string {
  const bytes = new Uint8Array(32);
  let remainder = scalar;
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number(remainder & 255n);
    remainder >>= 8n;
  }
  return toBase64Url(bytes);
}

function pointLedger(encoded: string) {
  return [
    {
      seat: 0 as const,
      commitments: Object.fromEntries(RESOURCES.map((resource) => [resource, encoded])),
    },
  ];
}

describe('public hand commitments', () => {
  test('initializes identity commitments in exact seat and resource order', () => {
    const empty = value(emptyHandCommitments(seats));
    expect(empty.map(({ seat }) => seat)).toEqual([0, 2]);
    expect(empty[0]?.commitments).toEqual({
      brick: pedersenCommit(0n, 0n),
      lumber: pedersenCommit(0n, 0n),
      wool: pedersenCommit(0n, 0n),
      grain: pedersenCommit(0n, 0n),
      ore: pedersenCommit(0n, 0n),
    });
    expect(validateHandCommitments(empty, seats)).toEqual({ ok: true, value: empty });
    expect(emptyHandCommitments([2, 0])).toMatchObject({
      ok: false,
      error: { code: 'hand-seats' },
    });
  });

  test('memoizes exact successful point encodings without sharing ledgers or caching failures', () => {
    const encoded = crypto.encodePoint(crypto.scalePoint(crypto.G, 712345n));
    const ledger = [
      {
        seat: 0 as const,
        commitments: Object.fromEntries(RESOURCES.map((resource) => [resource, encoded])),
      },
    ];
    const decode = vi.spyOn(crypto, 'decodePoint');
    try {
      const first = value(validateHandCommitments(ledger, [0]));
      const second = value(validateHandCommitments(ledger, [0]));
      expect(decode).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
      expect(second).not.toBe(first);
      expect(second[0]?.commitments).not.toBe(first[0]?.commitments);
      for (const malformed of ['', encoded + '=', toBase64Url(new Uint8Array(32).fill(255))]) {
        const changed = [
          { ...ledger[0], commitments: { ...ledger[0]?.commitments, brick: malformed } },
        ];
        const before = decode.mock.calls.length;
        expect(validateHandCommitments(changed, [0])).toMatchObject({
          ok: false,
          error: { code: 'hand-commitment-point' },
        });
        expect(validateHandCommitments(changed, [0])).toMatchObject({
          ok: false,
          error: { code: 'hand-commitment-point' },
        });
        expect(decode.mock.calls.length - before).toBe(2);
      }
      expect(validateHandCommitments(ledger, [1]).ok).toBe(false);
    } finally {
      decode.mockRestore();
    }
  });

  test('bounds retained point encodings and revalidates evicted successes', () => {
    const encodings = Array.from({ length: 257 }, (_, index) =>
      crypto.encodePoint(crypto.scalePoint(crypto.G, BigInt(800000 + index))),
    );
    const decode = vi.spyOn(crypto, 'decodePoint');
    try {
      for (const encoded of encodings)
        expect(validateHandCommitments(pointLedger(encoded), [0]).ok).toBe(true);
      expect(decode).toHaveBeenCalledTimes(257);
      expect(validateHandCommitments(pointLedger(encodings[0] ?? ''), [0]).ok).toBe(true);
      expect(decode).toHaveBeenCalledTimes(258);
    } finally {
      decode.mockRestore();
    }
  });

  test('applies fresh public credits and debits as independent group arithmetic', () => {
    const empty = value(emptyHandCommitments(seats));
    const credited = value(
      applyPublicResourceEffect(empty, seats, {
        seat: 0,
        resource: 'wool',
        direction: 'credit',
        count: 3,
      }),
    );
    const debited = value(
      applyPublicResourceEffect(credited, seats, {
        seat: 0,
        resource: 'wool',
        direction: 'debit',
        count: 2,
      }),
    );
    expect(credited[0]?.commitments.wool).toBe(pedersenCommit(3n, 0n));
    expect(debited[0]?.commitments.wool).toBe(pedersenCommit(1n, 0n));
    expect(debited[0]?.commitments.brick).toBe(pedersenCommit(0n, 0n));
    expect(debited[1]).toEqual(empty[1]);
    expect(empty[0]?.commitments.wool).toBe(pedersenCommit(0n, 0n));
    expect(credited).not.toBe(empty);
    expect(credited[0]).not.toBe(empty[0]);
    expect(credited[0]?.commitments).not.toBe(empty[0]?.commitments);
    const blinded = empty.map((row) => ({
      ...row,
      commitments: { ...row.commitments, wool: pedersenCommit(3n, 17n) },
    }));
    const blindedDebit = value(
      applyPublicResourceEffect(blinded, seats, {
        seat: 0,
        resource: 'wool',
        direction: 'debit',
        count: 2,
      }),
    );
    expect(blindedDebit[0]?.commitments.wool).toBe(pedersenCommit(1n, 17n));
    expect(blindedDebit[1]?.commitments.wool).toBe(pedersenCommit(3n, 17n));
  });

  test('validates exact dimensions, canonical points and bounded movement counts', () => {
    const empty = value(emptyHandCommitments(seats));
    expect(validateHandCommitments([empty[0]], seats)).toMatchObject({
      ok: false,
      error: { code: 'hand-seat-count' },
    });
    expect(validateHandCommitments([empty[0], empty[0]], seats)).toMatchObject({
      ok: false,
      error: { code: 'hand-seat-order' },
    });
    expect(
      validateHandCommitments(
        [{ ...empty[0], commitments: { ...empty[0]?.commitments, extra: 'value' } }, empty[1]],
        seats,
      ),
    ).toMatchObject({ ok: false });
    expect(
      validateHandCommitments([{ ...empty[0], commitments: { brick: 'bad' } }, empty[1]], seats),
    ).toMatchObject({ ok: false });
    expect(
      validateHandCommitments(
        [
          { ...empty[0], commitments: { ...empty[0]?.commitments, brick: '_'.repeat(42) + '8' } },
          empty[1],
        ],
        seats,
      ),
    ).toMatchObject({ ok: false, error: { code: 'hand-commitment-point' } });
    expect(validateHandCommitments([...empty, empty[0]], seats).ok).toBe(false);
    expect(validateHandCommitments(empty, [0, 1])).toMatchObject({ ok: false });
    expect(emptyHandCommitments([0, 0]).ok).toBe(false);
    expect(
      applyPublicResourceEffect(empty, seats, {
        seat: 0,
        resource: 'brick',
        direction: 'credit',
        count: -1,
      }),
    ).toMatchObject({ ok: false, error: { code: 'hand-resource-count-range' } });
    expect(
      applyPublicResourceEffect(empty, seats, {
        seat: 0,
        resource: 'brick',
        direction: 'credit',
        count: 0.5,
      }),
    ).toMatchObject({ ok: false });
    expect(
      applyPublicResourceEffect(empty, seats, {
        seat: 0,
        resource: 'brick',
        direction: 'credit',
        count: MAX_HAND_RESOURCE_COUNT + 1,
      }),
    ).toMatchObject({ ok: false, error: { code: 'hand-resource-count-range' } });
    let getterReads = 0;
    const effect = {
      seat: 0,
      resource: 'brick',
      direction: 'credit',
      get count() {
        getterReads++;
        return 1;
      },
    };
    expect(applyPublicResourceEffect(empty, seats, effect).ok).toBe(false);
    expect(getterReads).toBe(0);
  });

  test('checks all owned counts and canonical blindings against the public opening', () => {
    const counts = [1, 2, 0, 4, 3] as const;
    const blindings = [5n, 6n, 7n, 8n, 9n] as const;
    const empty = value(emptyHandCommitments(seats));
    const hand = empty.map((row) => ({ ...row, commitments: { ...row.commitments } }));
    const owner = hand[0];
    if (!owner) throw new Error('Missing owner commitments');
    for (const [index, resource] of RESOURCES.entries()) {
      owner.commitments[resource] = pedersenCommit(
        BigInt(counts[index] ?? 0),
        blindings[index] ?? 0n,
      );
    }
    const witness = opening(counts, blindings);
    expect(verifyHandOpening(hand, seats, 0, witness.counts, witness.blindings)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(
      verifyHandOpening(
        hand,
        seats,
        0,
        opening([1, 2, 0, 4, 2], blindings).counts,
        witness.blindings,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'hand-opening-mismatch' },
    });
    expect(
      verifyHandOpening(hand, seats, 0, witness.counts, { ...witness.blindings, ore: 'invalid' }),
    ).toMatchObject({ ok: false, error: { code: 'hand-opening-scalar' } });
    expect(
      verifyHandOpening(hand, seats, 0, witness.counts, {
        ...witness.blindings,
        ore: noncanonicalScalar(SCALAR_ORDER),
      }),
    ).toMatchObject({ ok: false, error: { code: 'hand-opening-scalar' } });
    expect(
      verifyHandOpening(hand, seats, 0, { ...witness.counts, ore: 64 }, witness.blindings),
    ).toMatchObject({ ok: false, error: { code: 'hand-opening-value' } });
    const missingCount = { ...witness.counts };
    delete missingCount.ore;
    expect(verifyHandOpening(hand, seats, 0, missingCount, witness.blindings)).toMatchObject({
      ok: false,
      error: { code: 'hand-opening-shape' },
    });
    expect(
      verifyHandOpening(hand, seats, 0, { ...witness.counts, extra: 0 }, witness.blindings),
    ).toMatchObject({ ok: false, error: { code: 'hand-opening-shape' } });
    expect(verifyHandOpening(hand, seats, 3, witness.counts, witness.blindings)).toMatchObject({
      ok: false,
      error: { code: 'hand-opening-seat' },
    });
  });
});
