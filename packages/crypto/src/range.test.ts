import { toBase64Url } from '@cp2p/codec';
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
import { proofChallenge } from './proof-transcript.js';
import {
  inspectBitProof,
  inspectRangeProof,
  pedersenCommit,
  prepareRangeProof,
  proveBit,
  proveRange,
  simulateRangeProof,
  verifyBit,
  verifyRange,
} from './range.js';
import type { RangeProof, RangeStatement } from './range.js';

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 17);
const CONTEXT = { genesis: 'g'.repeat(43), parent: 'a'.repeat(64), operation: 9 };

function statement(value: bigint, blinding: bigint, bits = 6): RangeStatement {
  return { commitment: pedersenCommit(value, blinding), bits };
}

function replaceProof(
  proof: RangeProof,
  index: number,
  replacement: RangeProof['proofs'][number],
): RangeProof {
  return {
    commitments: proof.commitments,
    proofs: proof.proofs.map((bit, at) => (at === index ? replacement : bit)),
  };
}

describe('Pedersen and bit proofs', () => {
  test('commitments support the identity and reject noncanonical field values', () => {
    const identity = encodePoint(scalePoint(G, 0n));
    expect(pedersenCommit(0n, 0n)).toBe(identity);
    expect(
      decodePoint(pedersenCommit(2n, 3n)).equals(scalePoint(G, 2n).add(scalePoint(H, 3n))),
    ).toBe(true);
    for (const invalid of [-1n, SCALAR_ORDER]) {
      expect(() => pedersenCommit(invalid, 0n)).toThrow(/canonical/);
      expect(() => pedersenCommit(0n, invalid)).toThrow(/canonical/);
    }
  });

  test('bit OR equations, including a zero response and identity first messages', () => {
    for (const bit of [0, 1] as const) {
      const commitment = pedersenCommit(BigInt(bit), 0n);
      const proof = proveBit(commitment, bit, 0n, SEED, CONTEXT);
      const inspected = inspectBitProof(commitment, proof);
      const e0 = decodeScalar(proof.challenges[0]);
      const e1 = decodeScalar(proof.challenges[1]);
      const z0 = decodeScalar(proof.responses[0]);
      const z1 = decodeScalar(proof.responses[1]);
      expect(modScalar(e0 + e1)).toBe(inspected.challenge);
      const target = decodePoint(commitment);
      expect(
        scalePoint(H, z0).equals(
          decodePoint(inspected.announcements[0]).add(scalePoint(target, e0)),
        ),
      ).toBe(true);
      expect(
        scalePoint(H, z1).equals(
          decodePoint(inspected.announcements[1]).add(scalePoint(target.subtract(G), e1)),
        ),
      ).toBe(true);
      expect(verifyBit(commitment, proof, CONTEXT)).toBe(true);
      expect(verifyBit(commitment, proof, { ...CONTEXT, operation: 10 })).toBe(false);
      expect(
        verifyBit(bit === 0 ? pedersenCommit(1n, 0n) : pedersenCommit(0n, 0n), proof, CONTEXT),
      ).toBe(false);
    }
    const identity = pedersenCommit(0n, 0n);
    const zeroFirstMessages = [identity, identity] as const;
    const challenge = proofChallenge('bit', CONTEXT, identity, zeroFirstMessages);
    expect(
      verifyBit(
        identity,
        {
          challenges: [encodeScalar(challenge), encodeScalar(0n)],
          responses: [encodeScalar(0n), encodeScalar(0n)],
        },
        CONTEXT,
      ),
    ).toBe(true);
    expect(
      verifyBit(
        identity,
        {
          challenges: [encodeScalar(0n), encodeScalar(challenge)],
          responses: [encodeScalar(0n), encodeScalar(0n)],
        },
        CONTEXT,
      ),
    ).toBe(false);
    expect(() => proveBit(identity, 1, 0n, SEED, CONTEXT)).toThrow(/witness/);
    expect(() => Reflect.apply(proveBit, undefined, [identity, 2, 0n, SEED, CONTEXT])).toThrow(
      /Bit/,
    );
  });
});

