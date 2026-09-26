import { toBase64Url } from '@cp2p/codec';
import {
  decodeScalar,
  encodeScalar,
  identityFromSecret,
  pedersenCommit,
  signObject,
} from '@cp2p/crypto';
import type { Seat } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import {
  countOperationId,
  countProofContext,
  proveCountOpening,
  signCountContribution,
  validateCountOperation,
  verifyCountContribution,
} from './count-reveal.js';
import type { CountOperation } from './count-reveal.js';

const identities = [1, 2, 3].map((byte) => identityFromSecret(new Uint8Array(32).fill(byte)));
const genesisDigest = toBase64Url(new Uint8Array(32).fill(9));
const seeds = [new Uint8Array(32).fill(41), new Uint8Array(32).fill(42)];

function makeOperation(): CountOperation {
  const first = identities[0];
  const second = identities[1];
  if (!first || !second) throw new Error('Missing test identities');
  return {
    protocol: 'monopoly-count-v1',
    genesisDigest,
    epoch: 2,
    anchor: { seq: 12, hash: 'ab'.repeat(32) },
    monopolist: 3,
    resource: 'ore',
    victims: [
      { seat: 0, publicKey: first.peerId, commitment: pedersenCommit(0n, 5n) },
      { seat: 1, publicKey: second.peerId, commitment: pedersenCommit(4n, 17n) },
    ],
  };
}

function prove(
  operation: CountOperation,
  seat: Seat,
  count: number,
  blinding: bigint,
  seed: Uint8Array,
) {
  const proof = proveCountOpening(operation, seat, count, encodeScalar(blinding), seed);
  if (!proof.ok) throw new Error(proof.error.code);
  return proof.value;
}

describe('monopoly count reveal helpers', () => {
  test('proves and verifies zero and positive counts with nonzero blindings', () => {
    const operation = makeOperation();
    const zero = signCountContribution(
      operation,
      0,
      0,
      prove(operation, 0, 0, 5n, seeds[0] ?? new Uint8Array(32)),
      identities[0]?.secretKey ?? new Uint8Array(32),
    );
    const positive = signCountContribution(
      operation,
      1,
      4,
      prove(operation, 1, 4, 17n, seeds[1] ?? new Uint8Array(32)),
      identities[1]?.secretKey ?? new Uint8Array(32),
    );
    expect(verifyCountContribution(zero, operation)).toMatchObject({ ok: true });
    expect(verifyCountContribution(positive, operation)).toMatchObject({ ok: true });
    expect(decodeScalar(encodeScalar(5n))).toBe(5n);
  });

  test('binds proof context and operation identity to every frozen field', () => {
    const operation = makeOperation();
    const baseline = countProofContext(operation, 0, 0);
    expect(countOperationId(operation)).toBe(countOperationId(makeOperation()));
    const mutations: CountOperation[] = [
      { ...operation, genesisDigest: toBase64Url(new Uint8Array(32).fill(10)) },
      { ...operation, epoch: operation.epoch + 1 },
      { ...operation, anchor: { ...operation.anchor, seq: operation.anchor.seq + 1 } },
      { ...operation, anchor: { ...operation.anchor, hash: 'cd'.repeat(32) } },
      { ...operation, resource: 'wool' },
      { ...operation, monopolist: 4 },
      {
        ...operation,
        victims: operation.victims.map((victim) =>
          victim.seat === 0 ? { ...victim, commitment: pedersenCommit(1n, 5n) } : victim,
        ),
      },
      {
        ...operation,
        victims: operation.victims.map((victim) =>
          victim.seat === 0 ? { ...victim, publicKey: identities[2]?.peerId ?? '' } : victim,
        ),
      },
    ];
    for (const changed of mutations) {
      expect(countOperationId(changed)).not.toBe(countOperationId(operation));
      expect(countProofContext(changed, 0, 0)).not.toEqual(baseline);
      const proof = prove(operation, 0, 0, 5n, seeds[0] ?? new Uint8Array(32));
      const signed = signCountContribution(
        operation,
        0,
        0,
        proof,
        identities[0]?.secretKey ?? new Uint8Array(32),
      );
      expect(verifyCountContribution(signed, changed).ok).toBe(false);
    }
  });

  test('rejects malformed, reordered and unbounded operations and contributions', () => {
    const operation = makeOperation();
    expect(validateCountOperation({ ...operation, extra: true }).ok).toBe(false);
    expect(
      validateCountOperation({ ...operation, victims: operation.victims.toReversed() }).ok,
    ).toBe(false);
    expect(
      validateCountOperation({
        ...operation,
        victims: [...operation.victims, operation.victims[0]],
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateCountOperation({
        ...operation,
        victims: [{ ...operation.victims[0], seat: operation.monopolist }, operation.victims[1]],
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateCountOperation({
        ...operation,
        victims: [{ ...operation.victims[0], publicKey: 'invalid-key' }, operation.victims[1]],
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateCountOperation({
        ...operation,
        victims: [{ ...operation.victims[0], commitment: 'malformed-point' }, operation.victims[1]],
      }),
    ).toMatchObject({ ok: false });
    expect(
      validateCountOperation({
        ...operation,
        victims: Array.from({ length: 6 }, (_, index) => ({
          seat: index,
          publicKey: identities[index % identities.length]?.peerId ?? '',
          commitment: pedersenCommit(0n, BigInt(index + 1)),
        })),
      }),
    ).toMatchObject({ ok: false });
  });

  test('rejects wrong owners, counts, proofs, signatures and contribution shapes', () => {
    const operation = makeOperation();
    const key = identities[0]?.secretKey;
    if (!key) throw new Error('Missing owner key');
    const proof = prove(operation, 0, 0, 5n, seeds[0] ?? new Uint8Array(32));
    const signed = signCountContribution(operation, 0, 0, proof, key);
    expect(
      proveCountOpening(operation, 2, 0, encodeScalar(5n), seeds[0] ?? new Uint8Array(32)).ok,
    ).toBe(false);
    const falseCountBody = { ...signed.body, count: 1 };
    const falseCount = {
      body: falseCountBody,
      sig: signObject('monopoly-count', falseCountBody, key),
    };
    expect(verifyCountContribution(falseCount, operation)).toMatchObject({
      ok: false,
      error: { code: 'count-proof' },
    });
    const secondKey = identities[1]?.secretKey;
    if (!secondKey) throw new Error('Missing second owner key');
    expect(() =>
      signCountContribution(
        operation,
        1,
        4,
        prove(operation, 1, 4, 17n, seeds[1] ?? new Uint8Array(32)),
        key,
      ),
    ).toThrow(/key/);
    expect(
      verifyCountContribution(
        { ...signed, sig: `${signed.sig.slice(0, -1)}${signed.sig.endsWith('A') ? 'B' : 'A'}` },
        operation,
      ).ok,
    ).toBe(false);
    expect(verifyCountContribution({ ...signed, extra: true }, operation).ok).toBe(false);
    expect(
      verifyCountContribution({ ...signed, body: { ...signed.body, seat: 1 } }, operation).ok,
    ).toBe(false);
    expect(
      verifyCountContribution({ ...signed, body: { ...signed.body, proof: {} } }, operation).ok,
    ).toBe(false);
  });
});
