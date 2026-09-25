import { canonicalEncode, fromBase64Url, sha256, toBase64Url } from '@cp2p/codec';
import { describe, expect, test } from 'vitest';
import {
  G,
  decodePoint,
  decodeScalar,
  encodePoint,
  encodeScalar,
  invertScalar,
  modScalar,
  scalePoint,
} from './group.js';
import {
  proveShuffle,
  verifyShuffle,
  type ShuffleProof,
  type ShuffleStatement,
} from './shuffle.js';

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 11);
const CONTEXT = { genesisDigest: 'ceremony-7', deck: 'development', epoch: 0, seat: 1 };
const SECRET = 7n;
// old index → new index; this four-cycle is deliberately not its own inverse.
const PI = [2, 0, 3, 1];

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing test fixture element');
  return value;
}

function fixture(
  permutation: readonly number[] = PI,
  inputMultipliers: readonly bigint[] = [1n, 2n, 3n, 4n],
): ShuffleStatement {
  const input = inputMultipliers.map((number) => encodePoint(scalePoint(G, number)));
  const output = input.slice();
  for (let oldIndex = 0; oldIndex < input.length; oldIndex += 1)
    output[permutation[oldIndex] ?? -1] = encodePoint(
      scalePoint(decodePoint(required(input[oldIndex])), SECRET),
    );
  return { input, output, publicKey: encodePoint(scalePoint(G, SECRET)) };
}

/** Independent expansion of the compact responses into the published R/Y proof. */
function expandExplicit(statement: ShuffleStatement, proof: ShuffleProof) {
  const bits = fromBase64Url(proof.challenge);
  const rounds = proof.responses.map((response, round) => {
    const scalar = decodeScalar(response.scalar, { nonzero: true });
    const bit = ((bits[Math.floor(round / 8)] ?? 0) & (0x80 >> (round % 8))) !== 0;
    if (!bit) {
      const y = statement.input.slice();
      for (let oldIndex = 0; oldIndex < statement.input.length; oldIndex += 1)
        y[response.permutation[oldIndex] ?? -1] = encodePoint(
          scalePoint(decodePoint(required(statement.input[oldIndex])), scalar),
        );
      return [encodePoint(scalePoint(G, scalar)), y] as const;
    }
    const inverse = invertScalar(scalar);
    return [
      encodePoint(scalePoint(decodePoint(statement.publicKey), inverse)),
      response.permutation.map((outIndex) =>
        encodePoint(scalePoint(decodePoint(required(statement.output[outIndex])), inverse)),
      ),
    ] as const;
  });
  return {
    challenge: sha256(canonicalEncode(['cp2p/v1/shuffle', CONTEXT, statement, rounds])).slice(0, 8),
    rounds,
  };
}

