import { DERIVATION_LABELS, deriveBytes } from './derivation.js';
import { decodeScalar, encodeScalar, modScalar } from './group.js';
import { proofChallenge, proofNonce, readProofArray, readProofRecord } from './proof-transcript.js';
import { inspectRangeProof, prepareRangeProof, simulateRangeProof } from './range.js';
import type { RangeProof, RangeStatement } from './range.js';
import { inspectSchnorrProof, prepareSchnorrProof, simulateSchnorrProof } from './sigma.js';
import type { SchnorrProof, SchnorrStatement } from './sigma.js';

/** Each branch proves an opening AND up to two ranges at the same challenge. */
export interface CdsBranchStatement {
  readonly opening: SchnorrStatement;
  readonly ranges: readonly RangeStatement[];
}

export interface CdsOrStatement {
  readonly branches: readonly CdsBranchStatement[];
}

export interface CdsBranchProof {
  readonly challenge: string;
  readonly opening: SchnorrProof;
  readonly ranges: readonly RangeProof[];
}

export interface CdsOrProof {
  readonly branches: readonly CdsBranchProof[];
}

export interface CdsBranchWitness {
  readonly secret: bigint;
  readonly ranges: readonly { readonly value: bigint; readonly blinding: bigint }[];
}

function boundedArray(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    throw new RangeError('CDS statement has an unsupported branch or range count.');
  return readProofArray(value, value.length);
}

function readStatement(value: CdsOrStatement): CdsOrStatement {
  const record = readProofRecord(value, ['branches']);
  const branches = boundedArray(record.branches, 1, 8).map((branch): CdsBranchStatement => {
    const fields = readProofRecord(branch, ['opening', 'ranges']);
    const opening = readProofRecord(fields.opening, ['base', 'publicPoint']);
    if (typeof opening.base !== 'string' || typeof opening.publicPoint !== 'string')
      throw new TypeError('CDS opening requires encoded points.');
    const ranges = boundedArray(fields.ranges, 0, 2).map((range): RangeStatement => {
      const rangeFields = readProofRecord(range, ['commitment', 'bits']);
      if (typeof rangeFields.commitment !== 'string' || typeof rangeFields.bits !== 'number')
        throw new TypeError('CDS range statement has invalid fields.');
      return { commitment: rangeFields.commitment, bits: rangeFields.bits };
    });
    return { opening: { base: opening.base, publicPoint: opening.publicPoint }, ranges };
  });
  return { branches };
}

function inspectBranch(statement: CdsBranchStatement, value: unknown) {
  const record = readProofRecord(value, ['challenge', 'opening', 'ranges']);
  if (typeof record.challenge !== 'string') throw new TypeError('CDS challenge must be encoded.');
  const challenge = decodeScalar(record.challenge);
  const opening = inspectSchnorrProof(statement.opening, record.opening, challenge);
  const proofs = readProofArray(record.ranges, statement.ranges.length);
  const ranges = statement.ranges.map((range, index) => {
    const inspected = inspectRangeProof(range, proofs[index]);
    if (inspected.challenge !== challenge)
      throw new TypeError('CDS range must share the branch challenge.');
    return { commitments: inspected.commitments, announcements: inspected.announcements };
  });
  return { challenge, firstMessage: { opening, ranges } };
}

/**
 * CDS OR composition. The complete ordered statement and every first message enter
 * one Fiat–Shamir challenge. Callers supply protocol-owned statements and widths.
 */
export function proveCdsOr(
  statement: CdsOrStatement,
  knownBranch: number,
  witness: CdsBranchWitness,
  seed: Uint8Array,
  context: unknown,
): CdsOrProof {
  const parsed = readStatement(statement);
  if (!Number.isInteger(knownBranch) || knownBranch < 0 || knownBranch >= parsed.branches.length)
    throw new RangeError('CDS witness branch is outside the statement.');
  // Separate this composition from direct uses of the exported Sigma helpers,
  // even when a caller supplies their same structured context and original seed.
  const compositionSeed = deriveBytes(
    seed,
    DERIVATION_LABELS.proofRandomness,
    {
      domain: 'cds-or-entropy',
      context,
      statement: parsed,
    },
    32,
  );
  const prepared = parsed.branches.map((branch, index) => {
    const branchContext = { context, statement: parsed, branch: index };
    const openingContext = { ...branchContext, component: 'opening' };
    if (index !== knownBranch) {
      const challenge = proofNonce(
        compositionSeed,
        'cds-or',
        branchContext,
        branch,
        'simulated-challenge',
      );
      const proof: CdsBranchProof = {
        challenge: encodeScalar(challenge),
        opening: simulateSchnorrProof(branch.opening, challenge, compositionSeed, openingContext),
        ranges: branch.ranges.map((range, at) =>
          simulateRangeProof(range, challenge, compositionSeed, {
            ...branchContext,
            component: 'range',
            index: at,
          }),
        ),
      };
      return { ...inspectBranch(branch, proof), respond: () => proof };
    }
    if (witness.ranges.length !== branch.ranges.length)
      throw new RangeError('CDS range witnesses do not match the known branch.');
    const opening = prepareSchnorrProof(
      branch.opening,
      witness.secret,
      compositionSeed,
      openingContext,
    );
    const ranges = branch.ranges.map((range, at) => {
      const item = witness.ranges[at];
      if (!item) throw new RangeError('Missing CDS range witness.');
      return prepareRangeProof(range, item.value, item.blinding, compositionSeed, {
        ...branchContext,
        component: 'range',
        index: at,
      });
    });
    return {
      challenge: 0n,
      firstMessage: {
        opening: opening.commitment,
        ranges: ranges.map((range) => ({
          commitments: range.commitments,
          announcements: range.announcements,
        })),
      },
      respond: (challenge: bigint): CdsBranchProof => ({
        challenge: encodeScalar(challenge),
        opening: opening.respond(challenge),
        ranges: ranges.map((range) => range.respond(challenge)),
      }),
    };
  });
  const challenge = proofChallenge(
    'cds-or',
    context,
    parsed,
    prepared.map((branch) => branch.firstMessage),
  );
  const simulatedSum = prepared.reduce((sum, branch) => modScalar(sum + branch.challenge), 0n);
  const honestChallenge = modScalar(challenge - simulatedSum);
  return { branches: prepared.map((branch) => branch.respond(honestChallenge)) };
}

export function verifyCdsOr(statement: CdsOrStatement, proof: unknown, context: unknown): boolean {
  try {
    const parsed = readStatement(statement);
    const record = readProofRecord(proof, ['branches']);
    const proofs = readProofArray(record.branches, parsed.branches.length);
    const inspected = parsed.branches.map((branch, index) => inspectBranch(branch, proofs[index]));
    const sum = inspected.reduce((total, branch) => modScalar(total + branch.challenge), 0n);
    return (
      sum ===
      proofChallenge(
        'cds-or',
        context,
        parsed,
        inspected.map((branch) => branch.firstMessage),
      )
    );
  } catch {
    return false;
  }
}
