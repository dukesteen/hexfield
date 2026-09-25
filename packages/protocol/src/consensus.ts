import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { parsePeerId } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { objectiveEvidenceSeq } from './control.js';
import { entryBody, entryHash, genesisDigest, signEntry } from './genesis.js';
import {
  authenticateProposalControlEvidence,
  authenticateCertifiedEntry,
  objectiveProofParentHash,
  proposerFor,
  signedProposalSchema,
  signProposal,
  validateCertifiedEntry,
  validateObjectiveForProposal,
  validateProposal,
} from './proposal.js';
import type { CertifiedEntry, ProposalContext, SignedProposal } from './proposal.js';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  seatSchema,
} from './schema-values.js';
import { excludeProposerControlSchema, logEntrySchema } from './schemas.js';
import type { PeerId } from './transport.js';
import {
  quorumSize,
  signedVoteSchema,
  signVote,
  validateVote,
  verifyCertificate,
} from './votes.js';
import type { SignedVote, VotePhase } from './votes.js';
import type { ExcludeProposerControl, LogEntry } from './types.js';

export type ConsensusStep = 'propose' | 'prevote' | 'precommit';
export type TimeoutPhase = ConsensusStep;

export interface QuorumValue {
  round: number;
  hash: string;
  proposal: SignedProposal;
  prevotes: SignedVote[];
}

export type RoundHint =
  | { kind: 'proposal'; seat: Seat; round: number; proposal: SignedProposal }
  | { kind: 'vote'; seat: Seat; round: number; vote: SignedVote };

export type Equivocation =
  | { kind: 'proposal'; seat: Seat; round: number; first: SignedProposal; second: SignedProposal }
  | {
      kind: 'vote';
      seat: Seat;
      round: number;
      phase: VotePhase;
      first: SignedVote;
      second: SignedVote;
    };

/** One objective first-offender proof carried across certified heights. */
export interface ProvenOffender {
  control: ExcludeProposerControl;
  atSeq: number;
  parentHash: string;
}

/** All safety-relevant records for one height. Persist this whole value atomically. */
export interface ConsensusState {
  version: 1;
  genesisDigest: string;
  epoch: number;
  height: number;
  parentHash: string;
  contextHash: string;
  localSeat: Seat;
  localPublicKey: PeerId;
  round: number;
  step: ConsensusStep;
  inputKnown: boolean;
  timers: { propose: boolean; prevote: boolean; precommit: boolean };
  proposals: SignedProposal[];
  votes: SignedVote[];
  hints: RoundHint[];
  equivocations: Equivocation[];
  pendingAccusation: ExcludeProposerControl | null;
  provenOffender: ProvenOffender | null;
  locked: QuorumValue | null;
  valid: QuorumValue | null;
  decision: CertifiedEntry | null;
  halted: string | null;
  haltKind: 'certified-validation' | 'terminal' | null;
  unappliedCertificate: CertifiedEntry | null;
}

/** The adapter must persist next state before acting on any effect. */
export type ConsensusEffect =
  | { kind: 'broadcast-proposal'; proposal: SignedProposal }
  | { kind: 'broadcast-vote'; vote: SignedVote }
  | { kind: 'schedule-timeout'; phase: TimeoutPhase; round: number }
  | { kind: 'request-value'; round: number; validHash: string | null }
  | { kind: 'request-proposal'; round: number; hash: string }
  | { kind: 'commit'; certified: CertifiedEntry }
  | { kind: 'equivocation'; evidence: Equivocation }
  | { kind: 'halt'; reason: string };

export interface ConsensusTransition {
  state: ConsensusState;
  effects: ConsensusEffect[];
}

const quorumValueSchema = v.strictObject({
  round: positiveIntegerSchema,
  hash: hashSchema,
  proposal: signedProposalSchema,
  prevotes: v.array(signedVoteSchema),
});
const hintSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('proposal'),
    seat: seatSchema,
    round: positiveIntegerSchema,
    proposal: signedProposalSchema,
  }),
  v.strictObject({
    kind: v.literal('vote'),
    seat: seatSchema,
    round: positiveIntegerSchema,
    vote: signedVoteSchema,
  }),
]);
const equivocationSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('proposal'),
    seat: seatSchema,
    round: positiveIntegerSchema,
    first: signedProposalSchema,
    second: signedProposalSchema,
  }),
  v.strictObject({
    kind: v.literal('vote'),
    seat: seatSchema,
    round: positiveIntegerSchema,
    phase: v.picklist(['prevote', 'precommit']),
    first: signedVoteSchema,
    second: signedVoteSchema,
  }),
]);
const certifiedSchema = v.strictObject({
  entry: logEntrySchema,
  certificate: v.array(signedVoteSchema),
});
const stateSchema = v.strictObject({
  version: v.literal(1),
  genesisDigest: key32Schema,
  epoch: nonnegativeIntegerSchema,
  height: positiveIntegerSchema,
  parentHash: hashSchema,
  contextHash: hashSchema,
  localSeat: seatSchema,
  localPublicKey: key32Schema,
  round: positiveIntegerSchema,
  step: v.picklist(['propose', 'prevote', 'precommit']),
  inputKnown: v.boolean(),
  timers: v.strictObject({ propose: v.boolean(), prevote: v.boolean(), precommit: v.boolean() }),
  proposals: v.array(signedProposalSchema),
  votes: v.array(signedVoteSchema),
  hints: v.pipe(v.array(hintSchema), v.maxLength(6)),
  equivocations: v.array(equivocationSchema),
  pendingAccusation: v.nullable(excludeProposerControlSchema),
  provenOffender: v.nullable(
    v.strictObject({
      control: excludeProposerControlSchema,
      atSeq: positiveIntegerSchema,
      parentHash: hashSchema,
    }),
  ),
  locked: v.nullable(quorumValueSchema),
  valid: v.nullable(quorumValueSchema),
  decision: v.nullable(certifiedSchema),
  halted: v.nullable(v.string()),
  haltKind: v.nullable(v.picklist(['certified-validation', 'terminal'])),
  unappliedCertificate: v.nullable(certifiedSchema),
});

function bound(state: ConsensusState, context: ProposalContext, localSeat: Seat): boolean {
  const member = context.membership.voters.find((voter) => voter.seat === localSeat);
  return (
    member !== undefined &&
    state.genesisDigest === genesisDigest(context.log.genesis) &&
    state.genesisDigest === context.membership.genesisDigest &&
    state.epoch === context.membership.epoch &&
    state.height === context.log.head.seq + 1 &&
    state.parentHash === entryHash(context.log.head) &&
    state.contextHash === consensusContextHash(context) &&
    state.localSeat === localSeat &&
    state.localPublicKey === member.publicKey
  );
}

