import { fromBase64Url } from '@cp2p/codec';
import { parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import type { PeerId } from './transport.js';
import { parseCanonical } from './validation.js';

export type VotePhase = 'prevote' | 'precommit';

export interface VoteBody {
  genesisDigest: string;
  epoch: number;
  seat: Seat;
  seq: number;
  term: number;
  phase: VotePhase;
  valueHash: string | null;
}

export interface SignedVote {
  body: VoteBody;
  sig: string;
}

/** Voter membership comes from a certified genesis or membership transition. */
export interface VoteContext {
  genesisDigest: string;
  epoch: number;
  voters: readonly { seat: Seat; publicKey: PeerId }[];
}

export type ExpectedVote = Pick<VoteBody, 'seq' | 'term' | 'phase' | 'valueHash'>;

const voteBodySchema = v.strictObject({
  genesisDigest: key32Schema,
  epoch: nonnegativeIntegerSchema,
  seat: seatSchema,
  seq: positiveIntegerSchema,
  term: positiveIntegerSchema,
  phase: v.picklist(['prevote', 'precommit']),
  valueHash: v.nullable(hashSchema),
});
export const signedVoteSchema = v.strictObject({ body: voteBodySchema, sig: signature64Schema });
const contextSchema = v.strictObject({
  genesisDigest: key32Schema,
  epoch: nonnegativeIntegerSchema,
  voters: v.pipe(
    v.array(v.strictObject({ seat: seatSchema, publicKey: key32Schema })),
    v.minLength(1),
    v.maxLength(6),
  ),
});
const expectedSchema = v.strictObject({
  seq: positiveIntegerSchema,
  term: positiveIntegerSchema,
  phase: v.picklist(['prevote', 'precommit']),
  valueHash: v.nullable(hashSchema),
});

/** Three of four voters suffice; three voters require all three. */
export function quorumSize(voterCount: number): number {
  if (!Number.isSafeInteger(voterCount) || voterCount < 1 || voterCount > 6)
    throw new RangeError('Voter count must be an integer from one to six');
  return voterCount === 1 ? 1 : Math.floor((voterCount + 1) / 2) + 1;
}

function validateContext(value: VoteContext): Result<VoteContext> {
  const parsed = parseCanonical(value, contextSchema);
  if (!parsed.ok) return parsed;
  const context = parsed.value;
  const keys = new Set<string>();
  let priorSeat = -1;
  try {
    for (const voter of context.voters) {
      if (voter.seat <= priorSeat || keys.has(voter.publicKey))
        return failure(
          'vote-membership',
          'Certified voters must have distinct ordered seats and keys',
        );
      parsePeerId(voter.publicKey);
      priorSeat = voter.seat;
      keys.add(voter.publicKey);
    }
  } catch {
    return failure('vote-membership', 'Certified voter key is invalid');
  }
  return success(context);
}

/** Signs exactly the canonical vote body in the vote purpose domain. */
export function signVote(body: VoteBody, secretKey: Uint8Array): SignedVote {
  const parsed = parseCanonical(body, voteBodySchema);
  if (!parsed.ok) throw new TypeError('Invalid vote body');
  return { body: parsed.value, sig: signObject('vote', parsed.value, secretKey) };
}

function validateWithContext(value: unknown, context: VoteContext): Result<SignedVote> {
  const parsed = parseCanonical(value, signedVoteSchema);
  if (!parsed.ok) return parsed;
  const vote = parsed.value;
  if (vote.body.genesisDigest !== context.genesisDigest || vote.body.epoch !== context.epoch)
    return failure('vote-context', 'Vote belongs to another genesis or membership epoch');
  const voter = context.voters.find((member) => member.seat === vote.body.seat);
  if (!voter) return failure('vote-seat', 'Vote seat is not in certified membership');
  if (!verifyObject('vote', vote.body, vote.sig, fromBase64Url(voter.publicKey)))
    return failure('vote-signature', 'Vote signature does not match its seat');
  return success(vote);
}

export function validateVote(value: unknown, context: VoteContext): Result<SignedVote> {
  const membership = validateContext(context);
  return membership.ok ? validateWithContext(value, membership.value) : membership;
}

/** A certificate is a sorted quorum for one height, round, phase and value. */
export function verifyCertificate(
  votes: unknown,
  context: VoteContext,
  expected: ExpectedVote,
): Result<readonly SignedVote[]> {
  const membership = validateContext(context);
  if (!membership.ok) return membership;
  const target = parseCanonical(expected, expectedSchema);
  if (!target.ok) return target;
  const voterCount = membership.value.voters.length;
  const parsed = parseCanonical(
    votes,
    v.pipe(v.array(signedVoteSchema), v.minLength(quorumSize(voterCount)), v.maxLength(voterCount)),
  );
  if (!parsed.ok) return parsed;
  const certified: SignedVote[] = [];
  let priorSeat = -1;
  for (const vote of parsed.value) {
    if (vote.body.seat <= priorSeat)
      return failure('vote-order', 'Certificate votes must be distinct and sorted by seat');
    priorSeat = vote.body.seat;
    const checked = validateWithContext(vote, membership.value);
    if (!checked.ok) return checked;
    const body = checked.value.body;
    if (
      body.seq !== target.value.seq ||
      body.term !== target.value.term ||
      body.phase !== target.value.phase ||
      body.valueHash !== target.value.valueHash
    )
      return failure('vote-conflict', 'Certificate votes do not agree on one height and value');
    certified.push(checked.value);
  }
  return success(certified);
}