describe('compact single-key shuffle proof', () => {
  test('verifies a non-involutive old→new permutation and explicit/compact transcript equivalence', () => {
    const statement = fixture();
    expect(statement.output).toEqual([
      encodePoint(scalePoint(G, 14n)),
      encodePoint(scalePoint(G, 28n)),
      encodePoint(scalePoint(G, 7n)),
      encodePoint(scalePoint(G, 21n)),
    ]);
    const compact = proveShuffle(statement, SECRET, PI, SEED, CONTEXT);
    expect(compact.challenge).toBe('VI-XijXWk4w');
    expect(compact.responses[0]).toEqual({
      scalar: 'xOAosToeuiX8UTcrfokfaiG2lp62qDNfh7QhkkT2hAQ',
      permutation: [1, 0, 3, 2],
    });
    expect(compact.responses[1]).toEqual({
      scalar: '43rgkY72f34I8JXmUexQ43MMim_jLbR2rZtneQdsqA0',
      permutation: [0, 1, 2, 3],
    });
    expect(compact.responses).toHaveLength(64);
    expect(fromBase64Url(compact.challenge)).toHaveLength(8);
    expect(verifyShuffle(statement, compact, CONTEXT)).toBe(true);

    const explicit = expandExplicit(statement, compact);
    expect(explicit.challenge).toEqual(fromBase64Url(compact.challenge));
    expect(explicit.rounds).toHaveLength(64);
    const bits = fromBase64Url(compact.challenge);
    expect([...bits].some((byte) => byte !== 0)).toBe(true);
    expect([...bits].some((byte) => byte !== 255)).toBe(true);
  });

  test('contracts an independently constructed explicit proof with forward equations', () => {
    const statement = fixture();
    // Four-cycle distinct from π; both directions matter to τ = π ∘ ρ⁻¹.
    const rho = [1, 3, 0, 2];
    const explicit = Array.from({ length: 64 }, (_, round) => {
      const r = BigInt(round + 2);
      const y = statement.input.slice();
      for (let oldIndex = 0; oldIndex < statement.input.length; oldIndex += 1)
        y[required(rho[oldIndex])] = encodePoint(
          scalePoint(decodePoint(required(statement.input[oldIndex])), r),
        );
      return { r, R: encodePoint(scalePoint(G, r)), Y: y };
    });
    const transcript = explicit.map(({ R, Y }) => [R, Y]);
    const challenge = sha256(
      canonicalEncode(['cp2p/v1/shuffle', CONTEXT, statement, transcript]),
    ).slice(0, 8);
    const forwardRelations: boolean[] = [];
    const responses = explicit.map(({ r, R, Y }, round) => {
      const bit = ((challenge[Math.floor(round / 8)] ?? 0) & (0x80 >> (round % 8))) !== 0;
      if (!bit) {
        for (let oldIndex = 0; oldIndex < statement.input.length; oldIndex += 1)
          forwardRelations.push(
            required(Y[required(rho[oldIndex])]) ===
              encodePoint(scalePoint(decodePoint(required(statement.input[oldIndex])), r)),
          );
        return { scalar: encodeScalar(r), permutation: rho };
      }
      const u = modScalar(SECRET * invertScalar(r));
      forwardRelations.push(scalePoint(decodePoint(R), u).equals(decodePoint(statement.publicKey)));
      const tau = rho.slice();
      for (let oldIndex = 0; oldIndex < rho.length; oldIndex += 1)
        tau[required(rho[oldIndex])] = required(PI[oldIndex]);
      for (let yIndex = 0; yIndex < Y.length; yIndex += 1)
        forwardRelations.push(
          scalePoint(decodePoint(required(Y[yIndex])), u).equals(
            decodePoint(required(statement.output[required(tau[yIndex])])),
          ),
        );
      return { scalar: encodeScalar(u), permutation: tau };
    });
    expect(
      responses.some(
        (_, round) => ((challenge[Math.floor(round / 8)] ?? 0) & (0x80 >> (round % 8))) !== 0,
      ),
    ).toBe(true);
    expect(
      responses.some(
        (_, round) => ((challenge[Math.floor(round / 8)] ?? 0) & (0x80 >> (round % 8))) === 0,
      ),
    ).toBe(true);
    expect(forwardRelations.every(Boolean)).toBe(true);
    const compact: ShuffleProof = { challenge: toBase64Url(challenge), responses };
    expect(verifyShuffle(statement, compact, CONTEXT)).toBe(true);
  });

  test('is deterministic for retransmission and changes nonce material with complete statement/context', () => {
    const statement = fixture();
    const first = proveShuffle(statement, SECRET, PI, SEED, CONTEXT);
    expect(proveShuffle(statement, SECRET, PI, SEED, CONTEXT)).toEqual(first);
    const otherContext = { ...CONTEXT, epoch: 1 };
    const changedContext = proveShuffle(statement, SECRET, PI, SEED, otherContext);
    expect(changedContext).not.toEqual(first);
    expect(verifyShuffle(statement, changedContext, otherContext)).toBe(true);
    expect(verifyShuffle(statement, first, otherContext)).toBe(false);
    const otherStatement = fixture(PI, [2n, 3n, 4n, 5n]);
    const changedStatement = proveShuffle(otherStatement, SECRET, PI, SEED, CONTEXT);
    expect(changedStatement).not.toEqual(first);
    expect(verifyShuffle(otherStatement, changedStatement, CONTEXT)).toBe(true);
    expect(verifyShuffle(otherStatement, first, CONTEXT)).toBe(false);
  });

  test('rejects bit flips, response changes, round reordering and wrong key or deck', () => {
    const statement = fixture();
    const proof = proveShuffle(statement, SECRET, PI, SEED, CONTEXT);
    const challenge = fromBase64Url(proof.challenge);
    challenge[0] = (challenge[0] ?? 0) ^ 0x80;
    const changedBit = { ...proof, challenge: toBase64Url(challenge) };
    expect(verifyShuffle(statement, changedBit, CONTEXT)).toBe(false);
    const responses = [...proof.responses];
    responses[0] = { ...required(responses[0]), scalar: encodeScalar(2n) };
    expect(verifyShuffle(statement, { ...proof, responses }, CONTEXT)).toBe(false);
    expect(
      verifyShuffle(statement, { ...proof, responses: proof.responses.toReversed() }, CONTEXT),
    ).toBe(false);
    expect(
      verifyShuffle({ ...statement, publicKey: encodePoint(scalePoint(G, 8n)) }, proof, CONTEXT),
    ).toBe(false);
    expect(
      verifyShuffle({ ...statement, input: statement.input.toReversed() }, proof, CONTEXT),
    ).toBe(false);
    expect(
      verifyShuffle({ ...statement, output: statement.output.toReversed() }, proof, CONTEXT),
    ).toBe(false);
  });

  test('rejects substituted/re-keyed outputs, duplicate or identity points and false witnesses', () => {
    const statement = fixture();
    const substituted = { ...statement, output: [...statement.output] };
    substituted.output[0] = encodePoint(scalePoint(G, 99n));
    expect(() => proveShuffle(substituted, SECRET, PI, SEED, CONTEXT)).toThrow(/output/);
    expect(
      verifyShuffle(substituted, proveShuffle(statement, SECRET, PI, SEED, CONTEXT), CONTEXT),
    ).toBe(false);
    const rekeyed = {
      ...statement,
      output: statement.output.map((point) => encodePoint(scalePoint(decodePoint(point), 2n))),
    };
    expect(() => proveShuffle(rekeyed, SECRET, PI, SEED, CONTEXT)).toThrow(/output/);
    expect(
      verifyShuffle(rekeyed, proveShuffle(statement, SECRET, PI, SEED, CONTEXT), CONTEXT),
    ).toBe(false);
    expect(() => proveShuffle(statement, 0n, PI, SEED, CONTEXT)).toThrow(/secret/);
    expect(() => proveShuffle(statement, 8n, PI, SEED, CONTEXT)).toThrow(/secret/);
    expect(() => proveShuffle(statement, SECRET, [0, 0, 2, 3], SEED, CONTEXT)).toThrow(/bijection/);
    expect(() =>
      proveShuffle(
        {
          ...statement,
          input: [
            required(statement.input[0]),
            required(statement.input[0]),
            ...statement.input.slice(2),
          ],
        },
        SECRET,
        PI,
        SEED,
        CONTEXT,
      ),
    ).toThrow(/distinct/);
    expect(
      verifyShuffle(
        { ...statement, output: [encodePoint(scalePoint(G, 0n)), ...statement.output.slice(1)] },
        {},
        CONTEXT,
      ),
    ).toBe(false);
    expect(
      verifyShuffle({ ...statement, publicKey: encodePoint(scalePoint(G, 0n)) }, {}, CONTEXT),
    ).toBe(false);
  });

  test('fails closed on malformed proof shape, scalar, permutation, and oversized inputs', () => {
    const statement = fixture();
    const proof = proveShuffle(statement, SECRET, PI, SEED, CONTEXT);
    expect(verifyShuffle(statement, { ...proof, extra: 1 }, CONTEXT)).toBe(false);
    expect(verifyShuffle(statement, { ...proof, challenge: `${proof.challenge}=` }, CONTEXT)).toBe(
      false,
    );
    expect(
      verifyShuffle(statement, { ...proof, responses: proof.responses.slice(1) }, CONTEXT),
    ).toBe(false);
    const zeroScalar = [
      { ...proof.responses[0], scalar: encodeScalar(0n) },
      ...proof.responses.slice(1),
    ];
    expect(verifyShuffle(statement, { ...proof, responses: zeroScalar }, CONTEXT)).toBe(false);
    const duplicatePermutation = [
      { ...proof.responses[0], permutation: [0, 0, 2, 3] },
      ...proof.responses.slice(1),
    ];
    expect(verifyShuffle(statement, { ...proof, responses: duplicatePermutation }, CONTEXT)).toBe(
      false,
    );
    const sparse = [...proof.responses];
    sparse.pop();
    sparse.length = 64;
    expect(verifyShuffle(statement, { ...proof, responses: sparse }, CONTEXT)).toBe(false);
    const oversized = Array.from({ length: 129 }, (_, index) =>
      encodePoint(scalePoint(G, BigInt(index + 1))),
    );
    expect(
      verifyShuffle(
        { input: oversized, output: oversized, publicKey: statement.publicKey },
        proof,
        CONTEXT,
      ),
    ).toBe(false);
    expect(verifyShuffle(statement, proof, 'x'.repeat(16_385))).toBe(false);
    expect(() => proveShuffle(statement, SECRET, PI, SEED.subarray(1), CONTEXT)).toThrow(/seed/);
  });
});
