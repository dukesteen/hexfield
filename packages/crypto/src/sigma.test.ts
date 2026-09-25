import { canonicalEncode, sha256, toBase64Url } from '@cp2p/codec';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { describe, expect, test } from 'vitest';
import {
  G,
  H,
  SCALAR_ORDER,
  decodePoint,
  decodeScalar,
  encodePoint,
  encodeScalar,
  modScalar,
  scalePoint,
} from './group.js';
import { proofChallenge, proofNonce, readProofArray, readProofRecord } from './proof-transcript.js';
import { proveDleq, proveSchnorr, verifyDleq, verifySchnorr } from './sigma.js';
import type { DleqStatement, SchnorrStatement } from './sigma.js';

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const CONTEXT = { game: 'test-game', parent: 'a'.repeat(64), operation: 7 };

function schnorr(secret: bigint): SchnorrStatement {
  return { base: encodePoint(G), publicPoint: encodePoint(scalePoint(G, secret)) };
}

function dleq(secret: bigint): DleqStatement {
  return {
    base1: encodePoint(G),
    point1: encodePoint(scalePoint(G, secret)),
    base2: encodePoint(H),
    point2: encodePoint(scalePoint(H, secret)),
  };
}

describe('proof transcript', () => {
  test('uses the exact canonical Fiat–Shamir tuple, little-endian digest reduction, and domains', () => {
    const statement = schnorr(7n);
    const commitment = encodePoint(scalePoint(G, 3n));
    const expected = modScalar(
      bytesToNumberLE(
        sha256(canonicalEncode(['cp2p/v1/fiat-shamir', 'schnorr', CONTEXT, statement, commitment])),
      ),
    );
    expect(proofChallenge('schnorr', CONTEXT, statement, commitment)).toBe(expected);
    expect(proofChallenge('dleq', CONTEXT, statement, commitment)).not.toBe(expected);
    expect(proofChallenge('schnorr', { ...CONTEXT, operation: 8 }, statement, commitment)).not.toBe(
      expected,
    );
    expect(() => proofChallenge('schnorr\0dleq', CONTEXT, statement, commitment)).toThrow(/domain/);
  });

  test('nonce binds complete statement, role, context and domain', () => {
    const first = proofNonce(SEED, 'schnorr', CONTEXT, schnorr(7n), 'commitment');
    expect(first).toBeGreaterThan(0n);
    expect(first).toBeLessThan(SCALAR_ORDER);
    expect(proofNonce(SEED, 'schnorr', CONTEXT, schnorr(7n), 'commitment')).toBe(first);
    expect(proofNonce(SEED, 'schnorr', CONTEXT, schnorr(8n), 'commitment')).not.toBe(first);
    expect(proofNonce(SEED, 'dleq', CONTEXT, schnorr(7n), 'commitment')).not.toBe(first);
    expect(proofNonce(SEED, 'schnorr', CONTEXT, schnorr(7n), 'other')).not.toBe(first);
    expect(
      proofNonce(SEED, 'schnorr', { ...CONTEXT, operation: 8 }, schnorr(7n), 'commitment'),
    ).not.toBe(first);
    expect(() => proofNonce(SEED, 'bad/domain', CONTEXT, schnorr(7n), 'commitment')).toThrow(
      /domain/,
    );
  });

  test('record reader snapshots exact own data properties without running getters', () => {
    const source = { commitment: 'a', response: 'b' };
    const copy = readProofRecord(source, ['commitment', 'response']);
    source.commitment = 'changed';
    expect(copy.commitment).toBe('a');
    expect(Object.getPrototypeOf(copy)).toBeNull();
    const nullPrototype: Record<string, unknown> = { a: 1 };
    Object.setPrototypeOf(nullPrototype, null);
    expect(readProofRecord(nullPrototype, ['a']).a).toBe(1);
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'a', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    expect(() => readProofRecord(accessor, ['a'])).toThrow(/data/);
    expect(getterCalls).toBe(0);
    expect(() => readProofRecord({ a: 1, b: 2 }, ['a'])).toThrow(/keys/);
    expect(() => readProofRecord({ a: 1, [Symbol('x')]: 2 }, ['a'])).toThrow(/keys/);
    expect(() => readProofRecord(new Date(0), [])).toThrow(/plain/);
  });

  test('array reader copies exact dense data elements and rejects traps', () => {
    const source = ['a', 'b'];
    const copy = readProofArray(source, 2);
    source[0] = 'changed';
    expect(copy).toEqual(['a', 'b']);
    expect(readProofArray([], 0)).toEqual([]);
    const sparse = ['a', 'b'];
    Reflect.deleteProperty(sparse, '0');
    expect(() => readProofArray(sparse, 2)).toThrow(/array/);
    let getterCalls = 0;
    const accessor = ['a'];
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'a';
      },
    });
    expect(() => readProofArray(accessor, 1)).toThrow(/data/);
    expect(getterCalls).toBe(0);
    const extra = ['a'];
    Object.defineProperty(extra, 'extra', { value: true });
    expect(() => readProofArray(extra, 1)).toThrow(/extra/);
    const symbolic = ['a'];
    Object.defineProperty(symbolic, Symbol('extra'), { value: true });
    expect(() => readProofArray(symbolic, 1)).toThrow(/extra/);
    expect(() => readProofArray(['a', 'b'], 1)).toThrow(/length/);
    expect(() => readProofArray(['a'], -1)).toThrow(/length/);
  });
});