function consensusContextHash(context: ProposalContext): string {
  return toHex(
    hashValue({
      voters: context.membership.voters,
      excludedProposers: [...context.excludedProposers].toSorted((a, b) => a - b),
    }),
  );
}

function localPeer(state: ConsensusState): PeerId {
  return state.localPublicKey;
}

function sameVote(a: SignedVote, b: SignedVote): boolean {
  return a.body.valueHash === b.body.valueHash;
}

function hasUnrecordedOwnVote(state: ConsensusState, proof: readonly SignedVote[]): boolean {
  return proof.some(
    (vote) =>
      vote.body.seat === state.localSeat &&
      vote.body.seq === state.height &&
      !state.votes.some(
        (stored) =>
          stored.body.seat === vote.body.seat &&
          stored.body.seq === vote.body.seq &&
          stored.body.term === vote.body.term &&
          stored.body.phase === vote.body.phase &&
          stored.body.valueHash === vote.body.valueHash &&
          stored.sig === vote.sig,
      ),
  );
}

function hasUnrecordedOwnEntry(state: ConsensusState, entry: LogEntry): boolean {
  return (
    entry.sequencer === state.localPublicKey &&
    !state.proposals.some(
      (stored) => proposalHash(stored) === entryHash(entry) && stored.body.entry.sig === entry.sig,
    )
  );
}

function proposalHash(proposal: SignedProposal): string {
  return entryHash(proposal.body.entry);
}

function proposalSeat(proposal: SignedProposal, context: ProposalContext): Seat | undefined {
  return context.membership.voters.find(
    (voter) => voter.publicKey === proposal.body.entry.sequencer,
  )?.seat;
}

function ownVote(state: ConsensusState, phase: VotePhase): SignedVote | undefined {
  return state.votes.find(
    (vote) =>
      vote.body.seat === state.localSeat &&
      vote.body.term === state.round &&
      vote.body.phase === phase,
  );
}

function votesAt(state: ConsensusState, round: number, phase: VotePhase): SignedVote[] {
  return state.votes.filter((vote) => vote.body.term === round && vote.body.phase === phase);
}

function quorumFor(
  state: ConsensusState,
  context: ProposalContext,
  round: number,
  phase: VotePhase,
  hash: string | null,
): SignedVote[] | null {
  const votes = votesAt(state, round, phase)
    .filter((vote) => vote.body.valueHash === hash)
    .toSorted((a, b) => a.body.seat - b.body.seat);
  return votes.length >= quorumSize(context.membership.voters.length)
    ? votes.slice(0, quorumSize(context.membership.voters.length))
    : null;
}

function anyQuorum(
  state: ConsensusState,
  context: ProposalContext,
  round: number,
  phase: VotePhase,
): boolean {
  return votesAt(state, round, phase).length >= quorumSize(context.membership.voters.length);
}

function proposalAt(
  state: ConsensusState,
  round: number,
  hash: string,
): SignedProposal | undefined {
  return state.proposals.find(
    (proposal) => proposal.body.entry.term === round && proposalHash(proposal) === hash,
  );
}

function signLocalVote(
  state: ConsensusState,
  context: ProposalContext,
  secretKey: Uint8Array,
  phase: VotePhase,
  hash: string | null,
  effects: ConsensusEffect[],
): Result<void> {
  if (ownVote(state, phase)) return success(undefined);
  try {
    const vote = signVote(
      {
        genesisDigest: state.genesisDigest,
        epoch: state.epoch,
        seat: state.localSeat,
        seq: state.height,
        term: state.round,
        phase,
        valueHash: hash,
      },
      secretKey,
    );
    const valid = validateVote(vote, context.membership);
    if (!valid.ok) return valid;
    state.votes.push(valid.value);
    effects.push({ kind: 'broadcast-vote', vote: valid.value });
    state.step = phase;
    return success(undefined);
  } catch {
    return failure(
      'consensus-key',
      'Local signing key is unavailable or does not match this voter',
    );
  }
}

function recordVote(state: ConsensusState, vote: SignedVote, effects: ConsensusEffect[]): void {
  const first = state.votes.find(
    (item) =>
      item.body.seat === vote.body.seat &&
      item.body.term === vote.body.term &&
      item.body.phase === vote.body.phase,
  );
  if (!first) {
    state.votes.push(vote);
    return;
  }
  if (sameVote(first, vote)) return;
  if (
    state.equivocations.some(
      (item) =>
        item.kind === 'vote' &&
        item.seat === vote.body.seat &&
        item.round === vote.body.term &&
        item.phase === vote.body.phase,
    )
  )
    return;
  const evidence: Equivocation = {
    kind: 'vote',
    seat: vote.body.seat,
    round: vote.body.term,
    phase: vote.body.phase,
    first,
    second: vote,
  };
  state.equivocations.push(evidence);
  effects.push({ kind: 'equivocation', evidence });
}

function recordProposal(
  state: ConsensusState,
  context: ProposalContext,
  proposal: SignedProposal,
  effects: ConsensusEffect[],
): void {
  const seat = proposalSeat(proposal, context);
  if (seat === undefined) return;
  const sameRound = state.proposals.filter(
    (item) => item.body.entry.term === proposal.body.entry.term,
  );
  if (sameRound.some((item) => proposalHash(item) === proposalHash(proposal))) return;
  // Two signed conflicts are enough for objective equivocation evidence. Further
  // variants cannot add safety information and must not grow the durable record.
  if (sameRound.length >= 2) return;
  for (const first of sameRound) {
    if (
      proposalHash(first) !== proposalHash(proposal) &&
      !state.equivocations.some(
        (item) =>
          item.kind === 'proposal' && item.seat === seat && item.round === proposal.body.entry.term,
      )
    ) {
      const evidence: Equivocation = {
        kind: 'proposal',
        seat,
        round: proposal.body.entry.term,
        first,
        second: proposal,
      };
      state.equivocations.push(evidence);
      effects.push({ kind: 'equivocation', evidence });
    }
  }
  state.proposals.push(proposal);
}

function addHint(state: ConsensusState, hint: RoundHint): void {
  const existing = state.hints.findIndex((item) => item.seat === hint.seat);
  if (existing < 0) state.hints.push(hint);
  else if ((state.hints[existing]?.round ?? 0) < hint.round) state.hints[existing] = hint;
}

function halt(state: ConsensusState, reason: string, effects: ConsensusEffect[]): void {
  if (state.halted !== null) return;
  state.halted = reason;
  state.haltKind = 'terminal';
  state.unappliedCertificate = null;
  effects.push({ kind: 'halt', reason });
}

