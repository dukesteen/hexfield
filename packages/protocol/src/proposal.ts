import { parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { objectiveEvidenceSeq, validateObjectiveAccusation } from './control.js';
import { entryBody, entryHash, genesisDigest } from './genesis.js';
import { validateNextEntry } from './log.js';
import type { EntryPolicy, LogContext, ValidatedEntry } from './log.js';
import {
  key32Schema,
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  signature64Schema,
} from './schema-values.js';
import { logEntrySchema } from './schemas.js';
import type { ExcludeProposerControl, LogEntry, ProposalBody, SignedProposal } from './types.js';
import { parseCanonical } from './validation.js';
import { signedVoteSchema, verifyCertificate } from './votes.js';
import type { SignedVote, VoteContext } from './votes.js';

export type { ProposalBody, SignedProposal } from './types.js';

/** All membership and exclusion fields must come from the certified prefix. */
export interface ProposalContext {
  log: LogContext;
  membership: VoteContext;
  excludedProposers: readonly Seat[];
  policy: Omit<EntryPolicy, 'term' | 'sequencer'>;
  /** Internal resolver built from replayed certified entries; never from wire metadata. */
  verifyHistoricalAccusation?: (control: ExcludeProposerControl) => Result<string>;
}

export function objectiveProofParentHash(
  control: ExcludeProposerControl,
  context: ProposalContext,
): Result<string> {
  const atSeq = objectiveEvidenceSeq(control);
  const height = context.log.head.seq + 1;
  if (atSeq < 1 || atSeq > height)
    return failure('control-context', 'Accusation evidence belongs to another height');
  if (atSeq < height)
    return (
      context.verifyHistoricalAccusation?.(control) ??
      failure('control-history', 'Certified historical parent is unavailable')
    );
  const checked = validateObjectiveAccusation(control, {
    log: context.log,
    membership: context.membership,
    excludedProposers: context.excludedProposers,
    proposerFor: (seq, term) =>
      proposerFor(seq, term, context.membership, context.excludedProposers),
  });
  return checked.ok ? success(entryHash(context.log.head)) : checked;
}

export function validateObjectiveForProposal(
  control: ExcludeProposerControl,
  context: ProposalContext,
): Result<void> {
  const checked = objectiveProofParentHash(control, context);
  return checked.ok ? success(undefined) : checked;
}

/** Authenticate objective control evidence even when the exclusion policy rejects the value. */
export function authenticateProposalControlEvidence(
  value: unknown,
  context: ProposalContext,
): Result<ExcludeProposerControl> {
  const parsed = parseCanonical(value, signedProposalSchema);
  if (!parsed.ok) return parsed;
  const proposal = parsed.value;
  const { body } = proposal;
  const entry = body.entry;
  if (entry.payload.kind !== 'control')
    return failure('control-evidence', 'Proposal does not carry exclusion evidence');
  if (
    body.genesisDigest !== context.membership.genesisDigest ||
    body.epoch !== context.membership.epoch ||
    context.membership.genesisDigest !== genesisDigest(context.log.genesis) ||
    entry.seq !== context.log.head.seq + 1 ||
    entry.prevHash !== entryHash(context.log.head)
  )
    return failure('proposal-context', 'Control proposal does not extend this certified parent');
  try {
    const proposer = proposerFor(
      entry.seq,
      entry.term,
      context.membership,
      context.excludedProposers,
    );
    const key = parsePeerId(proposer.publicKey);
    if (
      entry.sequencer !== proposer.publicKey ||
      !verifyObject('entry', entryBody(entry), entry.sig, key) ||
      !verifyObject('proposal', body, proposal.sig, key)
    )
      return failure('proposal-signature', 'Control proposal needs the elected signer');
  } catch {
    return failure('proposal-signature', 'Control proposal signer is invalid');
  }
  const objective = validateObjectiveForProposal(entry.payload, context);
  return objective.ok ? success(entry.payload) : objective;
}

function validateControlForProposal(
  control: ExcludeProposerControl,
  context: ProposalContext,
): Result<void> {
  const objective = validateObjectiveForProposal(control, context);
  if (!objective.ok) return objective;
  if (
    context.excludedProposers.includes(control.offender) ||
    context.excludedProposers.length >= 1 ||
    context.membership.voters.length === 1
  )
    return failure('control-fault-limit', 'A proposer is already excluded');
  return success(undefined);
}

export interface ValidatedProposal {
  proposal: SignedProposal;
  derived: ValidatedEntry;
}

export interface CertifiedEntry {
  entry: LogEntry;
  certificate: readonly SignedVote[];
}

const proposalBodySchema = v.strictObject({
  genesisDigest: key32Schema,
  epoch: nonnegativeIntegerSchema,
  entry: logEntrySchema,
  validRound: v.nullable(positiveIntegerSchema),
  prevotes: v.pipe(v.array(signedVoteSchema), v.maxLength(6)),
});
export const signedProposalSchema = v.strictObject({
  body: proposalBodySchema,
  sig: signature64Schema,
});
export const certifiedEntrySchema = v.strictObject({
  entry: logEntrySchema,
  certificate: v.pipe(v.array(signedVoteSchema), v.maxLength(6)),
});

/** Reachability cannot change the proposer selected from agreed membership. */
export function proposerFor(
  seq: number,
  term: number,
  membership: VoteContext,
  excluded: readonly Seat[] = [],
): VoteContext['voters'][number] {
  if (!Number.isSafeInteger(seq) || seq < 1 || !Number.isSafeInteger(term) || term < 1)
    throw new RangeError('Proposal height and round must be positive safe integers');
  const eligible = membership.voters.filter((voter) => !excluded.includes(voter.seat));
  if (eligible.length === 0) throw new RangeError('No eligible proposer');
  // Reduce before addition to avoid overflowing safe integers on hostile rounds.
  const index = (((seq - 1) % eligible.length) + ((term - 1) % eligible.length)) % eligible.length;
  const proposer = eligible[index];
  if (!proposer) throw new RangeError('No eligible proposer');
  return proposer;
}

export function signProposal(body: ProposalBody, secretKey: Uint8Array): SignedProposal {
  const parsed = parseCanonical(body, proposalBodySchema);
  if (!parsed.ok) throw new TypeError('Invalid proposal body');
  return { body: parsed.value, sig: signObject('proposal', parsed.value, secretKey) };
}

function validateEntry(entry: LogEntry, context: ProposalContext): Result<ValidatedEntry> {
  if (context.membership.genesisDigest !== genesisDigest(context.log.genesis))
    return failure('proposal-context', 'Membership does not match the game genesis');
  let proposer: VoteContext['voters'][number];
  try {
    proposer = proposerFor(entry.seq, entry.term, context.membership, context.excludedProposers);
  } catch {
    return failure('proposal-context', 'No valid proposer for this height and round');
  }
  return validateNextEntry(entry, context.log, {
    ...context.policy,
    term: entry.term,
    sequencer: proposer.publicKey,
    verifyControl: (control) => validateControlForProposal(control, context),
  });
}

/** Applies certified protocol metadata only after its entry has been validated. */
export function advanceContext(
  context: ProposalContext,
  validated: ValidatedEntry,
): Result<ProposalContext> {
  const payload = validated.entry.payload;
  if (
    payload.kind === 'control' &&
    (validated.input !== null ||
      context.excludedProposers.includes(payload.offender) ||
      context.excludedProposers.length >= 1)
  )
    return failure(
      'control-transition',
      'Certified proposer exclusion is inconsistent or exceeds the fault limit',
    );
  const excludedProposers =
    payload.kind === 'control'
      ? [...context.excludedProposers, payload.offender].toSorted((a, b) => a - b)
      : context.excludedProposers;
  return success({
    ...context,
    log: {
      ...context.log,
      head: validated.entry,
      state: validated.state,
      lastNonces: validated.lastNonces,
    },
    excludedProposers,
  });
}

/** A round justification is checked even when the receiving voter has no lock. */
export function validateProposal(
  value: unknown,
  context: ProposalContext,
): Result<ValidatedProposal> {
  const parsed = parseCanonical(value, signedProposalSchema);
  if (!parsed.ok) return parsed;
  const proposal = parsed.value;
  const { body } = proposal;
  if (
    body.genesisDigest !== context.membership.genesisDigest ||
    body.epoch !== context.membership.epoch
  )
    return failure('proposal-context', 'Proposal belongs to another game or membership epoch');
  const derived = validateEntry(body.entry, context);
  if (!derived.ok) return derived;
  if (!verifyObject('proposal', body, proposal.sig, parsePeerId(body.entry.sequencer)))
    return failure('proposal-signature', 'Proposal signature does not match its proposer');
  if (body.validRound === null) {
    if (body.prevotes.length !== 0)
      return failure('proposal-justification', 'Initial proposal cannot claim prior prevotes');
  } else {
    if (body.validRound >= body.entry.term)
      return failure('proposal-justification', 'Justification must precede the proposal round');
    const proof = verifyCertificate(body.prevotes, context.membership, {
      seq: body.entry.seq,
      term: body.validRound,
      phase: 'prevote',
      valueHash: derived.value.hash,
    });
    if (!proof.ok) return proof;
  }
  return success({ proposal, derived: derived.value });
}

/** Commit certificates may use an older round; local timeout state is irrelevant. */
export function authenticateCertifiedEntry(
  value: unknown,
  context: ProposalContext,
): Result<CertifiedEntry> {
  const parsed = parseCanonical(value, certifiedEntrySchema);
  if (!parsed.ok) return parsed;
  const { entry, certificate } = parsed.value;
  if (context.membership.genesisDigest !== genesisDigest(context.log.genesis))
    return failure('proposal-context', 'Membership does not match the game genesis');
  const proof = verifyCertificate(certificate, context.membership, {
    seq: entry.seq,
    term: entry.term,
    phase: 'precommit',
    valueHash: entryHash(entry),
  });
  if (!proof.ok) return proof;
  let proposer: VoteContext['voters'][number];
  try {
    proposer = proposerFor(entry.seq, entry.term, context.membership, context.excludedProposers);
  } catch {
    return failure('proposal-context', 'No valid proposer for this height and round');
  }
  if (entry.sequencer !== proposer.publicKey)
    return failure('wrong-term', 'Entry does not belong to the verified sequencer term');
  const genesisProposer = context.log.genesis.seats.find(
    (seat) => seat.kind === 'human' && seat.publicKey === proposer.publicKey,
  );
  if (!genesisProposer)
    return failure('sequencer-signature', 'Entry signature does not match the sequencer');
  try {
    if (!verifyObject('entry', entryBody(entry), entry.sig, parsePeerId(proposer.publicKey)))
      return failure('sequencer-signature', 'Entry signature does not match the sequencer');
  } catch {
    return failure('sequencer-signature', 'Entry signature does not match the sequencer');
  }
  return success({ entry, certificate: proof.value });
}

export function validateCertifiedEntry(
  value: unknown,
  context: ProposalContext,
): Result<ValidatedEntry & CertifiedEntry> {
  const authenticated = authenticateCertifiedEntry(value, context);
  if (!authenticated.ok) return authenticated;
  const derived = validateEntry(authenticated.value.entry, context);
  return derived.ok
    ? success({ ...derived.value, certificate: authenticated.value.certificate })
    : derived;
}
