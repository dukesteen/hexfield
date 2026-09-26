import { describe, expect, test } from 'vitest';
import { verifyCdsOr } from './cds.js';
import type { CdsOrStatement } from './cds.js';
import { DERIVATION_LABELS, deriveBytes } from './derivation.js';
import {
  decodePoint,
  decodeScalar,
  encodePoint,
  encodeScalar,
  G,
  H,
  modScalar,
  scalePoint,
} from './group.js';
import { proveHiddenTransfer, verifyHiddenTransfer } from './hidden-transfer.js';
import type { HiddenTransferProof, HiddenTransferStatement } from './hidden-transfer.js';
import {
  inspectRangeProof,
  pedersenCommit,
  prepareRangeProof,
  proveBit,
  simulateRangeProof,
  verifyBit,
} from './range.js';
import {
  inspectSchnorrProof,
  prepareSchnorrProof,
  proveSchnorr,
  simulateSchnorrProof,
  verifySchnorr,
} from './sigma.js';

const SEED = new Uint8Array(32).fill(41);
const CONTEXT = { genesis: 'a'.repeat(64), parent: 'b'.repeat(64), input: 9 };
const PAYLOAD = 'c'.repeat(64);

function itemAt<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error('Missing test fixture value.');
  return value;
}

function fixture(counts: number[], index: number) {
  const blindings = counts.map((_, at) => BigInt(at + 11));
  const transferBlindings = counts.map((_, at) => BigInt(at + 31));
  const selected = counts.findIndex((count, at) => {
    const prefix = counts.slice(0, at).reduce((sum, item) => sum + item, 0);
    return index >= prefix && index < prefix + count;
  });
  const statement: HiddenTransferStatement = {
    commitments: counts.map((count, at) => pedersenCommit(BigInt(count), itemAt(blindings, at))),
    transfer: counts.map((_, at) =>
      pedersenCommit(BigInt(at === selected ? 1 : 0), itemAt(transferBlindings, at)),
    ),
    handSize: counts.reduce((sum, count) => sum + count, 0),
    index,
    payloadHash: PAYLOAD,
  };
  return {
    statement,
    witness: { counts, blindings, transferBlindings },
  };
}

function prove(counts: number[], index: number) {
  const { statement, witness } = fixture(counts, index);
  return { statement, proof: proveHiddenTransfer(statement, witness, SEED, CONTEXT) };
}