describe('Schnorr proof', () => {
  test('matches the independent verification equation and complete transcript', () => {
    const statement = schnorr(7n);
    const proof = proveSchnorr(statement, 7n, SEED, CONTEXT);
    expect(proof).toEqual({
      commitment: 'bmjL8y_EACocEIMzG0rGGKAouq8qMeMVAtBnKe5agQI',
      response: 'iCwz5B--zfv0GECo6_mRq1xvRzcEuILX86UYl8UpkAg',
    });
    const challenge = proofChallenge('schnorr', CONTEXT, statement, proof.commitment);
    const left = scalePoint(G, decodeScalar(proof.response));
    const right = decodePoint(proof.commitment).add(
      scalePoint(decodePoint(statement.publicPoint), challenge),
    );
    expect(left.equals(right)).toBe(true);
    expect(verifySchnorr(statement, proof, CONTEXT)).toBe(true);
    expect(
      verifySchnorr({ publicPoint: statement.publicPoint, base: statement.base }, proof, {
        operation: 7,
        parent: 'a'.repeat(64),
        game: 'test-game',
      }),
    ).toBe(true);
  });

  test('accepts zero witness, identity target, zero response and identity commitment', () => {
    const statement = schnorr(0n);
    expect(verifySchnorr(statement, proveSchnorr(statement, 0n, SEED, CONTEXT), CONTEXT)).toBe(
      true,
    );
    expect(
      verifySchnorr(
        statement,
        { commitment: encodePoint(scalePoint(G, 0n)), response: encodeScalar(0n) },
        CONTEXT,
      ),
    ).toBe(true);
    expect(() => proveSchnorr(schnorr(1n), 0n, SEED, CONTEXT)).toThrow(/witness/);
    expect(() =>
      proveSchnorr(
        { base: encodePoint(scalePoint(G, 0n)), publicPoint: encodePoint(scalePoint(G, 0n)) },
        0n,
        SEED,
        CONTEXT,
      ),
    ).toThrow(/Identity/);
  });

  test('rejects changed statement, context, proof and hostile shapes without throwing', () => {
    const statement = schnorr(7n);
    const proof = proveSchnorr(statement, 7n, SEED, CONTEXT);
    expect(verifySchnorr(schnorr(8n), proof, CONTEXT)).toBe(false);
    expect(verifySchnorr({ ...statement, base: encodePoint(H) }, proof, CONTEXT)).toBe(false);
    const extraStatement = { ...statement, ignored: 'field' };
    expect(verifySchnorr(extraStatement, proof, CONTEXT)).toBe(false);
    expect(verifySchnorr(statement, proof, { ...CONTEXT, operation: 8 })).toBe(false);
    expect(verifySchnorr(statement, { ...proof, extra: true }, CONTEXT)).toBe(false);
    expect(
      verifySchnorr(statement, { ...proof, response: toBase64Url(new Uint8Array(31)) }, CONTEXT),
    ).toBe(false);
    expect(
      verifySchnorr(
        statement,
        { ...proof, response: toBase64Url(new Uint8Array(32).fill(0xff)) },
        CONTEXT,
      ),
    ).toBe(false);
    expect(
      verifySchnorr(statement, { ...proof, commitment: `${proof.commitment}=` }, CONTEXT),
    ).toBe(false);
    expect(
      verifySchnorr(
        statement,
        Object.defineProperty({}, 'response', {
          get: () => {
            throw new Error('getter');
          },
          enumerable: true,
        }),
        CONTEXT,
      ),
    ).toBe(false);
    expect(Reflect.apply(verifySchnorr, undefined, [null, proof, CONTEXT])).toBe(false);
  });
});

