import {
  G,
  H,
  decodePoint,
  decodeScalar,
  encodePoint,
  encodeScalar,
  invertScalar,
  modScalar,
  scalarToBytes,
  scalePublicPoint,
  scalePoint,
  zeroSafeProductTerms,
} from './group.js';
import { proofChallenge, proofNonce, readProofArray, readProofRecord } from './proof-transcript.js';

export interface BitProof {
  readonly challenges: readonly [string, string];
  readonly responses: readonly [string, string];
}

export interface RangeStatement {
  readonly commitment: string;
  readonly bits: number;
}

export interface RangeProof {
  readonly commitments: readonly string[];
  readonly proofs: readonly BitProof[];
}

export type BitAnnouncements = readonly [string, string];
export interface PreparedRangeProof {
  readonly commitments: readonly string[];
  readonly announcements: readonly BitAnnouncements[];
  /** Single-use: answering a different challenge with the same nonce leaks the witness. */
  respond(challenge: bigint): RangeProof;
}

const MAX_RANGE_BITS = 16;
const inverseWeights = new Map<number, bigint>();

function inverseLastWeight(bits: number): bigint {
  let inverse = inverseWeights.get(bits);
  if (inverse === undefined) {
    inverse = invertScalar(1n << BigInt(bits - 1));
    inverseWeights.set(bits, inverse);
  }
  return inverse;
}

/** Allows field values, including zero. Counts used in range proofs have narrower bounds. */
export function pedersenCommit(value: bigint, blinding: bigint): string {
  const [valuePositive, valueCorrection] = zeroSafeProductTerms(G, value);
  const [blindPositive, blindCorrection] = zeroSafeProductTerms(H, blinding);
  return encodePoint(
    valuePositive.add(blindPositive).subtract(valueCorrection).subtract(blindCorrection),
  );
}

function readEncoded(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 43)
    throw new TypeError('Expected a canonical 32-byte group encoding.');
  return value;
}

function readStatement(value: RangeStatement): RangeStatement {
  const record = readProofRecord(value, ['commitment', 'bits']);
  const bits = record['bits'];
  if (typeof bits !== 'number' || !Number.isInteger(bits) || bits < 1 || bits > MAX_RANGE_BITS)
    throw new RangeError('Range width must be from 1 through 16 bits.');
  const commitment = readEncoded(record['commitment']);
  decodePoint(commitment);
  return { commitment, bits };
}

function readBitProof(value: unknown): BitProof {
  const record = readProofRecord(value, ['challenges', 'responses']);
  const challenges = readProofArray(record['challenges'], 2).map(readEncoded);
  const responses = readProofArray(record['responses'], 2).map(readEncoded);
  const [e0, e1] = challenges;
  const [z0, z1] = responses;
  if (e0 === undefined || e1 === undefined || z0 === undefined || z1 === undefined)
    throw new TypeError('Bit proof requires two challenges and responses.');
  return { challenges: [e0, e1], responses: [z0, z1] };
}

/** First messages reconstructed from a CDS bit proof, independent of its enclosing challenge. */
export function inspectBitProof(
  commitment: string,
  proof: unknown,
  scale: typeof scalePoint = scalePoint,
): { challenge: bigint; announcements: BitAnnouncements } {
  const parsed = readBitProof(proof);
  const target = decodePoint(readEncoded(commitment));
  const e0 = decodeScalar(parsed.challenges[0]);
  const e1 = decodeScalar(parsed.challenges[1]);
  const z0 = decodeScalar(parsed.responses[0]);
  const z1 = decodeScalar(parsed.responses[1]);
  return {
    challenge: modScalar(e0 + e1),
    announcements: [
      encodePoint(scale(H, z0).subtract(scale(target, e0))),
      encodePoint(scale(H, z1).subtract(scale(target.subtract(G), e1))),
    ],
  };
}

interface PreparedBitProof {
  readonly announcements: BitAnnouncements;
  respond(challenge: bigint): BitProof;
}