function terminalFault(state: ConsensusState, reason: string, effects: ConsensusEffect[]): void {
  if (state.haltKind === 'terminal') return;
  state.halted = reason;
  state.haltKind = 'terminal';
  state.unappliedCertificate = null;
  effects.push({ kind: 'halt', reason });
}

function haltForControlFault(
  state: ConsensusState,
  context: ProposalContext,
  control: ExcludeProposerControl,
  effects: ConsensusEffect[],
): boolean {
  if (control.offender === state.localSeat) {
    terminalFault(state, 'Objective evidence implicates the local signing key', effects);
    return true;
  }
  if (
    (state.provenOffender && state.provenOffender.control.offender !== control.offender) ||
    context.excludedProposers.some((seat) => seat !== control.offender)
  ) {
    terminalFault(state, 'Objective evidence proves a second Byzantine voter', effects);
    return true;
  }
  return false;
}

function haltForEntryControlFault(
  state: ConsensusState,
  context: ProposalContext,
  entry: LogEntry,
  effects: ConsensusEffect[],
): boolean {
  return entry.payload.kind === 'control'
    ? haltForControlFault(state, context, entry.payload, effects)
    : false;
}

function haltForCertifiedValue(
  state: ConsensusState,
  certified: CertifiedEntry,
  errorCode: string,
  effects: ConsensusEffect[],
): void {
  if (state.halted !== null) return;
  const reason = `Certified value failed deterministic validation: ${errorCode}`;
  state.halted = reason;
  state.haltKind = 'certified-validation';
  state.unappliedCertificate = certified;
  effects.push({ kind: 'halt', reason });
}

function haltIfFaultThresholdExceeded(
  state: ConsensusState,
  context: ProposalContext,
  effects: ConsensusEffect[],
): void {
  const equivocators = new Set<Seat>([
    ...state.equivocations.map((item) => item.seat),
    ...context.excludedProposers,
  ]);
  if (state.provenOffender) equivocators.add(state.provenOffender.control.offender);
  if (equivocators.has(state.localSeat)) {
    terminalFault(state, 'Objective evidence implicates the local signing key', effects);
    return;
  }
  const tolerated = context.membership.voters.length === 1 ? 0 : 1;
  if (equivocators.size > tolerated)
    terminalFault(state, 'Objective evidence proves a second Byzantine voter', effects);
}

function enterRound(
  state: ConsensusState,
  context: ProposalContext,
  round: number,
  effects: ConsensusEffect[],
): void {
  if (round <= state.round) return;
  state.round = round;
  state.step = 'propose';
  state.timers = { propose: false, prevote: false, precommit: false };
  const ready = state.hints.filter((hint) => hint.round === round);
  state.hints = state.hints.filter((hint) => hint.round > round);
  for (const hint of ready) {
    if (hint.kind === 'vote') recordVote(state, hint.vote, effects);
    else recordProposal(state, context, hint.proposal, effects);
  }
  if (
    proposerFor(state.height, round, context.membership, context.excludedProposers).seat ===
    state.localSeat
  )
    effects.push({ kind: 'request-value', round, validHash: state.valid?.hash ?? null });
  if (state.inputKnown) {
    state.timers.propose = true;
    effects.push({ kind: 'schedule-timeout', phase: 'propose', round });
  }
}

function maybeJump(
  state: ConsensusState,
  context: ProposalContext,
  effects: ConsensusEffect[],
): void {
  // One authenticated hint per voter bounds future-round memory. The second-highest
  // round is supported by two distinct voters; one Byzantine voter cannot force it.
  const rounds = state.hints.map((hint) => hint.round).toSorted((a, b) => b - a);
  const second = rounds[1];
  if (second !== undefined && second > state.round) enterRound(state, context, second, effects);
}

function maybeCommit(
  state: ConsensusState,
  context: ProposalContext,
  effects: ConsensusEffect[],
): void {
  const rounds = [
    ...new Set(
      state.votes.filter((vote) => vote.body.phase === 'precommit').map((vote) => vote.body.term),
    ),
  ].toSorted((a, b) => a - b);
  for (const round of rounds) {
    for (const hash of new Set(
      votesAt(state, round, 'precommit').map((vote) => vote.body.valueHash),
    )) {
      if (hash === null) continue;
      const certificate = quorumFor(state, context, round, 'precommit', hash);
      if (!certificate) continue;
      const proposal = proposalAt(state, round, hash);
      if (!proposal) {
        effects.push({ kind: 'request-proposal', round, hash });
        continue;
      }
      const certified = { entry: proposal.body.entry, certificate };
      const checked = validateCertifiedEntry(certified, context);
      if (!checked.ok) {
        const authenticated = authenticateCertifiedEntry(certified, context);
        if (authenticated.ok)
          haltForCertifiedValue(state, authenticated.value, checked.error.code, effects);
        else
          halt(
            state,
            `Certified proof failed authentication: ${authenticated.error.code}`,
            effects,
          );
        continue;
      }
      if (haltForEntryControlFault(state, context, checked.value.entry, effects)) return;
      if (state.decision && entryHash(state.decision.entry) !== hash) {
        halt(state, 'Conflicting certified values', effects);
        continue;
      }
      if (!state.decision) {
        state.decision = certified;
        effects.push({ kind: 'commit', certified });
      }
    }
  }
}

function drive(
  state: ConsensusState,
  context: ProposalContext,
  secretKey: Uint8Array,
  effects: ConsensusEffect[],
): Result<void> {
  maybeCommit(state, context, effects);
  if (state.halted !== null || state.decision !== null) return success(undefined);
  if (state.step === 'propose') {
    const waitingProposal = state.proposals.find((item) => item.body.entry.term === state.round);
    if (waitingProposal) {
      const voted = prevoteProposal(state, context, secretKey, waitingProposal, effects);
      if (!voted.ok) return voted;
    }
  }
  const q = quorumSize(context.membership.voters.length);
  for (const proposal of state.proposals.filter((item) => item.body.entry.term === state.round)) {
    const hash = proposalHash(proposal);
    const prevotes = quorumFor(state, context, state.round, 'prevote', hash);
    if (prevotes && (state.valid === null || state.valid.round < state.round)) {
      state.valid = { round: state.round, hash, proposal, prevotes };
    }
    if (prevotes && state.step === 'prevote' && !ownVote(state, 'precommit')) {
      state.locked = { round: state.round, hash, proposal, prevotes };
      const signed = signLocalVote(state, context, secretKey, 'precommit', hash, effects);
      if (!signed.ok) return signed;
    }
  }
  if (state.step === 'prevote' && quorumFor(state, context, state.round, 'prevote', null)) {
    const signed = signLocalVote(state, context, secretKey, 'precommit', null, effects);
    if (!signed.ok) return signed;
  }
  if (!state.timers.prevote && votesAt(state, state.round, 'prevote').length >= q) {
    state.timers.prevote = true;
    effects.push({ kind: 'schedule-timeout', phase: 'prevote', round: state.round });
  }
  if (!state.timers.precommit && anyQuorum(state, context, state.round, 'precommit')) {
    state.timers.precommit = true;
    effects.push({ kind: 'schedule-timeout', phase: 'precommit', round: state.round });
  }
  maybeCommit(state, context, effects);
  return success(undefined);
}