describe('DLEQ proof', () => {
  test('matches both independent Chaum–Pedersen equations', () => {
    const statement = dleq(11n);
    const proof = proveDleq(statement, 11n, SEED, CONTEXT);
    expect(proof).toEqual({
      commitments: [
        'nAjuC313CAEJJwWwrTryIJ1SBov-5-UsM0bSFcmpjjQ',
        'prUGZpMFf5hnUWYPVJmOrFfSdXkjW3Xfisf_v3bUjGM',
      ],
      response: '3qHqS2nJf1dfqJ_psBAOL441fKhatZPXFU9hDVcp8AE',
    });
    const challenge = proofChallenge('dleq', CONTEXT, statement, proof.commitments);
    const response = decodeScalar(proof.response);
    expect(
      scalePoint(G, response).equals(
        decodePoint(proof.commitments[0]).add(scalePoint(decodePoint(statement.point1), challenge)),
      ),
    ).toBe(true);
    expect(
      scalePoint(H, response).equals(
        decodePoint(proof.commitments[1]).add(scalePoint(decodePoint(statement.point2), challenge)),
      ),
    ).toBe(true);
    expect(verifyDleq(statement, proof, CONTEXT)).toBe(true);
  });

  test('accepts zero witness and response, but rejects inconsistent witnesses and identity bases', () => {
    const statement = dleq(0n);
    expect(verifyDleq(statement, proveDleq(statement, 0n, SEED, CONTEXT), CONTEXT)).toBe(true);
    expect(
      verifyDleq(
        statement,
        {
          commitments: [encodePoint(scalePoint(G, 0n)), encodePoint(scalePoint(G, 0n))],
          response: encodeScalar(0n),
        },
        CONTEXT,
      ),
    ).toBe(true);
    expect(() =>
      proveDleq({ ...dleq(4n), point2: encodePoint(scalePoint(H, 5n)) }, 4n, SEED, CONTEXT),
    ).toThrow(/witness/);
    expect(() =>
      proveDleq({ ...statement, base2: encodePoint(scalePoint(G, 0n)) }, 0n, SEED, CONTEXT),
    ).toThrow(/Identity/);
  });

  test('rejects spliced pairs, wrong context, invalid encodings and hostile shapes', () => {
    const statement = dleq(11n);
    const proof = proveDleq(statement, 11n, SEED, CONTEXT);
    const other = proveDleq(dleq(12n), 12n, SEED, CONTEXT);
    expect(
      verifyDleq(
        statement,
        { ...proof, commitments: [proof.commitments[0], other.commitments[1]] },
        CONTEXT,
      ),
    ).toBe(false);
    expect(verifyDleq(statement, proof, { ...CONTEXT, operation: 8 })).toBe(false);
    expect(verifyDleq({ ...statement, base2: encodePoint(G) }, proof, CONTEXT)).toBe(false);
    const extraStatement = { ...statement, ignored: 'field' };
    expect(verifyDleq(extraStatement, proof, CONTEXT)).toBe(false);
    expect(verifyDleq(statement, { ...proof, commitments: [proof.commitments[0]] }, CONTEXT)).toBe(
      false,
    );
    const extra = [proof.commitments[0], proof.commitments[1]];
    Object.defineProperty(extra, 'extra', { value: true });
    expect(verifyDleq(statement, { ...proof, commitments: extra }, CONTEXT)).toBe(false);
    expect(verifyDleq(statement, { ...proof, response: `${proof.response}=` }, CONTEXT)).toBe(
      false,
    );
    expect(
      verifyDleq(statement, { ...proof, commitments: [proof.commitments[0], 'invalid'] }, CONTEXT),
    ).toBe(false);
    expect(Reflect.apply(verifyDleq, undefined, [statement, null, CONTEXT])).toBe(false);
  });
});
