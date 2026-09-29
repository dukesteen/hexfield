import { DERIVATION_LABELS, deriveBytes } from './derivation.js';
import {
  SCALAR_ORDER,
  decodePoint,
  decodeScalar,
  encodePoint,
  encodeScalar,
  modScalar,
  scalePoint,
} from './group.js';
import type { RistrettoPoint } from './group.js';
import { proofChallenge, proofNonce, readProofArray, readProofRecord } from './proof-transcript.js';
import type { DleqStatement } from './sigma.js';

/** "One of these equalities of discrete logarithms holds", without saying which. */
export interface DleqOrStatement {
  readonly branches: readonly DleqStatement[];
}

export interface DleqOrBranchProof {
  readonly challenge: string;
  readonly response: string;
}

export interface DleqOrProof {
  readonly branches: readonly DleqOrBranchProof[];
}

export const MAX_DLEQ_OR_BRANCHES = 64;

interface ParsedBranch {
  body: DleqStatement;
  base1: RistrettoPoint;
  point1: RistrettoPoint;
  base2: RistrettoPoint;
  point2: RistrettoPoint;
}

function readStatement(value: DleqOrStatement): {
  branches: DleqStatement[];
  parsed: ParsedBranch[];
} {
  const record = readProofRecord(value, ['branches']);
  const list = record.branches;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_DLEQ_OR_BRANCHES)
    throw new RangeError('DLEQ OR needs between one and sixty-four branches.');
  const items = readProofArray(list, list.length);
  const parsed = items.map((item): ParsedBranch => {
    const fields = readProofRecord(item, ['base1', 'point1', 'base2', 'point2']);
    if (
      typeof fields.base1 !== 'string' ||
      typeof fields.point1 !== 'string' ||
      typeof fields.base2 !== 'string' ||
      typeof fields.point2 !== 'string'
    )
      throw new TypeError('DLEQ OR statements must contain encoded points.');
    const body = {
      base1: fields.base1,
      point1: fields.point1,
      base2: fields.base2,
      point2: fields.point2,
    };
    return {
      body,
      base1: decodePoint(body.base1, { nonIdentity: true }),
      point1: decodePoint(body.point1),
      base2: decodePoint(body.base2, { nonIdentity: true }),
      point2: decodePoint(body.point2),
    };
  });
  return { branches: parsed.map((item) => item.body), parsed };
}

function canonical(scalar: bigint): void {
  if (typeof scalar !== 'bigint' || scalar < 0n || scalar >= SCALAR_ORDER)
    throw new RangeError('Proof scalar must be canonical.');
}

function announce(branch: ParsedBranch, challenge: bigint, response: bigint): [string, string] {
  return [
    encodePoint(scalePoint(branch.base1, response).subtract(scalePoint(branch.point1, challenge))),
    encodePoint(scalePoint(branch.base2, response).subtract(scalePoint(branch.point2, challenge))),
  ];
}

/**
 * Chaum–Pedersen OR (Cramer–Damgård–Schoenmakers). The complete ordered statement and every
 * first message enter one Fiat–Shamir challenge; the branch challenges must sum to it. The prover
 * simulates every branch but the one it knows, so the proof does not reveal which one holds.
 */
export function proveDleqOr(
  statement: DleqOrStatement,
  knownBranch: number,
  secret: bigint,
  seed: Uint8Array,
  context: unknown,
): DleqOrProof {
  const { branches, parsed } = readStatement(statement);
  canonical(secret);
  if (!Number.isInteger(knownBranch) || knownBranch < 0 || knownBranch >= parsed.length)
    throw new RangeError('DLEQ OR witness branch is outside the statement.');
  const known = parsed[knownBranch];
  if (
    !known ||
    !scalePoint(known.base1, secret).equals(known.point1) ||
    !scalePoint(known.base2, secret).equals(known.point2)
  )
    throw new RangeError('DLEQ OR witness does not match its branch.');
  const entropy = deriveBytes(
    seed,
    DERIVATION_LABELS.proofRandomness,
    { domain: 'dleq-or-entropy', context, statement: branches },
    32,
  );
  const challenges: bigint[] = [];
  const responses: bigint[] = [];
  const commitments: [string, string][] = [];
  let nonce = 0n;
  for (const [index, branch] of parsed.entries()) {
    const branchContext = { context, statement: branches, branch: index };
    if (index === knownBranch) {
      nonce = proofNonce(entropy, 'dleq-or', branchContext, branch.body, 'nonce');
      challenges.push(0n);
      responses.push(0n);
      commitments.push([
        encodePoint(scalePoint(branch.base1, nonce)),
        encodePoint(scalePoint(branch.base2, nonce)),
      ]);
      continue;
    }
    const challenge = proofNonce(entropy, 'dleq-or', branchContext, branch.body, 'challenge');
    const response = proofNonce(entropy, 'dleq-or', branchContext, branch.body, 'response');
    challenges.push(challenge);
    responses.push(response);
    commitments.push(announce(branch, challenge, response));
  }
  entropy.fill(0);
  const total = proofChallenge('dleq-or', context, branches, commitments);
  const others = challenges.reduce(
    (sum, item, index) => (index === knownBranch ? sum : sum + item),
    0n,
  );
  const own = modScalar(total - others);
  challenges[knownBranch] = own;
  responses[knownBranch] = modScalar(nonce + own * secret);
  return {
    branches: challenges.map((challenge, index) => ({
      challenge: encodeScalar(challenge),
      response: encodeScalar(responses[index] ?? 0n),
    })),
  };
}

export function verifyDleqOr(
  statement: DleqOrStatement,
  proof: unknown,
  context: unknown,
): boolean {
  try {
    const { branches, parsed } = readStatement(statement);
    const record = readProofRecord(proof, ['branches']);
    const items = readProofArray(record.branches, parsed.length);
    const commitments: [string, string][] = [];
    let sum = 0n;
    for (const [index, branch] of parsed.entries()) {
      const fields = readProofRecord(items[index], ['challenge', 'response']);
      if (typeof fields.challenge !== 'string' || typeof fields.response !== 'string') return false;
      const challenge = decodeScalar(fields.challenge);
      const response = decodeScalar(fields.response);
      sum = modScalar(sum + challenge);
      commitments.push(announce(branch, challenge, response));
    }
    return sum === proofChallenge('dleq-or', context, branches, commitments);
  } catch {
    return false;
  }
}