function transition(
  state: ConsensusState,
  context: ProposalContext,
  action: (copy: ConsensusState, effects: ConsensusEffect[]) => Result<void>,
): Result<ConsensusTransition> {
  const restored = restoreConsensusState(state, context, state.localSeat);
  if (!restored.ok) return restored;
  const copy = restored.value;
  const effects: ConsensusEffect[] = [];
  const applied = action(copy, effects);
  return applied.ok ? success({ state: copy, effects }) : applied;
}

/** Only call this for a genuinely new height after the certified parent is stored. */
export function createConsensusState(
  context: ProposalContext,
  localSeat: Seat,
  provenOffender: ProvenOffender | null = null,
  pendingAccusation: ExcludeProposerControl | null = null,
): Result<ConsensusState> {
  const member = context.membership.voters.find((voter) => voter.seat === localSeat);
  if (!member || context.membership.genesisDigest !== genesisDigest(context.log.genesis))
    return failure('consensus-context', 'Local seat or genesis is not in certified membership');
  try {
    for (const voter of context.membership.voters) parsePeerId(voter.publicKey);
    quorumSize(context.membership.voters.length);
    if (
      new Set(context.membership.voters.map((voter) => voter.seat)).size !==
        context.membership.voters.length ||
      new Set(context.membership.voters.map((voter) => voter.publicKey)).size !==
        context.membership.voters.length
    )
      return failure('consensus-context', 'Certified voter set has duplicate seats or keys');
    if (
      context.membership.voters.some((voter, index, voters) => {
        const previous = voters[index - 1];
        return previous !== undefined && voter.seat <= previous.seat;
      }) ||
      new Set(context.excludedProposers).size !== context.excludedProposers.length ||
      context.excludedProposers.some(
        (seat) => !context.membership.voters.some((voter) => voter.seat === seat),
      )
    )
      return failure(
        'consensus-context',
        'Certified voter order or proposer exclusions are malformed',
      );
    proposerFor(context.log.head.seq + 1, 1, context.membership, context.excludedProposers);
  } catch {
    return failure('consensus-context', 'Certified voter set is malformed');
  }
  const state: ConsensusState = {
    version: 1,
    genesisDigest: context.membership.genesisDigest,
    epoch: context.membership.epoch,
    height: context.log.head.seq + 1,
    parentHash: entryHash(context.log.head),
    contextHash: consensusContextHash(context),
    localSeat,
    localPublicKey: member.publicKey,
    round: 1,
    step: 'propose',
    inputKnown: false,
    timers: { propose: false, prevote: false, precommit: false },
    proposals: [],
    votes: [],
    hints: [],
    equivocations: [],
    pendingAccusation,
    provenOffender,
    locked: null,
    valid: null,
    decision: null,
    halted: null,
    haltKind: null,
    unappliedCertificate: null,
  };
  if (provenOffender) {
    const checked = objectiveProofParentHash(provenOffender.control, context);
    if (!checked.ok || checked.value !== provenOffender.parentHash)
      return failure('consensus-context', 'First-offender proof has no certified parent');
    haltForControlFault(state, context, provenOffender.control, []);
  }
  if (
    pendingAccusation &&
    (!provenOffender ||
      toHex(hashValue(pendingAccusation)) !== toHex(hashValue(provenOffender.control)))
  )
    return failure('consensus-context', 'Pending accusation has no matching first proof');
  if (context.excludedProposers.includes(localSeat))
    terminalFault(state, 'Certified prefix excludes the local signing key', []);
  return success(state);
}