function prepareBit(
  commitment: string,
  bit: 0 | 1,
  blinding: bigint,
  seed: Uint8Array,
  context: unknown,
): PreparedBitProof {
  const target = decodePoint(commitment);
  if (pedersenCommit(BigInt(bit), blinding) !== commitment)
    throw new RangeError('Bit witness does not open its commitment.');
  const nonce = proofNonce(seed, 'bit', context, commitment, 'honest-nonce');
  const falseChallenge = proofNonce(seed, 'bit', context, commitment, 'simulated-challenge');
  const falseResponse = proofNonce(seed, 'bit', context, commitment, 'simulated-response');
  const shiftedTarget = target.subtract(G);
  const falseTarget = bit === 0 ? shiftedTarget : target;
  const honestAnnouncement = encodePoint(scalePoint(H, nonce));
  const falseAnnouncement = encodePoint(
    scalePoint(H, falseResponse).subtract(scalePoint(falseTarget, falseChallenge)),
  );
  let answered = false;
  return {
    announcements:
      bit === 0 ? [honestAnnouncement, falseAnnouncement] : [falseAnnouncement, honestAnnouncement],
    respond(challenge) {
      scalarToBytes(challenge);
      if (answered) throw new Error('A Sigma commitment must only answer one challenge.');
      answered = true;
      const honestChallenge = modScalar(challenge - falseChallenge);
      const honestResponse = modScalar(nonce + honestChallenge * blinding);
      const e = encodeScalar(honestChallenge);
      const z = encodeScalar(honestResponse);
      const fakeE = encodeScalar(falseChallenge);
      const fakeZ = encodeScalar(falseResponse);
      return {
        challenges: bit === 0 ? [e, fakeE] : [fakeE, e],
        responses: bit === 0 ? [z, fakeZ] : [fakeZ, z],
      };
    },
  };
}

export function proveBit(
  commitment: string,
  bit: 0 | 1,
  blinding: bigint,
  seed: Uint8Array,
  context: unknown,
): BitProof {
  if (bit !== 0 && bit !== 1) throw new RangeError('Bit must be zero or one.');
  const prepared = prepareBit(commitment, bit, blinding, seed, { mode: 'standalone-bit', context });
  return prepared.respond(proofChallenge('bit', context, commitment, prepared.announcements));
}

export function verifyBit(commitment: string, proof: unknown, context: unknown): boolean {
  try {
    const inspected = inspectBitProof(commitment, proof);
    return (
      inspected.challenge === proofChallenge('bit', context, commitment, inspected.announcements)
    );
  } catch {
    return false;
  }
}

/**
 * Prepares a range as a Sigma protocol for AND/OR composition. Callers must bind
 * the whole enclosing statement and branch in context and use one shared challenge.
 */
export function prepareRangeProof(
  statement: RangeStatement,
  value: bigint,
  blinding: bigint,
  seed: Uint8Array,
  context: unknown,
): PreparedRangeProof {
  return prepareRange(statement, value, blinding, seed, { mode: 'composed-range', context });
}

function prepareRange(
  statement: RangeStatement,
  value: bigint,
  blinding: bigint,
  seed: Uint8Array,
  context: unknown,
): PreparedRangeProof {
  const parsed = readStatement(statement);
  if (typeof value !== 'bigint' || value < 0n || value >= 1n << BigInt(parsed.bits))
    throw new RangeError('Value is outside the declared range.');
  if (pedersenCommit(value, blinding) !== parsed.commitment)
    throw new RangeError('Range witness does not open its commitment.');
  const commitments: string[] = [];
  const blindings: bigint[] = [];
  let weightedBlinding = 0n;
  for (let index = 0; index < parsed.bits; index += 1) {
    const weight = 1n << BigInt(index);
    const blind =
      index === parsed.bits - 1
        ? modScalar((blinding - weightedBlinding) * inverseLastWeight(parsed.bits))
        : proofNonce(seed, 'range', context, parsed, ['bit-blinding', index]);
    weightedBlinding = modScalar(weightedBlinding + weight * blind);
    const bit = (value >> BigInt(index)) & 1n;
    commitments.push(pedersenCommit(bit, blind));
    blindings.push(blind);
  }
  const prepared = commitments.map((commitment, index) => {
    const blind = blindings[index];
    if (blind === undefined) throw new Error('Missing bit blinding.');
    const bit = ((value >> BigInt(index)) & 1n) === 0n ? 0 : 1;
    return prepareBit(commitment, bit, blind, seed, {
      mode: 'range-bit',
      context,
      statement: parsed,
      commitments,
      index,
    });
  });
  let answered = false;
  return {
    commitments: [...commitments],
    announcements: prepared.map((bit) => bit.announcements),
    respond(challenge) {
      scalarToBytes(challenge);
      if (answered) throw new Error('A Sigma commitment must only answer one challenge.');
      answered = true;
      return {
        commitments: [...commitments],
        proofs: prepared.map((bit) => bit.respond(challenge)),
      };
    },
  };
}

