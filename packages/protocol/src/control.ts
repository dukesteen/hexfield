import { hashValue, toHex } from '@cp2p/codec';
import { parsePeerId, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { entryBody, entryHash } from './genesis.js';
import { validateSignedCommand } from './log.js';
import type { LogContext } from './log.js';
import {
  key32Schema,
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  signature64Schema,
} from './schema-values.js';
import { logEntrySchema } from './schemas.js';
import type { ExcludeProposerControl, SignedProposal } from './types.js';
import { parseCanonical } from './validation.js';
import { signedVoteSchema, validateVote } from './votes.js';
import type { VoteContext } from './votes.js';

const signedProposalSchema = v.strictObject({
  body: v.strictObject({
    genesisDigest: key32Schema,
    epoch: nonnegativeIntegerSchema,
    entry: logEntrySchema,
    validRound: v.nullable(positiveIntegerSchema),
    prevotes: v.pipe(v.array(signedVoteSchema), v.maxLength(6)),
  }),
  sig: signature64Schema,
});

const CONTEXTUAL_COMMAND_FAILURES = new Set([
  'wrong-game',
  'replayed-nonce',
  'future-head',
  'stale-head',
  'command-parent',
]);

export interface ControlEvidenceContext {
  /** Must be reconstructed from the certified prefix ending at the offending parent. */
  log: LogContext;
  membership: VoteContext;
  excludedProposers: readonly Seat[];
  proposerFor: (seq: number, term: number) => { seat: Seat; publicKey: string };
}

/** The claimed proof height comes only from authenticated signed evidence. */
export function objectiveEvidenceSeq(control: ExcludeProposerControl): number {
  const evidence = control.evidence;
  return evidence.kind === 'vote-equivocation'
    ? evidence.first.body.seq
    : evidence.kind === 'proposal-equivocation'
      ? evidence.first.body.entry.seq
      : evidence.proposal.body.entry.seq;
}

function authenticatedProposal(
  value: unknown,
  context: ControlEvidenceContext,
): Result<SignedProposal> {
  const parsed = parseCanonical(value, signedProposalSchema);
  if (!parsed.ok) return parsed;
  const proposal = parsed.value;
  const { body } = proposal;
  const entry = body.entry;
  if (
    body.genesisDigest !== context.membership.genesisDigest ||
    body.epoch !== context.membership.epoch ||
    entry.seq !== context.log.head.seq + 1 ||
    entry.prevHash !== entryHash(context.log.head)
  )
    return failure('control-context', 'Evidence proposal does not extend the certified parent');
  let proposer: ReturnType<ControlEvidenceContext['proposerFor']>;
  try {
    proposer = context.proposerFor(entry.seq, entry.term);
  } catch {
    return failure('control-context', 'Evidence proposal has no elected proposer');
  }
  if (
    entry.sequencer !== proposer.publicKey ||
    !verifyObject('proposal', body, proposal.sig, parsePeerId(proposer.publicKey)) ||
    !verifyObject('entry', entryBody(entry), entry.sig, parsePeerId(proposer.publicKey))
  )
    return failure(
      'control-signature',
      'Evidence proposal and entry require the elected proposer signatures',
    );
  return success(proposal);
}

/** Authenticates a claim even when another offender already exhausted the fault model. */
export function validateObjectiveAccusation(
  control: ExcludeProposerControl,
  context: ControlEvidenceContext,
): Result<void> {
  try {
    if (context.excludedProposers.includes(control.offender))
      return failure('control-duplicate', 'The proposer is already excluded');
    if (!context.membership.voters.some((voter) => voter.seat === control.offender))
      return failure('control-seat', 'Only a human voter can be excluded as proposer');
    // A locally damaged public state must never become accusation evidence.
    if (
      toHex(hashValue(context.log.state)) !== context.log.head.stateHash ||
      context.log.engine.checkInvariants(context.log.state).length !== 0
    )
      return failure(
        'control-parent',
        'Certified parent state must be replayed before checking evidence',
      );
    const evidence = control.evidence;
    if (evidence.kind === 'vote-equivocation') {
      const first = validateVote(evidence.first, context.membership);
      const second = validateVote(evidence.second, context.membership);
      if (!first.ok || !second.ok)
        return failure('control-vote', 'Both conflicting votes need valid voter signatures');
      const a = first.value.body;
      const b = second.value.body;
      return a.seat === control.offender &&
        b.seat === a.seat &&
        a.seq === context.log.head.seq + 1 &&
        b.seq === a.seq &&
        a.term === b.term &&
        a.phase === b.phase &&
        a.valueHash !== b.valueHash
        ? success(undefined)
        : failure('control-unproven', 'Votes do not conflict at one height, round and phase');
    }
    if (evidence.kind === 'proposal-equivocation') {
      const first = authenticatedProposal(evidence.first, context);
      const second = authenticatedProposal(evidence.second, context);
      if (!first.ok || !second.ok)
        return failure(
          'control-proposal',
          'Both conflicting proposals need elected proposer signatures',
        );
      const a = first.value.body.entry;
      const b = second.value.body.entry;
      const proposer = context.proposerFor(a.seq, a.term);
      return proposer.seat === control.offender &&
        a.term === b.term &&
        entryHash(a) !== entryHash(b)
        ? success(undefined)
        : failure('control-unproven', 'Proposals do not conflict at one height and round');
    }
    const proposal = authenticatedProposal(evidence.proposal, context);
    if (!proposal.ok) return proposal;
    const entry = proposal.value.body.entry;
    const proposer = context.proposerFor(entry.seq, entry.term);
    if (proposer.seat !== control.offender || entry.payload.kind !== 'command')
      return failure('control-unproven', 'Evidence is not this proposer’s signed command proposal');
    const command = validateSignedCommand(entry.payload.signed, context.log);
    return command.ok || CONTEXTUAL_COMMAND_FAILURES.has(command.error.code)
      ? failure('control-unproven', 'A stale or valid command is not objective proposer misconduct')
      : success(undefined);
  } catch {
    return failure(
      'control-verification',
      'Evidence could not be verified against the certified parent',
    );
  }
}

/** A control entry may exclude only the first proven offender; quorum never shrinks. */
export function validateExcludeProposerControl(
  control: ExcludeProposerControl,
  context: ControlEvidenceContext,
): Result<void> {
  const objective = validateObjectiveAccusation(control, context);
  if (!objective.ok) return objective;
  return context.excludedProposers.length >= 1 || context.membership.voters.length === 1
    ? failure('control-fault-limit', 'Further proposer exclusion exceeds the ordering fault limit')
    : success(undefined);
}