/** Never replace a malformed safety record with a fresh round-one state. */
export function restoreConsensusState(
  value: unknown,
  context: ProposalContext,
  localSeat: Seat,
): Result<ConsensusState> {
  let state: ConsensusState;
  try {
    // Persisted safety state is not a network envelope and may exceed its 256 KiB cap.
    const parsed = v.safeParse(stateSchema, canonicalDecode(canonicalEncode(value)));
    if (!parsed.success) return failure('consensus-restore', 'Safety record schema is malformed');
    state = parsed.output;
  } catch {
    return failure('consensus-restore', 'Safety record is not canonical data');
  }
  if (!bound(state, context, localSeat))
    return failure(
      'consensus-context',
      'Safety record belongs to another height, parent, game, epoch or key',
    );
  try {
    const proposalCounts = new Map<number, number>();
    for (const proposal of state.proposals) {
      const round = proposal.body.entry.term;
      const count = (proposalCounts.get(round) ?? 0) + 1;
      if (count > 2)
        return failure('consensus-restore', 'Safety record retains too many proposals per round');
      proposalCounts.set(round, count);
      if (!validateProposal(proposal, context).ok)
        return failure('consensus-restore', 'Stored proposal is invalid');
    }
    for (const vote of state.votes) {
      if (
        !validateVote(vote, context.membership).ok ||
        vote.body.seq !== state.height ||
        vote.body.term > state.round
      )
        return failure('consensus-restore', 'Stored vote is invalid');
    }
    if (
      new Set(state.votes.map((vote) => `${vote.body.seat}/${vote.body.term}/${vote.body.phase}`))
        .size !== state.votes.length
    )
      return failure('consensus-restore', 'Safety record contains duplicate votes');
    if (state.proposals.some((proposal) => proposal.body.entry.term > state.round))
      return failure('consensus-restore', 'Stored proposal is ahead of the persisted round');
    for (const hint of state.hints) {
      if (
        hint.round <= state.round ||
        (hint.kind === 'vote'
          ? !validateVote(hint.vote, context.membership).ok ||
            hint.vote.body.seat !== hint.seat ||
            hint.vote.body.term !== hint.round ||
            hint.vote.body.seq !== state.height
          : !validateProposal(hint.proposal, context).ok ||
            proposalSeat(hint.proposal, context) !== hint.seat ||
            hint.proposal.body.entry.term !== hint.round)
      )
        return failure('consensus-restore', 'Stored future-round hint is invalid');
    }
    if (new Set(state.hints.map((hint) => hint.seat)).size !== state.hints.length)
      return failure('consensus-restore', 'Safety record has duplicate future-round hints');
    for (const record of [state.valid, state.locked]) {
      if (!record) continue;
      if (
        record.round > state.round ||
        record.hash !== proposalHash(record.proposal) ||
        record.proposal.body.entry.term !== record.round ||
        !validateProposal(record.proposal, context).ok ||
        !verifyCertificate(record.prevotes, context.membership, {
          seq: state.height,
          term: record.round,
          phase: 'prevote',
          valueHash: record.hash,
        }).ok
      )
        return failure('consensus-restore', 'Stored lock or valid-value proof is invalid');
    }
    if (
      state.locked &&
      !state.votes.some(
        (vote) =>
          vote.body.seat === localSeat &&
          vote.body.term === state.locked?.round &&
          vote.body.phase === 'precommit' &&
          vote.body.valueHash === state.locked?.hash,
      )
    )
      return failure('consensus-restore', 'Stored lock has no matching local precommit');
    if (
      state.locked &&
      (!state.valid ||
        state.valid.round < state.locked.round ||
        (state.valid.round === state.locked.round && state.valid.hash !== state.locked.hash))
    )
      return failure('consensus-restore', 'Stored valid proof does not cover the local lock');
    const ownProposals = state.proposals.filter(
      (proposal) => proposalSeat(proposal, context) === localSeat,
    );
    if (
      new Set(ownProposals.map((proposal) => proposal.body.entry.term)).size !== ownProposals.length
    )
      return failure('consensus-restore', 'Safety record contains conflicting local proposals');
    const localCommitVotes = state.votes
      .filter(
        (vote) =>
          vote.body.seat === localSeat &&
          vote.body.phase === 'precommit' &&
          vote.body.valueHash !== null,
      )
      .toSorted((a, b) => b.body.term - a.body.term);
    const latestCommit = localCommitVotes[0];
    if (
      latestCommit &&
      (!state.locked ||
        state.locked.round !== latestCommit.body.term ||
        state.locked.hash !== latestCommit.body.valueHash)
    )
      return failure(
        'consensus-restore',
        'Latest local non-nil precommit has no matching persisted lock',
      );
    const localThisRound = state.votes.filter(
      (vote) => vote.body.seat === localSeat && vote.body.term === state.round,
    );
    if (state.step === 'propose' && localThisRound.length > 0)
      return failure('consensus-restore', 'Propose step conflicts with signed local vote');
    if (state.step !== 'propose' && !localThisRound.some((vote) => vote.body.phase === 'prevote'))
      return failure('consensus-restore', 'Voting step has no signed local prevote');
    if (state.step === 'prevote' && localThisRound.some((vote) => vote.body.phase === 'precommit'))
      return failure('consensus-restore', 'Prevote step conflicts with signed local precommit');
    if (
      state.step === 'precommit' &&
      !localThisRound.some((vote) => vote.body.phase === 'precommit')
    )
      return failure('consensus-restore', 'Precommit step has no signed local precommit');
    if (state.timers.propose && !state.inputKnown)
      return failure('consensus-restore', 'Proposal timer is inconsistent');
    if (
      !state.inputKnown &&
      (state.proposals.length > 0 || state.hints.some((hint) => hint.kind === 'proposal'))
    )
      return failure('consensus-restore', 'Stored proposal has no known-input marker');
    if (
      state.timers.prevote &&
      votesAt(state, state.round, 'prevote').length < quorumSize(context.membership.voters.length)
    )
      return failure('consensus-restore', 'Prevote timer has no quorum');
    if (state.timers.precommit && !anyQuorum(state, context, state.round, 'precommit'))
      return failure('consensus-restore', 'Precommit timer has no quorum');
    if (state.decision && !validateCertifiedEntry(state.decision, context).ok)
      return failure('consensus-restore', 'Stored decision certificate is invalid');
    if (
      (state.decision && hasUnrecordedOwnEntry(state, state.decision.entry)) ||
      (state.unappliedCertificate && hasUnrecordedOwnEntry(state, state.unappliedCertificate.entry))
    )
      return failure('consensus-restore', 'Safety proof contains an unrecorded local entry');
    if ((state.halted === null) !== (state.haltKind === null))
      return failure('consensus-restore', 'Stored halt reason and kind disagree');
    if (state.haltKind === 'certified-validation') {
      if (
        state.decision !== null ||
        state.unappliedCertificate === null ||
        state.unappliedCertificate.entry.seq !== state.height ||
        !authenticateCertifiedEntry(state.unappliedCertificate, context).ok
      )
        return failure('consensus-restore', 'Stored unapplied certificate is invalid');
    } else if (state.unappliedCertificate !== null) {
      return failure(
        'consensus-restore',
        'Only a certified-validation halt can retain a certificate',
      );
    }
    if (state.equivocations.length > 0) {
      for (const evidence of state.equivocations) {
        const checked =
          evidence.kind === 'vote'
            ? validateVote(evidence.first, context.membership).ok &&
              validateVote(evidence.second, context.membership).ok
            : validateProposal(evidence.first, context).ok &&
              validateProposal(evidence.second, context).ok;
        const sameTarget =
          evidence.kind === 'vote'
            ? evidence.first.body.seat === evidence.seat &&
              evidence.second.body.seat === evidence.seat &&
              evidence.first.body.seq === state.height &&
              evidence.second.body.seq === state.height &&
              evidence.first.body.term === evidence.round &&
              evidence.second.body.term === evidence.round &&
              evidence.first.body.phase === evidence.phase &&
              evidence.second.body.phase === evidence.phase &&
              evidence.first.body.valueHash !== evidence.second.body.valueHash
            : proposalSeat(evidence.first, context) === evidence.seat &&
              proposalSeat(evidence.second, context) === evidence.seat &&
              evidence.first.body.entry.term === evidence.round &&
              evidence.second.body.entry.term === evidence.round &&
              proposalHash(evidence.first) !== proposalHash(evidence.second);
        if (!checked || !sameTarget)
          return failure('consensus-restore', 'Stored equivocation evidence is invalid');
      }
    }
    if (state.provenOffender) {
      const proof = state.provenOffender;
      if (
        proof.atSeq > state.height ||
        (proof.atSeq === state.height && proof.parentHash !== state.parentHash)
      )
        return failure(
          'consensus-restore',
          'First-offender proof has a different height or parent',
        );
      const checked = objectiveProofParentHash(proof.control, context);
      if (!checked.ok || checked.value !== proof.parentHash)
        return failure('consensus-restore', 'First-offender proof has no certified parent');
    }
    if (state.pendingAccusation) {
      if (
        !state.provenOffender ||
        state.provenOffender.atSeq > state.height ||
        toHex(hashValue(state.provenOffender.control)) !== toHex(hashValue(state.pendingAccusation))
      )
        return failure('consensus-restore', 'Pending accusation has no matching current proof');
      const alreadyExcluded = context.excludedProposers.includes(state.pendingAccusation.offender);
      if (!alreadyExcluded && !validateObjectiveForProposal(state.pendingAccusation, context).ok)
        return failure('consensus-restore', 'Pending accusation is not objectively proven');
    }
    const referencedVotes = [
      ...state.proposals.flatMap((proposal) => proposal.body.prevotes),
      ...state.hints.flatMap((hint) =>
        hint.kind === 'vote' ? [hint.vote] : hint.proposal.body.prevotes,
      ),
      ...(state.valid?.prevotes ?? []),
      ...(state.locked?.prevotes ?? []),
      ...(state.decision?.certificate ?? []),
      ...(state.unappliedCertificate?.certificate ?? []),
      ...state.equivocations.flatMap((evidence) =>
        evidence.kind === 'vote'
          ? [evidence.first, evidence.second]
          : [...evidence.first.body.prevotes, ...evidence.second.body.prevotes],
      ),
    ];
    if (hasUnrecordedOwnVote(state, referencedVotes))
      return failure('consensus-restore', 'Safety proof contains an unrecorded local vote');
    const controls: ExcludeProposerControl[] = [];
    const includeControl = (entry: LogEntry): void => {
      if (entry.payload.kind === 'control') controls.push(entry.payload);
    };
    for (const proposal of state.proposals) includeControl(proposal.body.entry);
    for (const hint of state.hints)
      if (hint.kind === 'proposal') includeControl(hint.proposal.body.entry);
    if (state.valid) includeControl(state.valid.proposal.body.entry);
    if (state.locked) includeControl(state.locked.proposal.body.entry);
    if (state.decision) includeControl(state.decision.entry);
    if (state.provenOffender) controls.push(state.provenOffender.control);
    if (state.pendingAccusation) controls.push(state.pendingAccusation);
    for (const evidence of state.equivocations)
      controls.push({
        kind: 'control',
        action: 'exclude-proposer',
        offender: evidence.seat,
        evidence:
          evidence.kind === 'vote'
            ? { kind: 'vote-equivocation', first: evidence.first, second: evidence.second }
            : { kind: 'proposal-equivocation', first: evidence.first, second: evidence.second },
      });
    let observedOffender: Seat | null = null;
    for (const control of controls) {
      if (observedOffender !== null && observedOffender !== control.offender)
        terminalFault(state, 'Objective evidence proves a second Byzantine voter', []);
      observedOffender ??= control.offender;
      if (haltForControlFault(state, context, control, [])) break;
    }
    if (context.excludedProposers.includes(localSeat))
      terminalFault(state, 'Certified prefix excludes the local signing key', []);
    return success(state);
  } catch {
    return failure('consensus-restore', 'Safety record could not be verified');
  }
}