/** Simulates a range for a fixed enclosing OR-branch challenge, even for false statements. */
export function simulateRangeProof(
  statement: RangeStatement,
  challenge: bigint,
  seed: Uint8Array,
  context: unknown,
): RangeProof {
  const parsed = readStatement(statement);
  scalarToBytes(challenge);
  const commitments: string[] = [];
  let weighted = scalePoint(G, 0n);
  for (let index = 0; index < parsed.bits; index += 1) {
    const weight = 1n << BigInt(index);
    const point =
      index === parsed.bits - 1
        ? scalePublicPoint(
            decodePoint(parsed.commitment).subtract(weighted),
            inverseLastWeight(parsed.bits),
          )
        : scalePoint(
            H,
            proofNonce(seed, 'range-simulation', context, parsed, ['commitment', index]),
          );
    weighted = weighted.add(scalePublicPoint(point, weight));
    commitments.push(encodePoint(point));
  }
  const proofs = commitments.map((_, index): BitProof => {
    const role = { index, challenge: encodeScalar(challenge), commitments };
    const e0 = proofNonce(seed, 'range-simulation', context, parsed, [role, 'challenge']);
    const z0 = proofNonce(seed, 'range-simulation', context, parsed, [role, 'response0']);
    const z1 = proofNonce(seed, 'range-simulation', context, parsed, [role, 'response1']);
    return {
      challenges: [encodeScalar(e0), encodeScalar(modScalar(challenge - e0))],
      responses: [encodeScalar(z0), encodeScalar(z1)],
    };
  });
  return { commitments, proofs };
}

/** Validates the range equations and recovers its shared challenge and first messages. */
export function inspectRangeProof(
  statement: RangeStatement,
  proof: unknown,
  scale: typeof scalePoint = scalePoint,
): {
  challenge: bigint;
  commitments: readonly string[];
  announcements: readonly BitAnnouncements[];
} {
  const parsed = readStatement(statement);
  const record = readProofRecord(proof, ['commitments', 'proofs']);
  const commitments = readProofArray(record['commitments'], parsed.bits).map(readEncoded);
  const proofs = readProofArray(record['proofs'], parsed.bits);
  let weighted = scalePoint(G, 0n);
  let challenge: bigint | undefined;
  const announcements = commitments.map((commitment, index) => {
    weighted = weighted.add(scale(decodePoint(commitment), 1n << BigInt(index)));
    const inspected = inspectBitProof(commitment, proofs[index], scale);
    if (challenge !== undefined && challenge !== inspected.challenge)
      throw new TypeError('Range bit proofs must share one challenge.');
    challenge = inspected.challenge;
    return inspected.announcements;
  });
  if (challenge === undefined || !weighted.equals(decodePoint(parsed.commitment)))
    throw new TypeError('Range bit commitments do not sum to the statement.');
  return { challenge, commitments, announcements };
}

export function proveRange(
  statement: RangeStatement,
  value: bigint,
  blinding: bigint,
  seed: Uint8Array,
  context: unknown,
): RangeProof {
  const parsed = readStatement(statement);
  const prepared = prepareRange(parsed, value, blinding, seed, {
    mode: 'standalone-range',
    context,
  });
  const challenge = proofChallenge('range', context, parsed, {
    commitments: prepared.commitments,
    announcements: prepared.announcements,
  });
  return prepared.respond(challenge);
}

export function verifyRange(statement: RangeStatement, proof: unknown, context: unknown): boolean {
  try {
    const parsed = readStatement(statement);
    const inspected = inspectRangeProof(parsed, proof, scalePublicPoint);
    return (
      inspected.challenge ===
      proofChallenge('range', context, parsed, {
        commitments: inspected.commitments,
        announcements: inspected.announcements,
      })
    );
  } catch {
    return false;
  }
}