describe('range proof', () => {
  test('proves every six-bit value and independently checks weighted sum and shared equations', () => {
    for (let value = 0; value < 64; value += 1) {
      const blinding = BigInt(value * 17) % SCALAR_ORDER;
      const claim = statement(BigInt(value), blinding);
      const context = { ...CONTEXT, operation: value };
      const proof = proveRange(claim, BigInt(value), blinding, SEED, context);
      expect(verifyRange(claim, proof, context)).toBe(true);
      const inspected = inspectRangeProof(claim, proof);
      let weighted = scalePoint(G, 0n);
      for (let bit = 0; bit < claim.bits; bit += 1) {
        weighted = weighted.add(
          scalePoint(decodePoint(proof.commitments[bit] ?? ''), 1n << BigInt(bit)),
        );
        const bitProof = proof.proofs[bit];
        if (!bitProof) throw new Error('Missing bit proof');
        const e0 = decodeScalar(bitProof.challenges[0]);
        const e1 = decodeScalar(bitProof.challenges[1]);
        expect(modScalar(e0 + e1)).toBe(inspected.challenge);
        const target = decodePoint(proof.commitments[bit] ?? '');
        const [a0, a1] = inspected.announcements[bit] ?? [];
        expect(
          scalePoint(H, decodeScalar(bitProof.responses[0])).equals(
            decodePoint(a0 ?? '').add(scalePoint(target, e0)),
          ),
        ).toBe(true);
        expect(
          scalePoint(H, decodeScalar(bitProof.responses[1])).equals(
            decodePoint(a1 ?? '').add(scalePoint(target.subtract(G), e1)),
          ),
        ).toBe(true);
      }
      expect(weighted.equals(decodePoint(claim.commitment))).toBe(true);
      expect(inspected.challenge).toBe(
        proofChallenge('range', context, claim, {
          commitments: proof.commitments,
          announcements: inspected.announcements,
        }),
      );
    }
  }, 30_000);

  test('has a fixed transcript vector and accepts zero/identity at width boundaries', () => {
    const zero = statement(0n, 0n);
    expect(verifyRange(zero, proveRange(zero, 0n, 0n, SEED, CONTEXT), CONTEXT)).toBe(true);
    for (const [bits, value] of [
      [1, 1n],
      [8, 255n],
      [16, 65535n],
    ] as const) {
      const claim = statement(value, 19n, bits);
      expect(verifyRange(claim, proveRange(claim, value, 19n, SEED, CONTEXT), CONTEXT)).toBe(true);
    }
    const claim = statement(13n, 17n);
    const proof = proveRange(claim, 13n, 17n, SEED, CONTEXT);
    expect(proof.commitments).toHaveLength(6);
    expect(proof.proofs).toHaveLength(6);
    expect(claim.commitment).toBe('4osVolE59fcFcKpZc6RJC0Heldku5c_blLwYzSBS1Eg');
    expect(proof.commitments[0]).toBe('Fr8ysOkBdp-1tFt9uUp6wFgG6RU06G2GPgyKJTptoB8');
    expect(proof.commitments[5]).toBe('mNI-scsATrU8BkFNqcEWkN1SBsAh4okJ75rso9kt7CQ');
    expect(proof.proofs[0]).toEqual({
      challenges: [
        'hkoEvGlaTjI38hk7LeYlVbhqYvR-4rFXyAz-GWcFHQ0',
        'EVtQPhb_oa1pbA2aRvF8XmJSyns9M1fRx_cBZoUNgQU',
      ],
      responses: [
        'k4wctt486mdvHpDWrU6Hr2GZqE7pRFq2HY_0D6bvZwc',
        'wudWFoKXH6QtWpuLDTM4hmANJpntlsjcZjIA6qlB3Q8',
      ],
    });
  });

  test('rejects out-of-range values, wrong openings and invalid widths at the prover boundary', () => {
    const claim = statement(13n, 17n);
    for (const value of [-1n, 64n, SCALAR_ORDER - 1n])
      expect(() => proveRange(claim, value, 17n, SEED, CONTEXT)).toThrow(/range/);
    expect(() => proveRange(claim, 13n, 18n, SEED, CONTEXT)).toThrow(/witness/);
    expect(() => proveRange({ ...claim, bits: 0 }, 13n, 17n, SEED, CONTEXT)).toThrow(/width/);
    expect(() => proveRange({ ...claim, bits: 17 }, 13n, 17n, SEED, CONTEXT)).toThrow(/width/);
  });

  test('prepared responder answers one arbitrary common challenge exactly once', () => {
    const claim = statement(23n, 11n);
    const prepared = prepareRangeProof(claim, 23n, 11n, SEED, CONTEXT);
    const proof = prepared.respond(123n);
    const inspected = inspectRangeProof(claim, proof);
    expect(inspected.challenge).toBe(123n);
    expect(inspected.commitments).toEqual(prepared.commitments);
    expect(inspected.announcements).toEqual(prepared.announcements);
    expect(verifyRange(claim, proof, CONTEXT)).toBe(false);
    expect(() => prepared.respond(124n)).toThrow(/one challenge/);
    expect(() => prepared.respond(123n)).toThrow(/one challenge/);
  });

  test('simulates a false range for an enclosing challenge but fails standalone Fiat–Shamir', () => {
    const falseClaim = statement(64n, 5n);
    const proof = simulateRangeProof(falseClaim, 42n, SEED, CONTEXT);
    const inspected = inspectRangeProof(falseClaim, proof);
    expect(inspected.challenge).toBe(42n);
    expect(proof.commitments).toHaveLength(6);
    expect(verifyRange(falseClaim, proof, CONTEXT)).toBe(false);
    expect(simulateRangeProof(falseClaim, 42n, SEED, CONTEXT)).toEqual(proof);
    expect(
      inspectRangeProof(falseClaim, simulateRangeProof(falseClaim, 43n, SEED, CONTEXT)).challenge,
    ).toBe(43n);
  });

  test('rejects changed statement, commitment, response, challenge, context and proof splices', () => {
    const claim = statement(13n, 17n);
    const proof = proveRange(claim, 13n, 17n, SEED, CONTEXT);
    const other = proveRange(statement(14n, 17n), 14n, 17n, SEED, CONTEXT);
    expect(
      verifyRange({ ...claim, commitment: statement(13n, 18n).commitment }, proof, CONTEXT),
    ).toBe(false);
    expect(verifyRange({ ...claim, bits: 5 }, proof, CONTEXT)).toBe(false);
    expect(verifyRange(claim, proof, { ...CONTEXT, parent: 'b'.repeat(64) })).toBe(false);
    expect(
      verifyRange(
        claim,
        {
          ...proof,
          commitments: proof.commitments.map((item, index) =>
            index === 0 ? encodePoint(G) : item,
          ),
        },
        CONTEXT,
      ),
    ).toBe(false);
    const first = proof.proofs[0];
    if (!first) throw new Error('Missing bit proof');
    expect(
      verifyRange(
        claim,
        replaceProof(proof, 0, { ...first, responses: [encodeScalar(0n), first.responses[1]] }),
        CONTEXT,
      ),
    ).toBe(false);
    const changedChallenge = replaceProof(proof, 0, {
      ...first,
      challenges: [
        encodeScalar(modScalar(decodeScalar(first.challenges[0]) + 1n)),
        first.challenges[1],
      ],
    });
    expect(() => inspectRangeProof(claim, changedChallenge)).toThrow(/share one challenge/);
    expect(verifyRange(claim, changedChallenge, CONTEXT)).toBe(false);
    expect(verifyRange(claim, replaceProof(proof, 0, other.proofs[0] ?? first), CONTEXT)).toBe(
      false,
    );
    expect(verifyRange(claim, { ...proof, extra: true }, CONTEXT)).toBe(false);
  });

  test('rejects malformed peer records, holes, getters and noncanonical encodings without throwing', () => {
    const claim = statement(13n, 17n);
    const proof = proveRange(claim, 13n, 17n, SEED, CONTEXT);
    const first = proof.proofs[0];
    if (!first) throw new Error('Missing bit proof');
    const malformed = [
      null,
      [],
      { ...proof, commitments: proof.commitments.slice(0, 5) },
      {
        ...proof,
        commitments: proof.commitments.map((item, index) => (index === 0 ? 'bad' : item)),
      },
      replaceProof(proof, 0, {
        ...first,
        challenges: [first.challenges[0], `${first.challenges[1]}=`],
      }),
      replaceProof(proof, 0, {
        ...first,
        responses: [toBase64Url(new Uint8Array(32).fill(0xff)), first.responses[1]],
      }),
      replaceProof(proof, 0, Object.assign({}, first, { extra: true })),
    ];
    for (const invalid of malformed) expect(verifyRange(claim, invalid, CONTEXT)).toBe(false);
    const hole = [...proof.commitments];
    Reflect.deleteProperty(hole, '0');
    expect(verifyRange(claim, { ...proof, commitments: hole }, CONTEXT)).toBe(false);
    let getterCalls = 0;
    const accessor = Object.defineProperty({ ...proof }, 'proofs', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return proof.proofs;
      },
    });
    expect(verifyRange(claim, accessor, CONTEXT)).toBe(false);
    expect(getterCalls).toBe(0);
    const symbolic = [...proof.commitments];
    Object.defineProperty(symbolic, Symbol('extra'), { value: true });
    expect(verifyRange(claim, { ...proof, commitments: symbolic }, CONTEXT)).toBe(false);
  });
});