/** Signal that an applicable input exists; only then does proposal timing begin. */
export function inputAvailable(
  state: ConsensusState,
  context: ProposalContext,
): Result<ConsensusTransition> {
  return transition(state, context, (copy, effects) => {
    if (copy.decision || copy.halted) return success(undefined);
    copy.inputKnown = true;
    if (copy.step !== 'propose' || copy.timers.propose) return success(undefined);
    copy.timers.propose = true;
    effects.push({ kind: 'schedule-timeout', phase: 'propose', round: copy.round });
    if (
      proposerFor(copy.height, copy.round, context.membership, context.excludedProposers).seat ===
      copy.localSeat
    )
      effects.push({
        kind: 'request-value',
        round: copy.round,
        validHash: copy.valid?.hash ?? null,
      });
    return success(undefined);
  });
}

function retainAccusation(
  copy: ConsensusState,
  context: ProposalContext,
  control: ExcludeProposerControl,
  effects: ConsensusEffect[],
): Result<void> {
  const checked = objectiveProofParentHash(control, context);
  if (!checked.ok) return checked;
  if (haltForControlFault(copy, context, control, effects)) return success(undefined);
  if (context.excludedProposers.includes(control.offender) || copy.decision || copy.halted)
    return success(undefined);
  const evidence = control.evidence;
  const proposals =
    evidence.kind === 'proposal-equivocation'
      ? [evidence.first, evidence.second]
      : evidence.kind === 'invalid-command'
        ? [evidence.proposal]
        : [];
  const votes =
    evidence.kind === 'vote-equivocation'
      ? [evidence.first, evidence.second]
      : proposals.flatMap((proposal) => proposal.body.prevotes);
  const retainedHistoricalProof =
    copy.provenOffender !== null &&
    copy.provenOffender.atSeq < copy.height &&
    toHex(hashValue(copy.provenOffender.control)) === toHex(hashValue(control));
  if (
    !retainedHistoricalProof &&
    (hasUnrecordedOwnVote(
      copy,
      votes.filter((vote) => validateVote(vote, context.membership).ok),
    ) ||
      proposals.some(
        (proposal) =>
          proposal.body.entry.sequencer === copy.localPublicKey &&
          !copy.proposals.some(
            (stored) =>
              stored.sig === proposal.sig && proposalHash(stored) === proposalHash(proposal),
          ),
      ))
  ) {
    halt(copy, 'Accusation contains an unrecorded local signature', effects);
    return success(undefined);
  }
  if (copy.pendingAccusation) return success(undefined);
  copy.provenOffender ??= {
    control,
    atSeq: objectiveEvidenceSeq(control),
    parentHash: checked.value,
  };
  copy.pendingAccusation = control;
  return success(undefined);
}

/** Retain an authenticated accusation before the adapter can gossip it. */
export function stageAccusation(
  state: ConsensusState,
  context: ProposalContext,
  control: ExcludeProposerControl,
): Result<ConsensusTransition> {
  return transition(state, context, (copy, effects) =>
    retainAccusation(copy, context, control, effects),
  );
}

/** Remove only an accusation already represented by the certified exclusion. */
export function clearStaleAccusation(
  state: ConsensusState,
  context: ProposalContext,
): Result<ConsensusTransition> {
  return transition(state, context, (copy) => {
    if (
      copy.pendingAccusation &&
      copy.provenOffender &&
      context.excludedProposers.includes(copy.pendingAccusation.offender) &&
      toHex(hashValue(copy.pendingAccusation)) === toHex(hashValue(copy.provenOffender.control))
    )
      copy.pendingAccusation = null;
    return success(undefined);
  });
}