describe('hidden card transfer proofs', () => {
  test('proves index zero and the last index across zero-valued resource gaps', () => {
    for (const index of [0, 8]) {
      const { statement, proof } = prove([2, 0, 3, 0, 4], index);
      expect(verifyHiddenTransfer(statement, proof, CONTEXT)).toBe(true);
    }
  });

  test('supports prefixes and total hands above 63 with each component six-bit bounded', () => {
    const { statement, proof } = prove([40, 30, 20, 1], 90);
    expect(statement.handSize).toBeGreaterThan(63);
    expect(verifyHiddenTransfer(statement, proof, CONTEXT)).toBe(true);
  });

  test('supports the maximum eight resource components', () => {
    const { statement, proof } = prove([10, 11, 12, 13, 14, 15, 16, 17], 107);
    expect(verifyHiddenTransfer(statement, proof, CONTEXT)).toBe(true);
  });

  test('binds the proof to index, context, payload, parent commitments and transfer points', () => {
    const { statement, proof } = prove([2, 1, 3], 2);
    expect(verifyHiddenTransfer({ ...statement, index: 1 }, proof, CONTEXT)).toBe(false);
    expect(verifyHiddenTransfer(statement, proof, { ...CONTEXT, parent: 'd'.repeat(64) })).toBe(
      false,
    );
    expect(
      verifyHiddenTransfer({ ...statement, payloadHash: 'e'.repeat(64) }, proof, CONTEXT),
    ).toBe(false);
    expect(
      verifyHiddenTransfer(
        { ...statement, commitments: [pedersenCommit(3n, 11n), ...statement.commitments.slice(1)] },
        proof,
        CONTEXT,
      ),
    ).toBe(false);
    expect(
      verifyHiddenTransfer(
        { ...statement, transfer: [pedersenCommit(0n, 99n), ...statement.transfer.slice(1)] },
        proof,
        CONTEXT,
      ),
    ).toBe(false);
  });

  test('rejects zero-hot, two-hot and wrong-type transfer openings', () => {
    const { statement, witness } = fixture([2, 1, 3], 2);
    const zeroHot = statement.transfer.map((_, at) => pedersenCommit(0n, BigInt(at + 31)));
    const twoHot = statement.transfer.map((_, at) =>
      pedersenCommit(BigInt(at < 2 ? 1 : 0), BigInt(at + 31)),
    );
    const wrongTypeWitness = {
      ...witness,
      transferBlindings: witness.transferBlindings.map((_, at) => BigInt(at + 31)),
    };
    expect(() =>
      proveHiddenTransfer({ ...statement, transfer: zeroHot }, witness, SEED, CONTEXT),
    ).toThrow(RangeError);
    expect(() =>
      proveHiddenTransfer({ ...statement, transfer: twoHot }, witness, SEED, CONTEXT),
    ).toThrow(RangeError);
    expect(() =>
      proveHiddenTransfer(
        {
          ...statement,
          transfer: statement.transfer.map((_, at) =>
            pedersenCommit(BigInt(at === 0 ? 1 : 0), BigInt(at + 31)),
          ),
        },
        wrongTypeWitness,
        SEED,
        CONTEXT,
      ),
    ).toThrow(RangeError);
  });

  test('rejects a valid one-hot proof for the wrong resource even when its bit and sum proofs pass', () => {
    const { statement, proof } = prove([2, 1, 3], 2);
    const blindings = [31n, 32n, 33n];
    const transfer = statement.transfer.map((_, at) =>
      pedersenCommit(BigInt(at === 0 ? 1 : 0), itemAt(blindings, at)),
    );
    const wrongTypeStatement = { ...statement, transfer };
    const bitProofs = transfer.map((commitment, at) =>
      proveBit(commitment, at === 0 ? 1 : 0, itemAt(blindings, at), SEED, {
        protocol: 'hidden-transfer-v1',
        statement: wrongTypeStatement,
        context: CONTEXT,
        component: `bit-${at}`,
      }),
    );
    const sumBlinding = blindings.reduce((sum, blinding) => modScalar(sum + blinding), 0n);
    const sumPoint = transfer
      .map((point) => decodePoint(point))
      .reduce((sum, point) => sum.add(point), scalePoint(G, 0n))
      .subtract(G);
    const sumProof = proveSchnorr(
      { base: encodePoint(H), publicPoint: encodePoint(sumPoint) },
      sumBlinding,
      SEED,
      {
        protocol: 'hidden-transfer-v1',
        statement: wrongTypeStatement,
        context: CONTEXT,
        component: 'sum',
      },
    );
    for (const [at, commitment] of transfer.entries())
      expect(
        verifyBit(commitment, itemAt(bitProofs, at), {
          protocol: 'hidden-transfer-v1',
          statement: wrongTypeStatement,
          context: CONTEXT,
          component: `bit-${at}`,
        }),
      ).toBe(true);
    expect(
      verifySchnorr({ base: encodePoint(H), publicPoint: encodePoint(sumPoint) }, sumProof, {
        protocol: 'hidden-transfer-v1',
        statement: wrongTypeStatement,
        context: CONTEXT,
        component: 'sum',
      }),
    ).toBe(true);
    expect(
      verifyHiddenTransfer(
        wrongTypeStatement,
        { ...proof, bits: bitProofs, sum: sumProof },
        CONTEXT,
      ),
    ).toBe(false);
  });

  test('rejects a mutated shared range/opening challenge in the CDS index branch', () => {
    const { statement, proof } = prove([2, 1, 3], 2);
    const branches = proof.index.branches.map((branch, at) =>
      at === 0
        ? {
            ...branch,
            challenge: encodeScalar(modScalar(decodeScalar(branch.challenge) + 1n)),
          }
        : branch,
    );
    expect(verifyHiddenTransfer(statement, { ...proof, index: { branches } }, CONTEXT)).toBe(false);
  });

  test('rejects a forged zero-count branch with a true opening and upper range but impossible lower range', () => {
    const { statement, witness } = fixture([2, 1, 0, 3], 2);
    const zeroCountPrefix = witness.counts.slice(0, 2).reduce((sum, count) => sum + count, 0);
    expect(statement.index - zeroCountPrefix).toBe(-1);
    expect(zeroCountPrefix + itemAt(witness.counts, 2) - statement.index - 1).toBe(0);
    const transfer = statement.transfer.map((_, at) =>
      pedersenCommit(BigInt(at === 2 ? 1 : 0), itemAt(witness.transferBlindings, at)),
    );
    const forgedStatement = { ...statement, transfer };
    const branches: CdsOrStatement['branches'][number][] = [];
    let prefix = scalePoint(G, 0n);
    const lowerIndex = scalePoint(G, BigInt(statement.index));
    const upperIndex = scalePoint(G, BigInt(statement.index + 1));
    for (let at = 0; at < statement.commitments.length; at += 1) {
      const commitment = decodePoint(itemAt(statement.commitments, at));
      branches.push({
        opening: {
          base: encodePoint(H),
          publicPoint: encodePoint(decodePoint(itemAt(transfer, at)).subtract(G)),
        },
        ranges: [
          { commitment: encodePoint(lowerIndex.subtract(prefix)), bits: 6 },
          { commitment: encodePoint(prefix.add(commitment).subtract(upperIndex)), bits: 6 },
        ],
      });
      prefix = prefix.add(commitment);
    }
    const indexStatement: CdsOrStatement = { branches };
    const indexContext = {
      protocol: 'hidden-transfer-v1',
      statement: forgedStatement,
      context: CONTEXT,
      component: 'index',
    };
    const compositionSeed = deriveBytes(
      SEED,
      DERIVATION_LABELS.proofRandomness,
      { domain: 'cds-or-entropy', context: indexContext, statement: indexStatement },
      32,
    );
    const simulatedBranches = branches.map((branch, branchIndex) => {
      const challenge = BigInt(branchIndex + 5);
      const branchContext = {
        context: indexContext,
        statement: indexStatement,
        branch: branchIndex,
      };
      if (branchIndex !== 2)
        return {
          challenge: encodeScalar(challenge),
          opening: simulateSchnorrProof(branch.opening, challenge, compositionSeed, {
            ...branchContext,
            component: 'opening',
          }),
          ranges: branch.ranges.map((range, rangeIndex) =>
            simulateRangeProof(range, challenge, compositionSeed, {
              ...branchContext,
              component: 'range',
              index: rangeIndex,
            }),
          ),
        };

      const opening = prepareSchnorrProof(
        branch.opening,
        itemAt(witness.transferBlindings, branchIndex),
        compositionSeed,
        { ...branchContext, component: 'opening' },
      );
      const prefixBlinding = witness.blindings
        .slice(0, branchIndex)
        .reduce((sum, blinding) => modScalar(sum + blinding), 0n);
      const lowerImpossible = simulateRangeProof(
        itemAt(branch.ranges, 0),
        challenge,
        compositionSeed,
        { ...branchContext, component: 'range', index: 0 },
      );
      const upperTrue = prepareRangeProof(
        itemAt(branch.ranges, 1),
        0n,
        modScalar(prefixBlinding + itemAt(witness.blindings, branchIndex)),
        compositionSeed,
        { ...branchContext, component: 'range', index: 1 },
      );
      return {
        challenge: encodeScalar(challenge),
        opening: opening.respond(challenge),
        ranges: [lowerImpossible, upperTrue.respond(challenge)],
      };
    });
    const attempted = itemAt(simulatedBranches, 2);
    const chosenChallenge = decodeScalar(attempted.challenge);
    expect(
      inspectSchnorrProof(itemAt(branches, 2).opening, attempted.opening, chosenChallenge),
    ).toBeTypeOf('string');
    expect(
      inspectRangeProof(itemAt(itemAt(branches, 2).ranges, 0), itemAt(attempted.ranges, 0))
        .challenge,
    ).toBe(chosenChallenge);
    expect(
      inspectRangeProof(itemAt(itemAt(branches, 2).ranges, 1), itemAt(attempted.ranges, 1))
        .challenge,
    ).toBe(chosenChallenge);
    expect(verifyCdsOr(indexStatement, { branches: simulatedBranches }, indexContext)).toBe(false);
    compositionSeed.fill(0);
  });

  test('rejects malformed, oversized and noncanonical statement or proof shapes', () => {
    const { statement, proof } = prove([2, 1, 3], 2);
    const firstTransfer = itemAt(statement.transfer, 0);
    const firstBit = itemAt(proof.bits, 0);
    expect(verifyHiddenTransfer({ ...statement, commitments: [] }, proof, CONTEXT)).toBe(false);
    expect(
      verifyHiddenTransfer(
        { ...statement, transfer: [...statement.transfer, firstTransfer] },
        proof,
        CONTEXT,
      ),
    ).toBe(false);
    expect(verifyHiddenTransfer({ ...statement, handSize: 7 }, proof, CONTEXT)).toBe(false);
    expect(
      verifyHiddenTransfer({ ...statement, payloadHash: 'z'.repeat(64) }, proof, CONTEXT),
    ).toBe(false);
    expect(
      verifyHiddenTransfer(statement, { ...proof, bits: [...proof.bits, firstBit] }, CONTEXT),
    ).toBe(false);
    expect(verifyHiddenTransfer(statement, { ...proof, unexpected: true }, CONTEXT)).toBe(false);
    const malformed = {
      ...statement,
      commitments: [encodePoint(scalePoint(G, 1n)).slice(1), ...statement.commitments.slice(1)],
    };
    expect(verifyHiddenTransfer(malformed, proof, CONTEXT)).toBe(false);
    expect(verifyHiddenTransfer(statement, { ...proof, index: { branches: [] } }, CONTEXT)).toBe(
      false,
    );
  });

  test('rejects wrong openings, out-of-range counts and an incorrect hand size before proving', () => {
    const { statement, witness } = fixture([2, 1, 3], 2);
    expect(() =>
      proveHiddenTransfer(statement, { ...witness, counts: [2, 2, 2] }, SEED, CONTEXT),
    ).toThrow(RangeError);
    expect(() =>
      proveHiddenTransfer(statement, { ...witness, counts: [-1, 1, 5] }, SEED, CONTEXT),
    ).toThrow(RangeError);
    expect(() =>
      proveHiddenTransfer(statement, { ...witness, counts: [64, 0, 2] }, SEED, CONTEXT),
    ).toThrow(RangeError);
  });

  test('rejects malformed one-hot sum proof encodings', () => {
    const { statement, proof } = prove([1, 1], 0);
    const altered = {
      ...proof,
      sum: { ...proof.sum, response: '00'.repeat(32) },
    } satisfies HiddenTransferProof;
    expect(verifyHiddenTransfer(statement, altered, CONTEXT)).toBe(false);
  });
});