/** Caller may invoke only after authenticating a conflicting certified history. */
export function terminalHalt(
  state: ConsensusState,
  context: ProposalContext,
  reason: string,
): Result<ConsensusTransition> {
  return transition(state, context, (copy, effects) => {
    halt(copy, reason, effects);
    return success(undefined);
  });
}

/** The local proposer signs a fresh or its latest quorum-backed value. */
export function propose(
  state: ConsensusState,
  context: ProposalContext,
  secretKey: Uint8Array,
  candidate?: LogEntry,
): Result<ConsensusTransition> {
  return transition(state, context, (copy, effects) => {
    if (copy.decision || copy.halted || copy.step !== 'propose') return success(undefined);
    const proposer = proposerFor(
      copy.height,
      copy.round,
      context.membership,
      context.excludedProposers,
    );
    if (proposer.seat !== copy.localSeat)
      return failure('consensus-proposer', 'Only the selected proposer may sign');
    if (
      copy.proposals.some(
        (item) =>
          item.body.entry.term === copy.round && item.body.entry.sequencer === localPeer(copy),
      )
    )
      return success(undefined);
    const source = copy.valid?.proposal.body.entry ?? candidate;
    if (!source) return failure('consensus-value', 'No applicable proposal value is available');
    copy.inputKnown = true;
    try {
      const entry = signEntry(
        { ...entryBody(source), term: copy.round, sequencer: localPeer(copy) },
        secretKey,
      );
      const proposal = signProposal(
        {
          genesisDigest: copy.genesisDigest,
          epoch: copy.epoch,
          entry,
          validRound: copy.valid?.round ?? null,
          prevotes: copy.valid?.prevotes ?? [],
        },
        secretKey,
      );
      const checked = validateProposal(proposal, context);
      if (!checked.ok) return checked;
      if (checked.value.proposal.body.entry.payload.kind === 'control') {
        const retained = retainAccusation(
          copy,
          context,
          checked.value.proposal.body.entry.payload,
          effects,
        );
        if (!retained.ok || copy.halted) return retained;
      }
      recordProposal(copy, context, checked.value.proposal, effects);
      effects.push({ kind: 'broadcast-proposal', proposal: checked.value.proposal });
      const voted = prevoteProposal(copy, context, secretKey, checked.value.proposal, effects);
      if (!voted.ok) return voted;
      return drive(copy, context, secretKey, effects);
    } catch {
      return failure(
        'consensus-key',
        'Local proposal key is unavailable or does not match this voter',
      );
    }
  });
}

function prevoteProposal(
  state: ConsensusState,
  context: ProposalContext,
  secretKey: Uint8Array,
  proposal: SignedProposal,
  effects: ConsensusEffect[],
): Result<void> {
  if (proposal.body.entry.term !== state.round || state.step !== 'propose')
    return success(undefined);
  const hash = proposalHash(proposal);
  const accepts =
    !state.locked ||
    state.locked.hash === hash ||
    (proposal.body.validRound !== null && proposal.body.validRound >= state.locked.round);
  return signLocalVote(state, context, secretKey, 'prevote', accepts ? hash : null, effects);
}

export function receiveProposal(
  state: ConsensusState,
  context: ProposalContext,
  secretKey: Uint8Array,
  value: unknown,
): Result<ConsensusTransition> {
  return transition(state, context, (copy, effects) => {
    const checked = validateProposal(value, context);
    if (!checked.ok) {
      const evidence = authenticateProposalControlEvidence(value, context);
      if (evidence.ok && haltForControlFault(copy, context, evidence.value, effects))
        return success(undefined);
      return checked;
    }
    const proposal = checked.value.proposal;
    if (proposal.body.entry.payload.kind === 'control') {
      const retained = retainAccusation(copy, context, proposal.body.entry.payload, effects);
      if (!retained.ok || copy.halted) return retained;
    }
    if (hasUnrecordedOwnVote(copy, proposal.body.prevotes)) {
      halt(
        copy,
        'Unrecorded local vote in proposal proof indicates a stale safety record',
        effects,
      );
      return success(undefined);
    }
    const seat = proposalSeat(proposal, context);
    if (seat === undefined) return failure('consensus-proposer', 'Proposal signer is not a voter');
    const round = proposal.body.entry.term;
    if (
      seat === copy.localSeat &&
      !copy.proposals.some(
        (known) =>
          known.body.entry.term === round && proposalHash(known) === proposalHash(proposal),
      ) &&
      !copy.hints.some(
        (known) =>
          known.kind === 'proposal' &&
          known.round === round &&
          proposalHash(known.proposal) === proposalHash(proposal),
      )
    ) {
      halt(
        copy,
        'Unrecorded local proposal indicates a stale safety record or duplicate writer',
        effects,
      );
      return success(undefined);
    }
    if (copy.halted) return success(undefined);
    copy.inputKnown = true;
    if (round > copy.round) {
      addHint(copy, { kind: 'proposal', seat, round, proposal });
      maybeJump(copy, context, effects);
      if (round > copy.round) return success(undefined);
    }
    recordProposal(copy, context, proposal, effects);
    if (
      !copy.proposals.some(
        (known) =>
          known.body.entry.term === round && proposalHash(known) === proposalHash(proposal),
      )
    )
      return success(undefined);
    haltIfFaultThresholdExceeded(copy, context, effects);
    if (copy.halted) return success(undefined);
    if (copy.decision) return drive(copy, context, secretKey, effects);
    const voted = prevoteProposal(copy, context, secretKey, proposal, effects);
    return voted.ok ? drive(copy, context, secretKey, effects) : voted;
  });
}

export function receiveVote(
  state: ConsensusState,
  context: ProposalContext,
  secretKey: Uint8Array,
  value: unknown,
): Result<ConsensusTransition> {
  return transition(state, context, (copy, effects) => {
    const checked = validateVote(value, context.membership);
    if (!checked.ok) return checked;
    const vote = checked.value;
    if (vote.body.seq !== copy.height)
      return failure('consensus-height', 'Vote belongs to another height');
    if (
      vote.body.seat === copy.localSeat &&
      !copy.votes.some(
        (known) =>
          known.body.seat === copy.localSeat &&
          known.body.term === vote.body.term &&
          known.body.phase === vote.body.phase &&
          sameVote(known, vote),
      )
    ) {
      halt(
        copy,
        'Unrecorded local vote indicates a stale safety record or duplicate writer',
        effects,
      );
      return success(undefined);
    }
    if (copy.halted) return success(undefined);
    if (vote.body.term > copy.round) {
      addHint(copy, { kind: 'vote', seat: vote.body.seat, round: vote.body.term, vote });
      maybeJump(copy, context, effects);
      if (vote.body.term > copy.round) return success(undefined);
    }
    recordVote(copy, vote, effects);
    haltIfFaultThresholdExceeded(copy, context, effects);
    return copy.halted ? success(undefined) : drive(copy, context, secretKey, effects);
  });
}

/** A complete old-round certificate remains valid after local round changes. */
export function receiveCommit(
  state: ConsensusState,
  context: ProposalContext,
  value: unknown,
): Result<ConsensusTransition> {
  return transition(state, context, (copy, effects) => {
    const authenticated = authenticateCertifiedEntry(value, context);
    if (!authenticated.ok) return authenticated;
    const entry = authenticated.value.entry;
    if (entry.seq <= context.log.head.seq)
      return failure('stale-entry', 'Entry was already superseded');
    if (entry.seq > context.log.head.seq + 1)
      return failure('missing-ancestor', 'Fetch missing log entries before validating this entry');
    if (hasUnrecordedOwnVote(copy, authenticated.value.certificate)) {
      halt(
        copy,
        'Unrecorded local vote in commit certificate indicates a stale safety record',
        effects,
      );
      return success(undefined);
    }
    if (hasUnrecordedOwnEntry(copy, entry)) {
      halt(copy, 'Unrecorded local entry indicates a stale safety record', effects);
      return success(undefined);
    }
    const checked = validateCertifiedEntry(authenticated.value, context);
    if (!checked.ok) {
      haltForCertifiedValue(copy, authenticated.value, checked.error.code, effects);
      return success(undefined);
    }
    if (haltForEntryControlFault(copy, context, checked.value.entry, effects))
      return success(undefined);
    const certified: CertifiedEntry = {
      entry: checked.value.entry,
      certificate: [...checked.value.certificate],
    };
    if (copy.decision && entryHash(copy.decision.entry) !== checked.value.hash)
      halt(copy, 'Conflicting certified values', effects);
    else if (!copy.decision && !copy.halted) {
      copy.decision = certified;
      effects.push({ kind: 'commit', certified });
    }
    return success(undefined);
  });
}

/** Resume only a certified-value halt after reconstructing the same prefix in a fresh engine. */
export function resumeAfterReplay(
  state: ConsensusState,
  freshContext: ProposalContext,
): Result<ConsensusTransition> {
  const restored = restoreConsensusState(state, freshContext, state.localSeat);
  if (!restored.ok) return restored;
  const copy = restored.value;
  if (copy.haltKind !== 'certified-validation' || copy.unappliedCertificate === null)
    return failure('consensus-repair-unavailable', 'This halt cannot be cleared by replay');
  const checked = validateCertifiedEntry(copy.unappliedCertificate, freshContext);
  if (!checked.ok)
    return failure('consensus-repair-incomplete', 'Certified value still fails replay validation');
  const effects: ConsensusEffect[] = [];
  if (haltForEntryControlFault(copy, freshContext, checked.value.entry, effects))
    return success({ state: copy, effects });
  const certified: CertifiedEntry = {
    entry: checked.value.entry,
    certificate: [...checked.value.certificate],
  };
  copy.decision = certified;
  copy.halted = null;
  copy.haltKind = null;
  copy.unappliedCertificate = null;
  return success({ state: copy, effects: [{ kind: 'commit', certified }] });
}

export function timeout(
  state: ConsensusState,
  context: ProposalContext,
  secretKey: Uint8Array,
  phase: TimeoutPhase,
  round: number,
): Result<ConsensusTransition> {
  return transition(state, context, (copy, effects) => {
    if (copy.decision || copy.halted || round !== copy.round || !copy.timers[phase])
      return success(undefined);
    if (phase === 'propose' && copy.step === 'propose') {
      const signed = signLocalVote(copy, context, secretKey, 'prevote', null, effects);
      return signed.ok ? drive(copy, context, secretKey, effects) : signed;
    }
    if (phase === 'prevote' && copy.step === 'propose') {
      const prevoted = signLocalVote(copy, context, secretKey, 'prevote', null, effects);
      if (!prevoted.ok) return prevoted;
    }
    if (phase === 'prevote' && copy.step === 'prevote') {
      const signed = signLocalVote(copy, context, secretKey, 'precommit', null, effects);
      return signed.ok ? drive(copy, context, secretKey, effects) : signed;
    }
    if (phase === 'precommit') {
      enterRound(copy, context, copy.round + 1, effects);
      return drive(copy, context, secretKey, effects);
    }
    return success(undefined);
  });
}

/** Re-arm durable timers and retransmit signed local messages after restart.
 * Commit delivery is at least once; the consumer deduplicates by height/value.
 */
export function recoverConsensusEffects(
  state: ConsensusState,
  context: ProposalContext,
): Result<ConsensusEffect[]> {
  const restored = restoreConsensusState(state, context, state.localSeat);
  if (!restored.ok) return restored;
  const current = restored.value;
  if (current.halted) return success([{ kind: 'halt', reason: current.halted }]);
  const effects: ConsensusEffect[] = [];
  const signed = [
    ...current.proposals
      .filter((proposal) => proposalSeat(proposal, context) === current.localSeat)
      .map((proposal) => ({
        round: proposal.body.entry.term,
        order: 0,
        effect: { kind: 'broadcast-proposal' as const, proposal },
      })),
    ...current.votes
      .filter((vote) => vote.body.seat === current.localSeat)
      .map((vote) => ({
        round: vote.body.term,
        order: 1,
        effect: { kind: 'broadcast-vote' as const, vote },
      })),
  ].toSorted((a, b) => b.round - a.round || a.order - b.order);
  effects.push(...signed.map(({ effect }) => effect));
  if (current.decision) {
    effects.push({ kind: 'commit', certified: current.decision });
    return success(effects);
  }
  if (current.step === 'propose' && current.timers.propose)
    effects.push({ kind: 'schedule-timeout', phase: 'propose', round: current.round });
  if ((current.step === 'propose' || current.step === 'prevote') && current.timers.prevote)
    effects.push({ kind: 'schedule-timeout', phase: 'prevote', round: current.round });
  if (current.timers.precommit)
    effects.push({ kind: 'schedule-timeout', phase: 'precommit', round: current.round });
  if (
    current.step === 'propose' &&
    proposerFor(current.height, current.round, context.membership, context.excludedProposers)
      .seat === current.localSeat &&
    !current.proposals.some(
      (proposal) =>
        proposal.body.entry.term === current.round &&
        proposalSeat(proposal, context) === current.localSeat,
    )
  )
    effects.push({
      kind: 'request-value',
      round: current.round,
      validHash: current.valid?.hash ?? null,
    });
  return success(effects);
}
