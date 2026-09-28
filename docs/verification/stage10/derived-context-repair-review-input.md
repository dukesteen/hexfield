# Derived context repair: frozen source review

Review this implementation read-only. Find concrete safety/liveness defects, with severity, path/line, mechanism and smallest fix. Do not infer full scenario acceptance from unit tests.

Check opening-stamp comparison against locally trusted durable replay, including wrapper/function omissions; quarantine of all signing/persistence/authority effects; authentic held commit revalidation and certificate order; immutable certified-parent anchor; durable revision and byte equality; pending writes and disposed effect suppression; exact vote/lock restore without reset; metadata recovery versus authority/runtime changes; forged snapshot refusal and bounded ingress.

Prior design disposition: implemented an immutable controller opening anchor and guard-independent opening-stamp accessor, repair-only quarantine, bounded four next-height commit hints, durable full replay and snapshot validation before adoption, settled stopped-controller queue, and exact durable safety restore/recheck. Existing owned-context guard is unchanged. Replay necessarily rebuilds context/log wrappers (runtimeReferences depth zero repeats each wrapper) and the two ancestry verifier closures; only those references are omitted from replay equivalence. All deeper prototypes, engine/policy identities/functions and canonical data remain compared. A locally trusted replay, never a received context, is the comparison candidate.

Coverage: two complete unit files passed 49 tests before the final added locked-byte corruption case; focused follow-up results are reported separately. Tests include forged snapshot gating, automatic held-commit continuation, same-revision corrupted lock bytes, competing safety revision, changed engine apply identity, opening equivalence after certified commit, exact locked-state restoration and pending persisted vote retransmission. Pending write is tested at controller level; no full scenario8 game has run.


## packages/protocol/src/consensus.ts

```text
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
/** Local voting policy; it never changes proposal or certified-entry validity. */
export type LocalVoteAdmissibility = (proposal: SignedProposal) => boolean;

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

interface ContextStamp {
  contextBytes: Uint8Array;
  functions: readonly (readonly [string, unknown])[];
}

// Only an OwnedConsensusState's private state enters this set. Public transition
// functions continue to verify every caller-supplied state in full.
const ownedStates = new WeakSet<ConsensusState>();

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function nonfunctions(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== 'function'));
}

function runtimeReferences(value: object, name: string): (readonly [string, unknown])[] {
  const references: (readonly [string, unknown])[] = [[name, value]];
  let current: object | null = value;
  for (let depth = 0; current && current !== Object.prototype && depth < 8; depth++) {
    references.push([`${name}/prototype/${depth}`, current]);
    for (const key of Object.getOwnPropertyNames(current).toSorted()) {
      const property = Object.getOwnPropertyDescriptor(current, key);
      if (typeof property?.value === 'function')
        references.push([`${name}/${key}`, property.value]);
      if (property?.get) references.push([`${name}/${key}/get`, Reflect.get(property, 'get')]);
      if (property?.set) references.push([`${name}/${key}/set`, Reflect.get(property, 'set')]);
    }
    current = Object.getPrototypeOf(current);
  }
  return references;
}

function contextStamp(context: ProposalContext): ContextStamp {
  const functions: (readonly [string, unknown])[] = [
    ...runtimeReferences(context, 'context'),
    ...runtimeReferences(context.log, 'log'),
    ...runtimeReferences(context.log.engine, 'engine'),
    ...runtimeReferences(context.policy, 'policy'),
    ...(context.policy.randomDerivations
      ? runtimeReferences(context.policy.randomDerivations, 'randomDerivations')
      : [['randomDerivations', null] as const]),
  ];
  const { engine, ...log } = context.log;
  const other = nonfunctions(context);
  delete other.log;
  delete other.policy;
  return {
    contextBytes: canonicalEncode({
      ...other,
      log: { ...log, lastNonces: [...log.lastNonces], engine: nonfunctions(engine) },
      policy: {
        ...nonfunctions(context.policy),
        randomDerivations: nonfunctions(context.policy.randomDerivations ?? {}),
      },
    }),
    functions,
  };
}

function sameContextStamp(left: ContextStamp, right: ContextStamp): boolean {
  return (
    sameBytes(left.contextBytes, right.contextBytes) &&
    left.functions.length === right.functions.length &&
    left.functions.every(
      ([name, value], index) =>
        name === right.functions[index]?.[0] && value === right.functions[index]?.[1],
    )
  );
}

/** Detached schema-checked data for observer callbacks; it confers no validation authority. */
export function copyConsensusStateData(state: ConsensusState): ConsensusState {
  return v.parse(stateSchema, canonicalDecode(canonicalEncode(state)));
}

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
      crypto: context.log.crypto,
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
  admitValue?: LocalVoteAdmissibility,
): Result<void> {
  if (ownVote(state, phase)) return success(undefined);
  if (hash !== null && admitValue) {
    const proposal = proposalAt(state, state.round, hash);
    if (
      !proposal ||
      !admitValue(v.parse(signedProposalSchema, canonicalDecode(canonicalEncode(proposal))))
    )
      hash = null;
  }
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
  admitValue?: LocalVoteAdmissibility,
): Result<void> {
  maybeCommit(state, context, effects);
  if (state.halted !== null || state.decision !== null) return success(undefined);
  if (state.step === 'propose') {
    const waitingProposal = state.proposals.find((item) => item.body.entry.term === state.round);
    if (waitingProposal) {
      const voted = prevoteProposal(
        state,
        context,
        secretKey,
        waitingProposal,
        effects,
        admitValue,
      );
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
      const signed = signLocalVote(
        state,
        context,
        secretKey,
        'precommit',
        hash,
        effects,
        admitValue,
      );
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
  const restored = ownedStates.has(state)
    ? success(copyConsensusStateData(state))
    : restoreConsensusState(state, context, state.localSeat);
  if (!restored.ok) return restored;
  const copy = restored.value;
  const effects: ConsensusEffect[] = [];
  const applied = action(copy, effects);
  if (!applied.ok) return applied;
  try {
    const bytes = canonicalEncode(copy);
    const parsed = v.safeParse(stateSchema, canonicalDecode(bytes));
    if (!parsed.success)
      return failure('consensus-restore', 'Transition produced malformed safety state');
    if (ownedStates.has(state)) ownedStates.add(copy);
  } catch {
    return failure('consensus-restore', 'Transition produced malformed safety state');
  }
  return success({ state: copy, effects });
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
      : evidence.kind === 'vote-equivocation'
        ? []
        : [evidence.proposal];
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
  admitValue?: LocalVoteAdmissibility,
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
      const voted = prevoteProposal(
        copy,
        context,
        secretKey,
        checked.value.proposal,
        effects,
        admitValue,
      );
      if (!voted.ok) return voted;
      return drive(copy, context, secretKey, effects, admitValue);
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
  admitValue?: LocalVoteAdmissibility,
): Result<void> {
  if (proposal.body.entry.term !== state.round || state.step !== 'propose')
    return success(undefined);
  const hash = proposalHash(proposal);
  const accepts =
    !state.locked ||
    state.locked.hash === hash ||
    (proposal.body.validRound !== null && proposal.body.validRound >= state.locked.round);
  return signLocalVote(
    state,
    context,
    secretKey,
    'prevote',
    accepts ? hash : null,
    effects,
    admitValue,
  );
}

export function receiveProposal(
  state: ConsensusState,
  context: ProposalContext,
  secretKey: Uint8Array,
  value: unknown,
  admitValue?: LocalVoteAdmissibility,
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
    if (copy.decision) return drive(copy, context, secretKey, effects, admitValue);
    const voted = prevoteProposal(copy, context, secretKey, proposal, effects, admitValue);
    return voted.ok ? drive(copy, context, secretKey, effects, admitValue) : voted;
  });
}

export function receiveVote(
  state: ConsensusState,
  context: ProposalContext,
  secretKey: Uint8Array,
  value: unknown,
  admitValue?: LocalVoteAdmissibility,
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
    return copy.halted ? success(undefined) : drive(copy, context, secretKey, effects, admitValue);
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
  admitValue?: LocalVoteAdmissibility,
): Result<ConsensusTransition> {
  return transition(state, context, (copy, effects) => {
    if (copy.decision || copy.halted || round !== copy.round || !copy.timers[phase])
      return success(undefined);
    if (phase === 'propose' && copy.step === 'propose') {
      const signed = signLocalVote(copy, context, secretKey, 'prevote', null, effects);
      return signed.ok ? drive(copy, context, secretKey, effects, admitValue) : signed;
    }
    if (phase === 'prevote' && copy.step === 'propose') {
      const prevoted = signLocalVote(copy, context, secretKey, 'prevote', null, effects);
      if (!prevoted.ok) return prevoted;
    }
    if (phase === 'prevote' && copy.step === 'prevote') {
      const signed = signLocalVote(copy, context, secretKey, 'precommit', null, effects);
      return signed.ok ? drive(copy, context, secretKey, effects, admitValue) : signed;
    }
    if (phase === 'precommit') {
      enterRound(copy, context, copy.round + 1, effects);
      return drive(copy, context, secretKey, effects, admitValue);
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

export type ConsensusEvent =
  | { kind: 'input-available' }
  | { kind: 'propose'; candidate?: LogEntry }
  | { kind: 'proposal'; proposal: unknown }
  | { kind: 'vote'; vote: unknown }
  | { kind: 'commit'; certified: unknown }
  | { kind: 'stage-accusation'; control: ExcludeProposerControl }
  | { kind: 'clear-stale-accusation' }
  | { kind: 'terminal-halt'; reason: string }
  | { kind: 'resume-after-replay' }
  | { kind: 'timeout'; phase: TimeoutPhase; round: number };

/** Private, validated state for one controller height. Public reducers stay fully validating. */
export interface OwnedConsensusState {
  matchesOpenedContext(candidate: ProposalContext): boolean;
  snapshot(): Result<ConsensusState>;
  dispatch(
    event: ConsensusEvent,
    secretKey: Uint8Array,
    admitValue?: LocalVoteAdmissibility,
  ): Result<ConsensusTransition>;
  commit(): Result<void>;
  discard(): void;
}

class OwnedConsensusStateImpl implements OwnedConsensusState {
  private pending: ConsensusState | null = null;

  constructor(
    private state: ConsensusState,
    private readonly context: ProposalContext,
    private readonly seat: Seat,
    private readonly stamp: ContextStamp,
  ) {
    ownedStates.add(state);
  }

  matchesOpenedContext(candidate: ProposalContext): boolean {
    try {
      const replayed = contextStamp(candidate);
      // Full replay rebuilds these record wrappers and ancestry closures. Engine,
      // policy, prototypes and their function references must remain identical.
      const rebuilt = new Set([
        'context',
        // runtimeReferences depth zero repeats the wrapper itself; deeper
        // prototype references remain part of the comparison.
        'context/prototype/0',
        'log',
        'log/prototype/0',
        'context/verifyHistoricalCheat',
        'context/verifyHistoricalAccusation',
      ]);
      const openedFunctions = this.stamp.functions.filter(([name]) => !rebuilt.has(name));
      const replayedFunctions = replayed.functions.filter(([name]) => !rebuilt.has(name));
      return (
        sameBytes(this.stamp.contextBytes, replayed.contextBytes) &&
        openedFunctions.length === replayedFunctions.length &&
        openedFunctions.every(
          ([name, reference], index) =>
            name === replayedFunctions[index]?.[0] && reference === replayedFunctions[index]?.[1],
        )
      );
    } catch {
      return false;
    }
  }

  private checkContext(): Result<void> {
    let current: ContextStamp;
    try {
      current = contextStamp(this.context);
    } catch {
      return failure('consensus-restore', 'Certified context is not canonical data');
    }
    if (sameContextStamp(this.stamp, current)) return success(undefined);
    if (this.pending)
      return failure('consensus-context', 'Certified context changed during persistence');
    const restored = restoreConsensusState(this.state, this.context, this.seat);
    if (!restored.ok) return restored;
    if (!sameBytes(canonicalEncode(restored.value), canonicalEncode(this.state)))
      return failure('consensus-restore', 'Restore to persist newly verified terminal evidence');
    return failure('consensus-context', 'Certified context changed; restore this voting record');
  }

  snapshot(): Result<ConsensusState> {
    const checked = this.checkContext();
    return checked.ok ? success(copyConsensusStateData(this.state)) : checked;
  }

  dispatch(
    event: ConsensusEvent,
    secretKey: Uint8Array,
    admitValue?: LocalVoteAdmissibility,
  ): Result<ConsensusTransition> {
    const checked = this.checkContext();
    if (!checked.ok) return checked;
    if (this.pending) return failure('consensus-pending', 'Persist the previous transition first');
    let next: Result<ConsensusTransition>;
    switch (event.kind) {
      case 'input-available':
        next = inputAvailable(this.state, this.context);
        break;
      case 'propose':
        next = propose(this.state, this.context, secretKey, event.candidate, admitValue);
        break;
      case 'proposal':
        next = receiveProposal(this.state, this.context, secretKey, event.proposal, admitValue);
        break;
      case 'vote':
        next = receiveVote(this.state, this.context, secretKey, event.vote, admitValue);
        break;
      case 'commit':
        next = receiveCommit(this.state, this.context, event.certified);
        break;
      case 'stage-accusation':
        next = stageAccusation(this.state, this.context, event.control);
        break;
      case 'clear-stale-accusation':
        next = clearStaleAccusation(this.state, this.context);
        break;
      case 'terminal-halt':
        next = terminalHalt(this.state, this.context, event.reason);
        break;
      case 'resume-after-replay':
        next = resumeAfterReplay(this.state, this.context);
        break;
      case 'timeout':
        next = timeout(this.state, this.context, secretKey, event.phase, event.round, admitValue);
        break;
      default: {
        const unknownEvent: never = event;
        return failure('consensus-event', `Unknown consensus event: ${String(unknownEvent)}`);
      }
    }
    const after = this.checkContext();
    if (!after.ok) return after;
    if (!next.ok) return next;
    this.pending = copyConsensusStateData(next.value.state);
    ownedStates.add(this.pending);
    return success({ state: copyConsensusStateData(this.pending), effects: next.value.effects });
  }

  commit(): Result<void> {
    if (!this.pending) throw new Error('No persisted consensus transition to install');
    let current: ContextStamp;
    try {
      current = contextStamp(this.context);
    } catch {
      return failure('consensus-context', 'Certified context changed during persistence');
    }
    if (!sameContextStamp(this.stamp, current))
      return failure('consensus-context', 'Certified context changed during persistence');
    this.state = this.pending;
    this.pending = null;
    return success(undefined);
  }

  discard(): void {
    this.pending = null;
  }
}

export function openOwnedConsensusState(
  value: ConsensusState,
  context: ProposalContext,
  seat: Seat,
): Result<OwnedConsensusState> {
  const restored = restoreConsensusState(value, context, seat);
  if (!restored.ok) return restored;
  try {
    return success(
      new OwnedConsensusStateImpl(restored.value, context, seat, contextStamp(context)),
    );
  } catch {
    return failure('consensus-restore', 'Certified context is not canonical data');
  }
}

```

## packages/protocol/src/consensus-controller.ts

```text
import { canonicalDecode, canonicalEncode, sha256, toHex } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import {
  copyConsensusStateData,
  createConsensusState,
  openOwnedConsensusState,
  recoverConsensusEffects,
  restoreConsensusState,
} from './consensus.js';
import type {
  ConsensusEffect,
  ConsensusEvent,
  LocalVoteAdmissibility,
  OwnedConsensusState,
  ConsensusState,
  ConsensusTransition,
} from './consensus.js';
import type { ProposalContext } from './proposal.js';
import type { SafetyStore, StoredSafety } from './safety-store.js';
import { MAX_MESSAGE_BYTES } from './validation.js';

export type { ConsensusEvent } from './consensus.js';

export interface ConsensusControllerOptions {
  context: ProposalContext;
  seat: Seat;
  secretKey: Uint8Array;
  /** One record for this game/key/height, retained across controller crashes. */
  store: SafetyStore;
  /** Repair must reuse exact durable bytes without normalizing newly found terminal evidence. */
  requireExactRestore?: boolean;
  /** Effects are at-least-once. Handlers must deduplicate committed sequence/value. */
  onEffects: (effects: readonly ConsensusEffect[]) => void | Promise<void>;
  /** Local admission only. It must not alter replay or objective validity. */
  beforePersist?: (previous: ConsensusState, next: ConsensusState) => Result<void>;
  admitLocalValue?: LocalVoteAdmissibility;
}

/**
 * Serializes a single height's transitions and persists before emission.
 * Opening the next height requires a separately persisted certified parent.
 */
export class ConsensusController {
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private persistedBytes: Uint8Array;
  private readonly secretKey: Uint8Array;
  private readonly rejectedProposals = new Map<string, { code: string; message: string }>();

  private constructor(
    private readonly options: ConsensusControllerOptions,
    private state: ConsensusState,
    private revision: number,
    private readonly owned: OwnedConsensusState,
  ) {
    this.secretKey = options.secretKey.slice();
    this.persistedBytes = canonicalEncode(state);
  }

  /** Only for a genuinely new height; existing or lost stores are not reset here. */
  static async create(options: ConsensusControllerOptions): Promise<Result<ConsensusController>> {
    const validKey = checkLocalKey(options);
    if (!validKey.ok) return validKey;
    const initial = createConsensusState(options.context, options.seat);
    if (!initial.ok) return initial;
    try {
      if (await options.store.load())
        return failure(
          'consensus-store-exists',
          'Restore existing vote records instead of resetting',
        );
      const owned = openOwnedConsensusState(initial.value, options.context, options.seat);
      if (!owned.ok) return owned;
      const saved = await options.store.save(null, canonicalEncode(initial.value));
      if (!saved)
        return failure('consensus-write-conflict', 'Another writer initialized this voting record');
      return success(new ConsensusController(options, initial.value, 0, owned.value));
    } catch {
      return failure('consensus-storage', 'Could not persist the initial voting record');
    }
  }

  /** An absent or damaged record fails closed; this never creates round-one state. */
  static async restore(options: ConsensusControllerOptions): Promise<Result<ConsensusController>> {
    const validKey = checkLocalKey(options);
    if (!validKey.ok) return validKey;
    let record: StoredSafety | null;
    try {
      record = await options.store.load();
    } catch {
      return failure('consensus-storage', 'Could not read the voting record');
    }
    if (!record)
      return failure(
        'consensus-store-missing',
        'The voting record is missing; key replacement is required',
      );
    if (!Number.isSafeInteger(record.revision) || record.revision < 0)
      return failure('consensus-storage', 'Stored voting revision is invalid');
    let restored: Result<ConsensusState>;
    try {
      restored = restoreConsensusState(
        canonicalDecode(record.bytes),
        options.context,
        options.seat,
      );
    } catch {
      return failure('consensus-storage', 'Stored voting data is not valid canonical data');
    }
    if (!restored.ok) return restored;
    let revision = record.revision;
    const normalized = canonicalEncode(restored.value);
    if (!sameBytes(normalized, record.bytes)) {
      if (options.requireExactRestore || restored.value.haltKind !== 'terminal')
        return failure('consensus-restore', 'Voting record changed without a terminal proof');
      try {
        if (!(await options.store.save(revision, normalized)))
          return failure('consensus-write-conflict', 'Voting record changed during terminal halt');
      } catch {
        return failure('consensus-storage', 'Could not persist the verified terminal halt');
      }
      revision++;
    }
    const owned = openOwnedConsensusState(restored.value, options.context, options.seat);
    return owned.ok
      ? success(new ConsensusController(options, restored.value, revision, owned.value))
      : owned;
  }

  /** Returns a detached, verified snapshot, never the mutable internal record. */
  snapshot(): Result<ConsensusState> {
    const snapshot = this.owned.snapshot();
    if (!snapshot.ok) {
      this.stopVoting();
      return snapshot;
    }
    if (!sameBytes(canonicalEncode(snapshot.value), canonicalEncode(this.state))) {
      this.stopVoting();
      return failure('consensus-restore', 'Restore to persist newly verified terminal evidence');
    }
    return snapshot;
  }

  /** The opening stamp remains usable after the mutable derived context fails its guard. */
  opensOn(context: ProposalContext): boolean {
    return this.owned.matchesOpenedContext(context);
  }

  settled(): Promise<void> {
    return this.queue.then(
      () => undefined,
      () => undefined,
    );
  }

  matchesPersistedRecord(record: StoredSafety): boolean {
    return record.revision === this.revision && sameBytes(record.bytes, this.persistedBytes);
  }

  /** Expected CAS revision for atomically committing this controller's height. */
  persistedRevision(): number {
    return this.revision;
  }

  /** Call after restoring to retransmit signed records and re-arm timers. */
  resume(): Promise<Result<void>> {
    return this.enqueue(async () => {
      const snapshot = this.snapshot();
      if (!snapshot.ok) return snapshot;
      const recovered = recoverConsensusEffects(this.state, this.options.context);
      if (!recovered.ok) {
        this.stopVoting();
        return recovered;
      }
      return this.emit(recovered.value);
    });
  }

  dispatch(event: ConsensusEvent): Promise<Result<void>> {
    return this.enqueue(async () => {
      if (event.kind === 'proposal' && this.isRecordedProposalReplay(event.proposal))
        return success(undefined);
      const proposalKey = event.kind === 'proposal' ? this.proposalKey(event.proposal) : null;
      const rejected = proposalKey ? this.rejectedProposals.get(proposalKey) : undefined;
      if (rejected)
        return failure(rejected.code, rejected.message, {
          proposalEntryRejected: true,
          cached: true,
        });
      const next = this.reduce(event);
      if (!next.ok) {
        if (next.error.code === 'consensus-restore' || next.error.code === 'consensus-context')
          this.stopVoting();
        else if (
          proposalKey &&
          next.error.details?.proposalEntryRejected === true &&
          next.error.details.proposalControl !== true
        ) {
          // Entry validation depends on this controller's fixed certified parent,
          // not its current round/votes. Controls can discover a second offender
          // after another proof is retained, so always reconsider them.
          this.rejectedProposals.set(proposalKey, {
            code: next.error.code,
            message: next.error.message,
          });
          if (this.rejectedProposals.size > 16) {
            const oldest = this.rejectedProposals.keys().next().value;
            if (oldest !== undefined) this.rejectedProposals.delete(oldest);
          }
        }
        return next;
      }
      const candidate = next.value.state;
      const admitted = this.options.beforePersist?.(
        copyConsensusStateData(this.state),
        copyConsensusStateData(candidate),
      );
      if (admitted && !admitted.ok) {
        this.owned.discard();
        return admitted;
      }
      try {
        const bytes = canonicalEncode(candidate);
        if (!(await this.options.store.save(this.revision, bytes))) {
          this.owned.discard();
          this.stopped = true;
          return failure(
            'consensus-write-conflict',
            'Voting stopped because a newer record exists',
          );
        }
      } catch {
        this.owned.discard();
        this.stopped = true;
        return failure(
          'consensus-storage',
          'Voting stopped because its state could not be persisted',
        );
      }
      this.persistedBytes = canonicalEncode(candidate);
      this.revision += 1;
      const committed = this.owned.commit();
      if (!committed.ok) {
        this.owned.discard();
        this.stopVoting();
        return committed;
      }
      this.state = copyConsensusStateData(candidate);
      // A dispose/crash during the write must not transmit after the write resolves.
      if (this.stopped)
        return failure('consensus-stopped', 'Controller stopped during persistence');
      return this.emit(next.value.effects);
    });
  }

  dispose(): void {
    this.stopVoting();
  }

  private stopVoting(): void {
    this.stopped = true;
    this.secretKey.fill(0);
    this.rejectedProposals.clear();
  }

  private proposalKey(value: unknown): string | null {
    try {
      const bytes = canonicalEncode(value);
      return bytes.length <= MAX_MESSAGE_BYTES ? toHex(sha256(bytes)) : null;
    } catch {
      return null;
    }
  }

  /** Stored proposals were validated before persistence; exact replays need no transition. */
  private isRecordedProposalReplay(value: unknown): boolean {
    let bytes: Uint8Array;
    try {
      bytes = canonicalEncode(value);
    } catch {
      return false;
    }
    if (bytes.byteLength > MAX_MESSAGE_BYTES) return false;
    const recorded = [
      ...this.state.proposals,
      ...this.state.hints.flatMap((hint) => (hint.kind === 'proposal' ? [hint.proposal] : [])),
    ].find((proposal) => sameBytes(bytes, canonicalEncode(proposal)));
    if (!recorded) return false;
    // A proposal retained before entering its round may still need its first vote.
    return !(
      recorded.body.entry.term === this.state.round &&
      this.state.step === 'propose' &&
      !this.state.votes.some(
        (vote) =>
          vote.body.seat === this.state.localSeat &&
          vote.body.term === this.state.round &&
          vote.body.phase === 'prevote',
      )
    );
  }

  private enqueue(operation: () => Promise<Result<void>>): Promise<Result<void>> {
    const result = this.queue.then(async (): Promise<Result<void>> => {
      if (this.stopped)
        return failure('consensus-stopped', 'Restore the persisted record before continuing');
      try {
        return await operation();
      } catch {
        this.owned.discard();
        this.stopVoting();
        return failure('consensus-controller', 'Consensus transition failed; voting has stopped');
      }
    });
    this.queue = result;
    return result;
  }

  private reduce(event: ConsensusEvent): Result<ConsensusTransition> {
    return this.owned.dispatch(event, this.secretKey, this.options.admitLocalValue);
  }

  private async emit(effects: readonly ConsensusEffect[]): Promise<Result<void>> {
    if (effects.length === 0) return success(undefined);
    try {
      await this.options.onEffects(effects);
      return success(undefined);
    } catch {
      // The saved state can reproduce signed messages after a partial delivery.
      this.stopped = true;
      return failure('consensus-effects', 'Effect delivery failed; restore before retrying');
    }
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function checkLocalKey(options: ConsensusControllerOptions): Result<void> {
  try {
    const identity = identityFromSecret(options.secretKey);
    const voter = options.context.membership.voters.find((member) => member.seat === options.seat);
    return voter?.publicKey === identity.peerId
      ? success(undefined)
      : failure('consensus-key', 'The local key does not match the certified voter');
  } catch {
    return failure('consensus-key', 'The local voting key is invalid');
  }
}

```

## packages/protocol/src/consensus-controller.test.ts

```text
import { hashValue, toHex } from '@cp2p/codec';
import type { Result, SystemInput } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { ConsensusController } from './consensus-controller.js';
import type { ConsensusControllerOptions } from './consensus-controller.js';
import type { ConsensusEffect, ConsensusEvent } from './consensus.js';
import {
  entryBody,
  entryHash,
  genesisDigest,
  genesisId,
  signEntry,
  signGenesis,
} from './genesis.js';
import { stubEvidence } from './log.js';
import type { LogContext } from './log.js';
import type { ProposalContext } from './proposal.js';
import { proposerFor, signProposal } from './proposal.js';
import { MemorySafetyStore } from './safety-store.js';
import type { SafetyStore } from './safety-store.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';
import { signVote } from './votes.js';
import { LocalTimerObserver } from './turn-timeout.js';
import { VirtualClock } from './testing/virtual-clock.js';

function errorCode(result: Result<unknown>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

function deferred() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release() {
      if (!release) throw new Error('Deferred promise was not initialized');
      release();
    },
  };
}

class PausableStore implements SafetyStore {
  readonly inner = new MemorySafetyStore();
  readonly entered = deferred();
  readonly resume = deferred();
  pauseUpdates = false;

  load() {
    return this.inner.load();
  }

  async save(expectedRevision: number | null, bytes: Uint8Array): Promise<boolean> {
    if (this.pauseUpdates && expectedRevision !== null) {
      this.entered.release();
      await this.resume.promise;
    }
    return this.inner.save(expectedRevision, bytes);
  }
}

function setup(store: SafetyStore = new MemorySafetyStore(), fourVoters = false) {
  const fixture = protocolFixture();
  const owner = fixtureAt(fixture.identities, 0);
  const roster: readonly (0 | 1 | 2 | 3)[] = fourVoters ? [0, 1, 2, 3] : [0, 1];
  const body = {
    ...fixture.body,
    seats: fixture.body.seats.map((seat) => ({
      seat: seat.seat,
      kind: 'human' as const,
      publicKey: seat.publicKey,
      name: seat.name,
      colour: seat.colour,
    })),
  };
  const genesis = fourVoters
    ? {
        ...body,
        gameId: genesisId(body),
        signatures: roster.map((seat) =>
          signGenesis(body, seat, fixtureAt(fixture.identities, seat).secretKey),
        ),
      }
    : fixture.genesis;
  const head = fourVoters
    ? signEntry(
        { ...entryBody(fixture.entry), payload: { kind: 'genesis', genesis } },
        owner.secretKey,
      )
    : fixture.entry;
  const log: LogContext = {
    genesis,
    engine: fixture.engine,
    head,
    state: fixture.state,
    crypto: null,
    lastNonces: new Map(),
  };
  const digest = genesisDigest(genesis);
  const context: ProposalContext = {
    log,
    membership: {
      genesisDigest: digest,
      epoch: 0,
      voters: roster.map((seat) => ({
        seat,
        publicKey: fixtureAt(fixture.identities, seat).peerId,
      })),
    },
    excludedProposers: [],
    policy: { allowStub: true },
  };
  const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
  const applied = fixture.engine.apply(fixture.state, input);
  if (!applied.ok) throw new Error(`Fixture input rejected: ${applied.error.code}`);
  const candidate = signEntry(
    {
      seq: 1,
      term: 1,
      prevHash: entryHash(log.head),
      payload: { kind: 'system', input, evidence: stubEvidence(log, input) },
      stateHash: toHex(hashValue(applied.value.state)),
      sequencer: owner.peerId,
    },
    owner.secretKey,
  );
  const emissions: ConsensusEffect[][] = [];
  const options: ConsensusControllerOptions = {
    context,
    seat: 0,
    secretKey: owner.secretKey,
    store,
    onEffects: (effects) => {
      emissions.push([...effects]);
    },
  };
  const certificateSeats: readonly (0 | 1 | 2 | 3)[] = fourVoters ? [1, 2, 3] : [0, 1];
  const certificate = certificateSeats.map((seat) =>
    signVote(
      {
        genesisDigest: digest,
        epoch: 0,
        seat,
        seq: 1,
        term: 1,
        phase: 'precommit',
        valueHash: entryHash(candidate),
      },
      fixtureAt(fixture.identities, seat).secretKey,
    ),
  );
  return { options, store, candidate, certificate, emissions };
}

async function create(options: ConsensusControllerOptions): Promise<ConsensusController> {
  const result = await ConsensusController.create(options);
  if (!result.ok) throw new Error(`Controller create failed: ${result.error.code}`);
  return result.value;
}

async function restore(options: ConsensusControllerOptions): Promise<ConsensusController> {
  const result = await ConsensusController.restore(options);
  if (!result.ok) throw new Error(`Controller restore failed: ${result.error.code}`);
  return result.value;
}

describe('durable consensus controller', () => {
  test('a locked value can be declined in a later round without losing the round transition', async () => {
    const { options, candidate } = setup(new MemorySafetyStore(), true);
    let approved = true;
    const controller = await create({
      ...options,
      admitLocalValue: () => approved,
      beforePersist(previous, next) {
        return !approved &&
          next.votes.slice(previous.votes.length).some((vote) => vote.body.valueHash !== null)
          ? { ok: false, error: { code: 'unexpected-positive-vote', message: 'Approval was lost' } }
          : { ok: true, value: undefined };
      },
    });
    try {
      expect((await controller.dispatch({ kind: 'propose', candidate })).ok).toBe(true);
      const first = controller.snapshot();
      if (!first.ok) throw new Error(first.error.code);
      const originalPrevote = first.value.votes.find((vote) => vote.body.phase === 'prevote');
      if (!originalPrevote) throw new Error('Missing first-round prevote');
      const digest = options.context.membership.genesisDigest;
      const vote = (seat: 1 | 2, phase: 'prevote' | 'precommit', hash: string | null) =>
        signVote(
          {
            genesisDigest: digest,
            epoch: 0,
            seat,
            seq: 1,
            term: 1,
            phase,
            valueHash: hash,
          },
          fixtureAt(protocolFixture().identities, seat).secretKey,
        );
      expect(
        (
          await controller.dispatch({
            kind: 'vote',
            vote: vote(1, 'prevote', entryHash(candidate)),
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await controller.dispatch({
            kind: 'vote',
            vote: vote(2, 'prevote', entryHash(candidate)),
          })
        ).ok,
      ).toBe(true);
      const locked = controller.snapshot();
      expect(locked.ok && locked.value.locked?.hash).toBe(entryHash(candidate));
      const durableLock = await options.store.load();
      const exact = await restore({ ...options, requireExactRestore: true });
      expect(exact.snapshot()).toEqual(locked);
      expect(await options.store.load()).toEqual(durableLock);
      expect((await exact.resume()).ok).toBe(true);
      expect(await options.store.load()).toEqual(durableLock);
      exact.dispose();
      expect(
        (await controller.dispatch({ kind: 'vote', vote: vote(1, 'precommit', null) })).ok,
      ).toBe(true);
      expect(
        (await controller.dispatch({ kind: 'vote', vote: vote(2, 'precommit', null) })).ok,
      ).toBe(true);
      approved = false;
      expect(
        (await controller.dispatch({ kind: 'timeout', phase: 'precommit', round: 1 })).ok,
      ).toBe(true);
      const nextProposer = proposerFor(1, 2, options.context.membership);
      const proposerKey = fixtureAt(protocolFixture().identities, nextProposer.seat).secretKey;
      const nextEntry = signEntry(
        { ...entryBody(candidate), term: 2, sequencer: nextProposer.publicKey },
        proposerKey,
      );
      const proof = [
        originalPrevote,
        vote(1, 'prevote', entryHash(candidate)),
        vote(2, 'prevote', entryHash(candidate)),
      ];
      const nextProposal = signProposal(
        { genesisDigest: digest, epoch: 0, entry: nextEntry, validRound: 1, prevotes: proof },
        proposerKey,
      );
      expect((await controller.dispatch({ kind: 'proposal', proposal: nextProposal })).ok).toBe(
        true,
      );
      const resumed = controller.snapshot();
      expect(resumed.ok && resumed.value.round).toBe(2);
      expect(
        resumed.ok &&
          resumed.value.votes.find((item) => item.body.term === 2 && item.body.phase === 'prevote')
            ?.body.valueHash,
      ).toBeNull();
    } finally {
      controller.dispose();
    }
  });

  test('a locally refused value persists a nil vote and can advance its round', async () => {
    const { options, candidate, store } = setup();
    const controller = await create({
      ...options,
      admitLocalValue: () => false,
      beforePersist(_previous, next) {
        return next.votes.some((vote) => vote.body.seat === 0 && vote.body.valueHash !== null)
          ? {
              ok: false,
              error: { code: 'unexpected-positive-vote', message: 'Value was not admitted' },
            }
          : { ok: true, value: undefined };
      },
    });
    expect((await controller.dispatch({ kind: 'propose', candidate })).ok).toBe(true);
    const first = controller.snapshot();
    expect(
      first.ok && first.value.votes.find((vote) => vote.body.phase === 'prevote')?.body.valueHash,
    ).toBeNull();
    expect((await store.load())?.revision).toBe(1);
    controller.dispose();
    const resumed = await restore({ ...options, admitLocalValue: () => false });
    const snapshot = resumed.snapshot();
    expect(
      snapshot.ok &&
        snapshot.value.votes.find((vote) => vote.body.phase === 'prevote')?.body.valueHash,
    ).toBeNull();
    resumed.dispose();
  });

  test('a transient timer gate saves no vote or proposal and can retry later', async () => {
    const { options, candidate, store, emissions } = setup();
    const clock = new VirtualClock();
    const anchor = {
      key: 'turn/0/main',
      seat: 0 as const,
      phase: 'main',
      deadlineMs: 10_000,
      pendingSince: { seq: 0, hash: entryHash(options.context.log.head) },
    };
    const observer = new LocalTimerObserver(clock, [anchor]);
    const controller = await create({
      ...options,
      beforePersist(previous, next) {
        return next.votes.length > previous.votes.length
          ? observer.canVote(anchor)
          : { ok: true, value: undefined };
      },
    });
    const original = await store.load();
    const memory = controller.snapshot();
    expect(errorCode(await controller.dispatch({ kind: 'propose', candidate }))).toBe(
      'turn-timeout-early',
    );
    expect(await store.load()).toEqual(original);
    expect(controller.snapshot()).toEqual(memory);
    expect(emissions).toEqual([]);
    clock.advanceBy(7_000);
    expect((await controller.dispatch({ kind: 'propose', candidate })).ok).toBe(true);
    expect((await store.load())?.revision).toBe((original?.revision ?? 0) + 1);
    controller.dispose();
  });

  test('rejected proposal replays reuse a bounded cache without repeating entry derivation', async () => {
    const { options, candidate, store } = setup();
    let derivations = 0;
    const original = options.context.log.engine;
    options.context.log.engine = {
      ...original,
      apply(state, input) {
        derivations++;
        return original.apply(state, input);
      },
    };
    const controller = await create(options);
    const invalid = (variant: number) =>
      signProposal(
        {
          genesisDigest: options.context.membership.genesisDigest,
          epoch: 0,
          entry: signEntry(
            { ...entryBody(candidate), stateHash: variant.toString(16).padStart(64, '0') },
            options.secretKey,
          ),
          validRound: null,
          prevotes: [],
        },
        options.secretKey,
      );
    for (let variant = 0; variant < 17; variant++) {
      // oxlint-disable-next-line no-await-in-loop -- Each unique failure fills the bounded cache in order.
      const received = await controller.dispatch({ kind: 'proposal', proposal: invalid(variant) });
      expect(errorCode(received)).toBe('state-hash');
    }
    expect(derivations).toBe(17);
    expect(errorCode(await controller.dispatch({ kind: 'proposal', proposal: invalid(16) }))).toBe(
      'state-hash',
    );
    expect(derivations).toBe(17);
    expect(errorCode(await controller.dispatch({ kind: 'proposal', proposal: invalid(0) }))).toBe(
      'state-hash',
    );
    expect(derivations).toBe(18);
    expect((await store.load())?.revision).toBe(0);
    expect((await controller.dispatch({ kind: 'propose', candidate })).ok).toBe(true);
    controller.dispose();
  });

  test('rechecks a rejected control replay after proof of a different offender', async () => {
    const { options, store, emissions } = setup(new MemorySafetyStore(), true);
    const controller = await create(options);
    const controlFor = (offender: 1 | 2) => {
      const signer = fixtureAt(protocolFixture().identities, offender);
      const body = {
        genesisDigest: options.context.membership.genesisDigest,
        epoch: 0,
        seat: offender,
        seq: 1,
        term: 1,
        phase: 'prevote' as const,
        valueHash: null,
      };
      return {
        kind: 'control' as const,
        action: 'exclude-proposer' as const,
        offender,
        evidence: {
          kind: 'vote-equivocation' as const,
          first: signVote(body, signer.secretKey),
          second: signVote({ ...body, valueHash: 'e'.repeat(64) }, signer.secretKey),
        },
      };
    };
    const rejectedControl = controlFor(2);
    const entry = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(options.context.log.head),
        payload: rejectedControl,
        stateHash: 'f'.repeat(64),
        sequencer: fixtureAt(protocolFixture().identities, 0).peerId,
      },
      options.secretKey,
    );
    const rejectedProposal = signProposal(
      {
        genesisDigest: options.context.membership.genesisDigest,
        epoch: 0,
        entry,
        validRound: null,
        prevotes: [],
      },
      options.secretKey,
    );

    expect(
      errorCode(await controller.dispatch({ kind: 'proposal', proposal: rejectedProposal })),
    ).toBe('control-state');
    expect((await store.load())?.revision).toBe(0);
    expect(
      (await controller.dispatch({ kind: 'stage-accusation', control: controlFor(1) })).ok,
    ).toBe(true);
    const staged = controller.snapshot();
    if (!staged.ok) throw new Error(`Snapshot failed: ${staged.error.code}`);
    expect(staged.value.provenOffender?.control.offender).toBe(1);
    expect(staged.value.haltKind).toBeNull();

    expect(
      (await controller.dispatch({ kind: 'proposal', proposal: structuredClone(rejectedProposal) }))
        .ok,
    ).toBe(true);
    const halted = controller.snapshot();
    if (!halted.ok) throw new Error(`Snapshot failed: ${halted.error.code}`);
    expect(halted.value.haltKind).toBe('terminal');
    expect(halted.value.halted).toContain('second Byzantine voter');
    expect(emissions.flat().filter((effect) => effect.kind === 'halt')).toHaveLength(1);
    expect((await store.load())?.revision).toBe(2);
    controller.dispose();
  });

  test('exact proposal replay skips proof work and leaves the persisted vote intact', async () => {
    const { options, candidate, emissions, store } = setup();
    const controller = await create(options);
    expect((await controller.dispatch({ kind: 'propose', candidate })).ok).toBe(true);
    const proposal = emissions.flat().find((effect) => effect.kind === 'broadcast-proposal');
    if (!proposal || proposal.kind !== 'broadcast-proposal')
      throw new Error('Expected a signed proposal');
    const revision = (await store.load())?.revision;
    expect(
      (
        await controller.dispatch({
          kind: 'proposal',
          proposal: structuredClone(proposal.proposal),
        })
      ).ok,
    ).toBe(true);
    expect((await store.load())?.revision).toBe(revision);
    expect(emissions.flat().filter((effect) => effect.kind === 'broadcast-vote')).toHaveLength(1);
  });

  test('holds signed effects until the new safety record is saved', async () => {
    const store = new PausableStore();
    const { options, candidate, emissions } = setup(store);
    const controller = await create(options);
    store.pauseUpdates = true;
    const pending = controller.dispatch({ kind: 'propose', candidate });
    await store.entered.promise;
    expect(emissions).toHaveLength(0);
    expect((await store.load())?.revision).toBe(0);
    store.resume.release();
    expect((await pending).ok).toBe(true);
    expect((await store.load())?.revision).toBe(1);
    expect(emissions.flat().map((effect) => effect.kind)).toContain('broadcast-proposal');
    expect(emissions.flat().map((effect) => effect.kind)).toContain('broadcast-vote');
  });

  test('does not emit when the certified context changes during persistence', async () => {
    const store = new PausableStore();
    const { options, candidate, emissions } = setup(store);
    const controller = await create(options);
    const opened = {
      ...options.context,
      excludedProposers: [...options.context.excludedProposers],
    };
    store.pauseUpdates = true;
    const pending = controller.dispatch({ kind: 'propose', candidate });
    await store.entered.promise;
    let settled = false;
    const settlement = controller.settled().then(() => {
      settled = true;
      return undefined;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    options.context.excludedProposers = [1];
    store.resume.release();
    expect(errorCode(await pending)).toBe('consensus-context');
    await settlement;
    expect(settled).toBe(true);
    const saved = await store.load();
    if (!saved) throw new Error('Missing persisted vote after interrupted write');
    expect(saved.revision).toBe(1);
    expect(controller.matchesPersistedRecord(saved)).toBe(true);
    expect(controller.opensOn(opened)).toBe(true);
    expect(controller.opensOn(options.context)).toBe(false);
    expect(emissions).toHaveLength(0);
    expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-stopped',
    );
    const recoveredEffects: ConsensusEffect[][] = [];
    const repaired = await restore({
      ...options,
      context: opened,
      requireExactRestore: true,
      onEffects: (effects) => {
        recoveredEffects.push([...effects]);
      },
    });
    expect(await store.load()).toEqual(saved);
    expect((await repaired.resume()).ok).toBe(true);
    expect(recoveredEffects.flat().map((effect) => effect.kind)).toContain('broadcast-vote');
    expect(await store.load()).toEqual(saved);
    repaired.dispose();
  });

  test('does not persist an initial record when context stamping fails', async () => {
    const { options, store } = setup();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    Object.assign(options.context, { cyclic });
    expect(errorCode(await ConsensusController.create(options))).toBe('consensus-restore');
    expect(await store.load()).toBeNull();
  });

  test('rejects a local callback that changes the certified context during reduction', async () => {
    const { options, candidate, store, emissions } = setup();
    const controller = await create({
      ...options,
      admitLocalValue() {
        options.context.excludedProposers = [1];
        return true;
      },
    });
    expect(errorCode(await controller.dispatch({ kind: 'propose', candidate }))).toBe(
      'consensus-context',
    );
    expect((await store.load())?.revision).toBe(0);
    expect(emissions).toHaveLength(0);
  });

  test('context mutation takes precedence over a reducer rejection', async () => {
    const { options, store, candidate } = setup();
    const controller = await create(options);
    const event: ConsensusEvent = {
      kind: 'propose',
      get candidate() {
        options.context.excludedProposers = [1];
        return { ...candidate, prevHash: 'f'.repeat(64) };
      },
    };
    expect(errorCode(await controller.dispatch(event))).toBe('consensus-context');
    expect((await store.load())?.revision).toBe(0);
    expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-stopped',
    );
  });

  test('rejects a valid but different certified context at the same height', async () => {
    const { options, store } = setup();
    const controller = await create(options);
    options.context.excludedProposers = [1];
    expect(errorCode(controller.snapshot())).toBe('consensus-context');
    expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-stopped',
    );
    expect((await store.load())?.revision).toBe(0);
  });

  test('stops after a throwing persistence observer and rejects unknown events', async () => {
    const { options, candidate, store } = setup();
    const unknown = await create(options);
    // @ts-expect-error Exercise the runtime boundary with an unknown event kind.
    expect(errorCode(await unknown.dispatch({ kind: 'other' }))).toBe('consensus-event');
    unknown.dispose();
    const controller = await restore({
      ...options,
      store,
      beforePersist() {
        throw new Error('observer failed');
      },
    });
    expect(errorCode(await controller.dispatch({ kind: 'propose', candidate }))).toBe(
      'consensus-controller',
    );
    expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-stopped',
    );
    expect((await store.load())?.revision).toBe(0);
  });

  test('serializes concurrent dispatches without signing the same vote twice', async () => {
    const { options, candidate, emissions, store } = setup();
    const controller = await create(options);
    const outcomes = await Promise.all([
      controller.dispatch({ kind: 'propose', candidate }),
      controller.dispatch({ kind: 'propose', candidate }),
    ]);
    expect(outcomes.map((result) => result.ok)).toEqual([true, true]);
    const effects = emissions.flat();
    expect(effects.filter((effect) => effect.kind === 'broadcast-proposal')).toHaveLength(1);
    expect(effects.filter((effect) => effect.kind === 'broadcast-vote')).toHaveLength(1);
    const snapshot = controller.snapshot();
    if (!snapshot.ok) throw new Error(`Snapshot failed: ${snapshot.error.code}`);
    expect(snapshot.value.votes.filter((vote) => vote.body.seat === 0)).toHaveLength(1);
    expect((await store.load())?.revision).toBe(2);
  });

  test('disposal during persistence emits nothing, then restore retransmits saved signatures', async () => {
    const store = new PausableStore();
    const { options, candidate, emissions } = setup(store);
    const controller = await create(options);
    store.pauseUpdates = true;
    const pending = controller.dispatch({ kind: 'propose', candidate });
    await store.entered.promise;
    controller.dispose();
    store.resume.release();
    expect(errorCode(await pending)).toBe('consensus-stopped');
    expect(emissions).toHaveLength(0);
    const recoveredEffects: ConsensusEffect[][] = [];
    const restored = await restore({
      ...options,
      onEffects: (effects) => {
        recoveredEffects.push([...effects]);
      },
    });
    expect((await restored.resume()).ok).toBe(true);
    expect(recoveredEffects.flat().map((effect) => effect.kind)).toContain('broadcast-proposal');
    expect(recoveredEffects.flat().map((effect) => effect.kind)).toContain('broadcast-vote');
  });

  test('failed save emits nothing and stops the controller', async () => {
    const inner = new MemorySafetyStore();
    const store: SafetyStore = {
      load: () => inner.load(),
      save: (revision, bytes) =>
        revision === null ? inner.save(revision, bytes) : Promise.resolve(false),
    };
    const { options, emissions } = setup(store);
    const controller = await create(options);
    expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-write-conflict',
    );
    expect(emissions).toHaveLength(0);
    expect((await inner.load())?.revision).toBe(0);
    expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-stopped',
    );
  });

  test('a storage exception stops voting without emitting unsaved effects', async () => {
    const inner = new MemorySafetyStore();
    const store: SafetyStore = {
      load: () => inner.load(),
      save: (revision, bytes) => {
        if (revision !== null) throw new Error('disk unavailable');
        return inner.save(revision, bytes);
      },
    };
    const { options, emissions } = setup(store);
    const controller = await create(options);
    expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-storage',
    );
    expect(emissions).toHaveLength(0);
    expect((await inner.load())?.revision).toBe(0);
    expect(errorCode(await controller.resume())).toBe('consensus-stopped');
  });

  test('a stale CAS writer stops instead of overwriting the newer record', async () => {
    const { options, store, emissions } = setup();
    const first = await create(options);
    const stale = await restore(options);
    expect((await first.dispatch({ kind: 'input-available' })).ok).toBe(true);
    const newer = await store.load();
    expect(newer?.revision).toBe(1);
    const before = emissions.length;
    expect(errorCode(await stale.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-write-conflict',
    );
    expect(emissions).toHaveLength(before);
    expect((await store.load())?.bytes).toEqual(newer?.bytes);
    expect(errorCode(await stale.resume())).toBe('consensus-stopped');
  });

  test('missing, corrupt, cross-parent, and mismatched-key records fail closed', async () => {
    const { options, store } = setup();
    expect(errorCode(await ConsensusController.restore(options))).toBe('consensus-store-missing');
    expect(await store.save(null, new TextEncoder().encode('{'))).toBe(true);
    expect(errorCode(await ConsensusController.restore(options))).toBe('consensus-storage');

    const valid = setup();
    await create(valid.options);
    const alteredContext: ProposalContext = {
      ...valid.options.context,
      log: {
        ...valid.options.context.log,
        head: { ...valid.options.context.log.head, stateHash: 'f'.repeat(64) },
      },
    };
    expect(
      errorCode(await ConsensusController.restore({ ...valid.options, context: alteredContext })),
    ).toBe('consensus-context');
    const otherSecret = fixtureAt(protocolFixture().identities, 1).secretKey;
    expect(
      errorCode(await ConsensusController.restore({ ...valid.options, secretKey: otherSecret })),
    ).toBe('consensus-key');
  });

  test('a callback failure after save stops effects, and restore replays them', async () => {
    const { options, candidate, store } = setup();
    const controller = await create({
      ...options,
      onEffects: () => {
        throw new Error('delivery interrupted');
      },
    });
    expect(errorCode(await controller.dispatch({ kind: 'propose', candidate }))).toBe(
      'consensus-effects',
    );
    expect((await store.load())?.revision).toBe(1);
    expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-stopped',
    );
    const recovered: ConsensusEffect[] = [];
    const restarted = await restore({
      ...options,
      onEffects: (effects) => {
        recovered.push(...effects);
      },
    });
    expect((await restarted.resume()).ok).toBe(true);
    expect(recovered.some((effect) => effect.kind === 'broadcast-proposal')).toBe(true);
    expect(recovered.some((effect) => effect.kind === 'broadcast-vote')).toBe(true);
  });

  test('a snapshot is detached and create never replaces an existing record', async () => {
    const { options, store } = setup();
    const controller = await create(options);
    const original = await store.load();
    const snapshot = controller.snapshot();
    if (!snapshot.ok) throw new Error(`Snapshot failed: ${snapshot.error.code}`);
    snapshot.value.round = 99;
    snapshot.value.timers.propose = true;
    const next = controller.snapshot();
    if (!next.ok) throw new Error(`Snapshot failed: ${next.error.code}`);
    expect(next.value.round).toBe(1);
    expect(next.value.timers.propose).toBe(false);
    expect(errorCode(await ConsensusController.create(options))).toBe('consensus-store-exists');
    expect((await store.load())?.bytes).toEqual(original?.bytes);
    expect((await store.load())?.revision).toBe(original?.revision);
  });

  test('callbacks cannot mutate the controller-owned safety state before or after persistence', async () => {
    const { options, candidate, store } = setup();
    const controller = await create({
      ...options,
      admitLocalValue(proposal) {
        proposal.sig = 'forged';
        return true;
      },
      beforePersist(previous, next) {
        previous.round = 99;
        const proposal = next.proposals[0];
        if (proposal) proposal.sig = 'forged';
        return { ok: true, value: undefined };
      },
      onEffects(effects) {
        for (const effect of effects)
          if (effect.kind === 'broadcast-proposal') effect.proposal.sig = 'forged';
      },
    });
    expect((await controller.dispatch({ kind: 'propose', candidate })).ok).toBe(true);
    const snapshot = controller.snapshot();
    expect(snapshot.ok && snapshot.value.round).toBe(1);
    expect(snapshot.ok && snapshot.value.proposals[0]?.sig).not.toBe('forged');
    controller.dispose();
    const resumed = await restore({ ...options, store });
    const saved = resumed.snapshot();
    expect(saved.ok && saved.value.proposals[0]?.sig).not.toBe('forged');
    resumed.dispose();
  });

  test('corrupt local derivation stops an active controller until certified-prefix replay', async () => {
    const { options, candidate, store, emissions } = setup();
    const controller = await create(options);
    expect((await controller.dispatch({ kind: 'propose', candidate })).ok).toBe(true);
    const saved = await store.load();
    const freshContext: ProposalContext = {
      ...options.context,
      log: { ...options.context.log },
    };
    const corruptContext: ProposalContext = {
      ...freshContext,
      log: {
        ...freshContext.log,
        state: {
          ...freshContext.log.state,
          counters: {
            ...freshContext.log.state.counters,
            nextOfferId: freshContext.log.state.counters.nextOfferId + 1,
          },
        },
      },
    };
    // The same persisted proposal can no longer be derived from corrupted local state.
    options.context.log.state = corruptContext.log.state;
    expect(errorCode(controller.snapshot())).toBe('consensus-restore');
    expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-stopped',
    );
    expect((await store.load())?.bytes).toEqual(saved?.bytes);
    expect((await store.load())?.revision).toBe(saved?.revision);
    expect(emissions.flat().filter((effect) => effect.kind === 'broadcast-vote')).toHaveLength(1);

    const dispatchContext: ProposalContext = {
      ...freshContext,
      log: { ...freshContext.log },
    };
    const dispatchController = await restore({ ...options, context: dispatchContext });
    dispatchContext.log.state = corruptContext.log.state;
    expect(errorCode(await dispatchController.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-restore',
    );
    expect(errorCode(await dispatchController.resume())).toBe('consensus-stopped');

    const resumeContext: ProposalContext = {
      ...freshContext,
      log: { ...freshContext.log },
    };
    const resumeController = await restore({ ...options, context: resumeContext });
    resumeContext.log.state = corruptContext.log.state;
    expect(errorCode(await resumeController.resume())).toBe('consensus-restore');
    expect(errorCode(await resumeController.dispatch({ kind: 'input-available' }))).toBe(
      'consensus-stopped',
    );

    // A fresh controller can only continue after the certified parent is reconstructed.
    const retransmitted: ConsensusEffect[] = [];
    const replayed = await restore({
      ...options,
      context: freshContext,
      onEffects: (effects) => {
        retransmitted.push(...effects);
      },
    });
    expect((await replayed.resume()).ok).toBe(true);
    expect(retransmitted.some((effect) => effect.kind === 'broadcast-proposal')).toBe(true);
    expect(retransmitted.some((effect) => effect.kind === 'broadcast-vote')).toBe(true);
  });

  test('a persisted commit replays after a delivery crash at the commit boundary', async () => {
    const { options, candidate, certificate, store } = setup(new MemorySafetyStore(), true);
    const controller = await create({
      ...options,
      onEffects: (effects) => {
        if (effects.some((effect) => effect.kind === 'commit'))
          throw new Error('crashed after saving the certificate');
      },
    });
    expect((await controller.dispatch({ kind: 'propose', candidate })).ok).toBe(true);
    const certified = { entry: candidate, certificate };
    expect(errorCode(await controller.dispatch({ kind: 'commit', certified }))).toBe(
      'consensus-effects',
    );
    expect((await store.load())?.revision).toBe(2);
    const replayed: ConsensusEffect[] = [];
    const restarted = await restore({
      ...options,
      onEffects: (effects) => {
        replayed.push(...effects);
      },
    });
    expect((await restarted.resume()).ok).toBe(true);
    expect(replayed.filter((effect) => effect.kind === 'commit')).toHaveLength(1);
  });
});

```

## packages/protocol/src/replicated-log.ts

```text
import { resolveArtifactSigner } from './authority.js';
import type { ArtifactSigner } from './authority-types.js';
import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { identityFromSecret, parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Engine, Result, Seat, SystemInput } from '@cp2p/engine';
import { ConsensusController } from './consensus-controller.js';
import { prepareBeaconContribution } from './beacon-contributions.js';
import type { BeaconContributionStore, BeaconSecretSource } from './beacon-contributions.js';
import { BeaconInbox } from './beacon-inbox.js';
import { prepareCountContribution } from './count-contributions.js';
import type { CountContributionStore, CountProofProducer } from './count-contributions.js';
import { CountInbox } from './count-inbox.js';
import { StealInbox } from './steal-inbox.js';
import { prepareStealContribution, prepareStealResponse } from './steal-contributions.js';
import type {
  StealContributionProducer,
  StealDeliveryStore,
  StealResponseProducer,
} from './steal-contributions.js';
import {
  signTradeProofResponse,
  tradeProofHost,
  tradeProofRequestId,
  verifyTradeProofRequest,
  verifyTradeProofResponse,
} from './trade-proof-delivery.js';
import type {
  IndexedHandProof,
  SignedTradeProofRequest,
  SignedTradeProofResponse,
} from './trade-proof-delivery.js';
import { deckPassHash } from './deck-genesis.js';
import { DeckInbox } from './deck-inbox.js';
import { decksReady } from './deck-ledger.js';
import { prepareDeckUnlock } from './deck-outbox.js';
import type { DeckContributionStore } from './deck-outbox.js';
import type { DeckSourceFactory } from './deck-source.js';
import type { SignedDeckPass } from './deck-setup.js';
import type { ConsensusEffect, ConsensusState, Equivocation, TimeoutPhase } from './consensus.js';
import { createConsensusState } from './consensus.js';
import { objectiveEvidenceSeq, validateObjectiveAccusation } from './control.js';
import { entryBody, entryHash, signEntry } from './genesis.js';
import { journalSafetyStore } from './journal.js';
import { createRetiredSafety, restoreRetiredSafety } from './retired-safety.js';
import type { ProtocolJournal } from './journal.js';
import { validateNextEntry, validateSignedCommand } from './log.js';
import type { LogContext, ValidatedEntry } from './log.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import type { ProtocolMessage } from './messages.js';
import { recoveryChangeSchema } from './recovery-membership.js';
import { parseMembershipChange } from './membership-change.js';
import type { MembershipChange } from './membership-change.js';
import {
  TRANSFER_OWNER_GAME_DOMAIN,
  transferChangeSchema,
  transferRefSchema,
} from './transfer-readiness.js';
import type { SeatTransferAuthorization } from './transfer-types.js';
import { previewRecoveryAuthorization } from './recovery-facade.js';
import { SEAT_ONLINE_DOMAIN, seatOnlineStatement } from './recovery-presence.js';
import { RecoveryPresenceObserver } from './recovery-presence-observer.js';
import type { RecoveryPresenceState } from './recovery-presence-observer.js';
import type { RecoveryApprovalCandidate, RecoveryApprovalPreview } from './recovery-facade.js';
import type { RecoveryChange } from './recovery-types.js';
import type { EntryRef } from './beacon-state.js';
import { RecoveryParticipant } from './recovery-participant.js';
import type {
  RecoveryParticipantOptions,
  PreparedRecoveryPackets,
} from './recovery-participant.js';
import type { RecoveryRelease } from './recovery-release.js';
import type { SignedRecoveryCheck } from './recovery-check.js';
import type { SignedRecoveryVoidCheck } from './recovery-void.js';
import { MasterRevealCoordinator } from './master-reveal.js';
import type {
  MasterRevealOptions,
  MasterRevealVerdict,
  SignedMasterReveal,
} from './master-reveal.js';
import {
  advanceContext,
  objectiveProofParentHash,
  proposerFor,
  signedProposalSchema,
  validateCertifiedEntry,
  validateObjectiveForProposal,
} from './proposal.js';
import type { CertifiedEntry, ProposalContext, SignedProposal } from './proposal.js';
import {
  initialProposalContext,
  replayCertifiedPrefix,
  snapshotFromContext,
  verifyReplaySnapshot,
} from './replay.js';
import type { ReplayPolicy } from './replay.js';
import type { PeerId, ProtocolClock, Transport, Unsubscribe } from './transport.js';
import {
  LocalTimerObserver,
  TURN_TIMEOUT_PROTOCOL,
  verifyTimeoutEvidence,
} from './turn-timeout.js';
import type { TimerAnchor } from './turn-timeout.js';
import type { SessionTimer } from './session-types.js';
import type {
  EntryPayload,
  ExcludeProposerControl,
  LogEntry,
  SignedCommand,
  SystemEvidence,
} from './types.js';
import { genesisSchema, logEntrySchema } from './schemas.js';
import { MAX_MESSAGE_BYTES, parseCanonical } from './validation.js';
import { validateVote, verifyCertificate } from './votes.js';
import { authenticatedCheatSigner, verifyCheatProof } from './cheat-proof.js';
import type { CheatClaim, CheatFinding } from './cheat-proof.js';
import {
  cheatCandidateId,
  cheatClaimHash,
  decodeCheatCandidate,
  encodeCheatCandidate,
} from './cheat-candidates.js';
import type { CheatCandidateStore } from './cheat-candidates.js';
import { certifiedDeliveryClaim, rejectedWireProofCandidates } from './cheat-capture.js';
import * as v from 'valibot';

const MAX_QUEUED_MESSAGES_PER_PEER = 8;
const MAX_QUEUED_MESSAGES_TOTAL = 32;
const INVALID_MESSAGE_LIMIT = 5;
const EXPENSIVE_REQUEST_WINDOW_MS = 10_000;
const EXPENSIVE_REQUESTS_PER_WINDOW = 3;
const REVEAL_REQUESTS_PER_WINDOW = 6;
const TRADE_PROOF_REQUESTS_PER_WINDOW = 4;
const MAX_PENDING_COMMANDS = 32;
const MAX_PENDING_COMMANDS_PER_SEAT = 4;
const MAX_TRADE_PROOF_CACHE = 16;
const MAX_TRADE_PROOF_REQUESTS_PER_FINALIZER = 3;
const MAX_RECOVERY_PACKETS_PER_PULSE = 8;
const MAX_RECOVERY_RELEASES_PER_PEER = 36;
const MAX_RECOVERY_CHECKS_PER_PEER = 6;

export interface RecoveredReplicaOwnership {
  readonly keys: ReadonlyMap<Seat, Uint8Array>;
  readonly beaconSources: ReadonlyMap<Seat, BeaconSecretSource>;
  readonly createDeckSource?: DeckSourceFactory;
}

export type ReplicatedLogStatus =
  | { kind: 'pending'; commandHash: string }
  | { kind: 'sync'; fromSeq: number }
  | { kind: 'rejected'; code: string }
  | { kind: 'halted'; code: string }
  | { kind: 'retired'; seat: Seat };

export interface ReplicatedLogOptions {
  genesisEntry: unknown;
  engine: Engine;
  policy: ReplayPolicy;
  seat: Seat;
  secretKey: Uint8Array;
  /** Keys for bots assigned to this human by the signed genesis. */
  botKeys?: ReadonlyMap<Seat, Uint8Array>;
  transport: Transport;
  clock: ProtocolClock;
  journal: ProtocolJournal;
  /** Durable candidate outbox; without it no cheat claim may be gossiped. */
  cheatCandidateStore?: CheatCandidateStore;
  /** Required in verified sessions. Only this human's chain secrets are exposed here. */
  beaconSource?: BeaconSecretSource;
  /** Additional locally owned beacon sources, validated against certified authority. */
  beaconSources?: ReadonlyMap<Seat, BeaconSecretSource>;
  /** Durable, immutable outgoing contributions, retained alongside the voting journal. */
  beaconContributions?: BeaconContributionStore;
  /** Exact public ceremony passes fixed by genesis; never regenerated after consent. */
  deckSetupPasses?: readonly { deckId: string; pass: SignedDeckPass }[];
  /** Fresh deterministic source for each owned seat/deck; each invocation is disposed after use. */
  createDeckSource?: DeckSourceFactory;
  /** Durable immutable position reservations and signed unlocks. */
  deckContributions?: DeckContributionStore;
  /** Owner-only proof source for each locally hosted Monopoly victim. */
  countProof?: CountProofProducer;
  /** Immutable outgoing count reveals, retained across restarts. */
  countContributionStore?: CountContributionStore;
  /** Owned victim proof and recipient response, produced from replayed private state. */
  stealContribution?: StealContributionProducer;
  stealResponse?: StealResponseProducer;
  /** Immutable outgoing contributions and responses retained across restarts. */
  stealDeliveryStore?: StealDeliveryStore;
  /** Owner-only trade obligation proofs, produced after request authorization. */
  tradeProof?: (
    request: SignedTradeProofRequest,
    context: LogContext,
  ) => Result<readonly IndexedHandProof[]>;
  /** Verified remote trade proofs are delivered to the pre-admission coordinator. */
  onTradeProofResponse?: (response: SignedTradeProofResponse) => void;
  /** A validated current-parent authorization is available for a user decision. */
  onRecoveryCandidate?: (preview: RecoveryApprovalPreview | null) => void;
  /** Private recovery inputs; the replica supplies its own journal and current signing key. */
  recoveryParticipant?: Pick<
    RecoveryParticipantOptions,
    'encryptionSecret' | 'privateEntropy' | 'store'
  >;
  /** Install only certified active bot keys hosted by this voter. Temporary key buffers transfer ownership. */
  onAuthorityChange?: (
    current: ProposalContext,
  ) => Promise<Result<RecoveredReplicaOwnership | null>>;
  /** Secrets may be published only after the durable certified history contains a result. */
  masterReveal?: Pick<MasterRevealOptions, 'store' | 'loadOwnedMaster' | 'recoveryPrivateStore'>;
  onMasterReveal?: (reveal: { packet: SignedMasterReveal; verdict: MasterRevealVerdict }) => void;
  systemInput?: (
    context: ProposalContext,
  ) => { input: SystemInput; evidence: SystemEvidence } | null;
  onCommit?: (
    validated: ValidatedEntry & CertifiedEntry,
    previous: ProposalContext,
    next: ProposalContext,
  ) => void;
  /** Update device routes after the membership COMMIT is sent, before next-height work. */
  onMembershipCommitted?: (entries: readonly CertifiedEntry[]) => Result<void>;
  /** Local auto-policy hint only; authorization still passes the serialized vote gate. */
  onTakeoverEligible?: (departedSeat: Seat) => void;
  onStatus?: (status: ReplicatedLogStatus) => void;
}

interface PendingCommand {
  hash: string;
  signed: SignedCommand;
  resolve: (result: Result<void>) => void;
  pendingTimer: unknown;
}

interface PendingMembership {
  hash: string;
  change: MembershipChange;
  parentHash: string;
  resolve?: (result: Result<void>) => void;
  pendingTimer?: unknown;
}

interface LocalConfiguration {
  passes: ReadonlyMap<string, { deckId: string; pass: unknown }>;
  keys: Map<Seat, Uint8Array>;
  signingKey: Uint8Array;
}

/** Certified history plus one active, durable consensus height. */
export class ReplicatedLog {
  private controller: ConsensusController | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly secretKey: Uint8Array;
  private readonly self: PeerId;
  private readonly timers = new Map<string, unknown>();
  private readonly pending: PendingCommand[] = [];
  private membershipIntent: PendingMembership | null = null;
  private pendingRecoverySubmit: PendingMembership | null = null;
  private recoveryCandidateForApproval: RecoveryApprovalCandidate | null = null;
  private recoveryApproval: {
    parentHash: string;
    statementHash: string;
    generationHash: string;
  } | null = null;
  private recoveryApprovalRevision = 0;
  private readonly recoveryPresence = new Map<Seat, RecoveryPresenceObserver>();
  private pendingRecoveryProposal: SignedProposal | null = null;
  private readonly commands: SignedCommand[] = [];
  private readonly rejectedCommands = new Set<string>();
  private readonly rejectedProposals = new Set<string>();
  private readonly beaconInbox = new BeaconInbox();
  private recoveryParticipant: RecoveryParticipant | null = null;
  private masterRevealCoordinator: MasterRevealCoordinator | null = null;
  private masterRevealsRestored = false;
  private readonly acceptedMasterSeats = new Set<Seat>();
  private readonly localMasterReveals = new Map<
    Seat,
    { headHash: string; packet: SignedMasterReveal; verdict: MasterRevealVerdict }
  >();
  private readonly rejectedMasterReveals = new Set<string>();
  private readonly revealWorkByPeer = new Map<PeerId, { startedAt: number; seen: Set<string> }>();
  private readonly beaconSources = new Map<Seat, BeaconSecretSource>();
  private createDeckSource: DeckSourceFactory | undefined;
  private preparedRecovery: { headHash: string; packets: PreparedRecoveryPackets } | null = null;
  private recoverySendCursor = 0;
  private readonly sentRecoveryPackets = new Set<string>();
  private recoveryAdmissionScope: string | null = null;
  private recoveryCheckScope: string | null = null;
  private readonly recoveryReleasesByPeer = new Map<PeerId, Set<string>>();
  private readonly recoveryChecksByPeer = new Map<PeerId, Set<string>>();
  private readonly deckInbox = new DeckInbox();
  private readonly countInbox = new CountInbox();
  private readonly stealInbox = new StealInbox();
  private readonly deckSetupPasses: LocalConfiguration['passes'];
  private readonly deckKeys: LocalConfiguration['keys'];
  private readonly rejectedDeckContributions = new Set<string>();
  private readonly rejectedCountContributions = new Set<string>();
  private readonly rejectedStealMessages = new Set<string>();
  private readonly pendingTradeProofs = new Map<
    string,
    { request: SignedTradeProofRequest; ownerHost: PeerId }
  >();
  private readonly tradeProofResponses = new Map<
    string,
    { requestBytes: Uint8Array; responseBytes: Uint8Array; requester: PeerId }
  >();
  private readonly tradeProofRequestsByFinalizer = new Map<Seat, Set<string>>();
  private readonly tradeProofWorkByPeer = new Map<
    PeerId,
    { startedAt: number; seen: Set<string> }
  >();
  private sentStealStage: string | null = null;
  private preparedSteal: { readonly stage: string; readonly bytes: Uint8Array } | null = null;
  private readonly sentCountContributions = new Set<Seat>();
  private sentCountOperation: string | null = null;
  private preparedDeckPrefix: string | null = null;
  private sentDeckPrefix: string | null = null;
  private readonly sentBeaconOperations = new Set<string>();
  private readonly timerObserver: LocalTimerObserver;
  private timedVoteRetry: {
    parentHash: string;
    anchorHash: string;
    proposal: SignedProposal | null;
    handle: unknown;
  } | null = null;
  private accusation: ExcludeProposerControl | null = null;
  private readonly cheatCandidates = new Map<string, CheatClaim>();
  private readonly unsubscribers: Unsubscribe[] = [];
  private readonly queuedByPeer = new Map<PeerId, number>();
  private readonly invalidByPeer = new Map<PeerId, number>();
  private readonly blockedPeers = new Set<PeerId>();
  /** Only certified human generations may request a read-only catch-up after retirement. */
  private readonly historicalHumanPeers = new Set<PeerId>();
  private readonly expensiveByPeer = new Map<PeerId, { startedAt: number; seen: Set<string> }>();
  private readonly cheatWorkByPeer = new Map<PeerId, { startedAt: number; seen: Set<string> }>();
  private readonly historicalCheatWorkByPeer = new Map<
    PeerId,
    { startedAt: number; seen: Set<string> }
  >();
  private cheatGossipCursor = 0;
  private lastSyncRequest: { fromSeq: number; sentAt: number } | null = null;
  private queuedMessages = 0;
  private pulseTimer: unknown = null;
  private disposed = false;
  private controllerAnchor: {
    seq: number;
    hash: string;
    genesisDigest: string;
    voters: readonly string[];
  } | null = null;
  private derivedRepair: {
    stopped: ConsensusController;
    anchor: NonNullable<ReplicatedLog['controllerAnchor']>;
    heldCommits: Map<string, CertifiedEntry>;
    lastRequestAt: number;
  } | null = null;

  private constructor(
    private readonly options: ReplicatedLogOptions,
    private readonly genesisEntry: LogEntry,
    private context: ProposalContext,
    private entries: CertifiedEntry[],
    local: LocalConfiguration,
  ) {
    this.secretKey = local.signingKey;
    this.deckKeys = local.keys;
    this.deckSetupPasses = local.passes;
    this.createDeckSource = options.createDeckSource;
    this.timerObserver = new LocalTimerObserver(options.clock, context.log.timers ?? []);
    if (options.beaconSource) this.beaconSources.set(options.seat, options.beaconSource);
    for (const [seat, source] of options.beaconSources ?? []) this.beaconSources.set(seat, source);
    const identity = identityFromSecret(this.secretKey);
    this.self = identity.peerId;
    identity.secretKey.fill(0);
    this.refreshHistoricalHumanPeers();
  }

  static async create(options: ReplicatedLogOptions): Promise<Result<ReplicatedLog>> {
    const initial = initialProposalContext(options.genesisEntry, options.engine, options.policy);
    if (!initial.ok) return initial;
    const key = checkLocalKey(options, initial.value);
    if (!key.ok) return key;
    for (const keyBytes of key.value.keys.values()) keyBytes.fill(0);
    const safety = createConsensusState(initial.value, options.seat);
    if (!safety.ok) return safety;
    try {
      const initialized = await options.journal.initialize(
        initial.value.log.head,
        canonicalEncode(safety.value),
      );
      if (!initialized)
        return failure(
          'replica-exists',
          'Restore the existing certified journal instead of reinitializing it',
        );
    } catch {
      return failure(
        'replica-storage',
        'Could not initialize the certified journal and voting record',
      );
    }
    return ReplicatedLog.restore(options);
  }

  static async restore(options: ReplicatedLogOptions): Promise<Result<ReplicatedLog>> {
    let record: Awaited<ReturnType<ProtocolJournal['load']>>;
    try {
      record = await options.journal.load();
    } catch {
      return failure('replica-storage', 'Could not read the certified journal');
    }
    if (!record) return failure('replica-missing', 'Certified journal or safety state is missing');
    const requested = initialProposalContext(options.genesisEntry, options.engine, options.policy);
    if (!requested.ok) return requested;
    if (!sameBytes(canonicalEncode(requested.value.log.head), canonicalEncode(record.genesis)))
      return failure('replica-genesis', 'Requested genesis differs from the certified journal');
    const replayed = replayCertifiedPrefix(
      record.genesis,
      record.entries,
      options.engine,
      options.policy,
    );
    if (!replayed.ok) return replayed;
    const context = replayed.value.context;
    if (record.height !== context.log.head.seq + 1 || !record.safety)
      return failure('replica-journal', 'Certified prefix and active safety height disagree');
    let localPublicKey: string;
    try {
      const identity = identityFromSecret(options.secretKey);
      localPublicKey = identity.peerId;
      identity.secretKey.fill(0);
    } catch {
      return failure('replica-key', 'Local signing key is invalid');
    }
    if (
      !context.membership.voters.some(
        (voter) => voter.seat === options.seat && voter.publicKey === localPublicKey,
      )
    ) {
      let marker: unknown;
      try {
        marker = canonicalDecode(record.safety.bytes);
      } catch {
        return failure('replica-retirement', 'Retired signing record is malformed');
      }
      const checked = restoreRetiredSafety(marker, context, options.seat, localPublicKey);
      if (!checked.ok) return checked;
      return failure('replica-retired', 'This signing key was retired by certified membership');
    }
    const key = checkLocalKey(options, context);
    if (!key.ok) return key;
    const replica = new ReplicatedLog(
      options,
      record.genesis,
      context,
      replayed.value.entries,
      key.value,
    );
    const opened = await replica.openController();
    if (!opened.ok) {
      replica.dispose();
      return opened;
    }
    const initialized = await replica.enqueue(async () => {
      const installed = await replica.installAuthorityOwnership();
      if (!installed.ok) return installed;
      const recovered = await replica.recoverPersistedAccusation();
      if (!recovered.ok) return recovered;
      const cheats = await replica.recoverCheatCandidates();
      if (!cheats.ok) return cheats;
      replica.attachTransport();
      replica.observeAllRecoveryPresence();
      replica.broadcastNextCheatClaim();
      const resumed = await replica.activeController().resume();
      if (!resumed.ok) return resumed;
      await replica.captureCertifiedDelivery();
      const offered = await replica.offerAvailableInput();
      if (!offered.ok) return offered;
      // A one-shot commit hint can arrive before restore attaches its listener.
      // Request the next certified height while an authenticated peer is present.
      return replica.requestSync(replica.context.log.head.seq + 1);
    });
    if (!initialized.ok) {
      replica.dispose();
      return initialized;
    }
    replica.schedulePulse();
    return success(replica);
  }

  /** Detached public context. The certified prefix remains the only authority. */
  getContext(): ProposalContext {
    return detachedContext(this.context);
  }

  getEntries(): readonly CertifiedEntry[] {
    return copyCanonical(this.entries);
  }

  getTimers(): readonly SessionTimer[] {
    return this.context.log.genesis.security === 'verified' ? this.timerObserver.timers() : [];
  }

  /** Replays the certified parent before retrying a retained, authenticated certificate. */
  repair(snapshot?: unknown): Promise<Result<void>> {
    return this.enqueue(() => this.repairNow(snapshot), true);
  }

  private async repairNow(snapshot?: unknown): Promise<Result<void>> {
    const hold = this.derivedRepair;
    if (hold) await hold.stopped.settled();
    else {
      const state = this.activeController().snapshot();
      if (!state.ok) return state;
      if (state.value.haltKind !== 'certified-validation')
        return failure('replica-repair', 'Only a certified validation halt can be repaired');
    }
    let record: Awaited<ReturnType<ProtocolJournal['load']>>;
    try {
      record = await this.options.journal.load();
    } catch {
      return failure('replica-storage', 'Could not read the certified journal for repair');
    }
    if (!record)
      return this.failClosed('replica-journal', 'Certified journal is missing during repair');
    if (
      !sameBytes(canonicalEncode(record.genesis), canonicalEncode(this.genesisEntry)) ||
      !sameBytes(canonicalEncode(record.genesis), canonicalEncode(this.options.genesisEntry))
    )
      return this.failClosed('replica-genesis', 'Repair journal differs from the original genesis');
    const replayed = replayCertifiedPrefix(
      record.genesis,
      record.entries,
      this.options.engine,
      this.options.policy,
    );
    if (!replayed.ok)
      return hold ? this.failClosed(replayed.error.code, replayed.error.message) : replayed;
    const fresh = replayed.value.context;
    if (
      record.height !== fresh.log.head.seq + 1 ||
      fresh.log.head.seq !== (hold?.anchor.seq ?? this.context.log.head.seq) ||
      entryHash(fresh.log.head) !== (hold?.anchor.hash ?? entryHash(this.context.log.head))
    )
      return this.failClosed('replica-journal', 'Certified parent changed during repair');
    if (hold && !hold.stopped.opensOn(fresh))
      return this.failClosed(
        'replica-authority',
        'Durable replay differs from the controller opening context',
      );
    if (hold && snapshot === undefined)
      return failure('replica-repairing', 'Derived repair requires a replay-verified snapshot');
    if (snapshot !== undefined) {
      const checked = verifyReplaySnapshot(snapshot, fresh);
      if (!checked.ok) return checked;
    }
    let restored: ConsensusController | null = null;
    if (hold) {
      const safety = record.safety;
      if (!hold.stopped.matchesPersistedRecord(safety))
        return this.failClosed(
          'consensus-write-conflict',
          'Durable vote or lock record changed during repair',
        );
      const local = checkLocalKey(this.options, fresh);
      if (!local.ok) return this.failClosed(local.error.code, local.error.message);
      for (const key of local.value.keys.values()) key.fill(0);
      const opened = await this.restoreController(fresh, true);
      if (!opened.ok) return this.failClosed(opened.error.code, opened.error.message);
      restored = opened.value;
      let stillStored: Awaited<ReturnType<ProtocolJournal['loadSafety']>>;
      try {
        stillStored = await this.options.journal.loadSafety(record.height);
      } catch {
        restored.dispose();
        return failure('replica-storage', 'Could not recheck durable safety during repair');
      }
      if (!stillStored || !hold.stopped.matchesPersistedRecord(stillStored)) {
        restored.dispose();
        return this.failClosed(
          'consensus-write-conflict',
          'Durable safety changed while restoring repair',
        );
      }
    }
    if (!hold) this.activeController().dispose();
    this.controller = null;
    this.context = fresh;
    this.timerObserver.advance(fresh.log.timers ?? []);
    this.clearTimedVoteRetry();
    this.clearRecoveryCandidate();
    this.rejectedCommands.clear();
    this.rejectedProposals.clear();
    this.rejectedDeckContributions.clear();
    this.preparedDeckPrefix = null;
    this.sentDeckPrefix = null;
    this.entries = replayed.value.entries;
    this.refreshHistoricalHumanPeers();
    if (!restored) {
      const opened = await this.openController();
      if (!opened.ok) return this.failClosed(opened.error.code, opened.error.message);
      return this.activeController().dispatch({ kind: 'resume-after-replay' });
    }
    this.installController(restored, fresh);
    this.derivedRepair = null;
    const resumed = await restored.resume();
    if (!resumed.ok) return resumed;
    for (const certified of hold?.heldCommits.values() ?? []) {
      // oxlint-disable-next-line no-await-in-loop -- Retained untrusted hints are fully validated on the freshly restored parent.
      const accepted = await this.acceptCertified(certified);
      if (!accepted.ok && FATAL_CONTROLLER_ERRORS.has(accepted.error.code)) return accepted;
    }
    this.schedulePulse();
    return this.requestSync(this.context.log.head.seq + 1);
  }

  /** Resolves on matching commitment; another committed value requires renewed intent. */
  submit(signed: SignedCommand): Promise<Result<void>> {
    return new Promise((resolve) => {
      let acceptedHash: string | null = null;
      void this.enqueue(async () => {
        const state = this.activeController().snapshot();
        if (!state.ok) return state;
        if (state.value.halted)
          return failure(
            'replica-halted',
            'Voting is halted until the certified failure is repaired',
          );
        const checked = validateSignedCommand(signed, this.context.log);
        if (!checked.ok) return checked;
        const candidate = this.deriveCandidate(state.value, {
          kind: 'command',
          signed: checked.value,
        });
        if (!candidate.ok) return candidate;
        if (!this.rememberCommand(checked.value))
          return failure('replica-command-cap', 'Too many pending commands for this seat');
        const hash = commandHash(checked.value);
        acceptedHash = hash;
        const pendingTimer = this.options.clock.setTimeout(
          () => this.status({ kind: 'pending', commandHash: hash }),
          10_000,
        );
        this.pending.push({ hash, signed: checked.value, resolve, pendingTimer });
        const sent = this.broadcast({ t: 'SUBMIT', cmd: checked.value });
        if (!sent.ok) this.status({ kind: 'pending', commandHash: hash });
        return this.offerAvailableInput();
      }).then((result) => {
        if (!result.ok) {
          // A signed input retained after enqueue may still commit elsewhere.
          // Only pre-acceptance failures can be reported as final rejection.
          if (acceptedHash) this.status({ kind: 'pending', commandHash: acceptedHash });
          else resolve(result);
        }
        return undefined;
      });
    });
  }

  /** Gossip one parent-bound membership change and resolve when it is certified. */
  submitRecovery(value: unknown): Promise<Result<void>> {
    return this.enqueueMembership(value, 'recovery', false);
  }

  /** One serialized explicit local approval and submission after durable key preparation. */
  approveAndSubmitRecovery(value: unknown): Promise<Result<void>> {
    return this.enqueueMembership(value, 'recovery', true);
  }

  /** Submit a signed transfer intent, exact-parent activation, or cancellation. */
  submitTransfer(value: unknown): Promise<Result<void>> {
    return this.enqueueMembership(value, 'transfer', false);
  }

  /** Countersign one destination-only offer against this exact committed head. No gossip occurs. */
  authorizeLiveTransfer(
    offer: unknown,
    expectedHead: EntryRef,
  ): Promise<Result<SeatTransferAuthorization>> {
    const parsedOffer = parseCanonical(offer, transferChangeSchema);
    if (!parsedOffer.ok) return Promise.resolve(parsedOffer);
    const parsedHead = parseCanonical(expectedHead, transferRefSchema);
    if (!parsedHead.ok) return Promise.resolve(parsedHead);
    const change = parsedOffer.value;
    if (
      change.kind !== 'transfer-authorize' ||
      change.statement.mode !== 'live' ||
      change.ownerIntent !== undefined ||
      change.returnIntent !== undefined ||
      change.humanApprovals !== undefined
    )
      return Promise.resolve(
        failure('transfer-offer', 'A live transfer offer must contain only destination signatures'),
      );
    return this.enqueue(async () => {
      const head = this.context.log.head;
      const headHash = entryHash(head);
      if (parsedHead.value.seq !== head.seq || parsedHead.value.hash !== headHash)
        return failure('transfer-head', 'Source consent must name the exact committed head');
      const controller = this.context.log.authority?.controllers.find(
        (item) => item.seat === this.options.seat,
      );
      const voter = this.context.membership.voters.find((item) => item.seat === this.options.seat);
      if (
        change.statement.seat !== this.options.seat ||
        controller?.kind !== 'human' ||
        controller.status !== 'active' ||
        controller.hostSeat !== this.options.seat ||
        controller.publicKey !== this.self ||
        voter?.publicKey !== this.self
      )
        return failure('transfer-owner', 'Only the current local human may authorize this seat');
      if (
        this.context.log.state.result !== null ||
        this.context.log.recovery?.pending ||
        this.context.log.transfer?.pending ||
        this.membershipIntent ||
        this.pendingRecoverySubmit
      )
        return failure(
          'transfer-unavailable',
          'Another membership change or game result is pending',
        );
      const state = this.activeController().snapshot();
      if (!state.ok) return state;
      if (state.value.halted)
        return failure('replica-halted', 'Voting is halted until certified repair');
      const signed: SeatTransferAuthorization = {
        ...change,
        ownerIntent: {
          signer: 'current-game',
          sig: signObject(TRANSFER_OWNER_GAME_DOMAIN, change.statement, this.secretKey),
        },
      };
      const checked = this.deriveCandidate(state.value, { kind: 'membership', change: signed });
      return checked.ok ? success(signed) : checked;
    });
  }

  private enqueueMembership(
    value: unknown,
    family: 'recovery' | 'transfer',
    approveLocally: boolean,
  ): Promise<Result<void>> {
    const approvalRevision = this.recoveryApprovalRevision;
    return new Promise((resolve) => {
      let accepted = false;
      void this.enqueue(async () => {
        const parsed =
          family === 'recovery'
            ? parseCanonical(value, recoveryChangeSchema)
            : parseCanonical(value, transferChangeSchema);
        if (!parsed.ok) return parsed;
        const hash = toHex(hashValue(parsed.value));
        const conflicting = this.membershipIntent;
        if (conflicting && (conflicting.hash !== hash || conflicting.resolve))
          return failure('recovery-intent-pending', 'A membership change is already pending');
        if (approveLocally) {
          const approved = await this.approveRecoveryInQueue(parsed.value, approvalRevision);
          if (!approved.ok) return approved;
        }
        const state = this.activeController().snapshot();
        if (!state.ok) return state;
        if (state.value.halted)
          return failure('replica-halted', 'Voting is halted until certified repair');
        const checked = this.deriveCandidate(state.value, {
          kind: 'membership',
          change: parsed.value,
        });
        if (!checked.ok) return checked;
        if (parsed.value.kind === 'recovery-authorize') {
          const preview = this.previewRecoveryAuthorization(parsed.value);
          if (!preview.ok) return preview;
          this.rememberRecoveryCandidate(preview.value);
          if (!this.hasRecoveryApproval(preview.value.preview))
            return failure(
              'recovery-approval-required',
              'Approve this exact takeover before submitting',
            );
        }
        const existing = this.membershipIntent;
        if (existing) {
          if (existing.hash !== hash || existing.resolve)
            return failure('recovery-intent-pending', 'A membership change is already pending');
          existing.resolve = resolve;
          accepted = true;
        } else {
          const pendingTimer = this.options.clock.setTimeout(
            () => this.status({ kind: 'pending', commandHash: hash }),
            10_000,
          );
          this.membershipIntent = {
            hash,
            change: parsed.value,
            parentHash: entryHash(this.context.log.head),
            resolve,
            pendingTimer,
          };
          accepted = true;
        }
        const sent = this.broadcast({ t: 'MEMBERSHIP_SUBMIT', change: parsed.value });
        if (!sent.ok) this.status({ kind: 'pending', commandHash: hash });
        return this.offerAvailableInput();
      }).then((result) => {
        if (!result.ok) {
          if (accepted)
            this.status({ kind: 'pending', commandHash: this.membershipIntent?.hash ?? '' });
          else resolve(result);
        }
        return undefined;
      });
    });
  }

  previewRecoveryAuthorization(value: unknown): Result<RecoveryApprovalCandidate> {
    return previewRecoveryAuthorization(value, this.context.log, this.options.seat);
  }

  getRecoveryCandidate(): RecoveryApprovalCandidate | null {
    return this.recoveryCandidateForApproval
      ? copyCanonical(this.recoveryCandidateForApproval)
      : null;
  }

  canStartRecoveryRequest(): Promise<Result<void>> {
    return this.enqueue(async () =>
      this.membershipIntent || this.pendingRecoverySubmit || this.recoveryApproval
        ? failure('recovery-intent-pending', 'Another takeover request is already pending')
        : success(undefined),
    );
  }

  /** Local, restart-conservative eligibility; never used to validate certified history. */
  canRequestTakeover(targetSeat: Seat): Promise<Result<void>> {
    return this.enqueue(async () => {
      const policy = this.context.log.genesis.takeover;
      if (policy.afterSeconds === 'never')
        return failure('recovery-disabled', 'Takeover is disabled for this game');
      if (this.context.log.recovery?.pending)
        return failure('recovery-pending', 'A takeover is already certified');
      const observed = this.observeRecoveryPresence(targetSeat);
      if (!observed.ok) return observed;
      if (!this.context.log.recovery?.offline.some((item) => item.seat === targetSeat))
        return failure('recovery-offline-required', 'Certified offline notice is required');
      return this.checkRecoveryPresence(observed.value, policy.afterSeconds * 1_000);
    });
  }

  approveRecoveryAuthorization(value: unknown): Promise<Result<RecoveryApprovalPreview>> {
    const revision = this.recoveryApprovalRevision;
    return this.enqueue(() => this.approveRecoveryInQueue(value, revision));
  }

  private async approveRecoveryInQueue(
    value: unknown,
    revision: number,
  ): Promise<Result<RecoveryApprovalPreview>> {
    if (revision !== this.recoveryApprovalRevision)
      return failure('recovery-approval-cleared', 'The local takeover approval was cleared');
    const candidate = this.previewRecoveryAuthorization(value);
    if (!candidate.ok) return candidate;
    if (!candidate.value.preview.canApprove)
      return failure('recovery-approval-seat', 'This voter cannot approve its own takeover');
    const candidateHash = toHex(hashValue(candidate.value.change));
    if (this.membershipIntent && this.membershipIntent.hash !== candidateHash)
      return failure('recovery-intent-pending', 'Another takeover request is already pending');
    if (this.pendingRecoverySubmit && this.pendingRecoverySubmit.hash !== candidateHash)
      return failure('recovery-intent-pending', 'Another takeover request is already pending');
    const generation = this.context.log.authority?.controllers.find(
      (item) => item.seat === this.options.seat,
    )?.activatedAt;
    if (!generation)
      return failure('recovery-approval-authority', 'Local controller generation is unavailable');
    this.recoveryApproval = {
      parentHash: candidate.value.preview.parent.hash,
      statementHash: candidate.value.preview.statementHash,
      generationHash: generation.hash,
    };
    this.recoveryCandidateForApproval = null;
    this.rememberRecoveryCandidate(candidate.value);
    const submitted = this.pendingRecoverySubmit;
    if (submitted) {
      this.pendingRecoverySubmit = null;
      const submittedChange = parseCanonical(submitted.change, recoveryChangeSchema);
      if (
        submittedChange.ok &&
        submittedChange.value.kind === 'recovery-authorize' &&
        submitted.parentHash === candidate.value.preview.parent.hash &&
        toHex(hashValue(submittedChange.value.statement)) ===
          candidate.value.preview.statementHash &&
        !this.membershipIntent
      ) {
        this.membershipIntent = submitted;
        const sent = this.broadcast({ t: 'MEMBERSHIP_SUBMIT', change: submitted.change });
        if (!sent.ok) this.status({ kind: 'pending', commandHash: submitted.hash });
      }
    }
    if (this.pendingRecoveryProposal) {
      const proposal = this.pendingRecoveryProposal;
      this.pendingRecoveryProposal = null;
      const payload = proposal.body.entry.payload;
      const change =
        payload.kind === 'membership' ? parseCanonical(payload.change, recoveryChangeSchema) : null;
      if (
        change?.ok &&
        change.value.kind === 'recovery-authorize' &&
        toHex(hashValue(change.value.statement)) === candidate.value.preview.statementHash
      ) {
        const admitted = await this.activeController().dispatch({ kind: 'proposal', proposal });
        if (!admitted.ok && admitted.error.code !== 'recovery-approval-required') return admitted;
      }
    }
    const offered = await this.offerAvailableInput();
    return offered.ok ? success(candidate.value.preview) : offered;
  }

  clearRecoveryApproval(): void {
    this.recoveryApprovalRevision++;
    this.recoveryApproval = null;
  }

  /** Waits until all previously queued messages/transitions have settled. */
  async flush(): Promise<void> {
    let current: Promise<unknown>;
    do {
      current = this.queue;
      // oxlint-disable-next-line eslint/no-await-in-loop -- Follow-up tasks may join the serialized queue while it resolves.
      await current;
    } while (current !== this.queue);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.derivedRepair?.stopped.dispose();
    this.derivedRepair = null;
    this.pendingTradeProofs.clear();
    this.tradeProofResponses.clear();
    this.tradeProofRequestsByFinalizer.clear();
    this.tradeProofWorkByPeer.clear();
    this.cheatWorkByPeer.clear();
    this.historicalCheatWorkByPeer.clear();
    this.cheatCandidates.clear();
    this.recoveryParticipant?.dispose();
    this.recoveryParticipant = null;
    this.clearRecoveryCandidate();
    this.masterRevealCoordinator?.dispose();
    this.masterRevealCoordinator = null;
    this.acceptedMasterSeats.clear();
    this.localMasterReveals.clear();
    this.rejectedMasterReveals.clear();
    this.revealWorkByPeer.clear();
    this.preparedRecovery = null;
    this.sentRecoveryPackets.clear();
    this.recoveryReleasesByPeer.clear();
    this.recoveryChecksByPeer.clear();
    this.preparedSteal = null;
    this.sentStealStage = null;
    this.controller?.dispose();
    for (const key of this.deckKeys.values()) key.fill(0);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const handle of this.timers.values()) this.options.clock.clearTimeout(handle);
    this.timers.clear();
    if (this.pulseTimer !== null) this.options.clock.clearTimeout(this.pulseTimer);
    this.clearTimedVoteRetry();
    for (const pending of this.pending.splice(0)) {
      this.options.clock.clearTimeout(pending.pendingTimer);
      pending.resolve(
        failure(
          'replica-outcome-unknown',
          'The accepted command may have committed; restore and check the certified log before retrying',
        ),
      );
    }
    const membership = this.membershipIntent;
    this.membershipIntent = null;
    if (membership?.pendingTimer !== undefined)
      this.options.clock.clearTimeout(membership.pendingTimer);
    membership?.resolve?.(
      failure(
        'replica-outcome-unknown',
        'Accepted membership change may have committed; restore and inspect the certified log',
      ),
    );
    this.secretKey.fill(0);
  }

  /** Send one authorized trade-proof request directly to its counterparty host. */
  requestTradeProof(value: SignedTradeProofRequest): Result<void> {
    if (this.disposed) return failure('replica-disposed', 'Replica has been disposed');
    const checked = verifyTradeProofRequest(value, this.context.log);
    if (!checked.ok) return checked;
    const request = checked.value;
    const finalizerHost = tradeProofHost(
      this.context.log.genesis,
      request.body.seat,
      this.context.log.authority,
    );
    const ownerHost = tradeProofHost(
      this.context.log.genesis,
      request.body.command.withSeat,
      this.context.log.authority,
    );
    if (
      !this.deckKeys.has(request.body.seat) ||
      finalizerHost !== this.self ||
      !ownerHost ||
      ownerHost === this.self
    )
      return failure('trade-proof-route', 'Request is not for a remotely hosted trade owner');
    const requestId = tradeProofRequestId(request.body);
    const existing = this.pendingTradeProofs.get(requestId);
    if (existing && !sameBytes(canonicalEncode(existing.request), canonicalEncode(request)))
      return failure('trade-proof-request-id', 'Request identifier is already reserved');
    if (!existing && this.pendingTradeProofs.size >= MAX_TRADE_PROOF_CACHE)
      return failure('trade-proof-capacity', 'Too many trade-proof requests are pending');
    this.pendingTradeProofs.set(requestId, { request, ownerHost });
    return this.send(ownerHost, { t: 'TRADE_PROOF_REQUEST', request });
  }

  /** Cancel a pre-admission proof wait; late responses are then ignored. */
  cancelTradeProofRequest(requestId: string): void {
    this.pendingTradeProofs.delete(requestId);
  }

  private activeController(): ConsensusController {
    if (!this.controller) throw new Error('No active consensus controller');
    return this.controller;
  }

  private async installAuthorityOwnership(): Promise<Result<void>> {
    const authority = this.context.log.authority;
    const hasBeaconChain = (seat: Seat) =>
      this.context.log.crypto?.beacon.chains.some((chain) => chain.seat === seat) ?? false;
    const missing =
      authority?.controllers.filter(
        (controller) =>
          controller.kind === 'bot' &&
          controller.status === 'active' &&
          controller.hostSeat === this.options.seat &&
          controller.activatedAt.seq > 0 &&
          (!this.currentOwnedKeyMatches(controller.seat, controller.publicKey) ||
            (hasBeaconChain(controller.seat) && !this.beaconSources.has(controller.seat))),
      ) ?? [];
    if (missing.length === 0) return success(undefined);
    const install = this.options.onAuthorityChange;
    if (!install) {
      this.status({ kind: 'rejected', code: 'replica-recovery-keys' });
      return success(undefined);
    }
    const headHash = entryHash(this.context.log.head);
    const beaconSeats = missing.filter((controller) => hasBeaconChain(controller.seat));
    let ownership: RecoveredReplicaOwnership | null = null;
    try {
      const prepared = await install(detachedContext(this.context));
      if (!prepared.ok) return prepared;
      ownership = prepared.value;
      if (this.disposed || entryHash(this.context.log.head) !== headHash)
        return failure(
          'replica-recovery-stale',
          'Certified parent changed during key installation',
        );
      const record = await this.options.journal.load();
      if (this.disposed || entryHash(this.context.log.head) !== headHash)
        return failure(
          'replica-recovery-stale',
          'Certified parent changed during key installation',
        );
      if (
        !record ||
        entryHash(record.entries.at(-1)?.entry ?? record.genesis) !== headHash ||
        record.height !== this.context.log.head.seq + 1
      )
        return failure('replica-recovery-stale', 'Journal changed during key installation');
      if (
        !ownership ||
        !(ownership.keys instanceof Map) ||
        !(ownership.beaconSources instanceof Map) ||
        ownership.keys.size !== missing.length ||
        ownership.beaconSources.size !== beaconSeats.length ||
        missing.some((controller) => !ownership?.keys.has(controller.seat)) ||
        beaconSeats.some((controller) => !ownership?.beaconSources.has(controller.seat))
      )
        return failure('replica-recovery-keys', 'Recovered ownership differs from certified host');
      if (
        beaconSeats.some((controller) => {
          const source = ownership?.beaconSources.get(controller.seat);
          return (
            !source || typeof source.link !== 'function' || typeof source.extension !== 'function'
          );
        }) ||
        (ownership.createDeckSource !== undefined &&
          typeof ownership.createDeckSource !== 'function')
      )
        return failure('replica-recovery-keys', 'Recovered private source is malformed');
      const copied = new Map<Seat, Uint8Array>();
      try {
        for (const controller of missing) {
          const key = ownership.keys.get(controller.seat);
          if (!(key instanceof Uint8Array) || key.length !== 32)
            return failure('replica-recovery-keys', 'Recovered signing key is malformed');
          const identity = identityFromSecret(key);
          const matches = identity.peerId === controller.publicKey;
          identity.secretKey.fill(0);
          if (!matches)
            return failure(
              'replica-recovery-keys',
              'Recovered key differs from certified controller',
            );
          copied.set(controller.seat, new Uint8Array(key));
        }
        for (const [seat, key] of copied) {
          this.deckKeys.get(seat)?.fill(0);
          this.deckKeys.set(seat, key);
        }
        for (const [seat, source] of ownership.beaconSources) this.beaconSources.set(seat, source);
        if (ownership.createDeckSource) this.createDeckSource = ownership.createDeckSource;
        return success(undefined);
      } finally {
        if (copied.size !== missing.length) for (const key of copied.values()) key.fill(0);
      }
    } catch {
      return failure('replica-recovery-keys', 'Could not install certified recovery ownership');
    } finally {
      if (ownership?.keys instanceof Map)
        for (const key of ownership.keys.values()) if (key instanceof Uint8Array) key.fill(0);
    }
  }

  private currentOwnedKeyMatches(seat: Seat, publicKey: string): boolean {
    const key = this.deckKeys.get(seat);
    if (!key) return false;
    try {
      const identity = identityFromSecret(key);
      const matches = identity.peerId === publicKey;
      identity.secretKey.fill(0);
      return matches;
    } catch {
      return false;
    }
  }

  private pruneRetiredBotOwnership(): void {
    const authority = this.context.log.authority;
    if (!authority) return;
    const seats = new Set([...this.deckKeys.keys(), ...this.beaconSources.keys()]);
    for (const seat of seats) {
      if (seat === this.options.seat) continue;
      const controller = authority.controllers.find((item) => item.seat === seat);
      if (
        controller?.kind === 'bot' &&
        controller.status === 'active' &&
        controller.hostSeat === this.options.seat &&
        this.currentOwnedKeyMatches(seat, controller.publicKey)
      )
        continue;
      this.deckKeys.get(seat)?.fill(0);
      this.deckKeys.delete(seat);
      this.beaconSources.delete(seat);
    }
  }

  private restoreController(
    context: ProposalContext,
    exact = false,
  ): Promise<Result<ConsensusController>> {
    return ConsensusController.restore({
      context,
      requireExactRestore: exact,
      seat: this.options.seat,
      secretKey: this.secretKey,
      store: journalSafetyStore(this.options.journal, context.log.head.seq + 1),
      onEffects: (effects) => this.handleEffects(effects),
      admitLocalValue: (proposal) => this.canVoteForRecoveryProposal(proposal),
      beforePersist: (previous, next) => {
        const timed = this.admitTimedVotes(previous, next);
        return timed.ok ? this.admitRecoveryVotes(previous, next) : timed;
      },
    });
  }

  private installController(controller: ConsensusController, context: ProposalContext): void {
    this.controller = controller;
    this.controllerAnchor = Object.freeze({
      seq: context.log.head.seq,
      hash: entryHash(context.log.head),
      genesisDigest: context.membership.genesisDigest,
      voters: Object.freeze(context.membership.voters.map((voter) => voter.publicKey)),
    });
  }

  private async openController(): Promise<Result<void>> {
    const opened = await this.restoreController(this.context);
    if (!opened.ok) return opened;
    this.installController(opened.value, this.context);
    return success(undefined);
  }

  private enterDerivedRepair(): boolean {
    if (this.derivedRepair) return true;
    if (!this.controller || !this.controllerAnchor) return false;
    const stopped = this.controller;
    stopped.dispose();
    this.controller = null;
    this.derivedRepair = {
      stopped,
      anchor: this.controllerAnchor,
      heldCommits: new Map(),
      lastRequestAt: -Infinity,
    };
    this.clearConsensusTimers();
    this.clearTimedVoteRetry();
    this.status({ kind: 'halted', code: 'consensus-context' });
    this.requestDerivedSnapshot();
    this.schedulePulse();
    return true;
  }

  private requestDerivedSnapshot(): Result<void> {
    const hold = this.derivedRepair;
    if (!hold || this.options.clock.now() - hold.lastRequestAt < 2_000) return success(undefined);
    hold.lastRequestAt = this.options.clock.now();
    return this.broadcast({
      t: 'SNAPSHOT_REQ',
      genesisDigest: hold.anchor.genesisDigest,
      atSeq: hold.anchor.seq,
    });
  }

  private retainHeldCommit(certified: CertifiedEntry): void {
    const hold = this.derivedRepair;
    if (
      !hold ||
      certified.entry.seq !== hold.anchor.seq + 1 ||
      certified.entry.prevHash !== hold.anchor.hash ||
      hold.heldCommits.size >= 4
    )
      return;
    hold.heldCommits.set(entryHash(certified.entry), copyCanonical(certified));
  }

  private receiveDuringRepair(from: PeerId, message: ProtocolMessage): Promise<Result<void>> {
    const hold = this.derivedRepair;
    if (!hold || !hold.anchor.voters.includes(from)) return Promise.resolve(success(undefined));
    if (message.t === 'SNAPSHOT_RES') {
      if (
        message.genesisDigest !== hold.anchor.genesisDigest ||
        message.atSeq !== hold.anchor.seq ||
        !this.admitExpensiveRequest(from, `snapshot-response/${toHex(hashValue(message.snapshot))}`)
      )
        return Promise.resolve(success(undefined));
      return this.repairNow(message.snapshot);
    }
    if (message.t === 'COMMIT') this.retainHeldCommit(message.certified);
    if (message.t === 'PING') return Promise.resolve(this.send(from, { t: 'PONG', n: message.n }));
    return Promise.resolve(success(undefined));
  }

  private enqueue<T>(
    operation: () => Promise<Result<T>>,
    duringRepair = false,
  ): Promise<Result<T>> {
    const result = this.queue.then(async (): Promise<Result<T>> => {
      if (this.disposed) return failure('replica-disposed', 'Replicated log is closed');
      if (this.derivedRepair && !duringRepair)
        return failure('replica-repairing', 'Awaiting certified derived-state repair');
      try {
        const outcome = await operation();
        if (!outcome.ok && outcome.error.code === 'consensus-context' && this.enterDerivedRepair())
          return outcome;
        if (!outcome.ok && FATAL_CONTROLLER_ERRORS.has(outcome.error.code)) {
          this.status({ kind: 'halted', code: outcome.error.code });
          this.dispose();
        }
        return outcome;
      } catch {
        this.status({ kind: 'halted', code: 'replica-transition' });
        this.dispose();
        return failure('replica-transition', 'Replicated log transition failed');
      }
    });
    this.queue = result;
    return result;
  }

  private attachTransport(): void {
    this.unsubscribers.push(
      this.options.transport.onMessage((from, bytes) => {
        if (this.blockedPeers.has(from)) return;
        if (!this.knownSyncPeer(from)) {
          this.rejectPeer(from);
          return;
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_MESSAGE_BYTES) {
          this.strikePeer(from);
          return;
        }
        const peerQueued = this.queuedByPeer.get(from) ?? 0;
        if (
          peerQueued >= MAX_QUEUED_MESSAGES_PER_PEER ||
          this.queuedMessages >= MAX_QUEUED_MESSAGES_TOTAL
        ) {
          // Congestion does not prove peer misconduct. Honest retransmission bursts
          // may exceed the bounded queue while a certified batch is replaying.
          return;
        }
        const copy = bytes.slice();
        this.queuedByPeer.set(from, peerQueued + 1);
        this.queuedMessages += 1;
        void this.enqueue(async () => {
          const result = await this.receive(from, copy);
          if (!this.derivedRepair && !result.ok && !FATAL_CONTROLLER_ERRORS.has(result.error.code))
            await this.captureRejectedProofs(from, copy);
          return result;
        }, true).then((result) => {
          this.queuedMessages -= 1;
          const remaining = (this.queuedByPeer.get(from) ?? 1) - 1;
          if (remaining === 0) this.queuedByPeer.delete(from);
          else this.queuedByPeer.set(from, remaining);
          if (
            !result.ok &&
            (result.error.code === 'invalid-envelope' ||
              result.error.code === 'invalid-encoding' ||
              result.error.code === 'message-too-large' ||
              result.error.code === 'command-proof-invalid' ||
              result.error.code.endsWith('-signature'))
          )
            this.strikePeer(from);
          return undefined;
        });
      }),
    );
    this.unsubscribers.push(
      this.options.transport.onPeerChange((peer, online) => {
        void this.enqueue(async () => {
          if (this.derivedRepair) return this.pulse();
          this.observeAllRecoveryPresence();
          if (online) this.cancelRecoveryForReturningPeer(peer);
          return this.pulse();
        }, true);
      }),
    );
  }

  private formerHumanPeer(peer: PeerId): boolean {
    return this.historicalHumanPeers.has(peer);
  }

  private rememberHumanActivation(entry: LogEntry): void {
    if (entry.payload.kind !== 'membership') return;
    const parsed = v.safeParse(transferChangeSchema, entry.payload.change);
    if (parsed.success && parsed.output.kind === 'transfer-activate')
      this.historicalHumanPeers.add(parsed.output.statement.destinationGame);
  }

  private refreshHistoricalHumanPeers(): void {
    this.historicalHumanPeers.clear();
    for (const seat of this.context.log.genesis.seats)
      if (seat.kind === 'human') this.historicalHumanPeers.add(seat.publicKey);
    // `entries` came from certified replay or local validated commits. Pending
    // authorizations never enter this set; only activated human controllers do.
    for (const { entry } of this.entries) this.rememberHumanActivation(entry);
  }

  private knownSyncPeer(peer: PeerId): boolean {
    return (
      (this.derivedRepair?.anchor.voters.includes(peer) ??
        this.context.membership.voters.some((voter) => voter.publicKey === peer)) ||
      this.formerHumanPeer(peer)
    );
  }

  private strikePeer(peer: PeerId): void {
    const count = (this.invalidByPeer.get(peer) ?? 0) + 1;
    this.invalidByPeer.set(peer, count);
    if (count >= INVALID_MESSAGE_LIMIT) this.rejectPeer(peer);
  }

  private rejectPeer(peer: PeerId): void {
    if (this.blockedPeers.has(peer)) return;
    this.blockedPeers.add(peer);
    try {
      this.options.transport.disconnect(peer);
    } catch {
      // The local receive path still blocks this peer if transport teardown fails.
    }
  }

  /** Bound repeated work without allowing trade preparation to consume repair capacity. */
  private admitExpensiveRequest(
    peer: PeerId,
    key: string,
    category: 'repair' | 'trade' | 'cheat' | 'historical-cheat' | 'reveal' = 'repair',
  ): boolean {
    const now = this.options.clock.now();
    let budgets = this.expensiveByPeer;
    let limit = EXPENSIVE_REQUESTS_PER_WINDOW;
    switch (category) {
      case 'repair':
        break;
      case 'trade':
        budgets = this.tradeProofWorkByPeer;
        limit = TRADE_PROOF_REQUESTS_PER_WINDOW;
        break;
      case 'reveal':
        budgets = this.revealWorkByPeer;
        limit = REVEAL_REQUESTS_PER_WINDOW;
        break;
      case 'cheat':
        budgets = this.cheatWorkByPeer;
        break;
      case 'historical-cheat':
        budgets = this.historicalCheatWorkByPeer;
        break;
    }
    let budget = budgets.get(peer);
    if (
      !budget ||
      now < budget.startedAt ||
      now - budget.startedAt >= EXPENSIVE_REQUEST_WINDOW_MS
    ) {
      budget = { startedAt: now, seen: new Set() };
      budgets.set(peer, budget);
    }
    if (budget.seen.has(key) || budget.seen.size >= limit) return false;
    budget.seen.add(key);
    return true;
  }

  private receiveTradeProofRequest(from: PeerId, value: SignedTradeProofRequest): Result<void> {
    const body = value.body;
    const finalizerHost = tradeProofHost(
      this.context.log.genesis,
      body.seat,
      this.context.log.authority,
    );
    if (finalizerHost !== from) return success(undefined);
    if (body.headSeq < this.context.log.head.seq) return success(undefined);
    if (body.headSeq > this.context.log.head.seq) return success(undefined);

    let requestId: string;
    let requestBytes: Uint8Array;
    try {
      requestId = tradeProofRequestId(body);
      requestBytes = canonicalEncode(value);
    } catch {
      this.strikePeer(from);
      return failure('trade-proof-request', 'Trade-proof request is malformed');
    }
    const cached = this.tradeProofResponses.get(requestId);
    if (cached && cached.requester === from && sameBytes(cached.requestBytes, requestBytes)) {
      try {
        this.options.transport.send(from, cached.responseBytes.slice());
        return success(undefined);
      } catch {
        return failure('replica-transport', 'Could not resend trade-proof response');
      }
    }

    const verified = verifyTradeProofRequest(value, this.context.log);
    if (!verified.ok) {
      if (
        verified.error.code !== 'trade-proof-stale-head' &&
        verified.error.code !== 'trade-proof-future-head' &&
        verified.error.code !== 'trade-proof-unavailable'
      )
        this.strikePeer(from);
      return success(undefined);
    }
    const request = verified.value;
    const owner = request.body.command.withSeat;
    const ownerHost = tradeProofHost(this.context.log.genesis, owner, this.context.log.authority);
    const key = this.deckKeys.get(owner);
    if (!key || ownerHost !== this.self || !this.options.tradeProof) return success(undefined);

    const seen = this.tradeProofRequestsByFinalizer.get(request.body.seat) ?? new Set<string>();
    if (!seen.has(requestId) && seen.size >= MAX_TRADE_PROOF_REQUESTS_PER_FINALIZER)
      return success(undefined);
    // A trade allows the initial parent plus three fresh-parent attempts. Keep
    // its work budget separate so proof preparation cannot starve log repair.
    if (!this.admitExpensiveRequest(from, requestId, 'trade')) return success(undefined);
    seen.add(requestId);
    this.tradeProofRequestsByFinalizer.set(request.body.seat, seen);

    let produced: Result<readonly IndexedHandProof[]>;
    try {
      produced = this.options.tradeProof(request, detachedContext(this.context).log);
    } catch {
      // Cannot-pay and private-source failures intentionally produce no response.
      return success(undefined);
    }
    if (!produced.ok) return success(undefined);
    let response: SignedTradeProofResponse;
    try {
      response = signTradeProofResponse(request, owner, produced.value, key);
    } catch {
      return success(undefined);
    }
    const checked = verifyTradeProofResponse(response, request, this.context.log);
    if (!checked.ok) return success(undefined);
    const encoded = encodeProtocolMessage({ t: 'TRADE_PROOF_RESPONSE', response });
    if (!encoded.ok) return success(undefined);
    this.tradeProofResponses.set(requestId, {
      requestBytes,
      responseBytes: encoded.value.slice(),
      requester: from,
    });
    while (this.tradeProofResponses.size > MAX_TRADE_PROOF_CACHE) {
      const oldest = this.tradeProofResponses.keys().next().value;
      if (oldest === undefined) break;
      this.tradeProofResponses.delete(oldest);
    }
    try {
      this.options.transport.send(from, encoded.value.slice());
      return success(undefined);
    } catch {
      return failure('replica-transport', 'Could not send trade-proof response');
    }
  }

  private receiveTradeProofResponse(
    from: PeerId,
    response: SignedTradeProofResponse,
  ): Result<void> {
    const pending = this.pendingTradeProofs.get(response.body.requestId);
    if (!pending) return success(undefined);
    const { request, ownerHost } = pending;
    if (
      ownerHost !== from ||
      response.body.seat !== request.body.command.withSeat ||
      request.body.headSeq !== this.context.log.head.seq ||
      request.body.headHash !== entryHash(this.context.log.head)
    )
      return success(undefined);
    const checked = verifyTradeProofResponse(response, request, this.context.log);
    if (!checked.ok) {
      if (checked.error.code !== 'trade-proof-unavailable') this.strikePeer(from);
      return success(undefined);
    }
    this.pendingTradeProofs.delete(response.body.requestId);
    try {
      this.options.onTradeProofResponse?.(checked.value);
    } catch {
      // A coordinator callback has no authority over replicated-log progress.
    }
    return success(undefined);
  }

  private participant(): RecoveryParticipant | null {
    const privateInputs = this.options.recoveryParticipant;
    if (!privateInputs) return null;
    this.recoveryParticipant ??= new RecoveryParticipant({
      ...privateInputs,
      journal: this.options.journal,
      engine: this.options.engine,
      policy: this.options.policy,
      localSeat: this.options.seat,
      signingKey: this.secretKey,
    });
    return this.recoveryParticipant;
  }

  private recoverySender(seat: Seat): PeerId | null {
    const controller = this.context.log.authority?.controllers.find((item) => item.seat === seat);
    if (!controller || controller.status !== 'active') return null;
    return (
      this.context.membership.voters.find((item) => item.seat === controller.hostSeat)?.publicKey ??
      null
    );
  }

  private admitRecoveryPacket(from: PeerId, hash: string, check: boolean): boolean {
    const pending = this.context.log.recovery?.pending;
    if (!pending) return false;
    const authorization = `${pending.seq}/${pending.hash}`;
    const parent = `${authorization}/${this.context.log.head.seq}/${entryHash(this.context.log.head)}`;
    if (this.recoveryAdmissionScope !== authorization) {
      this.recoveryAdmissionScope = authorization;
      this.recoveryReleasesByPeer.clear();
    }
    if (this.recoveryCheckScope !== parent) {
      this.recoveryCheckScope = parent;
      this.recoveryChecksByPeer.clear();
    }
    const byPeer = check ? this.recoveryChecksByPeer : this.recoveryReleasesByPeer;
    const limit = check ? MAX_RECOVERY_CHECKS_PER_PEER : MAX_RECOVERY_RELEASES_PER_PEER;
    let seen = byPeer.get(from);
    if (!seen) {
      seen = new Set();
      byPeer.set(from, seen);
    }
    if (seen.has(hash) || seen.size >= limit) return false;
    seen.add(hash);
    return true;
  }

  private async receiveRecoveryRelease(
    from: PeerId,
    release: RecoveryRelease,
    digest: string,
  ): Promise<Result<void>> {
    const pending = this.context.log.recovery?.pending;
    if (
      digest !== this.context.membership.genesisDigest ||
      !pending ||
      release.body.authorization.seq !== pending.seq ||
      release.body.authorization.hash !== pending.hash ||
      release.body.genesisDigest !== digest ||
      this.recoverySender(release.body.holderSeat) !== from ||
      this.recoverySender(release.body.recipientSeat) !== this.self
    )
      return success(undefined);
    const participant = this.participant();
    if (!participant) return success(undefined);
    const hash = toHex(hashValue(release));
    if (!this.admitRecoveryPacket(from, hash, false)) return success(undefined);
    const remembered = participant.rememberRelease(this.context.log, release);
    if (!remembered.ok) {
      this.strikePeer(from);
      return failure('recovery-release-invalid', 'Authenticated recovery share is invalid', {
        cause: remembered.error.code,
      });
    }
    if (remembered.value) this.preparedRecovery = null;
    return remembered.value ? this.offerAvailableInput() : success(undefined);
  }

  private async receiveRecoveryCheck(
    from: PeerId,
    check: SignedRecoveryCheck,
    digest: string,
  ): Promise<Result<void>> {
    if (
      digest !== this.context.membership.genesisDigest ||
      !this.context.log.recovery?.pending ||
      this.recoverySender(check.check.seat) !== from
    )
      return success(undefined);
    const parent = { seq: this.context.log.head.seq, hash: entryHash(this.context.log.head) };
    const pending = this.context.log.recovery.pending;
    if (
      check.statement.parent.seq !== parent.seq ||
      check.statement.parent.hash !== parent.hash ||
      check.statement.authorization.seq !== pending.seq ||
      check.statement.authorization.hash !== pending.hash ||
      check.statement.genesisDigest !== digest
    )
      return success(undefined);
    const participant = this.participant();
    if (!participant) return success(undefined);
    const hash = toHex(hashValue(check));
    if (!this.admitRecoveryPacket(from, hash, true)) return success(undefined);
    const remembered = participant.rememberCheck(this.context.log, check);
    if (!remembered.ok) {
      this.strikePeer(from);
      return failure('recovery-check-invalid', 'Authenticated recovery check is invalid', {
        cause: remembered.error.code,
      });
    }
    return remembered.value ? this.offerAvailableInput() : success(undefined);
  }

  private async receiveRecoveryVoidCheck(
    from: PeerId,
    check: SignedRecoveryVoidCheck,
    digest: string,
  ): Promise<Result<void>> {
    if (
      digest !== this.context.membership.genesisDigest ||
      !this.context.log.recovery?.pending ||
      this.recoverySender(check.check.seat) !== from
    )
      return success(undefined);
    const parent = { seq: this.context.log.head.seq, hash: entryHash(this.context.log.head) };
    const pending = this.context.log.recovery.pending;
    if (
      check.statement.parent.seq !== parent.seq ||
      check.statement.parent.hash !== parent.hash ||
      check.statement.authorization.seq !== pending.seq ||
      check.statement.authorization.hash !== pending.hash ||
      check.statement.genesisDigest !== digest
    )
      return success(undefined);
    const participant = this.participant();
    if (!participant) return success(undefined);
    const hash = toHex(hashValue(check));
    if (!this.admitRecoveryPacket(from, hash, true)) return success(undefined);
    const remembered = participant.rememberVoidCheck(this.context.log, check);
    if (!remembered.ok) {
      this.strikePeer(from);
      return failure(
        'recovery-void-check-invalid',
        'Authenticated recovery void check is invalid',
        {
          cause: remembered.error.code,
        },
      );
    }
    return remembered.value ? this.offerAvailableInput() : success(undefined);
  }

  private revealCoordinator(): MasterRevealCoordinator | null {
    if (!this.options.masterReveal || this.context.log.state.result === null) return null;
    this.masterRevealCoordinator ??= new MasterRevealCoordinator({
      ...this.options.masterReveal,
      journal: this.options.journal,
      engine: this.options.engine,
      policy: this.options.policy,
      localSeat: this.options.seat,
      signingKey: this.secretKey,
    });
    return this.masterRevealCoordinator;
  }

  private rememberMasterReveal(reveal: {
    packet: SignedMasterReveal;
    verdict: MasterRevealVerdict;
  }): void {
    const seat = reveal.packet.body.originalSeat;
    if (this.acceptedMasterSeats.has(seat)) return;
    try {
      this.options.onMasterReveal?.({
        packet: structuredReveal(reveal.packet),
        verdict: reveal.verdict,
      });
      this.acceptedMasterSeats.add(seat);
    } catch {
      this.status({ kind: 'rejected', code: 'master-reveal-observer' });
    }
  }

  private async restoreMasterReveals(coordinator: MasterRevealCoordinator): Promise<Result<void>> {
    if (!this.masterRevealsRestored) {
      const restored = await coordinator.restoreAccepted();
      if (this.disposed) return failure('replica-disposed', 'Replica closed during reveal restore');
      if (!restored.ok) return restored;
      this.masterRevealsRestored = true;
      for (const { code } of coordinator.quarantinedAccepted())
        this.status({ kind: 'rejected', code });
    }
    for (const reveal of coordinator.reveals()) this.rememberMasterReveal(reveal);
    return success(undefined);
  }

  private async receiveMasterReveal(
    from: PeerId,
    packet: SignedMasterReveal,
  ): Promise<Result<void>> {
    if (
      !this.context.log.state.result ||
      packet.body.genesisDigest !== this.context.membership.genesisDigest ||
      this.acceptedMasterSeats.has(packet.body.originalSeat)
    )
      return success(undefined);
    if (!this.context.membership.voters.some((voter) => voter.publicKey === from))
      return failure('master-reveal-relay', 'Reveal relay is not a current voter');
    const coordinator = this.revealCoordinator();
    if (!coordinator) return success(undefined);
    const hash = toHex(hashValue(packet));
    if (
      this.rejectedMasterReveals.has(hash) ||
      !this.admitExpensiveRequest(
        from,
        `master-reveal/${packet.body.originalSeat}/${hash}`,
        'reveal',
      )
    )
      return success(undefined);
    const restored = await this.restoreMasterReveals(coordinator);
    if (!restored.ok) return restored;
    if (this.acceptedMasterSeats.has(packet.body.originalSeat)) return success(undefined);
    const checked = await coordinator.receive(packet);
    if (this.disposed) return failure('replica-disposed', 'Replica closed during master reveal');
    if (!checked.ok) {
      if (
        [
          'master-reveal-publisher',
          'master-reveal-signature',
          'master-reveal-result',
          'master-reveal-f0',
          'master-reveal-conflict',
        ].includes(checked.error.code)
      ) {
        rememberRejection(this.rejectedMasterReveals, hash);
        if (checked.error.code !== 'master-reveal-signature') this.strikePeer(from);
      }
      return checked;
    }
    this.rememberMasterReveal(checked.value);
    return success(undefined);
  }

  private async prepareMasterReveals(retransmit: boolean): Promise<Result<void>> {
    if (this.context.log.recovery?.void) return success(undefined);
    const coordinator = this.revealCoordinator();
    if (!coordinator) return success(undefined);
    const restored = await this.restoreMasterReveals(coordinator);
    if (!restored.ok) {
      this.status({ kind: 'rejected', code: restored.error.code });
      return success(undefined);
    }
    const headHash = entryHash(this.context.log.head);
    const eligible = await coordinator.eligibleSeats();
    if (this.disposed) return failure('replica-disposed', 'Replica closed during master reveal');
    if (!eligible.ok) {
      this.status({ kind: 'rejected', code: eligible.error.code });
      return success(undefined);
    }
    const metadata = await coordinator.metadata();
    if (this.disposed) return failure('replica-disposed', 'Replica closed during master reveal');
    if (!metadata.ok || metadata.value.head.hash !== headHash) {
      this.status({
        kind: 'rejected',
        code: metadata.ok ? 'master-reveal-stale' : metadata.error.code,
      });
      return success(undefined);
    }
    for (const seat of eligible.value) {
      const saved = this.localMasterReveals.get(seat);
      if (saved?.headHash === headHash) {
        this.rememberMasterReveal(saved);
        if (retransmit) {
          const sent = this.broadcast({ t: 'MASTER_REVEAL', reveal: saved.packet });
          if (!sent.ok) this.status({ kind: 'rejected', code: sent.error.code });
        }
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- Keep secret publication serialized with durable journal operations.
      const prepared = await coordinator.prepare(seat);
      if (this.disposed)
        return failure('replica-disposed', 'Replica closed during master preparation');
      if (!prepared.ok) {
        // One unavailable master must not suppress the other hosted seats' reveals.
        this.status({ kind: 'rejected', code: prepared.error.code });
        continue;
      }
      if (entryHash(this.context.log.head) !== headHash) return success(undefined);
      this.localMasterReveals.set(seat, { headHash, ...prepared.value });
      this.rememberMasterReveal(prepared.value);
      const sent = this.broadcast({ t: 'MASTER_REVEAL', reveal: prepared.value.packet });
      if (!sent.ok) this.status({ kind: 'rejected', code: sent.error.code });
    }
    if (retransmit)
      for (const reveal of coordinator.reveals()) {
        const sent = this.broadcast({ t: 'MASTER_REVEAL', reveal: reveal.packet });
        if (!sent.ok) this.status({ kind: 'rejected', code: sent.error.code });
      }
    return success(undefined);
  }

  private async receive(from: PeerId, bytes: Uint8Array): Promise<Result<void>> {
    if (this.blockedPeers.has(from)) return success(undefined);
    const decoded = decodeProtocolMessage(bytes);
    if (!decoded.ok) return decoded;
    const message = decoded.value;
    if (this.derivedRepair) return this.receiveDuringRepair(from, message);
    const voter = this.context.membership.voters.some((item) => item.publicKey === from);
    if (!voter && !this.formerHumanPeer(from))
      return failure('replica-peer', 'Sender is not a certified voter or historical human');
    if (!voter && message.t !== 'SYNC_REQ')
      return failure('replica-peer', 'Former voters may only request certified history');
    switch (message.t) {
      case 'MASTER_REVEAL':
        return this.receiveMasterReveal(from, message.reveal);
      case 'RECOVERY_RELEASE':
        return this.receiveRecoveryRelease(from, message.release, message.genesisDigest);
      case 'RECOVERY_CHECK':
        return this.receiveRecoveryCheck(from, message.check, message.genesisDigest);
      case 'RECOVERY_VOID_CHECK':
        return this.receiveRecoveryVoidCheck(from, message.check, message.genesisDigest);
      case 'SYS_CONTRIB': {
        if (message.genesisDigest !== this.context.membership.genesisDigest)
          return failure('replica-beacon-genesis', 'Beacon contribution belongs to another game');
        if (this.beaconFrozen()) return success(undefined);
        const refreshed = this.beaconInbox.refresh(
          this.context.log.crypto,
          this.context.log.genesis,
          this.context.log.authority,
        );
        if (!refreshed.ok) return refreshed;
        const remembered = this.beaconInbox.remember(message.contribution);
        if (!remembered.ok) return remembered;
        return remembered.value ? this.offerAvailableInput() : success(undefined);
      }
      case 'DECK_CONTRIB': {
        if (message.genesisDigest !== this.context.membership.genesisDigest)
          return failure('replica-deck-genesis', 'Deck contribution belongs to another game');
        if (this.deckFrozen()) return success(undefined);
        const refreshed = this.deckInbox.refresh(
          this.context.log.crypto,
          this.context.log.genesis,
          this.context.log.authority,
        );
        if (!refreshed.ok) return refreshed;
        // Old operation retries cannot alter the certified request or spend proof work.
        if (message.contribution.operationId !== this.deckInbox.operationId())
          return success(undefined);
        const hash = toHex(hashValue(message.contribution));
        if (this.rejectedDeckContributions.has(hash)) return success(undefined);
        const remembered = this.deckInbox.remember(message.contribution);
        if (!remembered.ok) {
          rememberRejection(this.rejectedDeckContributions, hash);
          this.strikePeer(from);
          return failure('deck-proof-invalid', 'Deck unlock prefix is invalid');
        }
        return remembered.value ? this.offerAvailableInput() : success(undefined);
      }
      case 'COUNT_CONTRIB': {
        if (message.genesisDigest !== this.context.membership.genesisDigest)
          return failure('replica-count-genesis', 'Count contribution belongs to another game');
        if (this.countFrozen()) return success(undefined);
        const refreshed = this.countInbox.refresh(
          this.context.log.crypto,
          this.context.log.genesis,
          this.context.log.authority,
        );
        if (!refreshed.ok) return refreshed;
        if (message.contribution.body.operationId !== this.countInbox.operationId())
          return success(undefined);
        const hash = toHex(hashValue(message.contribution));
        if (this.rejectedCountContributions.has(hash)) return success(undefined);
        const remembered = this.countInbox.remember(message.contribution);
        if (!remembered.ok) {
          rememberRejection(this.rejectedCountContributions, hash);
          this.strikePeer(from);
          return failure('count-proof-invalid', 'Signed count contribution is invalid');
        }
        return remembered.value ? this.offerAvailableInput() : success(undefined);
      }
      case 'STEAL_CONTRIB':
      case 'STEAL_RESPONSE': {
        if (message.genesisDigest !== this.context.membership.genesisDigest)
          return failure('replica-steal-genesis', 'Steal delivery belongs to another game');
        if (this.stealFrozen()) return success(undefined);
        const refreshed = this.stealInbox.refresh(
          this.context.log.crypto,
          this.context.log.genesis,
          this.context.log.authority,
        );
        if (!refreshed.ok) return refreshed;
        const hash = toHex(hashValue(message));
        if (this.rejectedStealMessages.has(hash)) return success(undefined);
        const remembered =
          message.t === 'STEAL_CONTRIB'
            ? this.stealInbox.rememberContribution(message.contribution)
            : this.stealInbox.rememberResponse(message.response);
        if (!remembered.ok) {
          rememberRejection(this.rejectedStealMessages, hash);
          this.strikePeer(from);
          return failure('steal-proof-invalid', 'Signed steal delivery is invalid');
        }
        return remembered.value ? this.offerAvailableInput() : success(undefined);
      }
      case 'TRADE_PROOF_REQUEST':
        return this.receiveTradeProofRequest(from, message.request);
      case 'TRADE_PROOF_RESPONSE':
        return this.receiveTradeProofResponse(from, message.response);
      case 'MEMBERSHIP_SUBMIT': {
        const change = message.change;
        // Presence notices are derived at the current proposer from authenticated
        // links; they are not arbitrary network-submitted membership intents.
        if (change.kind === 'seat-offline' || change.kind === 'seat-online')
          return success(undefined);
        const digest =
          change.kind === 'transfer-cancel' ? change.genesisDigest : change.statement.genesisDigest;
        const parent =
          change.kind === 'transfer-cancel'
            ? change.parent
            : change.kind === 'transfer-authorize'
              ? null
              : change.statement.parent;
        if (
          digest !== this.context.membership.genesisDigest ||
          (parent !== null &&
            (parent.seq !== this.context.log.head.seq ||
              parent.hash !== entryHash(this.context.log.head))) ||
          (change.kind !== 'transfer-cancel' &&
            change.kind !== 'recovery-void' &&
            change.statement.nextEpoch !== this.context.membership.epoch + 1)
        )
          return success(undefined);
        const hash = toHex(hashValue(change));
        if (this.membershipIntent) return success(undefined);
        if (!this.admitExpensiveRequest(from, `membership/${hash}`)) return success(undefined);
        const checked = this.deriveCandidate(
          { height: this.context.log.head.seq + 1, round: 1 },
          { kind: 'membership', change },
        );
        if (!checked.ok)
          return failure('recovery-proof-invalid', 'Membership change failed at certified parent', {
            cause: checked.error.code,
          });
        if (change.kind === 'recovery-authorize') {
          const preview = this.previewRecoveryAuthorization(change);
          if (!preview.ok) return preview;
          if (
            this.recoveryCandidateForApproval &&
            this.recoveryCandidateForApproval.preview.statementHash !==
              preview.value.preview.statementHash
          )
            return success(undefined);
          this.rememberRecoveryCandidate(preview.value);
          if (!this.hasRecoveryApproval(preview.value.preview)) {
            this.pendingRecoverySubmit ??= {
              hash,
              change,
              parentHash: entryHash(this.context.log.head),
            };
            return success(undefined);
          }
        }
        this.membershipIntent = { hash, change, parentHash: entryHash(this.context.log.head) };
        return this.offerAvailableInput();
      }
      case 'SUBMIT': {
        const hash = commandHash(message.cmd);
        if (this.rejectedCommands.has(hash)) return success(undefined);
        if (this.commands.some((command) => commandHash(command) === hash))
          return success(undefined);
        const command = validateSignedCommand(message.cmd, this.context.log);
        if (!command.ok) {
          if (command.error.code === 'entry-verification-failed')
            rememberRejection(this.rejectedCommands, hash);
          return command.error.code === 'entry-verification-failed'
            ? failure('command-proof-invalid', 'Signed command validation failed')
            : command;
        }
        // Once this seat's queue is full, even valid proof variants must not force
        // more verification work. Stale honest retries fail the cheap gates above.
        if (!this.hasCommandCapacity(command.value.body.seat)) return success(undefined);
        // This signed preview is never transmitted or retained. It runs the same
        // engine, proof, invariant and pending-request checks as a real entry.
        const checked = this.deriveCandidate(
          { height: this.context.log.head.seq + 1, round: 1 },
          { kind: 'command', signed: command.value },
        );
        if (!checked.ok) {
          rememberRejection(this.rejectedCommands, hash);
          return failure('command-proof-invalid', 'Command proof failed at its certified parent', {
            cause: checked.error.code,
          });
        }
        if (!this.rememberCommand(command.value)) return success(undefined);
        return this.offerAvailableInput();
      }
      case 'PROPOSAL': {
        const entry = message.proposal.body.entry;
        if (
          entry.payload.kind === 'control' &&
          objectiveEvidenceSeq(entry.payload) < this.context.log.head.seq + 1
        ) {
          const authenticated = authenticateSignedProposal(message.proposal, this.context);
          if (!authenticated.ok) return authenticated;
          if (
            !this.admitExpensiveRequest(
              from,
              `historical-proposal/${toHex(hashValue(message.proposal))}`,
            )
          )
            return success(undefined);
        }
        if (
          entry.payload.kind === 'cheat-proof' &&
          entry.payload.claim.evidence.at.seq < this.context.log.head.seq
        ) {
          const authenticated = authenticateSignedProposal(message.proposal, this.context);
          if (!authenticated.ok) return authenticated;
          if (
            !this.admitExpensiveRequest(
              from,
              `historical-cheat/${toHex(hashValue(message.proposal))}`,
              'historical-cheat',
            )
          )
            return success(undefined);
        }
        let received = await this.activeController().dispatch({
          kind: 'proposal',
          proposal: message.proposal,
        });
        if (!received.ok) {
          await this.captureRejectedProofs(from, bytes);
          if (
            received.error.code === 'recovery-approval-required' &&
            entry.payload.kind === 'membership'
          ) {
            const preview = this.previewRecoveryAuthorization(entry.payload.change);
            if (!preview.ok) return preview;
            if (
              this.recoveryCandidateForApproval &&
              this.recoveryCandidateForApproval.preview.statementHash !==
                preview.value.preview.statementHash
            )
              return success(undefined);
            this.rememberRecoveryCandidate(preview.value);
            this.pendingRecoveryProposal = copyCanonical(message.proposal);
            return success(undefined);
          }
          if (
            received.error.code === 'turn-timeout-early' &&
            entry.payload.kind === 'system' &&
            entry.payload.input.type === 'TIMEOUT'
          ) {
            const pending = this.timedVoteRetry;
            if (pending?.parentHash === entryHash(this.context.log.head))
              pending.proposal = copyCanonical(message.proposal);
            return success(undefined);
          }
          if (
            received.error.details?.proposalEntryRejected === true &&
            !FATAL_CONTROLLER_ERRORS.has(received.error.code) &&
            entry.seq === this.context.log.head.seq + 1 &&
            entry.prevHash === entryHash(this.context.log.head)
          ) {
            // A local fault can reject an honest value. Count each distinct
            // failure once so retransmissions cannot isolate us before repair.
            if (rememberRejection(this.rejectedProposals, toHex(hashValue(message.proposal))))
              this.strikePeer(from);
            received = failure('proposal-proof-invalid', 'Proposal entry verification failed', {
              cause: received.error.code,
            });
          }
          if (
            entry.payload.kind !== 'command' &&
            (this.context.log.genesis.security !== 'verified' ||
              (entry.payload.kind !== 'system' && entry.payload.kind !== 'crypto'))
          )
            return received;
          try {
            const offender = proposerFor(
              entry.seq,
              entry.term,
              this.context.membership,
              this.context.excludedProposers,
            ).seat;
            if (!this.admitExpensiveRequest(from, `proposal/${toHex(hashValue(message.proposal))}`))
              return received;
            const accused = await this.rememberAccusation({
              kind: 'control',
              action: 'exclude-proposer',
              offender,
              evidence: {
                kind: entry.payload.kind === 'command' ? 'invalid-command' : 'invalid-proof',
                proposal: message.proposal,
              },
            });
            if (accused.ok) return success(undefined);
          } catch {
            // An invalid proposer index is not accusation evidence.
          }
        }
        if (received.ok && entry.payload.kind === 'membership') {
          const preview = this.previewRecoveryAuthorization(entry.payload.change);
          if (preview.ok) this.rememberRecoveryCandidate(preview.value);
        }
        return received;
      }
      case 'VOTE':
        return this.activeController().dispatch({ kind: 'vote', vote: message.vote });
      case 'COMMIT':
        return this.acceptCertified(message.certified, from);
      case 'ACCUSE': {
        const authenticated = authenticateAccusationSignatures(message.control, this.context);
        if (!authenticated.ok) return authenticated;
        if (!this.admitExpensiveRequest(from, `accuse/${toHex(hashValue(message.control))}`))
          return success(undefined);
        return this.rememberAccusation(message.control);
      }
      case 'CHEAT_CLAIM': {
        if (
          message.claim.evidence.at.seq === this.context.log.head.seq &&
          !authenticatedCheatSigner(
            message.claim,
            this.context.log.genesis,
            this.context.log.authority,
            this.context.log.crypto?.epoch,
          )
        )
          return failure('cheat-signature', 'Cheat evidence has no authenticated genesis signer');
        if (message.claim.evidence.at.seq > this.context.log.head.seq)
          return failure('cheat-future', 'Cheat evidence parent is not certified');
        const id = cheatCandidateId(message.claim);
        if (this.cheatCandidates.has(id)) return success(undefined);
        if (
          this.context.log.crypto?.cheats.some(
            (finding) =>
              finding.seat === message.claim.seat && finding.kind === message.claim.evidence.kind,
          )
        )
          return success(undefined);
        if (!this.admitExpensiveRequest(from, `cheat/${cheatClaimHash(message.claim)}`, 'cheat'))
          return success(undefined);
        return this.rememberCheatClaim(message.claim, true);
      }
      case 'PROPOSAL_REQ':
        return this.sendRequestedProposal(from, message);
      case 'SYNC_REQ':
        if (message.genesisDigest !== this.context.membership.genesisDigest)
          return failure('replica-sync', 'Sync request belongs to another game');
        if (!this.admitExpensiveRequest(from, `sync/${message.fromSeq}/${message.toSeq ?? 'end'}`))
          return success(undefined);
        return this.sendCertifiedBatch(from, message.fromSeq, message.toSeq);
      case 'SYNC_RES':
        if (message.genesisDigest !== this.context.membership.genesisDigest)
          return failure('replica-sync', 'Sync response belongs to another game');
        if (message.more && message.entries.length === 0)
          return failure(
            'replica-sync',
            'A continued sync response must advance the certified prefix',
          );
        if (message.more && (message.entries.at(-1)?.entry.seq ?? 0) <= this.context.log.head.seq)
          return failure('replica-sync', 'Continued sync response made no certified progress');
        return this.acceptCertifiedBatch(message.entries, message.more, from);
      case 'SNAPSHOT_REQ':
        if (!this.admitExpensiveRequest(from, `snapshot/${message.atSeq}`))
          return success(undefined);
        return this.sendReplaySnapshot(from, message);
      case 'SNAPSHOT_RES': {
        if (message.genesisDigest !== this.context.membership.genesisDigest)
          return failure('replica-snapshot', 'Snapshot belongs to another game');
        if (message.atSeq !== this.context.log.head.seq) return success(undefined);
        const state = this.activeController().snapshot();
        if (!state.ok) return state;
        if (
          state.value.haltKind === 'certified-validation' &&
          !this.admitExpensiveRequest(
            from,
            `snapshot-response/${toHex(hashValue(message.snapshot))}`,
          )
        )
          return success(undefined);
        return state.value.haltKind === 'certified-validation'
          ? this.repairNow(message.snapshot)
          : success(undefined);
      }
      case 'HEARTBEAT':
        return this.receiveHeartbeat(from, message);
      case 'PING':
        return this.send(from, { t: 'PONG', n: message.n });
      case 'PONG':
        return success(undefined);
    }
    return failure('replica-message', 'Unknown protocol message');
  }

  private async acceptCertified(certified: CertifiedEntry, from?: PeerId): Promise<Result<void>> {
    const height = this.context.log.head.seq + 1;
    if (certified.entry.seq < height) {
      if (certified.entry.seq < 1)
        return failure('replica-certificate', 'Genesis is not a certified next entry');
      const local = this.entries[certified.entry.seq - 1];
      // A repeat of our committed logical value has no effect or new authority.
      // Only a conflicting value needs historical certificate verification.
      if (local && entryHash(local.entry) === entryHash(certified.entry)) return success(undefined);
      const envelope = this.precheckCertifiedEntrySignature(certified);
      if (!envelope.ok) return envelope;
      if (
        from &&
        !this.admitExpensiveRequest(
          from,
          `old-commit/${certified.entry.seq}/${entryHash(certified.entry)}`,
        )
      )
        return success(undefined);
      const previous = replayCertifiedPrefix(
        this.genesisEntry,
        this.entries.slice(0, certified.entry.seq - 1),
        this.options.engine,
        this.options.policy,
      );
      if (!previous.ok) return previous;
      const checked = validateCertifiedEntry(certified, previous.value.context);
      if (!checked.ok) {
        const votes = verifyCertificate(certified.certificate, previous.value.context.membership, {
          seq: certified.entry.seq,
          term: certified.entry.term,
          phase: 'precommit',
          valueHash: entryHash(certified.entry),
        });
        return votes.ok ? this.haltForHistoricalConflict() : checked;
      }
      if (local && entryHash(local.entry) === checked.value.hash) return success(undefined);
      const halted = await this.activeController().dispatch({
        kind: 'terminal-halt',
        reason: 'A verified certificate conflicts with local history',
      });
      return halted.ok
        ? failure('replica-conflict', 'A verified certificate conflicts with local history')
        : halted;
    }
    if (certified.entry.seq > height) {
      const envelope = this.precheckCertifiedEntrySignature(certified);
      if (!envelope.ok) return envelope;
      if (
        from &&
        !this.admitExpensiveRequest(
          from,
          `future-commit/${certified.entry.seq}/${entryHash(certified.entry)}`,
        )
      )
        return success(undefined);
      return this.requestSync(height);
    }
    const accepted = await this.activeController().dispatch({ kind: 'commit', certified });
    if (!accepted.ok && accepted.error.code === 'consensus-context' && this.enterDerivedRepair())
      this.retainHeldCommit(certified);
    return accepted;
  }

  /** A cheap gate only; the certified parent decides the authoritative voter set. */
  private precheckCertifiedEntrySignature(certified: CertifiedEntry): Result<void> {
    try {
      const entry = certified.entry;
      if (!verifyObject('entry', entryBody(entry), entry.sig, parsePeerId(entry.sequencer)))
        return failure('replica-certificate', 'Certified entry signature is invalid');
      // A matching epoch has the same certified voter set, so reject malformed
      // same-epoch votes cheaply. Cross-epoch votes wait for parent replay.
      if (
        certified.certificate.every((vote) => vote.body.epoch === this.context.membership.epoch)
      ) {
        const votes = verifyCertificate(certified.certificate, this.context.membership, {
          seq: entry.seq,
          term: entry.term,
          phase: 'precommit',
          valueHash: entryHash(entry),
        });
        if (!votes.ok) return votes;
      }
      return success(undefined);
    } catch {
      return failure('replica-certificate', 'Certified envelope is malformed');
    }
  }

  private async acceptCertifiedBatch(
    entries: readonly CertifiedEntry[],
    more: boolean,
    from: PeerId,
    index = 0,
    headBefore = this.context.log.head.seq,
  ): Promise<Result<void>> {
    const certified = entries[index];
    if (certified) {
      const accepted = await this.acceptCertified(certified, from);
      if (this.disposed) return accepted;
      return accepted.ok
        ? this.acceptCertifiedBatch(entries, more, from, index + 1, headBefore)
        : accepted;
    }
    if (more && this.context.log.head.seq <= headBefore)
      return failure('replica-sync', 'Continued sync response made no certified progress');
    return more ? this.requestSync(this.context.log.head.seq + 1) : success(undefined);
  }

  private async offerAvailableInput(retransmit = false): Promise<Result<void>> {
    if (this.context.log.recovery?.void) return success(undefined);
    const state = this.activeController().snapshot();
    if (!state.ok) return state;
    if (state.value.halted) return success(undefined);
    const revealsPrepared = await this.prepareMasterReveals(retransmit);
    if (!revealsPrepared.ok) return revealsPrepared;
    const recoveryPrepared = await this.prepareRecovery(retransmit);
    if (!recoveryPrepared.ok) return recoveryPrepared;
    const deckPrepared = await this.prepareDeck(retransmit);
    if (!deckPrepared.ok) return deckPrepared;
    const countPrepared = await this.prepareCount(retransmit);
    if (!countPrepared.ok) return countPrepared;
    const stealPrepared = await this.prepareSteal(retransmit);
    if (!stealPrepared.ok) return stealPrepared;
    const prepared = await this.prepareBeacon(retransmit);
    if (!prepared.ok) return prepared;
    const available =
      this.accusation !== null ||
      this.cheatCandidates.size > 0 ||
      this.membershipIntent !== null ||
      this.recoveryCandidate() !== null ||
      this.presenceCandidate() !== null ||
      (!this.context.log.recovery?.pending &&
        ((!this.cryptoPending() && this.commands.length > 0) ||
          this.deckSetupCandidate() !== null ||
          this.deckDrawCandidate() !== null ||
          this.countCandidate() !== null ||
          this.stealCandidate() !== null ||
          this.beaconCandidate() !== null ||
          this.systemCandidate() !== null)) ||
      state.value.valid !== null;
    if (!available) return success(undefined);
    if (!state.value.inputKnown) {
      const marked = await this.activeController().dispatch({ kind: 'input-available' });
      if (!marked.ok) return marked;
    }
    return this.maybePropose();
  }

  private async maybePropose(): Promise<Result<void>> {
    if (this.context.log.recovery?.void) return success(undefined);
    const snapshot = this.activeController().snapshot();
    if (!snapshot.ok) return snapshot;
    const state = snapshot.value;
    if (state.decision || state.halted || state.step !== 'propose') return success(undefined);
    const proposer = proposerFor(
      state.height,
      state.round,
      this.context.membership,
      this.context.excludedProposers,
    );
    if (proposer.seat !== this.options.seat) return success(undefined);
    if (
      state.proposals.some(
        (proposal) =>
          proposal.body.entry.term === state.round && proposal.body.entry.sequencer === this.self,
      )
    )
      return success(undefined);
    const candidate = state.valid ? undefined : this.candidate(state);
    if (!state.valid && !candidate) return success(undefined);
    return this.activeController().dispatch(
      candidate ? { kind: 'propose', candidate } : { kind: 'propose' },
    );
  }

  private recoveryCandidate(): RecoveryChange | null {
    if (!this.context.log.recovery?.pending || !this.recoveryParticipant) return null;
    const candidate = this.recoveryParticipant.candidate(this.context.log);
    if (!candidate.ok) {
      this.status({ kind: 'rejected', code: candidate.error.code });
      return null;
    }
    return candidate.value;
  }

  private presenceCandidate(): MembershipChange | null {
    if (this.context.log.genesis.security !== 'verified') return null;
    const policy = this.context.log.genesis.takeover;
    if (policy.afterSeconds === 'never' || this.context.log.recovery?.pending) return null;
    const offline = this.context.log.recovery?.offline ?? [];
    const ownMarker = offline.find((item) => item.seat === this.options.seat);
    if (ownMarker) {
      const statement = seatOnlineStatement(this.context.log, this.options.seat);
      if (statement.ok)
        return {
          kind: 'seat-online',
          proof: {
            statement: statement.value,
            sig: signObject(SEAT_ONLINE_DOMAIN, statement.value, this.secretKey),
          },
        };
    }
    for (const voter of this.context.membership.voters) {
      if (offline.some((item) => item.seat === voter.seat)) continue;
      const observed = this.observeRecoveryPresence(voter.seat);
      if (observed.ok && this.checkRecoveryPresence(observed.value, 15_000).ok)
        return { kind: 'seat-offline', seat: voter.seat };
    }
    return null;
  }

  private async prepareRecovery(retransmit: boolean): Promise<Result<void>> {
    const participant = this.context.log.recovery?.pending ? this.participant() : null;
    if (!participant) {
      this.preparedRecovery = null;
      this.sentRecoveryPackets.clear();
      return success(undefined);
    }
    const headHash = entryHash(this.context.log.head);
    if (this.preparedRecovery?.headHash !== headHash) {
      const prepared = await participant.prepare(detachedContext(this.context).log);
      if (this.disposed)
        return failure('replica-disposed', 'Replica closed during recovery preparation');
      if (!prepared.ok) return prepared;
      if (entryHash(this.context.log.head) !== headHash)
        return failure(
          'recovery-participant-stale',
          'Certified parent advanced during preparation',
        );
      this.preparedRecovery = { headHash, packets: prepared.value };
      this.recoverySendCursor = 0;
      this.sentRecoveryPackets.clear();
    }
    const packets = this.preparedRecovery.packets;
    const releases = packets.releases;
    let sentCount = 0;
    for (
      let scanned = 0;
      scanned < releases.length && sentCount < MAX_RECOVERY_PACKETS_PER_PULSE;
      scanned += 1
    ) {
      const release = releases[this.recoverySendCursor % releases.length];
      this.recoverySendCursor += 1;
      if (!release) continue;
      const recipient = this.recoverySender(release.body.recipientSeat);
      if (!recipient || recipient === this.self) continue;
      const hash = toHex(hashValue(release));
      if (!retransmit && this.sentRecoveryPackets.has(hash)) continue;
      const sent = this.send(recipient, {
        t: 'RECOVERY_RELEASE',
        genesisDigest: this.context.membership.genesisDigest,
        release,
      });
      if (sent.ok) {
        this.sentRecoveryPackets.add(hash);
        sentCount += 1;
      } else this.status({ kind: 'rejected', code: sent.error.code });
    }
    if (packets.check) {
      const hash = toHex(hashValue(packets.check));
      if (retransmit || !this.sentRecoveryPackets.has(hash)) {
        const sent = this.broadcast({
          t: 'RECOVERY_CHECK',
          genesisDigest: this.context.membership.genesisDigest,
          check: packets.check,
        });
        if (sent.ok) this.sentRecoveryPackets.add(hash);
        else this.status({ kind: 'rejected', code: sent.error.code });
      }
    }
    if (packets.voidCheck) {
      const hash = toHex(hashValue(packets.voidCheck));
      if (retransmit || !this.sentRecoveryPackets.has(hash)) {
        const sent = this.broadcast({
          t: 'RECOVERY_VOID_CHECK',
          genesisDigest: this.context.membership.genesisDigest,
          check: packets.voidCheck,
        });
        if (sent.ok) this.sentRecoveryPackets.add(hash);
        else this.status({ kind: 'rejected', code: sent.error.code });
      }
    }
    return success(undefined);
  }

  private candidate(state: ConsensusState): LogEntry | null {
    if (this.context.log.recovery?.void) return null;
    if (this.accusation)
      return signEntry(
        {
          seq: state.height,
          term: state.round,
          prevHash: entryHash(this.context.log.head),
          payload: this.accusation,
          stateHash: this.context.log.head.stateHash,
          sequencer: this.self,
        },
        this.secretKey,
      );
    const firstCheat = [...this.cheatCandidates.entries()].toSorted(([a], [b]) =>
      a.localeCompare(b),
    )[0];
    if (firstCheat)
      return signEntry(
        {
          seq: state.height,
          term: state.round,
          prevHash: entryHash(this.context.log.head),
          payload: { kind: 'cheat-proof', claim: firstCheat[1] },
          stateHash: this.context.log.head.stateHash,
          sequencer: this.self,
        },
        this.secretKey,
      );
    const activation = this.recoveryCandidate();
    if (activation) return this.entryCandidate(state, { kind: 'membership', change: activation });
    if (this.membershipIntent) {
      const candidate = this.entryCandidate(state, {
        kind: 'membership',
        change: this.membershipIntent.change,
      });
      if (candidate) return candidate;
    }
    const presence = this.presenceCandidate();
    if (presence) return this.entryCandidate(state, { kind: 'membership', change: presence });
    if (this.context.log.recovery?.pending) return null;
    const crypto =
      this.deckSetupCandidate() ??
      this.deckDrawCandidate() ??
      this.stealCandidate() ??
      this.beaconCandidate();
    if (crypto) return this.entryCandidate(state, crypto);
    const count = this.countCandidate();
    if (count) {
      const candidate = this.entryCandidate(state, count);
      if (candidate) return candidate;
    }
    if (this.cryptoPending()) return null;
    while (this.commands.length > 0) {
      const command = this.commands[0];
      if (!command) break;
      const candidate = this.entryCandidate(state, { kind: 'command', signed: command });
      if (candidate) return candidate;
      this.commands.shift();
      // The caller may have broadcast this signed intent elsewhere. Keep its pending
      // promise until commitment or a new parent, but never let it block this queue.
    }
    const system = this.systemCandidate();
    return system ? this.entryCandidate(state, system) : null;
  }

  private entryCandidate(
    state: ConsensusState,
    payload: Extract<EntryPayload, { kind: 'command' | 'system' | 'crypto' | 'membership' }>,
  ): LogEntry | null {
    const checked = this.deriveCandidate(state, payload);
    if (!checked.ok) {
      this.status({ kind: 'rejected', code: checked.error.code });
      return null;
    }
    return checked.value;
  }

  private deriveCandidate(
    state: Pick<ConsensusState, 'height' | 'round'>,
    payload: Extract<EntryPayload, { kind: 'command' | 'system' | 'crypto' | 'membership' }>,
  ): Result<LogEntry> {
    try {
      let stateHash = this.context.log.head.stateHash;
      const membership =
        payload.kind === 'membership' ? parseMembershipChange(payload.change) : null;
      if (membership && !membership.ok) return membership;
      if (membership?.ok && membership.value.kind === 'recovery-activate') {
        const pending = this.context.log.recovery?.authorizations.find(
          (item) =>
            item.entry.seq === this.context.log.recovery?.pending?.seq &&
            item.entry.hash === this.context.log.recovery?.pending?.hash,
        );
        if (!pending)
          return failure('recovery-authorization', 'Activation needs certified authorization');
        const applied = this.context.log.engine.apply(this.context.log.state, {
          kind: 'system',
          type: 'SEAT_STATUS',
          seat: pending.statement.departedSeat,
          status: 'bot',
        });
        if (!applied.ok) return applied;
        stateHash = toHex(hashValue(applied.value.state));
      } else if (membership?.ok && membership.value.kind === 'transfer-activate') {
        const pending = this.context.log.transfer?.authorizations.find(
          (item) =>
            item.entry.seq === this.context.log.transfer?.pending?.seq &&
            item.entry.hash === this.context.log.transfer?.pending?.hash,
        );
        if (!pending)
          return failure('transfer-authorization', 'Activation needs certified authorization');
        if (pending.statement.mode === 'return') {
          const applied = this.context.log.engine.apply(this.context.log.state, {
            kind: 'system',
            type: 'SEAT_STATUS',
            seat: pending.statement.seat,
            status: 'active',
          });
          if (!applied.ok) return applied;
          stateHash = toHex(hashValue(applied.value.state));
        }
      } else if (payload.kind === 'command' || payload.kind === 'system') {
        const input =
          payload.kind === 'command'
            ? {
                kind: 'command' as const,
                seat: payload.signed.body.seat,
                command: payload.signed.body.command,
              }
            : payload.input;
        const applied = this.context.log.engine.apply(this.context.log.state, input);
        if (!applied.ok) return applied;
        stateHash = toHex(hashValue(applied.value.state));
      }
      const entry = signEntry(
        {
          seq: state.height,
          term: state.round,
          prevHash: entryHash(this.context.log.head),
          payload,
          stateHash,
          sequencer: this.self,
        },
        this.secretKey,
      );
      const checked = validateNextEntry(entry, this.context.log, {
        ...this.context.policy,
        term: state.round,
        sequencer: this.self,
      });
      return checked.ok ? success(entry) : checked;
    } catch {
      return failure('entry-verification-failed', 'Candidate derivation failed');
    }
  }

  private systemCandidate(): {
    kind: 'system';
    input: SystemInput;
    evidence: SystemEvidence;
  } | null {
    if (this.cryptoPending()) return null;
    try {
      const candidate = this.options.systemInput?.(detachedContext(this.context));
      if (candidate) {
        if (
          this.context.log.genesis.security === 'verified' &&
          candidate.input.type === 'TIMEOUT'
        ) {
          const anchor = verifyTimeoutEvidence(
            candidate.input,
            candidate.evidence,
            this.context.log.timers,
          );
          if (
            !anchor.ok ||
            (this.timerObserver.elapsed(anchor.value) ?? 0) < anchor.value.deadlineMs
          )
            return null;
        }
        return { kind: 'system', ...candidate };
      }
      if (this.context.log.genesis.security !== 'verified') return null;
      for (const expired of this.timerObserver.timers()) {
        if (expired.remainingMs !== 0 || expired.phase === 'discard') continue;
        const anchor = this.context.log.timers?.find((item) => item.key === expired.key);
        if (!anchor) continue;
        const input: SystemInput = {
          kind: 'system',
          type: 'TIMEOUT',
          seat: anchor.seat,
          phase: anchor.phase,
        };
        if (!this.options.engine.validate(this.context.log.state, input).ok) continue;
        return {
          kind: 'system',
          input,
          evidence: {
            kind: 'proof',
            protocol: TURN_TIMEOUT_PROTOCOL,
            data: { pendingSince: anchor.pendingSince.seq, deadlineMs: anchor.deadlineMs },
          },
        };
      }
      return null;
    } catch {
      this.status({ kind: 'rejected', code: 'system-input' });
      return null;
    }
  }

  /** Refuse local votes that would precede this peer's observed timer window. */
  private admitTimedVotes(previous: ConsensusState, next: ConsensusState): Result<void> {
    if (this.context.log.genesis.security !== 'verified') return success(undefined);
    const prior = new Set(
      previous.votes
        .filter((vote) => vote.body.seat === this.options.seat)
        .map((vote) => `${vote.body.term}/${vote.body.phase}`),
    );
    const proposals = [
      ...next.proposals,
      ...next.hints.flatMap((hint) => (hint.kind === 'proposal' ? [hint.proposal] : [])),
      ...(next.locked ? [next.locked.proposal] : []),
      ...(next.valid ? [next.valid.proposal] : []),
    ];
    for (const vote of next.votes) {
      if (
        vote.body.seat !== this.options.seat ||
        prior.has(`${vote.body.term}/${vote.body.phase}`) ||
        vote.body.valueHash === null
      )
        continue;
      const proposal = proposals.find((item) => entryHash(item.body.entry) === vote.body.valueHash);
      if (!proposal)
        return failure('turn-timeout-proposal', 'Local vote has no retained proposal value');
      const payload = proposal.body.entry.payload;
      if (payload.kind !== 'system' || payload.input.type !== 'TIMEOUT') continue;
      const anchor = verifyTimeoutEvidence(
        payload.input,
        payload.evidence,
        this.context.log.timers,
      );
      if (!anchor.ok) return anchor;
      const admitted = this.timerObserver.canVote(anchor.value);
      if (!admitted.ok) {
        this.scheduleTimedVoteRetry(anchor.value);
        return admitted;
      }
    }
    return success(undefined);
  }

  private admitRecoveryVotes(previous: ConsensusState, next: ConsensusState): Result<void> {
    if (this.context.log.genesis.security !== 'verified') return success(undefined);
    const prior = new Set(
      previous.votes
        .filter((vote) => vote.body.seat === this.options.seat)
        .map((vote) => toHex(hashValue(vote.body))),
    );
    const proposals = [
      ...next.proposals,
      ...next.hints.flatMap((hint) => (hint.kind === 'proposal' ? [hint.proposal] : [])),
      ...(next.locked ? [next.locked.proposal] : []),
      ...(next.valid ? [next.valid.proposal] : []),
    ];
    for (const vote of next.votes) {
      if (
        vote.body.seat !== this.options.seat ||
        prior.has(toHex(hashValue(vote.body))) ||
        vote.body.valueHash === null
      )
        continue;
      const proposal = proposals.find((item) => entryHash(item.body.entry) === vote.body.valueHash);
      if (!proposal)
        return failure('recovery-approval-proposal', 'Local vote has no retained proposal value');
      const payload = proposal.body.entry.payload;
      if (payload.kind !== 'membership') continue;
      const change = parseMembershipChange(payload.change);
      if (!change.ok) return change;
      if (change.value.kind === 'seat-offline') {
        const observed = this.observeRecoveryPresence(change.value.seat);
        if (!observed.ok) return observed;
        const admitted = this.checkRecoveryPresence(observed.value, 15_000);
        if (!admitted.ok) return admitted;
        continue;
      }
      if (change.value.kind !== 'recovery-authorize') continue;
      const preview = this.previewRecoveryAuthorization(change.value);
      if (!preview.ok) return preview;
      const admitted = this.admitTakeoverAuthorization(preview.value.preview);
      if (!admitted.ok) return admitted;
    }
    return success(undefined);
  }

  private canVoteForRecoveryProposal(proposal: SignedProposal): boolean {
    if (this.context.log.genesis.security !== 'verified') return true;
    const payload = proposal.body.entry.payload;
    if (payload.kind !== 'membership') return true;
    const change = parseMembershipChange(payload.change);
    if (!change.ok) return false;
    if (change.value.kind === 'seat-offline') {
      const observed = this.observeRecoveryPresence(change.value.seat);
      return observed.ok && this.checkRecoveryPresence(observed.value, 15_000).ok;
    }
    if (change.value.kind !== 'recovery-authorize') return true;
    const preview = this.previewRecoveryAuthorization(change.value);
    return preview.ok && this.admitTakeoverAuthorization(preview.value.preview).ok;
  }

  private observeRecoveryPresence(targetSeat: Seat): Result<RecoveryPresenceState> {
    const voters = this.context.membership.voters;
    const target = voters.find((item) => item.seat === targetSeat);
    const controller = this.context.log.authority?.controllers.find(
      (item) => item.seat === targetSeat,
    );
    if (!target || controller?.kind !== 'human' || controller.status !== 'active')
      return failure('recovery-target', 'Takeover target is not an active human voter');
    let observer = this.recoveryPresence.get(targetSeat);
    if (!observer) {
      observer = new RecoveryPresenceObserver();
      this.recoveryPresence.set(targetSeat, observer);
    }
    try {
      return success(
        observer.observe({
          targetSeat,
          voters,
          connectedPeers: this.options.transport.peers(),
          self: this.self,
          now: this.options.clock.now(),
        }),
      );
    } catch {
      return failure('recovery-presence', 'Authenticated voter presence is unavailable');
    }
  }

  private observeAllRecoveryPresence(): void {
    for (const voter of this.context.membership.voters) this.observeRecoveryPresence(voter.seat);
    const current = new Set(this.context.membership.voters.map((item) => item.seat));
    for (const seat of this.recoveryPresence.keys())
      if (!current.has(seat)) this.recoveryPresence.delete(seat);
  }

  private checkRecoveryPresence(observed: RecoveryPresenceState, delayMs: number): Result<void> {
    if (observed.targetOnline)
      return failure('recovery-target-online', 'The original voter is connected');
    if (!observed.quorumReachable)
      return failure('recovery-quorum', 'The unchanged voter set cannot reach quorum');
    if (observed.quorumQualifiedAbsentMs < delayMs)
      return failure(
        'recovery-too-early',
        'The local quorum-qualified absence interval has not elapsed',
      );
    return success(undefined);
  }

  private admitTakeoverAuthorization(preview: RecoveryApprovalPreview): Result<void> {
    const policy = this.context.log.genesis.takeover;
    if (policy.afterSeconds === 'never')
      return failure('recovery-disabled', 'Takeover is disabled for this game');
    if (!this.context.log.recovery?.offline.some((item) => item.seat === preview.departedSeat))
      return failure('recovery-offline-required', 'Certified offline notice is required');
    const observed = this.observeRecoveryPresence(preview.departedSeat);
    if (!observed.ok) return observed;
    const admitted = this.checkRecoveryPresence(observed.value, policy.afterSeconds * 1_000);
    if (!admitted.ok) return admitted;
    if (policy.mode === 'vote' && !this.hasRecoveryApproval(preview))
      return failure('recovery-approval-required', 'Approve this exact takeover before voting');
    return success(undefined);
  }

  private notifyAutoTakeoverEligibility(): void {
    const policy = this.context.log.genesis.takeover;
    if (
      policy.mode !== 'auto' ||
      this.context.log.recovery?.pending ||
      this.membershipIntent ||
      this.pendingRecoverySubmit
    )
      return;
    for (const marker of this.context.log.recovery?.offline ?? []) {
      const host = this.context.log.authority?.controllers
        .filter(
          (item) => item.kind === 'human' && item.status === 'active' && item.seat !== marker.seat,
        )
        .map((item) => item.seat)
        .toSorted((a, b) => a - b)[0];
      if (host !== this.options.seat) continue;
      const observed = this.observeRecoveryPresence(marker.seat);
      if (
        !observed.ok ||
        !this.checkRecoveryPresence(observed.value, policy.afterSeconds * 1_000).ok
      )
        continue;
      try {
        this.options.onTakeoverEligible?.(marker.seat);
      } catch {
        this.status({ kind: 'rejected', code: 'recovery-auto-observer' });
      }
    }
  }

  private hasRecoveryApproval(preview: RecoveryApprovalPreview): boolean {
    const generation = this.context.log.authority?.controllers.find(
      (item) => item.seat === this.options.seat,
    )?.activatedAt;
    return !!(
      preview.canApprove &&
      generation &&
      this.recoveryApproval?.parentHash === preview.parent.hash &&
      this.recoveryApproval.statementHash === preview.statementHash &&
      this.recoveryApproval.generationHash === generation.hash
    );
  }

  private rememberRecoveryCandidate(candidate: RecoveryApprovalCandidate): void {
    if (this.recoveryCandidateForApproval) return;
    this.recoveryCandidateForApproval = copyCanonical(candidate);
    try {
      this.options.onRecoveryCandidate?.(copyCanonical(candidate.preview));
    } catch {
      this.status({ kind: 'rejected', code: 'recovery-candidate-observer' });
    }
  }

  private clearRecoveryCandidate(): void {
    this.recoveryApprovalRevision++;
    const hadCandidate = this.recoveryCandidateForApproval !== null;
    this.recoveryCandidateForApproval = null;
    this.recoveryApproval = null;
    this.pendingRecoveryProposal = null;
    this.pendingRecoverySubmit = null;
    if (!hadCandidate) return;
    try {
      this.options.onRecoveryCandidate?.(null);
    } catch {
      this.status({ kind: 'rejected', code: 'recovery-candidate-observer' });
    }
  }

  private cancelRecoveryForReturningPeer(peer: PeerId): void {
    const active = this.context.log.authority?.controllers.find(
      (item) => item.kind === 'human' && item.status === 'active' && item.publicKey === peer,
    );
    if (!active) return;
    const pending = this.membershipIntent;
    const pendingSeat =
      pending?.change.kind === 'recovery-authorize'
        ? pending.change.statement.departedSeat
        : undefined;
    const candidateSeat = this.recoveryCandidateForApproval?.preview.departedSeat;
    const submitSeat =
      this.pendingRecoverySubmit?.change.kind === 'recovery-authorize'
        ? this.pendingRecoverySubmit.change.statement.departedSeat
        : undefined;
    if (![pendingSeat, candidateSeat, submitSeat].includes(active.seat)) return;
    this.clearRecoveryCandidate();
    if (pendingSeat !== active.seat || !pending) return;
    this.membershipIntent = null;
    if (pending.pendingTimer !== undefined) this.options.clock.clearTimeout(pending.pendingTimer);
    pending.resolve?.(failure('recovery-target-returned', 'The original voter has returned'));
  }

  private scheduleTimedVoteRetry(anchor: TimerAnchor): void {
    const delay = this.timerObserver.untilVote(anchor);
    if (delay === null || delay === 0 || this.disposed) return;
    const parentHash = entryHash(this.context.log.head);
    const anchorHash = anchor.pendingSince.hash;
    if (
      this.timedVoteRetry?.parentHash === parentHash &&
      this.timedVoteRetry.anchorHash === anchorHash
    )
      return;
    this.clearTimedVoteRetry();
    const retry = {
      parentHash,
      anchorHash,
      proposal: null as SignedProposal | null,
      handle: null as unknown,
    };
    retry.handle = this.options.clock.setTimeout(
      () => {
        if (this.timedVoteRetry !== retry) return;
        this.timedVoteRetry = null;
        void this.enqueue(async () => {
          if (this.disposed || entryHash(this.context.log.head) !== parentHash)
            return success(undefined);
          if (retry.proposal) {
            const admitted = await this.activeController().dispatch({
              kind: 'proposal',
              proposal: retry.proposal,
            });
            if (!admitted.ok) {
              if (admitted.error.code === 'turn-timeout-early' && this.timedVoteRetry)
                this.timedVoteRetry.proposal = retry.proposal;
              else return admitted;
            }
          }
          return this.offerAvailableInput(true);
        });
      },
      Math.max(1, Math.ceil(delay)),
    );
    this.timedVoteRetry = retry;
  }

  private clearTimedVoteRetry(): void {
    if (this.timedVoteRetry) this.options.clock.clearTimeout(this.timedVoteRetry.handle);
    this.timedVoteRetry = null;
  }

  private beaconCandidate() {
    if (this.beaconFrozen()) return null;
    const candidate = this.beaconInbox.candidate(
      this.context.log,
      this.options.policy.entry.randomDerivations,
    );
    if (!candidate.ok) {
      this.status({ kind: 'rejected', code: candidate.error.code });
      return null;
    }
    return candidate.value;
  }

  private deckSetupCandidate(): Extract<EntryPayload, { kind: 'crypto' }> | null {
    const decks = this.context.log.crypto?.decks;
    const next = decks?.decks.find((deck) => deck.nextPass < deck.commitment.passHashes.length);
    const hash = next?.commitment.passHashes[next.nextPass];
    const evidence = hash ? this.deckSetupPasses.get(hash) : undefined;
    return evidence && next?.commitment.definition.deckId === evidence.deckId
      ? { kind: 'crypto', action: 'deck-pass', evidence }
      : null;
  }

  private deckDrawCandidate(): Extract<EntryPayload, { kind: 'system' }> | null {
    if (this.deckFrozen()) return null;
    const candidate = this.deckInbox.candidate(this.context.log);
    if (!candidate.ok) {
      this.status({ kind: 'rejected', code: candidate.error.code });
      return null;
    }
    return candidate.value;
  }

  private countCandidate(): Extract<EntryPayload, { kind: 'system' }> | null {
    if (this.countFrozen()) return null;
    const candidate = this.countInbox.candidate(
      this.context.log.crypto,
      this.context.log.genesis,
      this.context.log.authority,
    );
    if (!candidate.ok) {
      this.status({ kind: 'rejected', code: candidate.error.code });
      return null;
    }
    return candidate.value;
  }

  private async prepareCount(retransmit: boolean): Promise<Result<void>> {
    if (this.countFrozen()) return success(undefined);
    const refreshed = this.countInbox.refresh(
      this.context.log.crypto,
      this.context.log.genesis,
      this.context.log.authority,
    );
    if (!refreshed.ok) return this.failClosed(refreshed.error.code, refreshed.error.message);
    const active = this.context.log.crypto?.counts;
    const operationId = this.countInbox.operationId();
    if (!active || !operationId) {
      this.sentCountOperation = null;
      this.sentCountContributions.clear();
      return success(undefined);
    }
    if (this.sentCountOperation !== operationId) {
      this.sentCountOperation = operationId;
      this.sentCountContributions.clear();
    }
    for (const seat of active.remaining) {
      const key = this.deckKeys.get(seat);
      if (!key) continue;
      const { countProof, countContributionStore } = this.options;
      if (!countProof || !countContributionStore)
        return this.failClosed(
          'replica-count-store',
          'Verified count reveals need an owner proof source and durable store',
        );
      // Each hosted victim has an independent durable record for this frozen operation.
      // oxlint-disable-next-line no-await-in-loop -- The store must settle before this contribution is sent.
      const prepared = await prepareCountContribution(
        active.operation,
        seat,
        key,
        detachedContext(this.context).log,
        countProof,
        countContributionStore,
      );
      if (this.disposed)
        return failure('replica-disposed', 'Replica closed during count preparation');
      if (!prepared.ok) return this.failClosed(prepared.error.code, prepared.error.message);
      const stillPending = this.countInbox.refresh(
        this.context.log.crypto,
        this.context.log.genesis,
        this.context.log.authority,
      );
      if (!stillPending.ok)
        return this.failClosed(stillPending.error.code, stillPending.error.message);
      const current = this.context.log.crypto?.counts;
      if (
        !current ||
        !current.remaining.includes(seat) ||
        this.countInbox.operationId() !== operationId
      )
        return success(undefined);
      const remembered = this.countInbox.remember(prepared.value);
      if (!remembered.ok) return this.failClosed(remembered.error.code, remembered.error.message);
      if (retransmit || !this.sentCountContributions.has(seat)) {
        const sent = this.broadcast({
          t: 'COUNT_CONTRIB',
          genesisDigest: this.context.membership.genesisDigest,
          contribution: prepared.value,
        });
        if (sent.ok) this.sentCountContributions.add(seat);
        else this.status({ kind: 'rejected', code: sent.error.code });
      }
    }
    return success(undefined);
  }

  private stealCandidate(): Extract<EntryPayload, { kind: 'crypto' | 'system' }> | null {
    if (this.stealFrozen()) return null;
    const candidate = this.stealInbox.candidate(
      this.context.log.crypto,
      this.context.log.genesis,
      this.context.log.authority,
    );
    if (!candidate.ok) {
      this.status({ kind: 'rejected', code: candidate.error.code });
      return null;
    }
    return candidate.value;
  }

  private async prepareSteal(retransmit: boolean): Promise<Result<void>> {
    if (this.stealFrozen()) return success(undefined);
    const refreshed = this.stealInbox.refresh(
      this.context.log.crypto,
      this.context.log.genesis,
      this.context.log.authority,
    );
    if (!refreshed.ok) return this.failClosed(refreshed.error.code, refreshed.error.message);
    const active = this.context.log.crypto?.steal;
    const stage = this.stealInbox.stageId();
    if (!active || !stage) {
      this.sentStealStage = null;
      this.preparedSteal = null;
      return success(undefined);
    }
    if (this.preparedSteal?.stage !== stage) this.preparedSteal = null;
    if (!retransmit && this.sentStealStage === stage) return success(undefined);
    const cached = this.preparedSteal;
    if (cached?.stage === stage) {
      const sent = this.broadcastBytes(cached.bytes);
      if (sent.ok) this.sentStealStage = stage;
      else this.status({ kind: 'rejected', code: sent.error.code });
      return success(undefined);
    }
    const seat = active.fixed ? active.operation.thief.seat : active.operation.victim.seat;
    const key = this.deckKeys.get(seat);
    if (!key) return success(undefined);
    const { stealContribution, stealResponse, stealDeliveryStore } = this.options;
    if (!stealContribution || !stealResponse || !stealDeliveryStore)
      return this.failClosed(
        'replica-steal-store',
        'Verified steals need owned proof sources and durable delivery',
      );
    const context = detachedContext(this.context).log;
    const prepared = active.fixed
      ? await prepareStealResponse(
          active.fixed,
          seat,
          key,
          context,
          stealResponse,
          stealDeliveryStore,
        )
      : await prepareStealContribution(
          active.operation,
          seat,
          key,
          context,
          stealContribution,
          stealDeliveryStore,
        );
    if (this.disposed)
      return failure('replica-disposed', 'Replica closed during steal preparation');
    if (!prepared.ok) return this.failClosed(prepared.error.code, prepared.error.message);
    const current = this.stealInbox.refresh(
      this.context.log.crypto,
      this.context.log.genesis,
      this.context.log.authority,
    );
    if (!current.ok) return this.failClosed(current.error.code, current.error.message);
    if (this.stealInbox.stageId() !== stage) return success(undefined);
    const outgoing = prepared.value;
    const remembered =
      'kind' in outgoing
        ? this.stealInbox.rememberResponse(outgoing)
        : this.stealInbox.rememberContribution(outgoing);
    if (!remembered.ok) return this.failClosed(remembered.error.code, remembered.error.message);
    const message =
      'kind' in outgoing
        ? {
            t: 'STEAL_RESPONSE',
            genesisDigest: this.context.membership.genesisDigest,
            response: outgoing,
          }
        : {
            t: 'STEAL_CONTRIB',
            genesisDigest: this.context.membership.genesisDigest,
            contribution: outgoing,
          };
    const encoded = encodeProtocolMessage(message);
    if (!encoded.ok) return this.failClosed(encoded.error.code, encoded.error.message);
    const cachedOutgoing = { stage, bytes: encoded.value.slice() };
    this.preparedSteal = cachedOutgoing;
    const sent = this.broadcastBytes(cachedOutgoing.bytes);
    if (sent.ok) this.sentStealStage = stage;
    else this.status({ kind: 'rejected', code: sent.error.code });
    return success(undefined);
  }

  private refreshPreparedStealStage(): void {
    if (this.stealFrozen()) return;
    const refreshed = this.stealInbox.refresh(
      this.context.log.crypto,
      this.context.log.genesis,
      this.context.log.authority,
    );
    const stage = refreshed.ok ? this.stealInbox.stageId() : null;
    if (this.preparedSteal?.stage !== stage) this.preparedSteal = null;
    if (this.sentStealStage !== stage) this.sentStealStage = null;
  }

  private async prepareDeck(retransmit: boolean): Promise<Result<void>> {
    if (this.deckFrozen()) return success(undefined);
    const crypto = this.context.log.crypto;
    const refreshed = this.deckInbox.refresh(
      crypto,
      this.context.log.genesis,
      this.context.log.authority,
    );
    if (!refreshed.ok) return this.failClosed(refreshed.error.code, refreshed.error.message);
    const active = crypto?.decks.active;
    const operationId = this.deckInbox.operationId();
    if (!active || !operationId) {
      this.preparedDeckPrefix = null;
      this.sentDeckPrefix = null;
      return success(undefined);
    }
    const setup = crypto.decks.decks.find(
      (deck) => deck.commitment.definition.deckId === active.deckId,
    )?.setup;
    const createDeckSource = this.createDeckSource;
    const { deckContributions } = this.options;
    if (!setup || !createDeckSource || !deckContributions)
      return this.failClosed(
        'replica-deck-store',
        'Verified draws need local sources and durable contributions',
      );
    const signers: ArtifactSigner[] = [];
    for (const participant of active.participants.filter((item) => item.seat !== active.seat)) {
      const signer = resolveArtifactSigner(
        this.context.log.authority,
        this.context.log.genesis,
        crypto.epoch,
        participant.seat,
      );
      if (!signer.ok) return signer;
      signers.push(signer.value);
    }
    const prefixKey = () => `${operationId}/${crypto.epoch}/${this.deckInbox.prefix().length}`;
    if (this.preparedDeckPrefix !== prefixKey()) {
      const request = {
        genesisDigest: active.genesisDigest,
        epoch: active.epoch,
        anchor: active.anchor,
        position: active.position,
        seat: active.seat,
        slotId: active.slotId,
      };
      // Seat order matches the unlock chain. One host may append several bot
      // unlocks. Even the drawer reserves the certified position before returning.
      for (const participant of active.participants) {
        const key = this.deckKeys.get(participant.seat);
        if (!key) continue;
        const localSigner = resolveArtifactSigner(
          this.context.log.authority,
          this.context.log.genesis,
          crypto.epoch,
          participant.seat,
        );
        if (!localSigner.ok) return localSigner;
        let source: ReturnType<DeckSourceFactory> | undefined;
        try {
          source = createDeckSource(active.deckId, participant.seat);
          // oxlint-disable-next-line no-await-in-loop -- Each durable unlock consumes the previously verified ordered prefix.
          const prepared = await prepareDeckUnlock(
            setup,
            request,
            this.deckInbox.prefix(),
            participant.seat,
            key,
            source,
            deckContributions,
            signers,
            localSigner.value,
          );
          if (this.disposed)
            return failure('replica-disposed', 'Replica closed during deck preparation');
          if (!prepared.ok) return this.failClosed(prepared.error.code, prepared.error.message);
          if (prepared.value) {
            const remembered = this.deckInbox.remember({
              kind: 'deck-unlock',
              operationId,
              unlocks: [...this.deckInbox.prefix(), prepared.value],
            });
            if (!remembered.ok)
              return this.failClosed(remembered.error.code, remembered.error.message);
          }
        } catch {
          return this.failClosed(
            'replica-deck-source',
            'Could not reconstruct the certified deck source',
          );
        } finally {
          source?.dispose();
        }
      }
      this.preparedDeckPrefix = prefixKey();
    }
    const unlocks = this.deckInbox.prefix();
    const latest = prefixKey();
    if (unlocks.length > 0 && (retransmit || latest !== this.sentDeckPrefix)) {
      const sent = this.broadcast({
        t: 'DECK_CONTRIB',
        genesisDigest: this.context.membership.genesisDigest,
        contribution: { kind: 'deck-unlock', operationId, unlocks },
      });
      if (sent.ok) this.sentDeckPrefix = latest;
      else this.status({ kind: 'rejected', code: sent.error.code });
    }
    return success(undefined);
  }

  private cryptoPending(): boolean {
    const crypto = this.context.log.crypto;
    return !!(
      crypto &&
      (!decksReady(crypto.decks) ||
        crypto.decks.active ||
        crypto.beacon.active ||
        crypto.beacon.fixed)
    );
  }

  private seatFrozen(seat: Seat): boolean {
    return (
      this.context.log.authority?.controllers.some(
        (controller) => controller.seat === seat && controller.status === 'pending-recovery',
      ) ?? false
    );
  }

  private deckFrozen(): boolean {
    return (
      this.context.log.crypto?.decks.active?.participants.some((item) =>
        this.seatFrozen(item.seat),
      ) ?? false
    );
  }

  private beaconFrozen(): boolean {
    return (
      this.context.log.crypto?.beacon.active?.participants.some((item) =>
        this.seatFrozen(item.seat),
      ) ?? false
    );
  }

  private countFrozen(): boolean {
    return (
      this.context.log.crypto?.counts?.remaining.some((seat) => this.seatFrozen(seat)) ?? false
    );
  }

  private stealFrozen(): boolean {
    const active = this.context.log.crypto?.steal;
    if (!active) return false;
    const seat = active.fixed ? active.operation.thief.seat : active.operation.victim.seat;
    return this.seatFrozen(seat);
  }

  private async prepareBeacon(retransmit: boolean): Promise<Result<void>> {
    if (this.beaconFrozen()) return success(undefined);
    const crypto = this.context.log.crypto;
    const refreshed = this.beaconInbox.refresh(
      crypto,
      this.context.log.genesis,
      this.context.log.authority,
    );
    if (!refreshed.ok) return this.failClosed(refreshed.error.code, refreshed.error.message);
    if (!crypto?.beacon.active || !decksReady(crypto.decks)) return success(undefined);
    const { beaconContributions } = this.options;
    if (!beaconContributions)
      return this.failClosed(
        'replica-beacon-store',
        'Verified sessions need durable beacon contributions',
      );
    for (const participant of crypto.beacon.active.participants) {
      const key = this.deckKeys.get(participant.seat);
      if (!key) continue;
      const source = this.beaconSources.get(participant.seat);
      if (!source)
        return this.failClosed('replica-beacon-source', 'Owned beacon source is missing');
      const signer = resolveArtifactSigner(
        this.context.log.authority,
        this.context.log.genesis,
        crypto.epoch,
        participant.seat,
      );
      if (!signer.ok) return signer;
      const operationId = `${this.beaconInbox.operationId()}/${crypto.epoch}/${participant.seat}/${signer.value.generation.hash}`;
      if (!retransmit && this.sentBeaconOperations.has(operationId)) continue;
      // oxlint-disable-next-line no-await-in-loop -- Each owned seat has a separate immutable outbox slot.
      const prepared = await prepareBeaconContribution(
        crypto,
        participant.seat,
        key,
        source,
        beaconContributions,
        signer.value,
      );
      if (this.disposed)
        return failure('replica-disposed', 'Replica closed during beacon preparation');
      if (!prepared.ok) return this.failClosed(prepared.error.code, prepared.error.message);
      if (!prepared.value) continue;
      const remembered = this.beaconInbox.remember(prepared.value);
      if (!remembered.ok) return this.failClosed(remembered.error.code, remembered.error.message);
      const sent = this.broadcast({
        t: 'SYS_CONTRIB',
        genesisDigest: this.context.membership.genesisDigest,
        contribution: prepared.value,
      });
      if (sent.ok) this.sentBeaconOperations.add(operationId);
      else this.status({ kind: 'rejected', code: sent.error.code });
    }
    return success(undefined);
  }

  private rememberCommand(command: SignedCommand): boolean {
    const hash = commandHash(command);
    if (this.commands.some((known) => commandHash(known) === hash)) return true;
    if (!this.hasCommandCapacity(command.body.seat)) return false;
    this.commands.push(command);
    return true;
  }

  private hasCommandCapacity(seat: Seat): boolean {
    return (
      this.commands.length < MAX_PENDING_COMMANDS &&
      this.commands.filter((known) => known.body.seat === seat).length <
        MAX_PENDING_COMMANDS_PER_SEAT
    );
  }

  private verifiedCheatClaim(claim: CheatClaim): Result<CheatFinding> {
    if (claim.evidence.at.seq > this.context.log.head.seq)
      return failure('cheat-future', 'Cheat evidence parent is not certified');
    if (claim.evidence.at.seq < this.context.log.head.seq)
      return (
        this.context.verifyHistoricalCheat?.(claim) ??
        failure('cheat-history', 'Certified evidence parent is unavailable')
      );
    if (
      !authenticatedCheatSigner(
        claim,
        this.context.log.genesis,
        this.context.log.authority,
        this.context.log.crypto?.epoch,
      )
    )
      return failure('cheat-signature', 'Cheat evidence has no authenticated current signer');
    return verifyCheatProof(claim, this.context.log);
  }

  private async captureRejectedProofs(from: PeerId, bytes: Uint8Array): Promise<void> {
    if (
      this.disposed ||
      this.context.log.genesis.security !== 'verified' ||
      !this.context.membership.voters.some((voter) => voter.publicKey === from) ||
      !this.admitExpensiveRequest(from, `capture/${toHex(hashValue(bytes))}`, 'cheat')
    )
      return;
    for (const claim of rejectedWireProofCandidates(bytes, this.context.log)) {
      // Retain before gossip; a candidate is still untrusted until the objective
      // verifier checks its signature and proof against this certified parent.
      // oxlint-disable-next-line no-await-in-loop -- Bounded candidates share one durable outbox.
      const retained = await this.rememberCheatClaim(claim, true);
      if (!retained.ok && retained.error.code.startsWith('cheat-store-'))
        this.status({ kind: 'rejected', code: retained.error.code });
    }
  }

  private async captureCertifiedDelivery(): Promise<void> {
    const delivery = certifiedDeliveryClaim(this.context.log);
    if (!delivery) return;
    const retained = await this.rememberCheatClaim(delivery, true);
    if (!retained.ok) this.status({ kind: 'rejected', code: retained.error.code });
  }

  private async rememberCheatClaim(value: unknown, gossip: boolean): Promise<Result<void>> {
    const store = this.options.cheatCandidateStore;
    if (!store)
      return failure('cheat-store-required', 'Cheat claims need a durable candidate store');
    const encoded = encodeCheatCandidate(value);
    if (!encoded.ok) return encoded;
    const { claim, bytes } = encoded.value;
    const id = cheatCandidateId(claim);
    if (
      this.context.log.crypto?.cheats.some(
        (finding) => finding.seat === claim.seat && finding.kind === claim.evidence.kind,
      )
    )
      return success(undefined);
    if (this.cheatCandidates.has(id)) return success(undefined);
    if (this.cheatCandidates.size >= 48)
      return failure('cheat-capacity', 'The bounded candidate queue is full');
    const finding = this.verifiedCheatClaim(claim);
    if (!finding.ok) return finding;
    let retained = claim;
    try {
      if (!(await store.putIfAbsent(id, bytes))) {
        const winner = (await store.loadAll()).find((record) => record.id === id);
        if (!winner) return failure('cheat-store-record', 'Winning cheat candidate is missing');
        const loaded = decodeCheatCandidate(winner.bytes);
        if (!loaded.ok || cheatCandidateId(loaded.value) !== id)
          return failure('cheat-store-record', 'Winning cheat candidate is corrupt');
        const checked = this.verifiedCheatClaim(loaded.value);
        if (!checked.ok) return checked;
        retained = loaded.value;
      }
    } catch {
      return failure('cheat-store-write', 'Could not persist the cheat candidate');
    }
    this.cheatCandidates.set(id, retained);
    if (gossip) {
      const sent = this.broadcast({ t: 'CHEAT_CLAIM', claim: retained });
      if (!sent.ok) return sent;
    }
    return this.offerAvailableInput();
  }

  private async recoverCheatCandidates(): Promise<Result<void>> {
    const store = this.options.cheatCandidateStore;
    if (!store) return success(undefined);
    let records: readonly { id: string; bytes: Uint8Array }[];
    try {
      records = await store.loadAll();
    } catch {
      return failure('cheat-store-read', 'Could not load retained cheat candidates');
    }
    if (records.length > 48) this.status({ kind: 'rejected', code: 'cheat-store-capacity' });
    for (const record of records.slice(0, 48)) {
      const loaded = decodeCheatCandidate(record.bytes);
      if (!loaded.ok || cheatCandidateId(loaded.value) !== record.id) {
        this.status({ kind: 'rejected', code: 'cheat-store-record' });
        try {
          // oxlint-disable-next-line no-await-in-loop -- Quarantine each invalid auxiliary record before proceeding.
          await store.delete(record.id);
        } catch {
          this.status({ kind: 'rejected', code: 'cheat-store-delete' });
        }
        continue;
      }
      const claim = loaded.value;
      if (
        this.context.log.crypto?.cheats.some(
          (finding) => finding.seat === claim.seat && finding.kind === claim.evidence.kind,
        )
      ) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- Every stale record must be removed before replay resumes.
          await store.delete(record.id);
        } catch {
          this.status({ kind: 'rejected', code: 'cheat-store-delete' });
        }
        continue;
      }
      const checked = this.verifiedCheatClaim(claim);
      if (!checked.ok || this.cheatCandidates.has(record.id)) {
        this.status({ kind: 'rejected', code: 'cheat-store-record' });
        try {
          // oxlint-disable-next-line no-await-in-loop -- Quarantine each invalid auxiliary record before proceeding.
          await store.delete(record.id);
        } catch {
          this.status({ kind: 'rejected', code: 'cheat-store-delete' });
        }
        continue;
      }
      this.cheatCandidates.set(record.id, claim);
    }
    return success(undefined);
  }

  private broadcastNextCheatClaim(): void {
    const claims = [...this.cheatCandidates.entries()].toSorted(([left], [right]) =>
      left.localeCompare(right),
    );
    if (claims.length === 0) return;
    const selected = claims[this.cheatGossipCursor % claims.length];
    if (!selected) return;
    const sent = this.broadcast({ t: 'CHEAT_CLAIM', claim: selected[1] });
    if (sent.ok) this.cheatGossipCursor += 1;
    else this.status({ kind: 'rejected', code: sent.error.code });
  }

  private async rememberAccusation(control: ExcludeProposerControl): Promise<Result<void>> {
    const known = this.activeController().snapshot();
    if (!known.ok) return known;
    if (
      this.context.excludedProposers.includes(control.offender) &&
      known.value.provenOffender?.control.offender === control.offender
    ) {
      this.accusation = null;
      return success(undefined);
    }
    if (known.value.provenOffender?.control.offender === control.offender)
      control = known.value.provenOffender.control;
    if (this.accusation !== null && toHex(hashValue(this.accusation)) === toHex(hashValue(control)))
      return success(undefined);
    const replayed = replayCertifiedPrefix(
      this.genesisEntry,
      this.entries,
      this.options.engine,
      this.options.policy,
    );
    if (!replayed.ok) return this.failClosed(replayed.error.code, replayed.error.message);
    const verified = replayed.value.context;
    if (entryHash(verified.log.head) !== entryHash(this.context.log.head))
      return this.failClosed('replica-parent', 'Accusation parent differs from certified replay');
    const objective = validateObjectiveForProposal(control, verified);
    if (!objective.ok) return objective;
    const staged = await this.activeController().dispatch({ kind: 'stage-accusation', control });
    if (!staged.ok) return staged;
    const after = this.activeController().snapshot();
    if (!after.ok) return after;
    if (after.value.haltKind === 'terminal') {
      const code = after.value.halted?.includes('unrecorded local signature')
        ? 'replica-local-signature'
        : 'replica-fault-limit';
      this.status({ kind: 'halted', code });
      return failure(code, after.value.halted ?? 'Voting halted after objective evidence');
    }
    if (
      verified.excludedProposers.length > 0 &&
      !verified.excludedProposers.includes(control.offender)
    )
      return failure('replica-fault-limit', 'Another proposer is already certified excluded');
    if (verified.excludedProposers.length > 0)
      return failure('control-fault-limit', 'A proposer is already excluded');
    if (this.accusation !== null) return success(undefined);
    this.accusation = after.value.pendingAccusation;
    const sent = this.broadcast({ t: 'ACCUSE', control });
    if (!sent.ok) return sent;
    void this.enqueue(() => this.offerAvailableInput());
    return success(undefined);
  }

  /** Validate the retained proof against the certified prefix before resuming votes. */
  private async recoverPersistedAccusation(): Promise<Result<void>> {
    let snapshot = this.activeController().snapshot();
    if (!snapshot.ok) return snapshot;
    const proven = snapshot.value.provenOffender;
    if (proven) {
      const historical = replayCertifiedPrefix(
        this.genesisEntry,
        this.entries.slice(0, proven.atSeq - 1),
        this.options.engine,
        this.options.policy,
      );
      if (!historical.ok) return historical;
      if (entryHash(historical.value.context.log.head) !== proven.parentHash)
        return failure('replica-accusation', 'Retained proof has a different certified parent');
      const old = historical.value.context;
      const checked = validateObjectiveAccusation(proven.control, {
        log: old.log,
        commandPolicy: old.policy,
        membership: old.membership,
        excludedProposers: old.excludedProposers,
        proposerFor: (seq, term) => proposerFor(seq, term, old.membership, old.excludedProposers),
      });
      if (!checked.ok) return checked;
    }
    const pending = snapshot.value.pendingAccusation;
    const isAlreadyCertified =
      pending !== null &&
      proven?.control.offender === pending.offender &&
      this.context.excludedProposers.includes(pending.offender) &&
      toHex(hashValue(proven.control)) === toHex(hashValue(pending));
    if (isAlreadyCertified) {
      const cleared = await this.activeController().dispatch({ kind: 'clear-stale-accusation' });
      if (!cleared.ok) return cleared;
      snapshot = this.activeController().snapshot();
      if (!snapshot.ok) return snapshot;
    }
    if (snapshot.value.halted || snapshot.value.decision) return success(undefined);
    if (snapshot.value.pendingAccusation)
      return this.rememberAccusation(snapshot.value.pendingAccusation);
    const evidence = snapshot.value.equivocations[0];
    return evidence
      ? this.rememberAccusation(controlForEquivocation(evidence))
      : success(undefined);
  }

  private async handleEffects(effects: readonly ConsensusEffect[], index = 0): Promise<void> {
    const effect = effects[index];
    if (!effect || this.derivedRepair) return;
    switch (effect.kind) {
      case 'broadcast-proposal':
        this.requireSend(this.broadcast({ t: 'PROPOSAL', proposal: effect.proposal }));
        break;
      case 'broadcast-vote':
        this.requireSend(this.broadcast({ t: 'VOTE', vote: effect.vote }));
        break;
      case 'schedule-timeout':
        this.scheduleConsensusTimeout(effect.phase, effect.round);
        break;
      case 'request-value':
        void this.enqueue(() => this.maybePropose());
        break;
      case 'request-proposal':
        this.requireSend(
          this.broadcast({
            t: 'PROPOSAL_REQ',
            genesisDigest: this.context.membership.genesisDigest,
            epoch: this.context.membership.epoch,
            seq: this.context.log.head.seq + 1,
            term: effect.round,
            valueHash: effect.hash,
          }),
        );
        break;
      case 'commit':
        await this.persistCommit(effect.certified);
        break;
      case 'equivocation': {
        void this.enqueue(() => this.rememberAccusation(controlForEquivocation(effect.evidence)));
        break;
      }
      case 'halt': {
        this.status({ kind: 'halted', code: effect.reason });
        const state = this.activeController().snapshot();
        if (state.ok && state.value.haltKind === 'certified-validation')
          this.requireSend(
            this.broadcast({
              t: 'SNAPSHOT_REQ',
              genesisDigest: this.context.membership.genesisDigest,
              atSeq: this.context.log.head.seq,
            }),
          );
        break;
      }
    }
    await this.handleEffects(effects, index + 1);
  }

  private async persistCommit(certified: CertifiedEntry): Promise<void> {
    const previous = this.context;
    const checked = validateCertifiedEntry(certified, previous);
    if (!checked.ok) throw new Error(`Certified entry failed replay: ${checked.error.code}`);
    const advanced = advanceContext(previous, checked.value);
    if (!advanced.ok) throw new Error(`Certified context failed: ${advanced.error.code}`);
    const next = advanced.value;
    const prior = this.activeController().snapshot();
    if (!prior.ok) throw new Error(`Voting record failed: ${prior.error.code}`);
    const controlProof =
      checked.value.entry.payload.kind === 'control'
        ? objectiveProofParentHash(checked.value.entry.payload, previous)
        : null;
    if (controlProof && !controlProof.ok)
      throw new Error(`Committed accusation proof failed: ${controlProof.error.code}`);
    const provenOffender =
      prior.value.provenOffender ??
      (checked.value.entry.payload.kind === 'control' && controlProof?.ok
        ? {
            control: checked.value.entry.payload,
            atSeq: objectiveEvidenceSeq(checked.value.entry.payload),
            parentHash: controlProof.value,
          }
        : null);
    const pendingAccusation =
      checked.value.entry.payload.kind === 'control' ? null : prior.value.pendingAccusation;
    const retired = !next.membership.voters.some(
      (voter) => voter.seat === this.options.seat && voter.publicKey === this.self,
    );
    const nextSafety = retired
      ? createRetiredSafety(previous, certified, this.options.seat, prior.value)
      : createConsensusState(next, this.options.seat, provenOffender, pendingAccusation);
    if (!nextSafety.ok) throw new Error(`Next voting state failed: ${nextSafety.error.code}`);
    const current = await this.options.journal.loadSafety(certified.entry.seq);
    const snapshot = this.activeController().snapshot();
    if (
      !snapshot.ok ||
      !current ||
      current.revision !== this.activeController().persistedRevision() ||
      !sameBytes(current.bytes, canonicalEncode(snapshot.value)) ||
      !(await this.options.journal.commit(
        certified.entry.seq,
        this.activeController().persistedRevision(),
        certified,
        canonicalEncode(nextSafety.value),
      ))
    )
      throw new Error('Certified journal commit lost its safety CAS');
    this.activeController().dispose();
    this.context = next;
    this.observeAllRecoveryPresence();
    if (checked.value.entry.payload.kind === 'membership') this.pruneRetiredBotOwnership();
    this.timerObserver.advance(next.log.timers ?? []);
    this.clearTimedVoteRetry();
    this.clearRecoveryCandidate();
    this.pendingTradeProofs.clear();
    this.tradeProofResponses.clear();
    this.tradeProofRequestsByFinalizer.clear();
    this.entries.push({ entry: checked.value.entry, certificate: [...checked.value.certificate] });
    this.rememberHumanActivation(checked.value.entry);
    if (checked.value.entry.payload.kind === 'cheat-proof') {
      const id = cheatCandidateId(checked.value.entry.payload.claim);
      this.cheatCandidates.delete(id);
      try {
        await this.options.cheatCandidateStore?.delete(id);
      } catch {
        // A stale auxiliary record is removed during restore after certified replay.
      }
    }
    if (this.lastSyncRequest && next.log.head.seq >= this.lastSyncRequest.fromSeq)
      this.lastSyncRequest = null;
    this.commands.length = 0;
    this.rejectedCommands.clear();
    this.rejectedProposals.clear();
    this.rejectedDeckContributions.clear();
    this.rejectedCountContributions.clear();
    this.rejectedStealMessages.clear();
    this.sentCountContributions.clear();
    this.sentBeaconOperations.clear();
    this.preparedRecovery = null;
    this.sentRecoveryPackets.clear();
    this.accusation = pendingAccusation;
    this.clearConsensusTimers();
    this.refreshPreparedStealStage();
    if (!retired) {
      const opened = await this.openController();
      if (!opened.ok) throw new Error(`Next voting controller failed: ${opened.error.code}`);
    }
    try {
      this.options.onCommit?.(
        detachedValidated(checked.value),
        detachedContext(previous),
        detachedContext(next),
      );
    } catch {
      this.status({ kind: 'halted', code: 'commit-application' });
      this.dispose();
      throw new Error('Committed private-state application failed');
    }
    if (!retired && checked.value.entry.payload.kind === 'membership') {
      const installed = await this.installAuthorityOwnership();
      if (!installed.ok) {
        this.status({ kind: 'halted', code: installed.error.code });
        this.dispose();
        throw new Error(`Certified recovery key installation failed: ${installed.error.code}`);
      }
    }
    this.settlePending(certified);
    const sent = this.broadcast({ t: 'COMMIT', certified });
    if (retired) {
      if (!sent.ok) this.status({ kind: 'rejected', code: sent.error.code });
    } else this.requireSend(sent);
    if (checked.value.entry.payload.kind === 'membership') {
      try {
        const routed = this.options.onMembershipCommitted?.(this.getEntries());
        if (routed && !routed.ok) throw new Error(routed.error.code);
      } catch {
        this.status({ kind: 'halted', code: 'membership-routing' });
        this.dispose();
        throw new Error('Certified membership routing failed');
      }
    }
    // Report a matching membership commit only after the final COMMIT is sent
    // on the old route and the new route is installed. A failed hook disposes
    // with an outcome-unknown result instead of reporting false success.
    this.settleMembership(certified);
    if (retired) {
      this.status({ kind: 'retired', seat: this.options.seat });
      this.dispose();
      return;
    }
    if (pendingAccusation)
      this.requireSend(this.broadcast({ t: 'ACCUSE', control: pendingAccusation }));
    void this.enqueue(async () => {
      await this.captureCertifiedDelivery();
      return this.offerAvailableInput();
    });
  }

  private settlePending(certified: CertifiedEntry): void {
    const committed =
      certified.entry.payload.kind === 'command'
        ? commandHash(certified.entry.payload.signed)
        : null;
    for (const pending of this.pending.splice(0)) {
      this.options.clock.clearTimeout(pending.pendingTimer);
      pending.resolve(
        committed === pending.hash
          ? success(undefined)
          : failure(
              'renewed-intent',
              'A different value committed; confirm the command against the new head',
            ),
      );
    }
  }

  private settleMembership(certified: CertifiedEntry): void {
    const pending = this.membershipIntent;
    this.membershipIntent = null;
    if (!pending) return;
    if (pending.pendingTimer !== undefined) this.options.clock.clearTimeout(pending.pendingTimer);
    const payload = certified.entry.payload;
    const committed = payload.kind === 'membership' ? toHex(hashValue(payload.change)) : null;
    pending.resolve?.(
      committed === pending.hash
        ? success(undefined)
        : failure('renewed-intent', 'Membership intent changed at the certified parent'),
    );
  }

  private resolvePending(hash: string, result: Result<void>): void {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const pending = this.pending[index];
      if (!pending || pending.hash !== hash) continue;
      this.pending.splice(index, 1);
      this.options.clock.clearTimeout(pending.pendingTimer);
      pending.resolve(result);
    }
  }

  private scheduleConsensusTimeout(phase: TimeoutPhase, round: number): void {
    const height = this.context.log.head.seq + 1;
    const key = `${height}/${round}/${phase}`;
    if (this.timers.has(key)) return;
    const base = phase === 'propose' ? 1_000 : 750;
    const delay = Math.min(2_147_483_647, base * 2 ** Math.min(round - 1, 22));
    const handle = this.options.clock.setTimeout(() => {
      this.timers.delete(key);
      void this.enqueue(() =>
        height === this.context.log.head.seq + 1
          ? this.activeController().dispatch({ kind: 'timeout', phase, round })
          : Promise.resolve(success(undefined)),
      );
    }, delay);
    this.timers.set(key, handle);
  }

  private clearConsensusTimers(): void {
    for (const handle of this.timers.values()) this.options.clock.clearTimeout(handle);
    this.timers.clear();
  }

  private schedulePulse(): void {
    if (this.disposed) return;
    if (this.pulseTimer !== null) this.options.clock.clearTimeout(this.pulseTimer);
    this.pulseTimer = this.options.clock.setTimeout(() => {
      void this.enqueue(() => this.pulse(), true);
    }, 2_000);
  }

  private async pulse(): Promise<Result<void>> {
    try {
      if (this.derivedRepair) return this.requestDerivedSnapshot();
      this.observeAllRecoveryPresence();
      this.notifyAutoTakeoverEligibility();
      const snapshot = this.activeController().snapshot();
      if (!snapshot.ok) return snapshot;
      const body = {
        genesisDigest: this.context.membership.genesisDigest,
        epoch: this.context.membership.epoch,
        seat: this.options.seat,
        head: { seq: this.context.log.head.seq, hash: entryHash(this.context.log.head) },
        term: snapshot.value.round,
      };
      const heartbeat = this.broadcast({
        t: 'HEARTBEAT',
        body,
        sig: signObject('heartbeat', body, this.secretKey),
      });
      if (!heartbeat.ok) return heartbeat;
      this.broadcastNextCheatClaim();
      for (const pending of this.pending)
        this.requireSend(this.broadcast({ t: 'SUBMIT', cmd: pending.signed }));
      if (this.membershipIntent)
        this.requireSend(
          this.broadcast({ t: 'MEMBERSHIP_SUBMIT', change: this.membershipIntent.change }),
        );
      const recovered = await this.activeController().resume();
      if (!recovered.ok) return recovered;
      await this.captureCertifiedDelivery();
      const offered = await this.offerAvailableInput(true);
      return offered.ok ? this.requestSync(this.context.log.head.seq + 1) : offered;
    } finally {
      this.schedulePulse();
    }
  }

  private receiveHeartbeat(
    from: PeerId,
    message: Extract<ProtocolMessage, { t: 'HEARTBEAT' }>,
  ): Result<void> {
    const owner = this.context.membership.voters.find((voter) => voter.seat === message.body.seat);
    if (
      !owner ||
      owner.publicKey !== from ||
      !verifyObject('heartbeat', message.body, message.sig, parsePeerId(from)) ||
      message.body.genesisDigest !== this.context.membership.genesisDigest
    )
      return failure('replica-heartbeat', 'Heartbeat signature or membership is invalid');
    if (
      message.body.epoch >= this.context.membership.epoch &&
      message.body.head.seq > this.context.log.head.seq
    )
      return this.requestSync(this.context.log.head.seq + 1);
    if (
      message.body.epoch === this.context.membership.epoch &&
      message.body.head.seq === this.context.log.head.seq &&
      message.body.head.hash !== entryHash(this.context.log.head)
    )
      return failure('replica-conflict', 'Peer reports a conflicting certified head');
    return success(undefined);
  }

  private requestSync(fromSeq: number): Result<void> {
    if (this.options.transport.peers().length === 0) return success(undefined);
    const now = this.options.clock.now();
    if (
      this.lastSyncRequest?.fromSeq === fromSeq &&
      now - this.lastSyncRequest.sentAt < EXPENSIVE_REQUEST_WINDOW_MS
    )
      return success(undefined);
    const sent = this.broadcast({
      t: 'SYNC_REQ',
      genesisDigest: this.context.membership.genesisDigest,
      fromSeq,
    });
    if (sent.ok) {
      this.lastSyncRequest = { fromSeq, sentAt: now };
      this.status({ kind: 'sync', fromSeq });
    }
    return sent;
  }

  private async haltForHistoricalConflict(): Promise<Result<void>> {
    const reason = 'A quorum certified an invalid value conflicting with committed history';
    const halted = await this.activeController().dispatch({ kind: 'terminal-halt', reason });
    return halted.ok ? failure('replica-conflict', reason) : halted;
  }

  private sendRequestedProposal(
    from: PeerId,
    message: Extract<ProtocolMessage, { t: 'PROPOSAL_REQ' }>,
  ): Result<void> {
    if (
      message.genesisDigest !== this.context.membership.genesisDigest ||
      message.epoch !== this.context.membership.epoch ||
      message.seq !== this.context.log.head.seq + 1
    )
      return failure('replica-proposal-request', 'Proposal request belongs to another context');
    const snapshot = this.activeController().snapshot();
    if (!snapshot.ok) return snapshot;
    const proposal = snapshot.value.proposals.find(
      (item) =>
        item.body.entry.term === message.term && entryHash(item.body.entry) === message.valueHash,
    );
    return proposal ? this.send(from, { t: 'PROPOSAL', proposal }) : success(undefined);
  }

  private sendCertifiedBatch(from: PeerId, fromSeq: number, toSeq?: number): Result<void> {
    if (fromSeq < 1 || fromSeq > this.entries.length + 1) return success(undefined);
    const upper = Math.min(this.entries.length, toSeq ?? this.entries.length);
    let batch = this.entries.slice(fromSeq - 1, Math.min(upper, fromSeq + 199));
    if (batch.length === 0)
      return this.send(from, {
        t: 'SYNC_RES',
        genesisDigest: this.context.membership.genesisDigest,
        entries: [],
        more: false,
      });
    while (batch.length > 0) {
      const result = this.send(from, {
        t: 'SYNC_RES',
        genesisDigest: this.context.membership.genesisDigest,
        entries: batch,
        more: upper > fromSeq + batch.length - 1,
      });
      if (result.ok) return result;
      batch = batch.slice(0, Math.floor(batch.length / 2));
    }
    return success(undefined);
  }

  private sendReplaySnapshot(
    from: PeerId,
    message: Extract<ProtocolMessage, { t: 'SNAPSHOT_REQ' }>,
  ): Result<void> {
    if (message.genesisDigest !== this.context.membership.genesisDigest)
      return failure('replica-snapshot', 'Snapshot request belongs to another game');
    if (message.atSeq > this.entries.length)
      return failure('replica-snapshot', 'Requested snapshot is beyond the certified prefix');
    const replayed = replayCertifiedPrefix(
      this.genesisEntry,
      this.entries.slice(0, message.atSeq),
      this.options.engine,
      this.options.policy,
    );
    if (!replayed.ok) return replayed;
    return this.send(from, {
      t: 'SNAPSHOT_RES',
      genesisDigest: this.context.membership.genesisDigest,
      atSeq: message.atSeq,
      snapshot: snapshotFromContext(replayed.value.context),
    });
  }

  private send(from: PeerId, message: unknown): Result<void> {
    const encoded = encodeProtocolMessage(message);
    if (!encoded.ok) return encoded;
    try {
      this.options.transport.send(from, encoded.value);
      return success(undefined);
    } catch {
      return failure('replica-transport', 'Could not send protocol message');
    }
  }

  private broadcast(message: unknown): Result<void> {
    const encoded = encodeProtocolMessage(message);
    if (!encoded.ok) return encoded;
    return this.broadcastBytes(encoded.value);
  }

  private broadcastBytes(bytes: Uint8Array): Result<void> {
    try {
      this.options.transport.broadcast(bytes.slice());
      return success(undefined);
    } catch {
      return failure('replica-transport', 'Could not broadcast protocol message');
    }
  }

  private requireSend(result: Result<void>): void {
    if (!result.ok) throw new Error(`Protocol delivery failed: ${result.error.code}`);
  }

  private status(status: ReplicatedLogStatus): void {
    try {
      this.options.onStatus?.(status);
    } catch {
      /* A diagnostic observer has no protocol authority. */
    }
  }

  private failClosed(code: string, message: string): Result<void> {
    this.status({ kind: 'halted', code });
    this.dispose();
    return failure(code, message);
  }
}

function commandHash(command: SignedCommand): string {
  return toHex(hashValue(command));
}

function structuredReveal(packet: SignedMasterReveal): SignedMasterReveal {
  return { ...packet, body: { ...packet.body, result: { ...packet.body.result } } };
}

/** Exact retries stay cheap and cannot turn one local failure into repeated strikes. */
function rememberRejection(rejected: Set<string>, hash: string): boolean {
  if (rejected.has(hash)) return false;
  rejected.add(hash);
  if (rejected.size > 16) {
    const oldest = rejected.keys().next().value;
    if (oldest !== undefined) rejected.delete(oldest);
  }
  return true;
}

function controlForEquivocation(evidence: Equivocation): ExcludeProposerControl {
  return {
    kind: 'control',
    action: 'exclude-proposer',
    offender: evidence.seat,
    evidence:
      evidence.kind === 'vote'
        ? {
            kind: 'vote-equivocation',
            first: evidence.first,
            second: evidence.second,
          }
        : {
            kind: 'proposal-equivocation',
            first: evidence.first,
            second: evidence.second,
          },
  };
}

const FATAL_CONTROLLER_ERRORS = new Set([
  'consensus-context',
  'consensus-restore',
  'consensus-effects',
  'consensus-storage',
  'consensus-write-conflict',
  'consensus-controller',
  'consensus-stopped',
]);

/** Check evidence signatures and basic membership before replaying a certified prefix. */
function authenticateAccusationSignatures(
  control: ExcludeProposerControl,
  context: ProposalContext,
): Result<void> {
  const evidence = control.evidence;
  if (evidence.kind === 'vote-equivocation') {
    const first = validateVote(evidence.first, context.membership);
    const second = validateVote(evidence.second, context.membership);
    return first.ok && second.ok
      ? success(undefined)
      : failure('control-signature', 'Accusation votes require valid voter signatures');
  }
  const proposals =
    evidence.kind === 'proposal-equivocation'
      ? [evidence.first, evidence.second]
      : [evidence.proposal];
  for (const value of proposals) {
    const parsed = parseCanonical(value, signedProposalSchema);
    if (!parsed.ok)
      return failure('control-signature', 'Accusation proposal has an invalid envelope');
    const authenticated = authenticateSignedProposal(parsed.value, context);
    if (!authenticated.ok) return authenticated;
  }
  return success(undefined);
}

/** Verify a proposal's identity and signature before admission to historical replay work. */
function authenticateSignedProposal(
  proposal: SignedProposal,
  context: ProposalContext,
): Result<void> {
  const { body } = proposal;
  const entry = body.entry;
  const voter = context.membership.voters.find((member) => member.publicKey === entry.sequencer);
  if (
    !voter ||
    body.genesisDigest !== context.membership.genesisDigest ||
    body.epoch !== context.membership.epoch
  )
    return failure('replica-signature', 'Proposal does not belong to the active membership');
  try {
    const signer = parsePeerId(entry.sequencer);
    return verifyObject('entry', entryBody(entry), entry.sig, signer) &&
      verifyObject('proposal', body, proposal.sig, signer)
      ? success(undefined)
      : failure('replica-signature', 'Proposal signatures are invalid');
  } catch {
    return failure('replica-signature', 'Proposal signer is invalid');
  }
}

function checkLocalKey(
  options: ReplicatedLogOptions,
  context: ProposalContext,
): Result<LocalConfiguration> {
  if (context.log.genesis.security === 'verified' && !options.cheatCandidateStore)
    return failure('replica-cheat-store', 'Verified sessions need durable cheat candidates');
  if (
    context.log.genesis.security === 'verified' &&
    (!options.beaconSource || !options.beaconContributions)
  )
    return failure('replica-beacon-store', 'Verified sessions need durable beacon contributions');
  const needsDeck = (context.log.crypto?.decks.decks.length ?? 0) > 0;
  if (needsDeck && (!options.createDeckSource || !options.deckContributions))
    return failure(
      'replica-deck-store',
      'Verified decks need local sources and durable contributions',
    );
  if (
    context.log.genesis.security === 'verified' &&
    (!options.countProof || !options.countContributionStore)
  )
    return failure(
      'replica-count-store',
      'Verified sessions need an owner count proof source and durable contributions',
    );
  if (
    context.log.genesis.security === 'verified' &&
    (!options.stealContribution || !options.stealResponse || !options.stealDeliveryStore)
  )
    return failure(
      'replica-steal-store',
      'Verified sessions need owned steal proof sources and durable delivery',
    );
  const keys = new Map<Seat, Uint8Array>();
  let retained = false;
  try {
    const expected = new Map(
      context.log.crypto?.decks.decks.flatMap((deck) =>
        deck.commitment.passHashes.map(
          (hash) => [hash, deck.commitment.definition.deckId] as const,
        ),
      ) ?? [],
    );
    const passes = new Map<string, { deckId: string; pass: unknown }>();
    for (const raw of options.deckSetupPasses ?? []) {
      const parsed = parseCanonical(
        raw,
        v.strictObject({
          deckId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
          pass: v.unknown(),
        }),
      );
      if (!parsed.ok)
        return failure('replica-deck-transcript', 'Local deck transcript is malformed');
      const item = parsed.value;
      const hash = deckPassHash(item.pass);
      if (
        expected.get(hash) !== item.deckId ||
        passes.has(hash) ||
        canonicalEncode(item).length > MAX_MESSAGE_BYTES - 4096
      )
        return failure(
          'replica-deck-transcript',
          'Local deck transcript differs from genesis or exceeds the message bound',
        );
      passes.set(hash, { deckId: item.deckId, pass: item.pass });
    }
    if (
      context.log.crypto?.decks.decks.some((deck) =>
        deck.commitment.passHashes.slice(deck.nextPass).some((hash) => !passes.has(hash)),
      )
    )
      return failure(
        'replica-deck-transcript',
        'Retain every uncommitted deck pass before starting or restoring',
      );
    const signingKey = new Uint8Array(options.secretKey);
    keys.set(options.seat, signingKey);
    const identity = identityFromSecret(signingKey);
    const local = identity.peerId;
    identity.secretKey.fill(0);
    const voter = context.membership.voters.find((member) => member.seat === options.seat);
    if (voter?.publicKey !== local || options.transport.self !== local)
      return failure(
        'replica-key',
        'Local key and authenticated transport do not match the certified voter',
      );
    for (const [seat, rawKey] of options.botKeys ?? []) {
      const bot = context.log.authority?.controllers.find((item) => item.seat === seat);
      if (
        bot?.kind !== 'bot' ||
        bot.status !== 'active' ||
        bot.hostSeat !== options.seat ||
        keys.has(seat)
      )
        return failure('replica-bot-key', 'Bot key is not hosted by this human');
      const key = rawKey.slice();
      keys.set(seat, key);
      const botIdentity = identityFromSecret(key);
      const matches = botIdentity.peerId === bot.publicKey;
      botIdentity.secretKey.fill(0);
      if (!matches) return failure('replica-bot-key', 'Bot key does not match genesis');
    }
    if (
      needsDeck &&
      context.log.authority?.controllers.some(
        (controller) =>
          controller.kind === 'bot' &&
          controller.status === 'active' &&
          controller.hostSeat === options.seat &&
          !keys.has(controller.seat) &&
          (controller.activatedAt.seq === 0 || !options.onAuthorityChange),
      )
    )
      return failure('replica-bot-key', 'Verified decks require keys for every locally hosted bot');
    retained = true;
    return success({ passes, keys, signingKey });
  } catch {
    return failure('replica-key', 'Local voting key is invalid');
  } finally {
    if (!retained) for (const key of keys.values()) key.fill(0);
  }
}

function copyCanonical<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only validated JSON domain values use this detached canonical clone.
  return canonicalDecode(canonicalEncode(value)) as T;
}

function detachedContext(context: ProposalContext): ProposalContext {
  return {
    ...context,
    log: {
      ...context.log,
      engine: { ...context.log.engine },
      genesis: v.parse(genesisSchema, canonicalDecode(canonicalEncode(context.log.genesis))),
      head: v.parse(logEntrySchema, canonicalDecode(canonicalEncode(context.log.head))),
      state: copyCanonical(context.log.state),
      ...(context.log.authority ? { authority: copyCanonical(context.log.authority) } : {}),
      ...(context.log.recovery ? { recovery: copyCanonical(context.log.recovery) } : {}),
      ...(context.log.transfer ? { transfer: copyCanonical(context.log.transfer) } : {}),
      lastNonces: new Map(context.log.lastNonces),
      crypto: copyCanonical(context.log.crypto),
      ...(context.log.timers
        ? {
            timers: context.log.timers.map((timer) => ({
              ...timer,
              pendingSince: { ...timer.pendingSince },
            })),
          }
        : {}),
    },
    membership: {
      ...context.membership,
      voters: context.membership.voters.map((voter) => ({ ...voter })),
    },
    excludedProposers: [...context.excludedProposers],
    policy: { ...context.policy },
  };
}

function detachedValidated(
  value: ValidatedEntry & CertifiedEntry,
): ValidatedEntry & CertifiedEntry {
  return {
    ...value,
    entry: v.parse(logEntrySchema, canonicalDecode(canonicalEncode(value.entry))),
    certificate: copyCanonical([...value.certificate]),
    input: copyCanonical(value.input),
    state: copyCanonical(value.state),
    events: copyCanonical([...value.events]),
    lastNonces: new Map(value.lastNonces),
    crypto: copyCanonical(value.crypto),
    ...(value.authority ? { authority: copyCanonical(value.authority) } : {}),
    ...(value.recovery ? { recovery: copyCanonical(value.recovery) } : {}),
    ...(value.transfer ? { transfer: copyCanonical(value.transfer) } : {}),
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

```

## packages/protocol/src/replicated-log.test.ts

```text
import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Engine, Result, Seat, SystemInput } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import type { ConsensusState } from './consensus.js';
import { entryHash, genesisDigest, genesisId, signEntry, signGenesis } from './genesis.js';
import { MemoryProtocolJournal } from './journal.js';
import { signCommand, stubEvidence } from './log.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import type { ProtocolMessage } from './messages.js';
import { proposerFor, signProposal, validateCertifiedEntry } from './proposal.js';
import type { ProposalContext } from './proposal.js';
import { ReplicatedLog } from './replicated-log.js';
import { initialProposalContext, replayCertifiedPrefix, snapshotFromContext } from './replay.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';
import type { PeerId, ProtocolClock, Transport, Unsubscribe } from './transport.js';
import { signVote } from './votes.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function mutateNonceMap(nonces: ReadonlyMap<Seat, number>): void {
  if (nonces instanceof Map) nonces.set(0, 999);
}

class ManualClock implements ProtocolClock {
  private nextId = 1;
  private time = 0;
  readonly scheduled = new Map<number, () => void>();
  now(): number {
    return this.time;
  }
  advance(ms: number): void {
    this.time += ms;
  }
  setTimeout(callback: () => void, _delayMs: number): unknown {
    const id = this.nextId++;
    this.scheduled.set(id, callback);
    return id;
  }
  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.scheduled.delete(handle);
  }
  fireLatest(): void {
    const latest = [...this.scheduled].at(-1);
    if (!latest) throw new Error('No scheduled timeout');
    this.scheduled.delete(latest[0]);
    latest[1]();
  }
  fireFirst(): void {
    const first = this.scheduled.entries().next().value;
    if (!first) throw new Error('No scheduled timeout');
    this.scheduled.delete(first[0]);
    first[1]();
  }
  fire(handle: unknown): void {
    if (typeof handle !== 'number') throw new Error('Missing timer handle');
    const callback = this.scheduled.get(handle);
    if (!callback) throw new Error('Timer is not scheduled');
    this.scheduled.delete(handle);
    callback();
  }
}

class CapturingTransport implements Transport {
  readonly sent: ProtocolMessage[] = [];
  readonly disconnected: PeerId[] = [];
  private listener: ((from: PeerId, bytes: Uint8Array) => void) | null = null;
  constructor(
    readonly self: PeerId,
    private readonly connected: PeerId[] = [],
  ) {}
  peers(): PeerId[] {
    return [...this.connected];
  }
  send(_to: PeerId, bytes: Uint8Array): void {
    this.sent.push(value(decodeProtocolMessage(bytes)));
  }
  broadcast(bytes: Uint8Array): void {
    this.sent.push(value(decodeProtocolMessage(bytes)));
  }
  disconnect(peer: PeerId): void {
    this.disconnected.push(peer);
  }
  onMessage(listener: (from: PeerId, bytes: Uint8Array) => void): Unsubscribe {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }
  onPeerChange(_listener: (peer: PeerId, online: boolean) => void): Unsubscribe {
    return () => undefined;
  }
  inject(from: PeerId, message: unknown): void {
    this.listener?.(from, value(encodeProtocolMessage(message)));
  }
  injectBytes(from: PeerId, bytes: Uint8Array): void {
    this.listener?.(from, bytes);
  }
}

class FlakySubmitTransport extends CapturingTransport {
  failedSubmit = false;
  override broadcast(bytes: Uint8Array): void {
    if (!this.failedSubmit && value(decodeProtocolMessage(bytes)).t === 'SUBMIT') {
      this.failedSubmit = true;
      throw new Error('Temporary network send failure');
    }
    super.broadcast(bytes);
  }
}

class FailingRetransmitTransport extends CapturingTransport {
  submitBroadcasts = 0;
  override broadcast(bytes: Uint8Array): void {
    if (value(decodeProtocolMessage(bytes)).t === 'SUBMIT') {
      this.submitBroadcasts++;
      if (this.submitBroadcasts === 2) throw new Error('Temporary retransmit failure');
    }
    super.broadcast(bytes);
  }
}

function fourHumanFixture(): ReturnType<typeof protocolFixture> {
  const source = protocolFixture();
  const body = {
    ...source.body,
    seats: source.body.seats.map((seat) => ({
      seat: seat.seat,
      kind: 'human' as const,
      publicKey: seat.publicKey,
      name: seat.name,
      colour: seat.colour,
    })),
  };
  const genesis = {
    ...body,
    gameId: genesisId(body),
    signatures: source.identities.map((identity, index) =>
      signGenesis(body, fixtureAt(source.body.seats, index).seat, identity.secretKey),
    ),
  };
  return {
    ...source,
    body,
    genesis,
    entry: signEntry(
      { ...source.entry, payload: { kind: 'genesis', genesis } },
      fixtureAt(source.identities, 0).secretKey,
    ),
  };
}

describe('replicated certified log adapter', () => {
  test('proposal retries after a local validator exception neither accuse nor disconnect the proposer', async () => {
    const fixture = protocolFixture();
    const proposer = fixtureAt(fixture.identities, 0);
    const local = fixtureAt(fixture.identities, 1);
    const transport = new CapturingTransport(local.peerId);
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: {
          ...fixture.engine,
          validate() {
            throw new Error('Injected local validator failure');
          },
        },
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 1,
        secretKey: local.secretKey,
        transport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
      }),
    );
    const context = replica.getContext();
    // The signatures are authentic. A failed local validator cannot establish
    // whether this command is illegal, so it cannot justify an accusation.
    const signed = signCommand(
      {
        gameId: fixture.genesis.gameId,
        genesisDigest: context.membership.genesisDigest,
        seat: 0,
        nonce: 1,
        headSeq: 0,
        headHash: entryHash(context.log.head),
        command: { type: 'END_TURN' },
      },
      proposer.secretKey,
    );
    const entry = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(context.log.head),
        payload: { kind: 'command', signed },
        stateHash: context.log.head.stateHash,
        sequencer: proposer.peerId,
      },
      proposer.secretKey,
    );
    const proposal = signProposal(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        entry,
        validRound: null,
        prevotes: [],
      },
      proposer.secretKey,
    );
    for (let retry = 0; retry < 8; retry++) {
      transport.inject(proposer.peerId, { t: 'PROPOSAL', proposal });
      // oxlint-disable-next-line no-await-in-loop -- Exercise actual transport retries after local validation fails.
      await replica.flush();
    }
    expect(transport.disconnected).toEqual([]);
    expect(transport.sent.some((message) => message.t === 'ACCUSE' || message.t === 'VOTE')).toBe(
      false,
    );
    expect(replica.getContext().log.head.seq).toBe(0);
    expect(replica.getContext().excludedProposers).toEqual([]);
    expect(replica['disposed']).toBe(false);
    const snapshot = value(replica['activeController']().snapshot());
    expect(snapshot.halted).toBeNull();
    expect(snapshot.provenOffender).toBeNull();
    replica.dispose();
  });

  test('bounds fresh invalid proposal variants from an elected proposer before they starve votes', async () => {
    const fixture = protocolFixture();
    const proposer = fixtureAt(fixture.identities, 0);
    const local = fixtureAt(fixture.identities, 1);
    const transport = new CapturingTransport(local.peerId);
    let derivations = 0;
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: {
          ...fixture.engine,
          apply(state, input) {
            derivations++;
            return fixture.engine.apply(state, input);
          },
        },
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 1,
        secretKey: local.secretKey,
        transport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
      }),
    );
    const context = replica.getContext();
    const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
    for (let variant = 0; variant < 8; variant++) {
      const entry = signEntry(
        {
          seq: 1,
          term: 1,
          prevHash: entryHash(context.log.head),
          payload: { kind: 'system', input, evidence: stubEvidence(context.log, input) },
          stateHash: variant.toString(16).padStart(64, '0'),
          sequencer: proposer.peerId,
        },
        proposer.secretKey,
      );
      transport.inject(proposer.peerId, {
        t: 'PROPOSAL',
        proposal: signProposal(
          {
            genesisDigest: context.membership.genesisDigest,
            epoch: 0,
            entry,
            validRound: null,
            prevotes: [],
          },
          proposer.secretKey,
        ),
      });
      // oxlint-disable-next-line no-await-in-loop -- Model a sender refilling the queue after each invalid proposal.
      await replica.flush();
    }
    expect(derivations).toBe(5);
    expect(transport.disconnected).toEqual([proposer.peerId]);
    expect(replica.getContext().log.head.seq).toBe(0);
    expect(replica['disposed']).toBe(false);
    expect(transport.sent.some((message) => message.t === 'VOTE')).toBe(false);
    replica.dispose();
  });

  test('rejects bad command proofs before queueing and cannot let them block a valid command', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const transport = new CapturingTransport(first.peerId);
    let checks = 0;
    let rejectAll = false;
    let rejectApply = false;
    let rejectInvariants = false;
    let throwValidate = false;
    let throwApply = false;
    const engine: Engine = {
      ...fixture.engine,
      validate(state, input) {
        if (throwValidate) throw new Error('Injected validator failure');
        return fixture.engine.validate(state, input);
      },
      apply: (state, input) => {
        if (throwApply) throw new Error('Injected reducer failure');
        return rejectApply
          ? failure('test-apply', 'Injected reducer rejection')
          : fixture.engine.apply(state, input);
      },
      checkInvariants: (state) =>
        rejectInvariants ? ['Injected invariant violation'] : fixture.engine.checkInvariants(state),
    };
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine,
        policy: {
          genesis: { allowStub: true },
          entry: {
            allowStub: true,
            verifyCommand: (signed) => {
              checks++;
              return !rejectAll && signed.body.evidence?.data === true
                ? success(undefined)
                : failure('test-bad-proof', 'Invalid command proof');
            },
          },
        },
        seat: 0,
        secretKey: first.secretKey,
        transport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
        systemInput: (context) => {
          if (context.log.head.seq !== 0) return null;
          const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
          return { input, evidence: stubEvidence(context.log, input) };
        },
      }),
    );
    const firstProposal = transport.sent.find((message) => message.t === 'PROPOSAL');
    if (firstProposal?.t !== 'PROPOSAL') throw new Error('Expected initial system proposal');
    const finishVotes = async (entry: typeof firstProposal.proposal.body.entry) => {
      const vote = (phase: 'prevote' | 'precommit') =>
        signVote(
          {
            genesisDigest: genesisDigest(fixture.genesis),
            epoch: 0,
            seat: 1,
            seq: entry.seq,
            term: entry.term,
            phase,
            valueHash: entryHash(entry),
          },
          second.secretKey,
        );
      transport.inject(second.peerId, { t: 'VOTE', vote: vote('prevote') });
      await replica.flush();
      transport.inject(second.peerId, { t: 'VOTE', vote: vote('precommit') });
      await replica.flush();
    };
    await finishVotes(firstProposal.proposal.body.entry);
    expect(replica.getContext().log.head.seq).toBe(1);
    const context = replica.getContext();
    const command = context.log.engine.getLegalCommands(context.log.state, 0).commands[0];
    if (!command) throw new Error('Expected a real legal setup command');
    const signed = (proof: boolean, nonce = 1) =>
      signCommand(
        {
          gameId: fixture.genesis.gameId,
          genesisDigest: context.membership.genesisDigest,
          seat: 0,
          nonce,
          headSeq: context.log.head.seq,
          headHash: entryHash(context.log.head),
          command,
          evidence: { protocol: 'test-proof', data: proof },
        },
        first.secretKey,
      );
    const bad = signed(false);
    expect(await replica.submit(bad)).toMatchObject({
      ok: false,
      error: { code: 'test-bad-proof' },
    });
    transport.inject(second.peerId, { t: 'SUBMIT', cmd: bad });
    await replica.flush();
    expect(replica['commands']).toEqual([]);
    expect(transport.sent.some((message) => message.t === 'ACCUSE')).toBe(false);
    const good = signed(true, 4);
    // Public command legality alone is insufficient. Admission must also run
    // the reducer and invariants before followers mark an input as available.
    rejectApply = true;
    expect(await replica.submit(good)).toMatchObject({ ok: false, error: { code: 'test-apply' } });
    rejectApply = false;
    rejectInvariants = true;
    expect(await replica.submit(good)).toMatchObject({ ok: false, error: { code: 'entry-state' } });
    transport.inject(second.peerId, { t: 'SUBMIT', cmd: signed(true, 1) });
    await replica.flush();
    expect(replica['commands']).toEqual([]);
    const afterInvariantFailure = checks;
    for (let retry = 0; retry < 6; retry++) {
      transport.inject(second.peerId, { t: 'SUBMIT', cmd: signed(true, 1) });
      // oxlint-disable-next-line no-await-in-loop -- Retries after a local fault must not spend more strikes or proof work.
      await replica.flush();
    }
    expect(checks).toBe(afterInvariantFailure);
    expect(transport.disconnected).toEqual([]);
    rejectInvariants = false;
    throwApply = true;
    expect(await replica.submit(good)).toMatchObject({
      ok: false,
      error: { code: 'entry-verification-failed' },
    });
    transport.inject(second.peerId, { t: 'SUBMIT', cmd: signed(true, 2) });
    await replica.flush();
    throwApply = false;
    throwValidate = true;
    expect(await replica.submit(good)).toMatchObject({
      ok: false,
      error: { code: 'entry-verification-failed' },
    });
    transport.inject(second.peerId, { t: 'SUBMIT', cmd: signed(true, 3) });
    await replica.flush();
    throwValidate = false;
    expect(replica['disposed']).toBe(false);
    expect(replica['commands']).toEqual([]);
    transport.inject(second.peerId, { t: 'SUBMIT', cmd: good });
    await replica.flush();
    expect(replica['commands']).toEqual([good]);
    const afterAdmission = checks;
    transport.inject(second.peerId, { t: 'SUBMIT', cmd: good });
    await replica.flush();
    expect(checks).toBe(afterAdmission);
    // Even a local policy change after admission cannot leave an invalid head item blocking the queue.
    rejectAll = true;
    expect(replica['candidate'](value(replica['activeController']().snapshot()))).toBeNull();
    expect(replica['commands']).toEqual([]);
    rejectAll = false;
    transport.inject(second.peerId, { t: 'SUBMIT', cmd: good });
    await replica.flush();
    const applied = value(
      fixture.engine.apply(context.log.state, { kind: 'command', seat: 0, command }),
    );
    const entry = signEntry(
      {
        seq: 2,
        term: 1,
        prevHash: entryHash(context.log.head),
        payload: { kind: 'command', signed: good },
        stateHash: toHex(hashValue(applied.state)),
        sequencer: second.peerId,
      },
      second.secretKey,
    );
    transport.inject(second.peerId, {
      t: 'PROPOSAL',
      proposal: signProposal(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          entry,
          validRound: null,
          prevotes: [],
        },
        second.secretKey,
      ),
    });
    await replica.flush();
    await finishVotes(entry);
    expect(replica.getContext().log.head.seq).toBe(2);
    expect(replica.getContext().excludedProposers).toEqual([]);
    // Honest retransmissions from the previous parent are cheap and are not strikes.
    const afterCommit = checks;
    for (let retry = 0; retry < 6; retry++) {
      transport.inject(second.peerId, { t: 'SUBMIT', cmd: bad });
      // oxlint-disable-next-line no-await-in-loop -- Model sequential retries, not queue overflow.
      await replica.flush();
    }
    expect(checks).toBe(afterCommit);
    expect(transport.disconnected).toEqual([]);
    const current = replica.getContext();
    const nextCommand = current.log.engine.getLegalCommands(current.log.state, 0).commands[0];
    if (!nextCommand) throw new Error('Expected the road after the setup settlement');
    const invalidProof = (nonce: number) =>
      signCommand(
        {
          ...good.body,
          nonce,
          headSeq: current.log.head.seq,
          headHash: entryHash(current.log.head),
          command: nextCommand,
          evidence: { protocol: 'test-proof', data: false },
        },
        first.secretKey,
      );
    // The bad proof, invariant and thrown validators used four strikes. One more failure
    // disconnects the sender, including when the callback uses its own error code.
    for (let retry = 0; retry < 8; retry++) {
      transport.inject(second.peerId, { t: 'SUBMIT', cmd: invalidProof(5 + retry) });
      // oxlint-disable-next-line no-await-in-loop -- Each fresh invalid value spends one strike before the next variant.
      await replica.flush();
    }
    expect(checks - afterCommit).toBe(1);
    expect(transport.disconnected).toEqual([second.peerId]);
    expect(replica['commands']).toEqual([]);
    expect(transport.sent.some((message) => message.t === 'ACCUSE')).toBe(false);
    replica.dispose();
  });

  test('one signed sender cannot evict another seat from pending command admission', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const transport = new CapturingTransport(first.peerId);
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 0,
        secretKey: first.secretKey,
        transport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
      }),
    );
    const context = replica.getContext();
    const signed = (seat: 0 | 1, nonce: number) =>
      signCommand(
        {
          gameId: fixture.genesis.gameId,
          genesisDigest: context.membership.genesisDigest,
          seat,
          nonce,
          headSeq: 0,
          headHash: entryHash(context.log.head),
          command: { type: 'END_TURN' },
        },
        fixtureAt(fixture.identities, seat).secretKey,
      );
    // Admission runs after command validation; exercise its bounded queue directly.
    const otherSeat = signed(1, 1);
    expect(replica['rememberCommand'](otherSeat)).toBe(true);
    for (let nonce = 1; nonce <= 40; nonce++)
      expect(replica['rememberCommand'](signed(0, nonce))).toBe(nonce <= 4);
    expect(replica['commands'].map(({ body }) => [body.seat, body.nonce])).toEqual([
      [1, 1],
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
    ]);
    replica.dispose();
  });

  test('a forged local prevote embedded in an offender proposal cannot halt the honest voter', async () => {
    const fixture = protocolFixture();
    const offender = fixtureAt(fixture.identities, 0);
    const local = fixtureAt(fixture.identities, 1);
    const transport = new CapturingTransport(local.peerId);
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 1,
        secretKey: local.secretKey,
        transport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
      }),
    );
    const context = replica.getContext();
    const invalidCommand = signCommand(
      {
        gameId: fixture.genesis.gameId,
        genesisDigest: context.membership.genesisDigest,
        seat: 0,
        nonce: 1,
        headSeq: 0,
        headHash: entryHash(context.log.head),
        command: { type: 'END_TURN' },
      },
      local.secretKey,
    );
    const entry = signEntry(
      {
        seq: 1,
        term: 3,
        prevHash: entryHash(context.log.head),
        payload: { kind: 'command', signed: invalidCommand },
        stateHash: context.log.head.stateHash,
        sequencer: offender.peerId,
      },
      offender.secretKey,
    );
    const forgedLocalVote = signVote(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        seat: 1,
        seq: 1,
        term: 1,
        phase: 'prevote',
        valueHash: entryHash(entry),
      },
      offender.secretKey,
    );
    const proposal = signProposal(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        entry,
        validRound: 1,
        prevotes: [forgedLocalVote],
      },
      offender.secretKey,
    );
    transport.inject(offender.peerId, { t: 'PROPOSAL', proposal });
    await replica.flush();
    expect(transport.sent.some((message) => message.t === 'ACCUSE')).toBe(true);
    const safety = replica['activeController']().snapshot();
    expect(value(safety).halted).toBeNull();
    expect(value(safety).pendingAccusation?.offender).toBe(0);
    replica.dispose();
  });

  test('gossips only authenticated objective invalid-command accusations without changing voters', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const transport = new CapturingTransport(second.peerId);
    const clock = new ManualClock();
    const journal = new MemoryProtocolJournal();
    const options = {
      genesisEntry: fixture.entry,
      engine: fixture.engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat: 1 as const,
      secretKey: second.secretKey,
      transport,
      clock,
      journal,
    };
    const replica = value(await ReplicatedLog.create(options));
    const context = replica.getContext();
    const invalidCommand = signCommand(
      {
        gameId: fixture.genesis.gameId,
        genesisDigest: context.membership.genesisDigest,
        seat: 0,
        nonce: 1,
        headSeq: 0,
        headHash: entryHash(context.log.head),
        command: { type: 'END_TURN' },
      },
      second.secretKey,
    );
    const entry = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(context.log.head),
        payload: { kind: 'command', signed: invalidCommand },
        stateHash: context.log.head.stateHash,
        sequencer: first.peerId,
      },
      first.secretKey,
    );
    const proposal = signProposal(
      {
        genesisDigest: context.membership.genesisDigest,
        epoch: 0,
        entry,
        validRound: null,
        prevotes: [],
      },
      first.secretKey,
    );
    transport.inject(first.peerId, { t: 'PROPOSAL', proposal });
    await replica.flush();
    const accusation = transport.sent.find((message) => message.t === 'ACCUSE');
    expect(accusation).toMatchObject({
      t: 'ACCUSE',
      control: {
        action: 'exclude-proposer',
        offender: 0,
        evidence: { kind: 'invalid-command' },
      },
    });
    expect(replica.getContext().membership.voters).toHaveLength(2);
    expect(replica.getContext().excludedProposers).toEqual([]);
    expect(replica.getContext().log.head.seq).toBe(0);

    clock.fireLatest();
    await replica.flush();
    const nilVote = (phase: 'prevote' | 'precommit') =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: 0,
          seat: 0,
          seq: 1,
          term: 1,
          phase,
          valueHash: null,
        },
        first.secretKey,
      );
    transport.inject(first.peerId, { t: 'VOTE', vote: nilVote('prevote') });
    await replica.flush();
    transport.inject(first.peerId, { t: 'VOTE', vote: nilVote('precommit') });
    await replica.flush();
    clock.fireLatest();
    await replica.flush();
    expect(
      transport.sent.some(
        (message) =>
          message.t === 'PROPOSAL' && message.proposal.body.entry.payload.kind === 'control',
      ),
    ).toBe(true);

    const forged = signProposal(
      {
        ...proposal.body,
        entry: signEntry({ ...entry, stateHash: 'f'.repeat(64) }, first.secretKey),
      },
      second.secretKey,
    );
    transport.inject(first.peerId, { t: 'PROPOSAL', proposal: forged });
    await replica.flush();
    expect(transport.sent.filter((message) => message.t === 'ACCUSE')).toHaveLength(1);
    const beforeCrash = await journal.load();
    expect(beforeCrash).not.toBeNull();
    replica.dispose();
    const restartedTransport = new CapturingTransport(second.peerId);
    const restarted = value(
      await ReplicatedLog.restore({ ...options, transport: restartedTransport }),
    );
    await restarted.flush();
    expect(restartedTransport.sent.filter((message) => message.t === 'ACCUSE')).toEqual(
      transport.sent.filter((message) => message.t === 'ACCUSE'),
    );
    expect((await journal.load())?.safety.bytes).toEqual(beforeCrash?.safety.bytes);
    restarted.dispose();
  });

  test('restores and revalidates persisted equivocation evidence after an ACCUSE send crash', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const journal = new MemoryProtocolJournal();
    const clock = new ManualClock();
    const transport = new CapturingTransport(second.peerId);
    const options = {
      genesisEntry: fixture.entry,
      engine: fixture.engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat: 1 as const,
      secretKey: second.secretKey,
      transport,
      clock,
      journal,
    };
    const replica = value(await ReplicatedLog.create(options));
    const vote = (valueHash: string | null) =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat: 0,
          seq: 1,
          term: 1,
          phase: 'prevote',
          valueHash,
        },
        first.secretKey,
      );
    transport.inject(first.peerId, { t: 'VOTE', vote: vote(null) });
    transport.inject(first.peerId, { t: 'VOTE', vote: vote('a'.repeat(64)) });
    await replica.flush();
    expect(transport.sent.filter((message) => message.t === 'ACCUSE')).toHaveLength(1);
    const saved = await journal.load();
    expect(saved?.height).toBe(1);
    replica.dispose();

    const restartedTransport = new CapturingTransport(second.peerId);
    const restarted = value(
      await ReplicatedLog.restore({ ...options, transport: restartedTransport }),
    );
    await restarted.flush();
    expect(restartedTransport.sent.filter((message) => message.t === 'ACCUSE')).toEqual(
      transport.sent.filter((message) => message.t === 'ACCUSE'),
    );
    expect((await journal.load())?.height).toBe(1);
    expect(restarted.getContext().excludedProposers).toEqual([]);
    restarted.dispose();
  });

  test('retains an accepted peer accusation before gossip and replays it after restart', async () => {
    const fixture = fourHumanFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const local = fixtureAt(fixture.identities, 2);
    const journal = new MemoryProtocolJournal();
    const transport = new CapturingTransport(local.peerId);
    const options = {
      genesisEntry: fixture.entry,
      engine: fixture.engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat: 2 as const,
      secretKey: local.secretKey,
      transport,
      clock: new ManualClock(),
      journal,
    };
    const replica = value(await ReplicatedLog.create(options));
    const vote = (valueHash: string | null) =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat: 0,
          seq: 1,
          term: 1,
          phase: 'prevote',
          valueHash,
        },
        first.secretKey,
      );
    const control = {
      kind: 'control' as const,
      action: 'exclude-proposer' as const,
      offender: 0 as const,
      evidence: {
        kind: 'vote-equivocation' as const,
        first: vote(null),
        second: vote('a'.repeat(64)),
      },
    };
    transport.inject(second.peerId, { t: 'ACCUSE', control });
    await replica.flush();
    expect(transport.sent.filter((message) => message.t === 'ACCUSE')).toEqual([
      { t: 'ACCUSE', control },
    ]);
    const beforeCrash = await journal.load();
    replica.dispose();

    const restartedTransport = new CapturingTransport(local.peerId);
    const restarted = value(
      await ReplicatedLog.restore({ ...options, transport: restartedTransport }),
    );
    await restarted.flush();
    expect(restartedTransport.sent.filter((message) => message.t === 'ACCUSE')).toEqual([
      { t: 'ACCUSE', control },
    ]);
    expect((await journal.load())?.safety.bytes).toEqual(beforeCrash?.safety.bytes);
    expect(restarted.getContext().excludedProposers).toEqual([]);
    restarted.dispose();
  });

  test('carries a first proof across a gameplay commit and durably halts on a second offender', async () => {
    const fixture = fourHumanFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const local = fixtureAt(fixture.identities, 2);
    const journal = new MemoryProtocolJournal();
    const transport = new CapturingTransport(local.peerId);
    const options = {
      genesisEntry: fixture.entry,
      engine: fixture.engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat: 2 as const,
      secretKey: local.secretKey,
      transport,
      clock: new ManualClock(),
      journal,
    };
    const replica = value(await ReplicatedLog.create(options));
    const accusation = (seat: 0 | 1, seq: number) => {
      const owner = fixtureAt(fixture.identities, seat);
      const vote = (valueHash: string | null) =>
        signVote(
          {
            genesisDigest: genesisDigest(fixture.genesis),
            epoch: 0,
            seat,
            seq,
            term: 1,
            phase: 'prevote',
            valueHash,
          },
          owner.secretKey,
        );
      return {
        kind: 'control' as const,
        action: 'exclude-proposer' as const,
        offender: seat,
        evidence: {
          kind: 'vote-equivocation' as const,
          first: vote(null),
          second: vote('a'.repeat(64)),
        },
      };
    };
    transport.inject(second.peerId, { t: 'ACCUSE', control: accusation(0, 1) });
    await replica.flush();

    const before = replica.getContext();
    const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
    const applied = value(fixture.engine.apply(before.log.state, input));
    const entry = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(before.log.head),
        payload: { kind: 'system', input, evidence: stubEvidence(before.log, input) },
        stateHash: toHex(hashValue(applied.state)),
        sequencer: first.peerId,
      },
      first.secretKey,
    );
    const hash = entryHash(entry);
    const certificate = [0, 1, 3].map((seat) =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat: fixtureAt(fixture.body.seats, seat).seat,
          seq: 1,
          term: 1,
          phase: 'precommit',
          valueHash: hash,
        },
        fixtureAt(fixture.identities, seat).secretKey,
      ),
    );
    transport.inject(second.peerId, { t: 'COMMIT', certified: { entry, certificate } });
    await replica.flush();
    expect(replica.getContext().log.head.seq).toBe(1);
    expect(replica.getContext().excludedProposers).toEqual([]);
    replica.dispose();

    const restartedTransport = new CapturingTransport(local.peerId);
    const restarted = value(
      await ReplicatedLog.restore({ ...options, transport: restartedTransport }),
    );
    restartedTransport.inject(first.peerId, { t: 'ACCUSE', control: accusation(1, 2) });
    await restarted.flush();
    const savedHalt = await journal.load();
    expect(savedHalt?.height).toBe(2);
    expect(restarted.getContext().log.head.seq).toBe(1);
    restarted.dispose();

    const again = value(
      await ReplicatedLog.restore({
        ...options,
        transport: new CapturingTransport(local.peerId),
      }),
    );
    expect((await journal.load())?.safety.bytes).toEqual(savedHalt?.safety.bytes);
    expect(
      await again.submit(
        signCommand(
          {
            gameId: fixture.genesis.gameId,
            genesisDigest: genesisDigest(fixture.genesis),
            seat: 2,
            nonce: 1,
            headSeq: 1,
            headHash: entryHash(entry),
            command: { type: 'END_TURN' },
          },
          local.secretKey,
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: 'replica-halted' } });
    again.dispose();

    const retained = await journal.load();
    if (!retained) throw new Error('Missing retained voting record');
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The journal record was already verified on restore above.
    const state = canonicalDecode(retained.safety.bytes) as ConsensusState;
    if (!state.provenOffender) throw new Error('Missing retained first-offender proof');
    expect(
      await journal.saveSafety(
        retained.height,
        retained.safety.revision,
        canonicalEncode({
          ...state,
          provenOffender: { ...state.provenOffender, parentHash: 'f'.repeat(64) },
        }),
      ),
    ).toBe(true);
    expect(
      await ReplicatedLog.restore({
        ...options,
        transport: new CapturingTransport(local.peerId),
      }),
    ).toMatchObject({ ok: false, error: { code: 'consensus-restore' } });
  });

  test('certifies an old first-offender proof only against its replayed historical parent', async () => {
    const fixture = fourHumanFixture();
    const policy = { genesis: { allowStub: true }, entry: { allowStub: true } };
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const initial = value(initialProposalContext(fixture.entry, fixture.engine, policy));
    const proofVote = (hash: string | null) =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat: 0,
          seq: 1,
          term: 1,
          phase: 'prevote',
          valueHash: hash,
        },
        first.secretKey,
      );
    const control = {
      kind: 'control' as const,
      action: 'exclude-proposer' as const,
      offender: 0 as const,
      evidence: {
        kind: 'vote-equivocation' as const,
        first: proofVote(null),
        second: proofVote('a'.repeat(64)),
      },
    };
    const precommit = (seq: number, hash: string) =>
      [0, 1, 3].map((index) =>
        signVote(
          {
            genesisDigest: genesisDigest(fixture.genesis),
            epoch: 0,
            seat: fixtureAt(fixture.body.seats, index).seat,
            seq,
            term: 1,
            phase: 'precommit',
            valueHash: hash,
          },
          fixtureAt(fixture.identities, index).secretKey,
        ),
      );
    const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
    const state = value(fixture.engine.apply(initial.log.state, input));
    const gameplay = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(initial.log.head),
        payload: { kind: 'system', input, evidence: stubEvidence(initial.log, input) },
        stateHash: toHex(hashValue(state.state)),
        sequencer: first.peerId,
      },
      first.secretKey,
    );
    const firstCertified = { entry: gameplay, certificate: precommit(1, entryHash(gameplay)) };
    const current = value(
      replayCertifiedPrefix(fixture.entry, [firstCertified], fixture.engine, policy),
    );
    const exclusion = signEntry(
      {
        seq: 2,
        term: 1,
        prevHash: entryHash(gameplay),
        payload: control,
        stateHash: gameplay.stateHash,
        sequencer: second.peerId,
      },
      second.secretKey,
    );
    const secondCertified = { entry: exclusion, certificate: precommit(2, entryHash(exclusion)) };
    expect(current.context.excludedProposers).toEqual([]);
    const replayed = value(
      replayCertifiedPrefix(
        fixture.entry,
        [firstCertified, secondCertified],
        fixture.engine,
        policy,
      ),
    );
    expect(replayed.context.excludedProposers).toEqual([0]);
    expect(replayed.context.membership.voters).toHaveLength(4);

    // A lagging peer never saw the ACCUSE, only the certified entries.
    const local = fixtureAt(fixture.identities, 2);
    const journal = new MemoryProtocolJournal();
    const transport = new CapturingTransport(local.peerId);
    const options = {
      genesisEntry: fixture.entry,
      engine: fixture.engine,
      policy,
      seat: 2 as const,
      secretKey: local.secretKey,
      transport,
      clock: new ManualClock(),
      journal,
    };
    const lagging = value(await ReplicatedLog.create(options));
    transport.inject(second.peerId, {
      t: 'SYNC_RES',
      genesisDigest: genesisDigest(fixture.genesis),
      entries: [firstCertified, secondCertified],
      more: false,
    });
    await lagging.flush();
    expect(lagging.getContext().log.head.seq).toBe(2);
    expect(lagging.getContext().excludedProposers).toEqual([0]);
    lagging.dispose();
    const restoredTransport = new CapturingTransport(local.peerId);
    const restored = value(
      await ReplicatedLog.restore({ ...options, transport: restoredTransport }),
    );
    expect(restored.getContext().excludedProposers).toEqual([0]);
    const conflicting = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(fixture.entry),
        payload: control,
        stateHash: fixture.entry.stateHash,
        sequencer: first.peerId,
      },
      first.secretKey,
    );
    restoredTransport.inject(second.peerId, {
      t: 'COMMIT',
      certified: { entry: conflicting, certificate: precommit(1, entryHash(conflicting)) },
    });
    await restored.flush();
    restored.dispose();
    const terminal = value(
      await ReplicatedLog.restore({
        ...options,
        transport: new CapturingTransport(local.peerId),
      }),
    );
    expect(
      await terminal.submit(
        signCommand(
          {
            gameId: fixture.genesis.gameId,
            genesisDigest: genesisDigest(fixture.genesis),
            seat: 2,
            nonce: 1,
            headSeq: 2,
            headHash: entryHash(exclusion),
            command: { type: 'END_TURN' },
          },
          local.secretKey,
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: 'replica-halted' } });
    terminal.dispose();
  });

  test('commits a retained historical accusation after ordinary gameplay won the first height', async () => {
    const fixture = fourHumanFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const local = fixtureAt(fixture.identities, 2);
    const transport = new CapturingTransport(local.peerId);
    const journal = new MemoryProtocolJournal();
    let replayCreates = 0;
    let proofChecks = 0;
    const engine: Engine = {
      ...fixture.engine,
      createGame(config, seed) {
        replayCreates++;
        return fixture.engine.createGame(config, seed);
      },
      checkInvariants(state) {
        proofChecks++;
        return fixture.engine.checkInvariants(state);
      },
    };
    const options = {
      genesisEntry: fixture.entry,
      engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat: 2 as const,
      secretKey: local.secretKey,
      transport,
      clock: new ManualClock(),
      journal,
    };
    const replica = value(await ReplicatedLog.create(options));
    const digest = genesisDigest(fixture.genesis);
    const vote = (
      seat: 0 | 1 | 2 | 3,
      seq: number,
      phase: 'prevote' | 'precommit',
      hash: string | null,
    ) =>
      signVote(
        { genesisDigest: digest, epoch: 0, seat, seq, term: 1, phase, valueHash: hash },
        fixtureAt(fixture.identities, seat).secretKey,
      );
    const control = {
      kind: 'control' as const,
      action: 'exclude-proposer' as const,
      offender: 0 as const,
      evidence: {
        kind: 'vote-equivocation' as const,
        first: vote(0, 1, 'prevote', null),
        second: vote(0, 1, 'prevote', 'a'.repeat(64)),
      },
    };
    transport.inject(fixtureAt(fixture.identities, 3).peerId, { t: 'ACCUSE', control });
    await replica.flush();
    const before = replica.getContext();
    const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
    const applied = value(fixture.engine.apply(before.log.state, input));
    const gameplay = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(before.log.head),
        payload: { kind: 'system', input, evidence: stubEvidence(before.log, input) },
        stateHash: toHex(hashValue(applied.state)),
        sequencer: first.peerId,
      },
      first.secretKey,
    );
    const certificate = (seq: number, hash: string) =>
      ([0, 1, 3] as const).map((seat) => vote(seat, seq, 'precommit', hash));
    transport.inject(second.peerId, {
      t: 'COMMIT',
      certified: { entry: gameplay, certificate: certificate(1, entryHash(gameplay)) },
    });
    await replica.flush();
    expect(replica.getContext().log.head.seq).toBe(1);
    expect(transport.sent.filter((message) => message.t === 'ACCUSE')).toHaveLength(2);
    const invalidHistoricalProposal = (index: number) => {
      const term = 1 + index * 4;
      const badControl = {
        ...control,
        evidence: {
          ...control.evidence,
          second: signVote({ ...control.evidence.second.body, term: index + 2 }, first.secretKey),
        },
      };
      const invalidEntry = signEntry(
        {
          seq: 2,
          term,
          prevHash: entryHash(gameplay),
          payload: badControl,
          stateHash: gameplay.stateHash,
          sequencer: second.peerId,
        },
        second.secretKey,
      );
      return signProposal(
        {
          genesisDigest: digest,
          epoch: 0,
          entry: invalidEntry,
          validRound: null,
          prevotes: [],
        },
        second.secretKey,
      );
    };
    const firstInvalid = invalidHistoricalProposal(0);
    const badSignature = signProposal(firstInvalid.body, first.secretKey);
    const budgetBeforeBadSignature = replica['expensiveByPeer'].get(second.peerId)?.seen.size ?? 0;
    transport.inject(second.peerId, { t: 'PROPOSAL', proposal: badSignature });
    await replica.flush();
    expect(replica['expensiveByPeer'].get(second.peerId)?.seen.size ?? 0).toBe(
      budgetBeforeBadSignature,
    );
    transport.inject(second.peerId, { t: 'PROPOSAL', proposal: firstInvalid });
    await replica.flush();
    const afterFirstReplay = replayCreates;
    const afterFirstCheck = proofChecks;
    transport.inject(second.peerId, { t: 'PROPOSAL', proposal: firstInvalid });
    await replica.flush();
    expect(replayCreates).toBe(afterFirstReplay);
    expect(proofChecks).toBe(afterFirstCheck);
    for (let index = 1; index < 3; index++) {
      transport.inject(second.peerId, {
        t: 'PROPOSAL',
        proposal: invalidHistoricalProposal(index),
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each attack arrives after the prior replay settles.
      await replica.flush();
    }
    const afterBudget = replayCreates;
    const checksAfterBudget = proofChecks;
    expect(checksAfterBudget).toBeGreaterThan(afterFirstCheck);
    for (let index = 3; index < 7; index++) {
      transport.inject(second.peerId, {
        t: 'PROPOSAL',
        proposal: invalidHistoricalProposal(index),
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Keep the sender's flood distinct from queue overflow.
      await replica.flush();
    }
    expect(replayCreates).toBe(afterBudget);
    expect(proofChecks).toBe(checksAfterBudget);
    const exclusion = signEntry(
      {
        seq: 2,
        term: 1,
        prevHash: entryHash(gameplay),
        payload: control,
        stateHash: gameplay.stateHash,
        sequencer: second.peerId,
      },
      second.secretKey,
    );
    transport.inject(second.peerId, {
      t: 'COMMIT',
      certified: { entry: exclusion, certificate: certificate(2, entryHash(exclusion)) },
    });
    await replica.flush();
    expect(replica.getContext().log.head.seq).toBe(2);
    expect(replica.getContext().excludedProposers).toEqual([0]);
    expect(replica.getContext().membership.voters).toHaveLength(4);

    // The already-excluded offender remains a certified voter and may replay old proof.
    transport.inject(first.peerId, { t: 'ACCUSE', control });
    await replica.flush();
    expect(value(replica['activeController']().snapshot()).pendingAccusation).toBeNull();
    expect(value(replica['activeController']().snapshot()).halted).toBeNull();

    const afterAccusation = replica.getContext();
    const setupCommand = afterAccusation.log.engine.getLegalCommands(afterAccusation.log.state, 0)
      .commands[0];
    if (!setupCommand) throw new Error('Expected a legal setup command after offender exclusion');
    const signed = signCommand(
      {
        gameId: fixture.genesis.gameId,
        genesisDigest: digest,
        seat: 0,
        nonce: 1,
        headSeq: 2,
        headHash: entryHash(afterAccusation.log.head),
        command: setupCommand,
      },
      first.secretKey,
    );
    const ordinaryApplied = value(
      fixture.engine.apply(afterAccusation.log.state, {
        kind: 'command',
        seat: 0,
        command: setupCommand,
      }),
    );
    const proposerSeat = proposerFor(
      3,
      1,
      afterAccusation.membership,
      afterAccusation.excludedProposers,
    ).seat;
    const proposer = fixtureAt(fixture.identities, proposerSeat);
    const ordinary = signEntry(
      {
        seq: 3,
        term: 1,
        prevHash: entryHash(afterAccusation.log.head),
        payload: { kind: 'command', signed },
        stateHash: toHex(hashValue(ordinaryApplied.state)),
        sequencer: proposer.peerId,
      },
      proposer.secretKey,
    );
    const ordinaryHash = entryHash(ordinary);
    const ordinaryCertificate = certificate(3, ordinaryHash);
    const locallyChecked = validateCertifiedEntry(
      { entry: ordinary, certificate: ordinaryCertificate },
      afterAccusation,
    );
    if (!locallyChecked.ok)
      throw new Error(`Test fixture commit invalid: ${locallyChecked.error.code}`);
    expect(replica['blockedPeers'].has(second.peerId)).toBe(false);
    transport.inject(second.peerId, {
      t: 'COMMIT',
      certified: { entry: ordinary, certificate: ordinaryCertificate },
    });
    await replica.flush();
    expect(replica.getContext().log.head.seq).toBe(3);
    expect(value(replica['activeController']().snapshot()).pendingAccusation).toBeNull();
    for (const hash of ['a'.repeat(64), 'b'.repeat(64)]) {
      transport.inject(first.peerId, {
        t: 'VOTE',
        vote: vote(0, 4, 'prevote', hash),
      });
      // Equivocation detection runs only after each vote is persisted in order.
      // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential vote evidence is the case under test.
      await replica.flush();
    }
    expect(value(replica['activeController']().snapshot()).pendingAccusation).toBeNull();
    expect(value(replica['activeController']().snapshot()).halted).toBeNull();

    const saved = await journal.load();
    if (!saved) throw new Error('Missing exclusion journal');
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The test deliberately injects a stale persisted field into a decoded safety snapshot.
    const safety = canonicalDecode(saved.safety.bytes) as ConsensusState;
    expect(
      await journal.saveSafety(
        saved.height,
        saved.safety.revision,
        canonicalEncode({ ...safety, pendingAccusation: control }),
      ),
    ).toBe(true);
    replica.dispose();
    const restored = value(
      await ReplicatedLog.restore({
        ...options,
        transport: new CapturingTransport(local.peerId),
      }),
    );
    expect(restored.getContext().excludedProposers).toEqual([0]);
    expect(value(restored['activeController']().snapshot()).pendingAccusation).toBeNull();
    expect((await journal.load())?.safety.revision).toBe(saved.safety.revision + 2);
    restored.dispose();
  });

  test('halts when objective evidence implicates two distinct voters', async () => {
    const fixture = fourHumanFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const local = fixtureAt(fixture.identities, 2);
    const transport = new CapturingTransport(local.peerId);
    const statuses: string[] = [];
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 2,
        secretKey: local.secretKey,
        transport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
        onStatus: (status) => {
          if (status.kind === 'halted') statuses.push(status.code);
        },
      }),
    );
    const evidenceFor = (seat: 0 | 1) => {
      const owner = fixtureAt(fixture.identities, seat);
      const vote = (valueHash: string | null) =>
        signVote(
          {
            genesisDigest: genesisDigest(fixture.genesis),
            epoch: 0,
            seat,
            seq: 1,
            term: 1,
            phase: 'prevote',
            valueHash,
          },
          owner.secretKey,
        );
      return {
        kind: 'control' as const,
        action: 'exclude-proposer' as const,
        offender: seat,
        evidence: {
          kind: 'vote-equivocation' as const,
          first: vote(null),
          second: vote('a'.repeat(64)),
        },
      };
    };
    transport.inject(first.peerId, { t: 'ACCUSE', control: evidenceFor(0) });
    await replica.flush();
    expect(statuses).toEqual([]);
    expect(replica.getContext().membership.voters).toHaveLength(4);
    transport.inject(second.peerId, { t: 'ACCUSE', control: evidenceFor(1) });
    await replica.flush();
    expect(statuses).toContain('replica-fault-limit');
    expect(replica.getContext().log.head.seq).toBe(0);
  });

  test('halts durably when peer accusation contains an unrecorded local signature', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const journal = new MemoryProtocolJournal();
    const transport = new FlakySubmitTransport(first.peerId);
    const options = {
      genesisEntry: fixture.entry,
      engine: fixture.engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat: 0 as const,
      secretKey: first.secretKey,
      transport,
      clock: new ManualClock(),
      journal,
    };
    const replica = value(await ReplicatedLog.create(options));
    const vote = (valueHash: string | null) =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat: 0,
          seq: 1,
          term: 1,
          phase: 'prevote',
          valueHash,
        },
        first.secretKey,
      );
    transport.inject(second.peerId, {
      t: 'ACCUSE',
      control: {
        kind: 'control',
        action: 'exclude-proposer',
        offender: 0,
        evidence: {
          kind: 'vote-equivocation',
          first: vote(null),
          second: vote('a'.repeat(64)),
        },
      },
    });
    await replica.flush();
    expect(transport.sent.some((message) => message.t === 'ACCUSE')).toBe(false);
    replica.dispose();
    const restarted = value(
      await ReplicatedLog.restore({
        ...options,
        transport: new CapturingTransport(first.peerId),
      }),
    );
    expect(
      await restarted.submit(
        signCommand(
          {
            gameId: fixture.genesis.gameId,
            genesisDigest: genesisDigest(fixture.genesis),
            seat: 0,
            nonce: 1,
            headSeq: 0,
            headHash: entryHash(fixture.entry),
            command: { type: 'END_TURN' },
          },
          first.secretKey,
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: 'replica-halted' } });
    restarted.dispose();
  });

  test('bounds ingress and disconnects a repeatedly malformed certified peer', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const transport = new CapturingTransport(first.peerId);
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 0,
        secretKey: first.secretKey,
        transport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
      }),
    );
    const malformed = new TextEncoder().encode('{not-json');
    for (let index = 0; index < 4; index += 1) {
      transport.injectBytes(second.peerId, malformed);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each strike must drain before checking the threshold.
      await replica.flush();
    }
    expect(transport.disconnected).toEqual([]);
    transport.inject(second.peerId, {
      t: 'VOTE',
      vote: signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat: 1,
          seq: 1,
          term: 1,
          phase: 'prevote',
          valueHash: null,
        },
        first.secretKey,
      ),
    });
    await replica.flush();
    expect(transport.disconnected).toEqual([second.peerId]);
    transport.injectBytes(second.peerId, malformed);
    await replica.flush();
    expect(transport.disconnected).toEqual([second.peerId]);
    replica.dispose();
  });

  test('bounds expensive peer replay requests while a legal submitted command still commits', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    let replayCreates = 0;
    const engine: Engine = {
      ...fixture.engine,
      createGame(config, seed) {
        replayCreates++;
        return fixture.engine.createGame(config, seed);
      },
    };
    const transport = new FlakySubmitTransport(first.peerId, [second.peerId]);
    const clock = new ManualClock();
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 0,
        secretKey: first.secretKey,
        transport,
        clock,
        journal: new MemoryProtocolJournal(),
        systemInput: (context) => {
          if (context.log.head.seq !== 0) return null;
          const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
          return { input, evidence: stubEvidence(context.log, input) };
        },
      }),
    );
    await replica.flush();
    const initial = transport.sent.find((message) => message.t === 'PROPOSAL');
    if (initial?.t !== 'PROPOSAL') throw new Error('Missing initial proposal');
    const initialHash = entryHash(initial.proposal.body.entry);
    const vote = (
      seat: 0 | 1,
      seq: number,
      phase: 'prevote' | 'precommit',
      valueHash: string | null,
      term = 1,
    ) =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat,
          seq,
          term,
          phase,
          valueHash,
        },
        fixtureAt(fixture.identities, seat).secretKey,
      );
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 1, 'prevote', initialHash) });
    await replica.flush();
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 1, 'precommit', initialHash) });
    await replica.flush();
    expect(replica.getContext().log.head.seq).toBe(1);

    const beforeRequests = replayCreates;
    const snapshotRequest = {
      t: 'SNAPSHOT_REQ' as const,
      genesisDigest: genesisDigest(fixture.genesis),
      atSeq: 1,
    };
    transport.inject(second.peerId, snapshotRequest);
    await replica.flush();
    expect(replayCreates).toBe(beforeRequests + 1);
    transport.inject(second.peerId, snapshotRequest);
    await replica.flush();
    expect(replayCreates).toBe(beforeRequests + 1);
    const accusationFor = (term: number) => {
      const sameVote = vote(1, 2, 'prevote', null, term);
      return {
        t: 'ACCUSE',
        control: {
          kind: 'control',
          action: 'exclude-proposer',
          offender: 1,
          evidence: { kind: 'vote-equivocation', first: sameVote, second: sameVote },
        },
      };
    };
    transport.inject(second.peerId, accusationFor(1));
    await replica.flush();
    const afterFirstAccusation = replayCreates;
    transport.inject(second.peerId, accusationFor(1));
    await replica.flush();
    expect(replayCreates).toBe(afterFirstAccusation);
    for (let term = 2; term <= 12; term++) {
      transport.inject(second.peerId, accusationFor(term));
      // oxlint-disable-next-line eslint/no-await-in-loop -- A streaming peer refills the bounded queue after each request.
      await replica.flush();
    }
    expect(replayCreates).toBeLessThanOrEqual(beforeRequests + 3);
    clock.advance(10_000);
    transport.inject(second.peerId, snapshotRequest);
    await replica.flush();
    expect(replayCreates).toBe(beforeRequests + 4);

    const before = replica.getContext();
    const command = before.log.engine.getLegalCommands(before.log.state, 0).commands[0];
    if (!command) throw new Error('Expected a legal setup command');
    const signed = signCommand(
      {
        gameId: fixture.genesis.gameId,
        genesisDigest: before.membership.genesisDigest,
        seat: 0,
        nonce: 1,
        headSeq: 1,
        headHash: entryHash(before.log.head),
        command,
      },
      first.secretKey,
    );
    let settled = false;
    const submitted = replica.submit(signed).then((result) => {
      settled = true;
      return result;
    });
    await replica.flush();
    expect(transport.failedSubmit).toBe(true);
    expect(settled).toBe(false);
    const applied = value(engine.apply(before.log.state, { kind: 'command', seat: 0, command }));
    const entry = signEntry(
      {
        seq: 2,
        term: 1,
        prevHash: entryHash(before.log.head),
        payload: { kind: 'command', signed },
        stateHash: toHex(hashValue(applied.state)),
        sequencer: second.peerId,
      },
      second.secretKey,
    );
    const proposal = signProposal(
      {
        genesisDigest: before.membership.genesisDigest,
        epoch: 0,
        entry,
        validRound: null,
        prevotes: [],
      },
      second.secretKey,
    );
    const hash = entryHash(entry);
    transport.inject(second.peerId, { t: 'PROPOSAL', proposal });
    await replica.flush();
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 2, 'prevote', hash) });
    await replica.flush();
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 2, 'precommit', hash) });
    await replica.flush();
    expect(await submitted).toMatchObject({ ok: true });
    expect(settled).toBe(true);
    expect(replica.getContext().log.head.seq).toBe(2);

    const beforeForged = replayCreates;
    const old = fixtureAt(replica.getEntries(), 0);
    clock.advance(10_000);
    const budgetBeforeInvalidOldCommit =
      replica['expensiveByPeer'].get(second.peerId)?.seen.size ?? 0;
    const conflicting = signEntry(
      { ...old.entry, stateHash: 'f'.repeat(64), sequencer: second.peerId },
      second.secretKey,
    );
    transport.inject(second.peerId, {
      t: 'COMMIT',
      certified: { entry: conflicting, certificate: old.certificate },
    });
    await replica.flush();
    expect(replica['expensiveByPeer'].get(second.peerId)?.seen.size ?? 0).toBe(
      budgetBeforeInvalidOldCommit,
    );
    expect(replayCreates).toBe(beforeForged);
    const syncs = transport.sent.filter((message) => message.t === 'SYNC_REQ').length;
    transport.inject(second.peerId, {
      t: 'SYNC_RES',
      genesisDigest: genesisDigest(fixture.genesis),
      entries: [old],
      more: true,
    });
    await replica.flush();
    expect(transport.sent.filter((message) => message.t === 'SYNC_REQ')).toHaveLength(syncs);
    const future = signEntry(
      {
        ...old.entry,
        seq: 4,
        prevHash: 'a'.repeat(64),
        sequencer: second.peerId,
      },
      second.secretKey,
    );
    const futureHash = entryHash(future);
    transport.inject(second.peerId, {
      t: 'SYNC_RES',
      genesisDigest: genesisDigest(fixture.genesis),
      entries: [
        {
          entry: future,
          certificate: [vote(0, 4, 'precommit', futureHash), vote(1, 4, 'precommit', futureHash)],
        },
      ],
      more: true,
    });
    await replica.flush();
    expect(transport.sent.filter((message) => message.t === 'SYNC_REQ')).toHaveLength(syncs + 1);
    const authenticatedConflict = signEntry(
      { ...old.entry, stateHash: 'e'.repeat(64), sequencer: second.peerId },
      second.secretKey,
    );
    const authenticatedConflictHash = entryHash(authenticatedConflict);
    clock.advance(10_000);
    transport.inject(second.peerId, {
      t: 'COMMIT',
      certified: {
        entry: authenticatedConflict,
        certificate: [
          vote(0, 1, 'precommit', authenticatedConflictHash),
          vote(1, 1, 'precommit', authenticatedConflictHash),
        ],
      },
    });
    await replica.flush();
    expect(value(replica['activeController']().snapshot()).halted).toBeTruthy();
    const blocked = await replica.submit(
      signCommand(
        {
          gameId: fixture.genesis.gameId,
          genesisDigest: genesisDigest(fixture.genesis),
          seat: 0,
          nonce: 2,
          headSeq: 2,
          headHash: entryHash(replica.getContext().log.head),
          command: { type: 'END_TURN' },
        },
        first.secretKey,
      ),
    );
    expect(blocked).toMatchObject({ ok: false, error: { code: 'replica-halted' } });
    replica.dispose();
  });

  test('reports an accepted command as outcome-unknown after a failed retransmission', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const transport = new FailingRetransmitTransport(first.peerId);
    const clock = new ManualClock();
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 0,
        secretKey: first.secretKey,
        transport,
        clock,
        journal: new MemoryProtocolJournal(),
        systemInput: (context) => {
          if (context.log.head.seq !== 0) return null;
          const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
          return { input, evidence: stubEvidence(context.log, input) };
        },
      }),
    );
    await replica.flush();
    const proposal = transport.sent.find((message) => message.t === 'PROPOSAL');
    if (proposal?.t !== 'PROPOSAL') throw new Error('Expected initial system proposal');
    const initialHash = entryHash(proposal.proposal.body.entry);
    for (const phase of ['prevote', 'precommit'] as const) {
      transport.inject(second.peerId, {
        t: 'VOTE',
        vote: signVote(
          {
            genesisDigest: genesisDigest(fixture.genesis),
            epoch: 0,
            seat: 1,
            seq: 1,
            term: proposal.proposal.body.entry.term,
            phase,
            valueHash: initialHash,
          },
          second.secretKey,
        ),
      });
      // The second vote is meaningful only after the first advances the local phase.
      // oxlint-disable-next-line eslint/no-await-in-loop -- Consensus phases are sequential.
      await replica.flush();
    }
    const context = replica.getContext();
    const command = context.log.engine.getLegalCommands(context.log.state, 0).commands[0];
    if (!command) throw new Error('Expected a legal player command after setup starts');
    const pending = replica.submit(
      signCommand(
        {
          gameId: fixture.genesis.gameId,
          genesisDigest: genesisDigest(fixture.genesis),
          seat: 0,
          nonce: 1,
          headSeq: 1,
          headHash: entryHash(context.log.head),
          command,
        },
        first.secretKey,
      ),
    );
    await replica.flush();
    expect(transport.submitBroadcasts).toBe(1);
    clock.fire(replica['pulseTimer']);
    await replica.flush();
    expect(transport.submitBroadcasts).toBe(2);
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'replica-outcome-unknown' },
    });
  });

  test('rejects oversized packets and drops a valid burst without disconnecting its peer', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const transport = new CapturingTransport(first.peerId);
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 0,
        secretKey: first.secretKey,
        transport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
      }),
    );
    const oversized = new Uint8Array(256 * 1024 + 1);
    for (let index = 0; index < 5; index += 1) transport.injectBytes(second.peerId, oversized);
    expect(transport.disconnected).toEqual([second.peerId]);
    await replica.flush();
    replica.dispose();

    const thirdTransport = new CapturingTransport(first.peerId);
    const third = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 0,
        secretKey: first.secretKey,
        transport: thirdTransport,
        clock: new ManualClock(),
        journal: new MemoryProtocolJournal(),
      }),
    );
    const valid = value(encodeProtocolMessage({ t: 'PING', n: 1 }));
    for (let index = 0; index < 13; index += 1) thirdTransport.injectBytes(second.peerId, valid);
    expect(thirdTransport.disconnected).toEqual([]);
    await third.flush();
    const answered = thirdTransport.sent.filter((message) => message.t === 'PONG').length;
    expect(answered).toBeGreaterThan(0);
    expect(answered).toBeLessThanOrEqual(8);
    thirdTransport.injectBytes(second.peerId, valid);
    await third.flush();
    expect(thirdTransport.sent.filter((message) => message.t === 'PONG')).toHaveLength(
      answered + 1,
    );
    expect(thirdTransport.disconnected).toEqual([]);
    third.dispose();
  });

  test('restore refuses a missing journal or a different valid genesis', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const journal = new MemoryProtocolJournal();
    const options = {
      genesisEntry: fixture.entry,
      engine: fixture.engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat: 0 as const,
      secretKey: first.secretKey,
      transport: new CapturingTransport(first.peerId),
      clock: new ManualClock(),
      journal,
    };
    expect(await ReplicatedLog.restore(options)).toMatchObject({
      ok: false,
      error: { code: 'replica-missing' },
    });
    const created = value(await ReplicatedLog.create(options));
    created.dispose();

    const alternateBody = { ...fixture.body, createdAt: fixture.body.createdAt + 1 };
    const alternateGenesis = {
      ...alternateBody,
      gameId: genesisId(alternateBody),
      signatures: [
        signGenesis(alternateBody, 0, first.secretKey),
        signGenesis(alternateBody, 1, second.secretKey),
      ],
    };
    const alternateEntry = signEntry(
      {
        seq: 0,
        term: 1,
        prevHash: fixture.entry.prevHash,
        payload: { kind: 'genesis', genesis: alternateGenesis },
        stateHash: fixture.entry.stateHash,
        sequencer: first.peerId,
      },
      first.secretKey,
    );
    expect(await ReplicatedLog.restore({ ...options, genesisEntry: alternateEntry })).toMatchObject(
      {
        ok: false,
        error: { code: 'replica-genesis' },
      },
    );
    expect((await journal.load())?.height).toBe(1);
  });

  test('persists genesis, certified entries and next-height safety before notifying; restores without reset', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const journal = new MemoryProtocolJournal();
    const clock = new ManualClock();
    const transport = new CapturingTransport(first.peerId);
    const notifications: number[] = [];
    const options = {
      genesisEntry: fixture.entry,
      engine: fixture.engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat: 0 as const,
      secretKey: first.secretKey,
      transport,
      clock,
      journal,
      systemInput: (
        context: Parameters<
          NonNullable<Parameters<typeof ReplicatedLog.create>[0]['systemInput']>
        >[0],
      ) => {
        if (context.log.head.seq !== 0) return null;
        const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
        return { input, evidence: stubEvidence(context.log, input) };
      },
      onCommit: (_validated: unknown, _before: unknown, next: ProposalContext) => {
        notifications.push(next.log.head.seq);
        mutateNonceMap(next.log.lastNonces);
        Reflect.set(next.log.authority?.controllers[0] ?? {}, 'status', 'pending-recovery');
        Reflect.set(next.log.recovery ?? {}, 'pending', { seq: 999, hash: '0'.repeat(64) });
      },
    };
    const replica = value(await ReplicatedLog.create(options));
    await replica.flush();
    const proposalMessage = transport.sent.find((message) => message.t === 'PROPOSAL');
    if (proposalMessage?.t !== 'PROPOSAL') throw new Error('Initial proposal not sent');
    const proposed = proposalMessage.proposal;
    const hash = entryHash(proposed.body.entry);
    const vote = (
      seat: 0 | 1,
      seq: number,
      term: number,
      phase: 'prevote' | 'precommit',
      valueHash: string,
    ) =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat,
          seq,
          term,
          phase,
          valueHash,
        },
        fixtureAt(fixture.identities, seat).secretKey,
      );
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 1, 1, 'prevote', hash) });
    await replica.flush();
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 1, 1, 'precommit', hash) });
    await replica.flush();
    expect((await journal.load())?.height).toBe(2);
    expect(replica.getContext().log.head.seq).toBe(1);
    expect(notifications).toEqual([1]);

    const before = replica.getContext();
    const command = before.log.engine.getLegalCommands(before.log.state, 0).commands[0];
    if (!command) throw new Error('Expected a legal setup command');
    const signed = signCommand(
      {
        gameId: fixture.genesis.gameId,
        genesisDigest: genesisDigest(fixture.genesis),
        seat: 0,
        nonce: 1,
        headSeq: before.log.head.seq,
        headHash: entryHash(before.log.head),
        command,
      },
      first.secretKey,
    );
    let finished = false;
    const submitted = replica.submit(signed).then((result) => {
      finished = true;
      return result;
    });
    await replica.flush();
    expect(finished).toBe(false);
    const applied = value(
      fixture.engine.apply(before.log.state, { kind: 'command', seat: 0, command }),
    );
    const proposer = proposerFor(2, 1, {
      genesisDigest: genesisDigest(fixture.genesis),
      epoch: 0,
      voters: [
        { seat: 0, publicKey: first.peerId },
        { seat: 1, publicKey: second.peerId },
      ],
    });
    expect(proposer.seat).toBe(1);
    const entry = signEntry(
      {
        seq: 2,
        term: 1,
        prevHash: entryHash(before.log.head),
        payload: { kind: 'command', signed },
        stateHash: toHex(hashValue(applied.state)),
        sequencer: second.peerId,
      },
      second.secretKey,
    );
    const commandValueHash = entryHash(entry);
    transport.inject(second.peerId, {
      t: 'PROPOSAL',
      proposal: signProposal(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          entry,
          validRound: null,
          prevotes: [],
        },
        second.secretKey,
      ),
    });
    await replica.flush();
    transport.inject(second.peerId, {
      t: 'VOTE',
      vote: vote(1, 2, 1, 'prevote', commandValueHash),
    });
    await replica.flush();
    transport.inject(second.peerId, {
      t: 'VOTE',
      vote: vote(1, 2, 1, 'precommit', commandValueHash),
    });
    await replica.flush();
    expect(value(await submitted)).toBeUndefined();
    expect((await journal.load())?.height).toBe(3);
    expect(notifications).toEqual([1, 2]);
    expect(replica.getContext().log.lastNonces.get(0)).toBe(1);

    const repeated = replica.getEntries()[0];
    if (!repeated) throw new Error('Expected committed entry');
    transport.inject(second.peerId, {
      t: 'COMMIT',
      certified: { entry: repeated.entry, certificate: [] },
    });
    await replica.flush();
    expect((await journal.load())?.height).toBe(3);
    expect(notifications).toEqual([1, 2]);

    const detached = replica.getContext();
    mutateNonceMap(detached.log.lastNonces);
    Reflect.set(detached.log.authority?.controllers[0] ?? {}, 'publicKey', second.peerId);
    Reflect.set(detached.log.recovery ?? {}, 'pending', { seq: 999, hash: '0'.repeat(64) });
    expect(replica.getContext().log.lastNonces.get(0)).toBe(1);
    expect(replica.getContext().log.authority?.controllers[0]?.publicKey).toBe(first.peerId);
    expect(replica.getContext().log.authority?.controllers[0]?.status).toBe('active');
    expect(replica.getContext().log.recovery?.pending).toBeNull();
    const detachedEntries = replica.getEntries();
    expect(detachedEntries).toHaveLength(2);
    Reflect.set(detachedEntries[0]?.entry ?? {}, 'seq', 999);
    expect(replica.getEntries()[0]?.entry.seq).toBe(1);
    replica.dispose();
    const restored = value(
      await ReplicatedLog.restore({ ...options, transport: new CapturingTransport(first.peerId) }),
    );
    expect(restored.getContext().log.head.seq).toBe(2);
    expect((await journal.load())?.height).toBe(3);
    const stale = await restored.submit(signed);
    expect(stale).toMatchObject({ ok: false, error: { code: 'replayed-nonce' } });
    restored.dispose();
    expect((await ReplicatedLog.create(options)).ok).toBe(false);
  });

  test('a committed private-state callback failure stops voting after durable commit', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const journal = new MemoryProtocolJournal();
    const transport = new CapturingTransport(first.peerId);
    const statuses: string[] = [];
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 0,
        secretKey: first.secretKey,
        transport,
        clock: new ManualClock(),
        journal,
        systemInput: (context) => {
          if (context.log.head.seq !== 0) return null;
          const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
          return { input, evidence: stubEvidence(context.log, input) };
        },
        onCommit: () => {
          throw new Error('Private driver failed');
        },
        onStatus: (status) => {
          if (status.kind === 'halted') statuses.push(status.code);
        },
      }),
    );
    await replica.flush();
    const sent = transport.sent.find((message) => message.t === 'PROPOSAL');
    if (sent?.t !== 'PROPOSAL') throw new Error('Expected the initial proposal');
    const hash = entryHash(sent.proposal.body.entry);
    const signedVote = (phase: 'prevote' | 'precommit') =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat: 1,
          seq: 1,
          term: 1,
          phase,
          valueHash: hash,
        },
        second.secretKey,
      );
    transport.inject(second.peerId, { t: 'VOTE', vote: signedVote('prevote') });
    await replica.flush();
    transport.inject(second.peerId, { t: 'VOTE', vote: signedVote('precommit') });
    await replica.flush();
    expect((await journal.load())?.height).toBe(2);
    expect(statuses).toContain('commit-application');
    expect(
      await replica.submit(
        signCommand(
          {
            gameId: fixture.genesis.gameId,
            genesisDigest: genesisDigest(fixture.genesis),
            seat: 0,
            nonce: 1,
            headSeq: 1,
            headHash: hash,
            command: { type: 'END_TURN' },
          },
          first.secretKey,
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: 'replica-disposed' } });
  });

  test('does not report command success when post-commit private application fails', async () => {
    const fixture = protocolFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const journal = new MemoryProtocolJournal();
    const transport = new CapturingTransport(first.peerId);
    const statuses: string[] = [];
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine: fixture.engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 0,
        secretKey: first.secretKey,
        transport,
        clock: new ManualClock(),
        journal,
        systemInput: (context) => {
          if (context.log.head.seq !== 0) return null;
          const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
          return { input, evidence: stubEvidence(context.log, input) };
        },
        onCommit: (_validated, _previous, next) => {
          if (next.log.head.seq === 2) throw new Error('Private driver failed');
        },
        onStatus: (status) => {
          if (status.kind === 'halted') statuses.push(status.code);
        },
      }),
    );
    await replica.flush();
    const proposal = transport.sent.find((message) => message.t === 'PROPOSAL');
    if (proposal?.t !== 'PROPOSAL') throw new Error('Initial proposal was not sent');
    const firstHash = entryHash(proposal.proposal.body.entry);
    const vote = (seat: 0 | 1, seq: number, phase: 'prevote' | 'precommit', hash: string) =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat,
          seq,
          term: 1,
          phase,
          valueHash: hash,
        },
        fixtureAt(fixture.identities, seat).secretKey,
      );
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 1, 'prevote', firstHash) });
    await replica.flush();
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 1, 'precommit', firstHash) });
    await replica.flush();
    const before = replica.getContext();
    const command = before.log.engine.getLegalCommands(before.log.state, 0).commands[0];
    if (!command) throw new Error('Expected legal setup command');
    const signed = signCommand(
      {
        gameId: fixture.genesis.gameId,
        genesisDigest: genesisDigest(fixture.genesis),
        seat: 0,
        nonce: 1,
        headSeq: before.log.head.seq,
        headHash: entryHash(before.log.head),
        command,
      },
      first.secretKey,
    );
    const pending = replica.submit(signed);
    await replica.flush();
    const applied = value(
      fixture.engine.apply(before.log.state, {
        kind: 'command',
        seat: 0,
        command,
      }),
    );
    const entry = signEntry(
      {
        seq: 2,
        term: 1,
        prevHash: entryHash(before.log.head),
        payload: { kind: 'command', signed },
        stateHash: toHex(hashValue(applied.state)),
        sequencer: second.peerId,
      },
      second.secretKey,
    );
    const hash = entryHash(entry);
    transport.inject(second.peerId, {
      t: 'PROPOSAL',
      proposal: signProposal(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          entry,
          validRound: null,
          prevotes: [],
        },
        second.secretKey,
      ),
    });
    await replica.flush();
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 2, 'prevote', hash) });
    await replica.flush();
    transport.inject(second.peerId, { t: 'VOTE', vote: vote(1, 2, 'precommit', hash) });
    await replica.flush();
    expect((await journal.load())?.height).toBe(3);
    expect(statuses).toContain('commit-application');
    expect(await pending).toMatchObject({ ok: false, error: { code: 'replica-outcome-unknown' } });
  });

  test('repair retains a certified value until a fresh replay accepts it', async () => {
    // A valid remote quorum excludes this replica's key while its local engine
    // cannot derive the certified value.
    const fixture = fourHumanFixture();
    const first = fixtureAt(fixture.identities, 0);
    const second = fixtureAt(fixture.identities, 1);
    const local = fixtureAt(fixture.identities, 3);
    const journal = new MemoryProtocolJournal();
    const transport = new CapturingTransport(local.peerId);
    let broken = true;
    const engine: Engine = {
      ...fixture.engine,
      apply: (state, input) =>
        broken
          ? failure('test-engine-failure', 'Engine cannot derive the certified value')
          : fixture.engine.apply(state, input),
    };
    const replica = value(
      await ReplicatedLog.create({
        genesisEntry: fixture.entry,
        engine,
        policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
        seat: 3,
        secretKey: local.secretKey,
        transport,
        clock: new ManualClock(),
        journal,
      }),
    );
    const context = replica.getContext();
    transport.inject(second.peerId, {
      t: 'SNAPSHOT_REQ',
      genesisDigest: context.membership.genesisDigest,
      atSeq: 0,
    });
    await replica.flush();
    expect(transport.sent.find((message) => message.t === 'SNAPSHOT_RES')).toMatchObject({
      t: 'SNAPSHOT_RES',
      atSeq: 0,
      snapshot: snapshotFromContext(context),
    });
    const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
    const applied = value(fixture.engine.apply(context.log.state, input));
    const entry = signEntry(
      {
        seq: 1,
        term: 1,
        prevHash: entryHash(context.log.head),
        payload: { kind: 'system', input, evidence: stubEvidence(context.log, input) },
        stateHash: toHex(hashValue(applied.state)),
        sequencer: first.peerId,
      },
      first.secretKey,
    );
    const hash = entryHash(entry);
    const vote = (seat: 0 | 1 | 2) =>
      signVote(
        {
          genesisDigest: genesisDigest(fixture.genesis),
          epoch: 0,
          seat,
          seq: 1,
          term: 1,
          phase: 'precommit',
          valueHash: hash,
        },
        fixtureAt(fixture.identities, seat).secretKey,
      );
    transport.inject(second.peerId, {
      t: 'COMMIT',
      certified: { entry, certificate: [vote(0), vote(1), vote(2)] },
    });
    await replica.flush();
    expect((await journal.load())?.height).toBe(1);
    expect(transport.sent.some((message) => message.t === 'SNAPSHOT_REQ')).toBe(true);
    expect(
      await replica.submit(
        signCommand(
          {
            gameId: fixture.genesis.gameId,
            genesisDigest: genesisDigest(fixture.genesis),
            seat: 0,
            nonce: 1,
            headSeq: 0,
            headHash: entryHash(context.log.head),
            command: { type: 'END_TURN' },
          },
          first.secretKey,
        ),
      ),
    ).toMatchObject({ ok: false, error: { code: 'replica-halted' } });
    expect(await replica.repair()).toMatchObject({
      ok: false,
      error: { code: 'consensus-repair-incomplete' },
    });
    expect((await journal.load())?.height).toBe(1);
    expect(replica.getContext().log.head.seq).toBe(0);
    broken = false;
    transport.inject(second.peerId, {
      t: 'SNAPSHOT_RES',
      genesisDigest: context.membership.genesisDigest,
      atSeq: 0,
      snapshot: { bogus: true },
    });
    await replica.flush();
    expect((await journal.load())?.height).toBe(1);
    transport.inject(second.peerId, {
      t: 'SNAPSHOT_RES',
      genesisDigest: context.membership.genesisDigest,
      atSeq: 0,
      snapshot: snapshotFromContext(context),
    });
    await replica.flush();
    expect((await journal.load())?.height).toBe(2);
    expect(replica.getContext().log.head.seq).toBe(1);
    replica.dispose();
  });

  test.each(['unchanged', 'safety', 'locked-safety', 'engine'] as const)(
    'repairs a corrupted derived context only with unchanged durable authority (%s)',
    async (mutation) => {
      const fixture = fourHumanFixture();
      const engine = { ...fixture.engine };
      const first = fixtureAt(fixture.identities, 0);
      const second = fixtureAt(fixture.identities, 1);
      const local = fixtureAt(fixture.identities, 3);
      const journal = new MemoryProtocolJournal();
      const transport = new CapturingTransport(local.peerId);
      const statuses: string[] = [];
      const replica = value(
        await ReplicatedLog.create({
          genesisEntry: fixture.entry,
          engine,
          policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
          seat: 3,
          secretKey: local.secretKey,
          transport,
          clock: new ManualClock(),
          journal,
          onStatus: (status) => statuses.push(status.kind === 'halted' ? status.code : status.kind),
        }),
      );
      const parent = replica.getContext();
      const safetyBefore = await journal.loadSafety(1);
      if (!safetyBefore) throw new Error('Missing initial durable safety record');

      let derived: unknown = replica;
      for (const property of ['context', 'log', 'state', 'bank']) {
        if (typeof derived !== 'object' || derived === null)
          throw new Error(`Cannot corrupt derived state at ${property}`);
        derived = Reflect.get(derived, property);
      }
      if (typeof derived !== 'object' || derived === null)
        throw new Error('Missing derived bank state');
      const brick = Reflect.get(derived, 'brick');
      if (typeof brick !== 'number' || !Reflect.set(derived, 'brick', brick + 1))
        throw new Error('Could not corrupt derived bank state');

      const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
      const applied = value(fixture.engine.apply(parent.log.state, input));
      const entry = signEntry(
        {
          seq: 1,
          term: 1,
          prevHash: entryHash(parent.log.head),
          payload: { kind: 'system', input, evidence: stubEvidence(parent.log, input) },
          stateHash: toHex(hashValue(applied.state)),
          sequencer: first.peerId,
        },
        first.secretKey,
      );
      const certified = {
        entry,
        certificate: ([0, 1, 2] as const).map((seat) =>
          signVote(
            {
              genesisDigest: genesisDigest(fixture.genesis),
              epoch: 0,
              seat,
              seq: 1,
              term: 1,
              phase: 'precommit',
              valueHash: entryHash(entry),
            },
            fixtureAt(fixture.identities, seat).secretKey,
          ),
        ),
      };

      transport.inject(second.peerId, { t: 'COMMIT', certified });
      await replica.flush();
      expect(statuses).toContain('consensus-context');
      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(0);
      expect(transport.sent).toContainEqual({
        t: 'SNAPSHOT_REQ',
        genesisDigest: parent.membership.genesisDigest,
        atSeq: parent.log.head.seq,
      });
      expect((await journal.load())?.height).toBe(1);
      expect(await journal.loadSafety(1)).toEqual(safetyBefore);
      expect(replica.getContext().log.head.seq).toBe(0);

      transport.inject(second.peerId, {
        t: 'SNAPSHOT_RES',
        genesisDigest: parent.membership.genesisDigest,
        atSeq: parent.log.head.seq,
        snapshot: { forged: true },
      });
      await replica.flush();
      expect((await journal.load())?.height).toBe(1);
      expect(await journal.loadSafety(1)).toEqual(safetyBefore);
      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(0);

      if (mutation === 'safety') {
        if (!(await journal.saveSafety(1, safetyBefore.revision, safetyBefore.bytes)))
          throw new Error('Could not inject a competing durable safety revision');
      } else if (mutation === 'locked-safety') {
        const changed: unknown = canonicalDecode(safetyBefore.bytes);
        if (typeof changed !== 'object' || changed === null || !journal['record'])
          throw new Error('Missing durable safety fixture');
        Reflect.set(changed, 'locked', { round: 1, hash: entryHash(entry), polka: [] });
        // Deliberately corrupt durable bytes without advancing its CAS revision.
        journal['record'].safety.bytes = canonicalEncode(changed);
      } else if (mutation === 'engine') {
        const apply = engine.apply;
        engine.apply = (state, nextInput) => apply(state, nextInput);
      }

      transport.inject(second.peerId, {
        t: 'SNAPSHOT_RES',
        genesisDigest: parent.membership.genesisDigest,
        atSeq: parent.log.head.seq,
        snapshot: snapshotFromContext(parent),
      });
      await replica.flush();
      // oxlint-disable vitest/no-conditional-expect -- Parameterized authority mutations intentionally have different terminal outcomes.
      if (mutation !== 'unchanged') {
        expect((await journal.load())?.height).toBe(1);
        expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(0);
        expect(statuses).toContain(
          mutation === 'engine' ? 'replica-authority' : 'consensus-write-conflict',
        );
        replica.dispose();
        return;
      }
      // oxlint-enable vitest/no-conditional-expect
      expect((await journal.load())?.height).toBe(2);
      expect(replica.getContext().log.head).toEqual(entry);
      expect((await journal.load())?.entries).toEqual([certified]);
      const replayed = value(
        replayCertifiedPrefix(fixture.entry, [certified], engine, replica['options'].policy),
      );
      expect(replica['activeController']().opensOn(replayed.context)).toBe(true);
      replica.dispose();
    },
  );
});

```

## packages/protocol/src/replay.ts

```text
import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Engine, GameEvent, Input, Result } from '@cp2p/engine';
import { entryHash, genesisDigest, validateGenesisEntry } from './genesis.js';
import { objectiveEvidenceSeq, validateObjectiveAccusation } from './control.js';
import { initializeCryptoContext } from './crypto-context.js';
import type { GenesisPolicy } from './genesis.js';
import type { ValidatedEntry } from './log.js';
import { advanceContext, proposerFor, validateCertifiedEntry } from './proposal.js';
import type { CertifiedEntry, ProposalContext } from './proposal.js';
import { authenticatedCheatSigner, verifyCheatProof } from './cheat-proof.js';
import type { CheatFinding } from './cheat-proof.js';
import { initialSeatAuthorities } from './authority.js';
import { initialTransferState } from './transfer-readiness.js';
import { advanceTimerAnchors } from './turn-timeout.js';

const MAX_HISTORICAL_CONTEXTS = 16;

export interface ReplayPolicy {
  genesis: GenesisPolicy;
  entry: ProposalContext['policy'];
}

export interface ReplayedPrefix {
  context: ProposalContext;
  entries: CertifiedEntry[];
  inputs: Input[];
  events: GameEvent[];
}

/** Genesis signatures establish the first voter set; transport peers have no say. */
export function initialProposalContext(
  genesisEntry: unknown,
  engine: Engine,
  policy: ReplayPolicy,
): Result<ProposalContext> {
  const checked = validateGenesisEntry(genesisEntry, engine, policy.genesis);
  if (!checked.ok) return checked;
  const { genesis, state, entry } = checked.value;
  const authority = initialSeatAuthorities(genesis);
  if (!authority.ok) return authority;
  const transfer =
    genesis.security === 'verified' ? initialTransferState(genesis, entry) : success(undefined);
  if (!transfer.ok) return transfer;
  const crypto = initializeCryptoContext(
    genesis,
    engine,
    state,
    entry,
    policy.entry.randomDerivations,
    authority.value,
  );
  if (!crypto.ok) return crypto;
  const timers = advanceTimerAnchors(engine, state, entry);
  if (!timers.ok) return timers;
  return success({
    log: {
      genesis,
      engine,
      state,
      head: entry,
      lastNonces: new Map(),
      crypto: crypto.value,
      timers: timers.value,
      authority: authority.value,
      recovery: { authorizations: [], pending: null, offline: [], completed: [], void: null },
      ...(transfer.value ? { transfer: transfer.value } : {}),
    },
    membership: {
      genesisDigest: genesisDigest(genesis),
      epoch: 0,
      voters: genesis.seats
        .filter((seat) => seat.kind === 'human')
        .map(({ seat, publicKey }) => ({ seat, publicKey })),
    },
    excludedProposers: [],
    policy: policy.entry,
  });
}

/** Replay certificates in order. A claimed snapshot never supplies voter or nonce state. */
export function replayCertifiedPrefix(
  genesisEntry: unknown,
  entries: readonly unknown[],
  engine: Engine,
  policy: ReplayPolicy,
  onEntry?: (entry: ValidatedEntry & CertifiedEntry, next: ProposalContext) => Result<void>,
): Result<ReplayedPrefix> {
  return replayCertifiedPrefixWithCache(genesisEntry, entries, engine, policy, new Map(), onEntry);
}

/** Successful findings are shared only within this certified ancestry. */
function replayCertifiedPrefixWithCache(
  genesisEntry: unknown,
  entries: readonly unknown[],
  engine: Engine,
  policy: ReplayPolicy,
  verifiedFindings: Map<string, CheatFinding>,
  onEntry?: (entry: ValidatedEntry & CertifiedEntry, next: ProposalContext) => Result<void>,
): Result<ReplayedPrefix> {
  const initial = initialProposalContext(genesisEntry, engine, policy);
  if (!initial.ok) return initial;
  const certified: CertifiedEntry[] = [];
  const historical = new Map<number, ProposalContext>();
  const cheatHistorical = new Map<number, ProposalContext>();
  const controllerTimeline = [
    {
      atSeq: 0,
      authority: initial.value.log.authority,
      epoch: initial.value.log.crypto?.epoch ?? initial.value.log.authority?.epoch ?? 0,
    },
  ];
  let context: ProposalContext = {
    ...initial.value,
    verifyHistoricalCheat: (claim) => {
      const atSeq = claim.evidence.at.seq;
      if (atSeq > certified.length)
        return failure('cheat-history', 'Certified evidence parent is unavailable');
      const parentEntry = atSeq === 0 ? initial.value.log.head : certified[atSeq - 1]?.entry;
      if (!parentEntry || claim.evidence.at.hash !== entryHash(parentEntry))
        return failure('cheat-history', 'Certified evidence parent hash does not match');
      const parentAuthority = controllerTimeline.findLast((item) => item.atSeq <= atSeq);
      if (
        !parentAuthority ||
        !authenticatedCheatSigner(
          claim,
          initial.value.log.genesis,
          parentAuthority.authority,
          parentAuthority.epoch,
        )
      )
        return failure('cheat-signature', 'Cheat evidence has no authenticated controller');
      const key = toHex(hashValue({ domain: 'cp2p/v1/cheat-claim-cache', claim }));
      const previous = verifiedFindings.get(key);
      if (previous) return success(previous);
      let parent = cheatHistorical.get(atSeq);
      if (!parent) {
        const replayed = replayCertifiedPrefixWithCache(
          genesisEntry,
          certified.slice(0, atSeq),
          engine,
          policy,
          verifiedFindings,
        );
        if (!replayed.ok) return replayed;
        parent = replayed.value.context;
      }
      cheatHistorical.delete(atSeq);
      cheatHistorical.set(atSeq, parent);
      if (cheatHistorical.size > MAX_HISTORICAL_CONTEXTS) {
        const oldest = cheatHistorical.keys().next().value;
        if (oldest !== undefined) cheatHistorical.delete(oldest);
      }
      return verifyCheatProof(claim, parent.log);
    },
    verifyHistoricalAccusation: (control) => {
      const atSeq = objectiveEvidenceSeq(control);
      if (atSeq < 1 || atSeq - 1 > certified.length)
        return failure('control-history', 'Certified evidence parent is unavailable');
      let parent = historical.get(atSeq);
      if (!parent) {
        const replayed = replayCertifiedPrefixWithCache(
          genesisEntry,
          certified.slice(0, atSeq - 1),
          engine,
          policy,
          verifiedFindings,
        );
        if (!replayed.ok) return replayed;
        parent = replayed.value.context;
      }
      // Pending proofs and round hints can reference different certified parents.
      // Keep recent parents together without retaining the whole game state history.
      historical.delete(atSeq);
      historical.set(atSeq, parent);
      if (historical.size > MAX_HISTORICAL_CONTEXTS) {
        const oldest = historical.keys().next().value;
        if (oldest !== undefined) historical.delete(oldest);
      }
      const checked = validateObjectiveAccusation(control, {
        log: parent.log,
        commandPolicy: parent.policy,
        membership: parent.membership,
        excludedProposers: parent.excludedProposers,
        proposerFor: (seq, term) =>
          proposerFor(seq, term, parent.membership, parent.excludedProposers),
      });
      return checked.ok ? success(entryHash(parent.log.head)) : checked;
    },
  };
  const inputs: Input[] = [];
  const events: GameEvent[] = [];
  for (const entry of entries) {
    const checked = validateCertifiedEntry(entry, context);
    if (!checked.ok) return checked;
    const next = checked.value;
    if (next.entry.payload.kind === 'cheat-proof') {
      const claim = next.entry.payload.claim;
      const finding = next.crypto?.cheats.find(
        (item) => item.seat === claim.seat && item.kind === claim.evidence.kind,
      );
      if (!finding)
        return failure('cheat-replay', 'Certified cheat record has no replayed finding');
      verifiedFindings.set(
        toHex(hashValue({ domain: 'cp2p/v1/cheat-claim-cache', claim })),
        finding,
      );
    }
    certified.push({ entry: next.entry, certificate: next.certificate });
    if (next.input !== null) inputs.push(next.input);
    events.push(...next.events);
    const advanced = advanceContext(context, next);
    if (!advanced.ok) return advanced;
    if (advanced.value.log.authority !== context.log.authority) {
      controllerTimeline.push({
        atSeq: next.entry.seq,
        authority: advanced.value.log.authority,
        epoch: advanced.value.log.crypto?.epoch ?? advanced.value.log.authority?.epoch ?? 0,
      });
    }
    const visited = onEntry?.(next, advanced.value);
    if (visited && !visited.ok) return visited;
    context = advanced.value;
  }
  return success({ context, entries: certified, inputs, events });
}

/** A cache for display/load speed, always checked against the certified replay before voting. */
export function snapshotFromContext(context: ProposalContext) {
  return canonicalDecode(
    canonicalEncode({
      genesisDigest: context.membership.genesisDigest,
      seq: context.log.head.seq,
      hash: entryHash(context.log.head),
      state: context.log.state,
      crypto: context.log.crypto,
      authority: context.log.authority ?? null,
      recovery: context.log.recovery ?? null,
      transfer: context.log.transfer ?? null,
      timers: context.log.timers ?? [],
      lastNonces: [...context.log.lastNonces].toSorted(([a], [b]) => a - b),
      membership: context.membership,
      excludedProposers: context.excludedProposers,
    }),
  );
}

export function verifyReplaySnapshot(value: unknown, context: ProposalContext): Result<void> {
  try {
    return toHex(hashValue(value)) === toHex(hashValue(snapshotFromContext(context)))
      ? success(undefined)
      : failure('snapshot-mismatch', 'Snapshot differs from the certified replay');
  } catch {
    return failure('snapshot-malformed', 'Snapshot is not canonical data');
  }
}

```

## packages/protocol/src/journal.ts

```text
import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import * as v from 'valibot';
import { entryHash } from './genesis.js';
import { certifiedEntrySchema } from './proposal.js';
import type { CertifiedEntry } from './proposal.js';
import type { SafetyStore, StoredSafety } from './safety-store.js';
import { logEntrySchema } from './schemas.js';
import type { LogEntry } from './types.js';

export interface JournalRecord {
  genesis: LogEntry;
  entries: CertifiedEntry[];
  /** The next height, initialized atomically with the committed parent. */
  height: number;
  safety: StoredSafety;
}

/** All writes are atomic. Failed writes must leave both history and votes intact. */
export interface ProtocolJournal {
  load(): Promise<JournalRecord | null>;
  initialize(genesis: LogEntry, safety: Uint8Array): Promise<boolean>;
  loadSafety(height: number): Promise<StoredSafety | null>;
  saveSafety(height: number, revision: number, bytes: Uint8Array): Promise<boolean>;
  commit(
    height: number,
    safetyRevision: number,
    certified: CertifiedEntry,
    nextSafety: Uint8Array,
  ): Promise<boolean>;
}

/**
 * A height's controller can restore and update its votes, but cannot initialize
 * missing records. Only the journal's certified-parent transaction opens a height.
 */
export function journalSafetyStore(journal: ProtocolJournal, height: number): SafetyStore {
  return {
    load: () => journal.loadSafety(height),
    save: (revision, bytes) =>
      revision === null ? Promise.resolve(false) : journal.saveSafety(height, revision, bytes),
  };
}

function copySafety(record: StoredSafety): StoredSafety {
  return { revision: record.revision, bytes: record.bytes.slice() };
}

function copyEntry(entry: LogEntry): LogEntry {
  return v.parse(logEntrySchema, canonicalDecode(canonicalEncode(entry)));
}

function copyCertified(certified: CertifiedEntry): CertifiedEntry {
  return v.parse(certifiedEntrySchema, canonicalDecode(canonicalEncode(certified)));
}

/** Retain this object across simulated process crashes. It has no reset operation. */
export class MemoryProtocolJournal implements ProtocolJournal {
  private record: JournalRecord | null = null;

  async load(): Promise<JournalRecord | null> {
    const record = this.record;
    return record === null
      ? null
      : {
          genesis: copyEntry(record.genesis),
          entries: record.entries.map(copyCertified),
          height: record.height,
          safety: copySafety(record.safety),
        };
  }

  async initialize(genesis: LogEntry, safety: Uint8Array): Promise<boolean> {
    if (this.record !== null || genesis.seq !== 0 || !(safety instanceof Uint8Array)) return false;
    this.record = {
      genesis: copyEntry(genesis),
      entries: [],
      height: 1,
      safety: { revision: 0, bytes: safety.slice() },
    };
    return true;
  }

  async loadSafety(height: number): Promise<StoredSafety | null> {
    return this.record?.height === height ? copySafety(this.record.safety) : null;
  }

  async saveSafety(height: number, revision: number, bytes: Uint8Array): Promise<boolean> {
    const record = this.record;
    if (
      record === null ||
      record.height !== height ||
      record.safety.revision !== revision ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      !Number.isSafeInteger(revision + 1) ||
      !(bytes instanceof Uint8Array)
    )
      return false;
    record.safety = { revision: revision + 1, bytes: bytes.slice() };
    return true;
  }

  async commit(
    height: number,
    safetyRevision: number,
    certified: CertifiedEntry,
    nextSafety: Uint8Array,
  ): Promise<boolean> {
    const record = this.record;
    if (
      record === null ||
      record.height !== height ||
      record.safety.revision !== safetyRevision ||
      certified.entry.seq !== height ||
      !Number.isSafeInteger(height + 1) ||
      !(nextSafety instanceof Uint8Array)
    )
      return false;
    const parent = record.entries.at(-1)?.entry ?? record.genesis;
    if (certified.entry.prevHash !== entryHash(parent)) return false;
    // Copy before mutation: a failed copy cannot append a partial transaction.
    const stored = copyCertified(certified);
    const safety = { revision: 0, bytes: nextSafety.slice() };
    record.entries.push(stored);
    record.height = height + 1;
    record.safety = safety;
    return true;
  }
}

```

## packages/protocol/src/safety-store.ts

```text
/** A persisted consensus-safety record with a monotonic revision. */
export interface StoredSafety {
  readonly revision: number;
  readonly bytes: Uint8Array;
}

/**
 * Durable implementations must complete `save` before sending signed messages.
 * A failed compare-and-swap must be followed by reloading and validating the
 * newer record; callers must never overwrite it as a recovery shortcut.
 */
export interface SafetyStore {
  load(): Promise<StoredSafety | null>;
  save(expectedRevision: number | null, bytes: Uint8Array): Promise<boolean>;
}

/**
 * In-memory CAS storage for tests and a single process lifetime. Keep this
 * object alive across consensus-controller restarts to preserve vote safety.
 */
export class MemorySafetyStore implements SafetyStore {
  private record: StoredSafety | null = null;

  async load(): Promise<StoredSafety | null> {
    const current = this.record;
    return current === null ? null : { revision: current.revision, bytes: current.bytes.slice() };
  }

  async save(expectedRevision: number | null, bytes: Uint8Array): Promise<boolean> {
    if (
      (expectedRevision !== null &&
        (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) ||
      !(bytes instanceof Uint8Array)
    ) {
      return false;
    }

    const current = this.record;
    if (expectedRevision === null ? current !== null : current?.revision !== expectedRevision) {
      return false;
    }

    const nextRevision = current === null ? 0 : current.revision + 1;
    if (!Number.isSafeInteger(nextRevision)) return false;

    this.record = { revision: nextRevision, bytes: bytes.slice() };
    return true;
  }
}

```

## docs/06-protocol-event-log.md

```text
# 06 — Protocol & Replicated Event Log

## Goal

Build `@cp2p/protocol`, which lets N peers keep one agreed, validated, hash-chained log of inputs and therefore identical game state. It must be:

- transport-agnostic,
- tested over an in-memory simulated network with delays, drops, duplicates and partitions.

Randomness and hidden information use a `LocalRandomSource` stub here. Stage 07 replaces it with the real cryptographic protocols. WebRTC comes in stage 08.

Stub evidence binds a system input to its game and parent. It does not prove a hidden resource count, a random result or elapsed time. Deliberately false but publicly plausible system inputs can therefore halt a stub simulation when its private-state driver checks them. The stub is confined to tests and development views. Stage 07 must verify those facts before commitment in real games. A committed value is never rolled back to hide a failed private-state check.

The [strict-agreement design](verification/stage06/strict-agreement-design.md) defines the fault model, vote rules and crash requirements. The user chose agreement over availability: three-human games require all three votes, and a two-human game cannot continue alone after a disconnect. Ordering tolerates at most one Byzantine human voter. For one through six human voters the quorum is 1, 2, 3, 3, 4, 4 respectively. Bots do not vote.

## Prerequisites

Stage 04 (engine + sim) is complete. Stage 05 isn't required.

## 1. Identities & signatures (`@cp2p/crypto`, first part)

- **Identity helpers**: Ed25519 keypairs (`@noble/curves/ed25519`), with `PeerId = base64url(publicKey)`. Device identities authenticate the later lobby connection; they are separate from game signing keys.
- **Seat binding**: genesis maps each seat to a fresh per-game public key. That key signs commands and, for human seats, consensus messages. Stage 09 binds it to the device identity during the ceremony. Stage 10 stores the private game key atomically with its safety records. The Stage 06 caller injects the key and journal together.
- Helpers: `sign(bytes, sk)`, `verify(sig, bytes, pk)`, and `signObject(value, sk)` = sign over `canonicalEncode(value)` with a **domain separation prefix** (`"cp2p/v1/<purpose>\0"`), so a signature for one purpose can't be replayed as another.

## 2. Log entries

```ts
interface SignedCommand {
  body: {
    gameId: string;
    genesisDigest: string;
    seat: Seat;
    nonce: number;
    headSeq: number;
    headHash: string; // exact committed parent
    command: Command;
  };
  sig: string; // Ed25519 by seat's key, purpose "cmd"
}

interface LogEntry {
  seq: number; // 0 = genesis
  term: number; // consensus round within this sequence, starting at 1
  prevHash: string; // hex sha256 of previous entry's hash-body
  payload:
    | { kind: 'genesis'; genesis: Genesis }
    | { kind: 'command'; signed: SignedCommand }
    | { kind: 'system'; input: SystemInput; evidence: SystemEvidence } // evidence proves validity (beacon reveals, deck proofs, timer claims)
    | { kind: 'membership'; change: MembershipChange }; // seat online/offline/bot-takeover (stage 10)
  stateHash: string; // hash of public state AFTER applying this entry (computed by sequencer, verified by all)
  sequencer: PeerId;
  sig: string; // sequencer signature over all fields above, purpose "entry"
}
entryHash(e) = sha256(canonicalEncode({ seq, prevHash, payload, stateHash }));
```

- `GenesisBody` contains `protocolVersion`, `engineVersion`, `config`, ordered seats and bot hosts, `genesisSeed`, a fresh `ceremonyNonce`, `security: 'stub' | 'verified'`, cryptographic commitments and `createdAt`. It excludes `gameId` and signatures.
- `genesisDigest = base64url(hashValue({domain: 'cp2p/v1/genesis-body', body: GenesisBody}))`; `gameId` is its first 22 characters, for routing only. Every human signs the full digest under purpose `genesis`. Keys and seat numbers must be unique; human signatures are stored in seat order.
- Entry zero uses term 1, an all-zero previous hash, the derived genesis state hash and the first human's outer signature. Its value hash normalizes the payload to `{kind: 'genesis', genesisDigest}` so alternate valid consent signatures cannot create different log anchors.
- Entry value hashes exclude outer signatures, round and proposer so a locked value can be reproposed unchanged. Proposal signatures still cover these fields and their prior-round justification.

## 3. Validation of an entry (every peer, every entry)

1. `seq == head.seq + 1` and `prevHash == entryHash(head)`.
2. Verify the proposer for the entry's height and round using the certified membership and exclusion state. Historical sync uses that historical context, not the receiver's latest local round. Verify the proposer signature.
3. Per payload:
   - `command`: verify the seat's signature, full genesis digest and exact parent; require `nonce > lastNonce[seat]`; validate the engine input and any per-move proof. A stale command requires renewed intent validation before signing against another parent.
   - `system`: verify the evidence before engine application. Stub evidence is bound to its input and parent and accepted only with an explicitly opted-in stub genesis. Production refuses stub games. Stage 07 supplies real proofs.
   - `membership`: validate against membership rules (stage 10).
4. Derive the next state without publishing it, check engine invariants and compare its hash with `stateHash`. Preserve nonce and protocol metadata with the derived result. A local mismatch requires replay and diagnosis before accusing another peer.

An objectively invalid signed proposal can supply misbehaviour evidence once its committed parent and proposer context are established. Stale entries, missing parents, clock disagreements and a lone state-hash mismatch are not such evidence. Permanent proposer exclusion must itself be a certified protocol-control entry. It never silently removes the offender's voting weight.

## 4. Messages

All wire messages are validated on receipt with Valibot schemas (`v.safeParse`). Use `v.variant("t", [...])` for the message union and `v.strictObject` so unknown fields are rejected. Oversized (> 256 KB after reassembly), malformed or unknown messages are dropped and counted against the sender's reputation (disconnect after a threshold).

The wire schema validates the surrounding message; the engine validates registered command and system-input keys. Signatures, reveal proofs, and timer evidence stay in their log-entry fields. The P2P adapter must reject a local-mode `CARD_DEALT.card` value and deliver that identity privately instead.

```ts
type Msg =
  | { t: 'HELLO'; peerId; gameId?; protocolVersion; appVersion; head?: { seq; hash; term }; sig }
  | { t: 'SUBMIT'; cmd: SignedCommand } // author → ALL peers (broadcast, not just sequencer)
  | { t: 'PROPOSAL'; entry: LogEntry; validRound; prevotes; sig }
  | { t: 'VOTE'; vote: SignedVote } // signed prevote or precommit, including nil
  | { t: 'COMMIT'; entry: LogEntry; certificate: SignedVote[] }
  | { t: 'SYNC_REQ'; fromSeq; toSeq? }
  | { t: 'SYNC_RES'; entries: CertifiedEntry[]; more: boolean }
  | { t: 'SNAPSHOT_REQ'; atSeq? }
  | { t: 'SNAPSHOT_RES'; seq; state; protocolState; certificate } // chunked, replay checked
  | { t: 'HEARTBEAT'; genesisDigest; epoch; seat; term; head: { seq; hash }; sig }
  | { t: 'ACCUSE'; evidence: MisbehaviourEvidence }
  | { t: 'SYS_CONTRIB'; round: string; data: unknown; sig } // stage 07 beacon/deck contributions
  | { t: 'PRIVATE'; to: PeerId; payload: unknown; sig } // sent only on the direct channel to recipient
  | { t: 'CHAT'; text; ts; sig }
  | { t: 'PING'; n }
  | { t: 'PONG'; n };
```

Transport interface (implemented in-memory here and by WebRTC in stage 08):

```ts
interface Transport {
  self: PeerId;
  peers(): PeerId[]; // currently connected
  send(to: PeerId, msg: Uint8Array): void; // reliable-ordered per link while connected
  broadcast(msg: Uint8Array): void;
  onMessage(cb: (from: PeerId, msg: Uint8Array) => void): Unsubscribe;
  onPeerChange(cb: (peer: PeerId, up: boolean) => void): Unsubscribe;
}
```

Messages are encoded as canonical JSON bytes. (Consider a binary encoding later; not needed now.) Links can drop and reconnect, and messages in flight during a drop are lost. **Every protocol step must be idempotent and retry-safe.**

`SignedVote` binds the full genesis digest, membership epoch, seat, sequence, round, phase and value hash or explicit nil. Certificates require distinct, sorted voter signatures from the certified voter set. An unsigned commit notification has no authority.

## 5. Proposers, voting rounds and locks

- Use the two-phase locking algorithm and quorum requirements in the strict-agreement design. Proposal, prevote and precommit transitions are serialized and persisted before sending their messages.
- The proposer rotates deterministically through the agreed eligible humans by height and round. It never depends on a local online list. Round 1 at height 1 starts with the first human seat.
- Each voter signs at most one prevote and one precommit per height/round. A non-nil precommit needs a matching prevote quorum and a persisted lock. Nil votes and timeouts do not erase locks. Reproposals carry verifiable prior-round justification.
- Increasing round timeouts allow recovery after network delays. Two distinct authenticated voters can justify catching up to a higher round. No timeout reduces quorum size.
- Broadcast and retry submitted commands. A proposer withholding a still-applicable command triggers round advancement; delay alone is not proof of cheating. Idle game state awaiting a human choice is not censorship.
- Bot seats have separate signing keys held by their designated human host. They remain nonvoters.

## 6. Commitment and repair

- A matching quorum of signed non-nil precommits certifies a validated value. Persist the certificate and resulting state before announcing commitment. Keep the committed prefix permanently.
- Publish engine effects, private updates and successful submission results only after commitment. Board selection previews remain local. A round change never rolls back committed state.
- Persist votes, locks, current round, justified values and committed certificates in an injected safety store. The Stage 06 memory store survives protocol-instance crashes; Stage 10 supplies IndexedDB. Tests cover crashes immediately before and after writes.
- A peer that loses its safety store cannot simply rejoin under the same key and vote. It must recover a provably safe state or undergo the agreed identity-replacement procedure.
- The injected raw-key API has a caller precondition: `create` is only the first activation of a fresh game key; subsequent openings use `restore`, which refuses missing records. A caller that copies the raw key into a replacement empty journal can violate that precondition. Stage 10 must own key creation/loading together with durable safety storage and forbid that fallback. The simulation's deterministic keys are test fixtures, not device identities for production.
- **Desync**: retain a diagnostic, replay the certified prefix and verify full protocol metadata. Repair preserves prior vote/lock records. Stop voting if replay cannot establish valid state; do not trust an unverified snapshot from a claimed majority.

## 7. Snapshots & sync

- Every peer keeps the full log in memory (and in IndexedDB later). Logs are small: a base game is ~1–3k entries.
- `SYNC_REQ` returns up to 200 certified entries per batch, staying within the byte limit. Snapshots contain engine state, nonces, membership/exclusions and crypto metadata. Verify the certified chain and replay-derived metadata before using them for voting. The engine state hash alone cannot authenticate nonce or voter metadata.

## 8. Session layer

`P2PSession implements GameSession` (from stage 05) composes: transport + log + sequencer state machine + engine + randomness driver + private state. The UI is unchanged. Command submission flow:

1. The UI calls `submit(command)`.
2. Local pre-validation against the public engine **and** the private hand (the owner knows exact values).
3. Sign and broadcast `SUBMIT`.
4. Resolve only when the entry commits. After 10 s, expose pending/retry status without claiming that a submitted intent was cancelled. Retry the same signed bytes; stale intents require renewed validation against the current parent.

**System-input driver**: when `getPending` contains `random`/`reveal`/timeout items, the driver runs the corresponding sub-protocol (stubbed now, real in stage 07). The sequencer puts the resulting `system` entry (with evidence) into the log.

## 9. In-memory network & chaos harness

`packages/protocol/test-utils/memnet.ts`:

- A network of N transports. Per-link configurable latency (distribution), jitter, drop probability, duplicate probability, and scheduled partitions/heals. Drive it with a **deterministic virtual clock**: a fake-timers scheduler owned by the harness, so tests are reproducible and fast.
- Reordering: happens only across reconnects (WebRTC channels are ordered while up). Also add a "reorder" mode to prove idempotency.

Chaos scenarios, with RandomBots playing full games through `P2PSession`: five seeds per scenario on each push/PR, twenty nightly seeds per scenario with date-rotated game indices, and an initial acceptance run of twenty seeds per scenario. Manual workflow dispatch supports up to 1,000 seeds per scenario in distinct forty-game shards.

1. Clean network, 4 peers.
2. 5–15% duplicates, 50–400 ms latency.
3. Sequencer crashes mid-turn and comes back 20 s later.
4. Partition 2|2 for 30 s, then heal. Neither side has the required 3-of-4 quorum, so both pause. Assert no divergent commits, and that play resumes after the heal.
5. Partition 3|1: the three cooperative peers continue where pending inputs permit, and the fourth catches up after heal.
6. Byzantine sequencer: it includes an invalid command → it gets accused and replaced, and the game continues. Its normal session halts on evidence implicating its own key. The fault injector then acts as an explicitly malicious command-only client for that seat, signing legal game inputs without voting or proposing. Three honest sessions must finish with a certified exclusion and identical histories.
7. Byzantine sequencer: it censors one seat's commands → it gets replaced.
8. A peer desync injected artificially (a corrupted local state) → it's repaired via snapshot.
9. Two peers restarting at the same time. Volatile state is wiped; persisted vote/lock records and certified entries remain and missing committed entries are fetched from peers.

**Invariant at the end of every scenario**: all honest peers have identical committed logs and identical final state hashes. No honest peer rolls back a committed entry. Scenario 6 does not require the deliberately faulty client to maintain an honest history.

Also run the adversarial traces in the strict-agreement design, including equivocation, hidden certificates, forged round proofs and two-/three-human quorum loss. The last cases must pause safely and resume after the required voters return.

## Steps

1. Crypto identity helpers + signing with domain separation.
2. Log entry types, hashing, and validation (unit tests with hand-made logs, including every rejection path).
3. Valibot message schemas, encode/decode, and size limits.
4. Memnet with a virtual clock.
5. Happy path: submit → proposal → prevote → precommit → certified commit.
6. Round changes, persistent locks and crash recovery.
7. Censorship detection, accusation, exclusion.
8. Sync and snapshot.
9. `P2PSession` + system-input driver with stub randomness.
10. Chaos suite + `pnpm sim net --scenario <n> --seeds 20` for initial acceptance; larger manual runs remain available through workflow dispatch.

## Acceptance criteria

- [x] All 9 chaos scenarios pass on 20 seeds each with zero divergence for initial acceptance.
- [x] Forged signatures, replayed nonces, wrong prevHash and invalid commands are all rejected (unit tests).
- [x] A Byzantine sequencer is detected and replaced in scenarios 6 and 7.
- [x] Adversarial vote, lock, persistence and small-population pause tests pass. No unavailable voter is removed without the required certificates.
- [x] The web app can run a "simulated P2P" dev mode: 4 `P2PSession`s over memnet in one tab, with 4 small game views. Useful for debugging.

```

## docs/verification/p2p-acceptance-policy.md

```text
# Bounded M-C and M-D acceptance

The user authorized reducing redundant game counts. Stages 07 and 10 use the
following deterministic coverage requirements instead of hundreds of repetitions
of each scenario. This changes sample counts, not the required failure cases,
security guarantees, performance targets or browser coverage. No unchecked gate
becomes complete through this policy change.

## Stage 07

Run one reproducible game for each of the nine Stage 06 scenarios with the real
cryptographic participants and verified genesis. The existing stub-randomness
simulation remains useful separate coverage; it cannot satisfy these checks.

| Scenario                        | Required observation                                                                                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean four-peer network         | Complete play and independent final audits with matching certified histories.                                                                                               |
| Delayed and duplicated messages | Actually deliver duplicates and 50–400 ms latency; certify the same history and finish.                                                                                     |
| Sequencer crash and restart     | Crash mid-turn, keep durable safety records, return after 20 seconds, and finish without conflicting votes.                                                                 |
| Two-against-two partition       | Neither partition commits during the 30-second split. Heal and finish from the same prefix.                                                                                 |
| Three-against-one partition     | The quorum commits when required inputs are available. A missing private input must wait. Heal, catch up and finish.                                                        |
| Invalid proposer                | Reject the signed invalid command, certify the attributable finding and proposer exclusion, then finish with three honest voters and legal commands from the excluded seat. |
| Censoring proposer              | Observe an actually censored command, replace the proposer and commit that command, then finish.                                                                            |
| Corrupted local state           | Exercise verified repair from certified history and finish without rolling back any committed entry.                                                                        |
| Two simultaneous restarts       | Restore both peers from durable records, fetch missing certified entries, and finish on the same history.                                                                   |

Record protocol version, source revision, seed, actual injected fault, certified
head and relevant safety assertions. The faulty client in the invalid-proposer
case is not required to maintain an honest history. Expected misconduct findings
in that case are distinct from false findings in honest games.

Require three honest terminal compositions: human-only, humans with hosted bots,
and survivors with a recovered bot. Each must finish on the current protocol,
have no false `CHEAT_PROOF`, and obtain a complete successful independent audit
from every surviving human. At least one uses the server-backed browser path.
The same game can satisfy a scenario and a composition when it proves both.

Keep one focused signed adversarial case for every row of the Stage 07 cheat
table. Assert the stated detection time and outcome, including the private
recovery-void policy. Primitive rejection alone does not prove admission or
certification behavior. Keep the fast 100,000-round dice distribution test.

## Stage 10

Exercise every named chaos addition at least once with deterministic faults and
the current protocol. A trace may cover multiple rows only when it records the
required observation for each.

| Case                         | Required observation                                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Periodic restart             | In a four-human game, restart a peer with storage intact at each reached approximately 50-entry boundary, rotating the peer. Restore the exact certified prefix and safety state before voting.                                |
| Permanent departure          | Depart mid-game with four humans, certify old-quorum authorization, reconstruct private state, activate the bot, finish and independently audit every survivor.                                                                |
| Everyone leaves              | Close all peers mid-game, reopen them in a fixed non-seat order, restore the same prefix, certify a new move, finish and audit.                                                                                                |
| Sequencer loss during unlock | Interrupt before persistence, after persistence but before send, and after peer acceptance but before local commit. Never send an unpersisted vote or replace a durable contribution; retry the same operation after recovery. |
| Return after takeover        | Rebuild the returning human's private state, certify fresh keys, keep old keys retired and continue. Exercise another takeover where the signed quorum permits it; otherwise assert pause.                                     |

Compare reconstructed private state with an independent omniscient engine at
every certified sequence of the representative lifecycle game. Add focused
fixtures for draw, steal, transfer, recovery and return if that game does not
exercise their private-state changes. Public-state or final-score agreement
cannot replace exact private-state equality.

Retain focused checks for every signing/persistence interruption boundary,
transaction abort, lost acknowledgement, writer contention, stale import,
migration, withholding shares and two-/three-human quorum loss. Retain native
browser refresh, takeover, save transfer, encryption, history and snapshot
checks. The measured three-second resume target remains unchanged.

## Execution

Use bounded runs with explicit time and move limits. A timeout is a failure to
investigate, not a reason to silently increase the limit. Store public results
and source provenance; keep private game material out of reports. Run local
native browser checks in Chrome. Run the required Firefox/WebKit combinations
on CI to avoid the user's local browser crash popups.

The existing Stage 06 CI policy is unchanged. The new real-crypto and lifecycle
fixtures must be named and mapped to these rows before claiming acceptance.

```

## tools/sim/src/net.ts:180-275 (scenario8 injection/evidence)

```text
180:   let crashedProposalHeight: number | null = null;
181:   let crashedProposerSeat: Seat | null = null;
182:   const intentionallyInterruptedSubmissions = new WeakSet<object>();
183:   let maliciousHeight: number | null = null;
184:   let maliciousEntryHash: string | null = null;
185:   let maliciousCommandHash: string | null = null;
186:   let censoredCommandHash: string | null = null;
187:   let corruptedHeight: number | null = null;
188:   let desyncObserved = false;
189:   const snapshotRequestAtSeqs = new Set<number>();
190:   const snapshotResponsePairs = new Set<string>();
191:   let certifiedExclusionPeers = 0;
192:   let byzantineHalted = false;
193:   let byzantineSubmissionRevision: number | null = null;
194:   let byzantineSubmissionHash: string | null = null;
195:   let byzantineCommandCommits = 0;
196:   let verifiedNonVoter: VerifiedNonVoterActor | null = null;
197:   let nonVoterCommand: NonVoterCommand | null = null;
198:   let nonVoterContributionRetryAt = 0;
199:   let nonVoterWake: unknown = null;
200:   let nonVoterPublishedMaster = false;
201:   const nonVoterMessageTypes = new Set<string>();
202:   let byzantinePrivateCache: {
203:     revision: number;
204:     privateState: PrivateState;
205:     context: ProposalContext;
206:     driver: SimulationDriver;
207:   } | null = null;
208:   const bots = new Map(
209:     game.genesis.config.seats.map((seat) => [
210:       seat,
211:       {
212:         bot: new RandomBot(game.engine),
213:         rng: createBotRng(deriveSeed(options.seed, options.gameIndex, 'net-bot', seat)),
214:       },
215:     ]),
216:   );
217:   const failures: string[] = [];
218:   let submission: { seat: Seat; result: Result<void> | null } | null = null;
219: 
220:   function observe(seat: Seat, update: SessionUpdate): void {
221:     const prior = updates.get(seat);
222:     if (prior && update.revision < prior.revision)
223:       failures.push(`Peer ${seat} rolled back a commit`);
224:     if (update.status.kind === 'error') {
225:       if (options.scenario === 8 && seat === 0 && faultInjected && !faultRecovered)
226:         desyncObserved = true;
227:       else if (
228:         options.scenario === 6 &&
229:         seat === 0 &&
230:         faultInjected &&
231:         ['Objective evidence implicates the local signing key', 'replica-fault-limit'].includes(
232:           update.status.message,
233:         )
234:       )
235:         byzantineHalted = true;
236:       else failures.push(`Peer ${seat}: ${update.status.message}`);
237:     }
238:     if (prior?.revision !== update.revision) {
239:       const hash = toHex(hashValue(update.state));
240:       const known = stateHashes.get(update.revision);
241:       if (known !== undefined && known !== hash)
242:         failures.push(`Public state diverged at revision ${update.revision}`);
243:       stateHashes.set(update.revision, hash);
244:     }
245:     const head = sessions.get(seat)?.getCommittedHead();
246:     if (head) {
247:       const known = logHashes.get(head.seq);
248:       if (known !== undefined && known !== head.hash)
249:         failures.push(`Committed log value diverged at revision ${head.seq}`);
250:       logHashes.set(head.seq, head.hash);
251:     }
252:     updates.set(seat, update);
253:     if (
254:       options.scenario === 8 &&
255:       seat === 0 &&
256:       desyncObserved &&
257:       corruptedHeight !== null &&
258:       update.revision >= corruptedHeight &&
259:       update.status.kind === 'running'
260:     )
261:       faultRecovered = true;
262:     if (
263:       (options.scenario === 6 || seat === 0) &&
264:       maliciousHeight !== null &&
265:       update.revision >= maliciousHeight &&
266:       !faultRecovered
267:     ) {
268:       if (options.scenario === 6) {
269:         const committed = sessions.get(seat)?.exportSave().entries[maliciousHeight - 1];
270:         if (committed?.entry.payload.kind !== 'control' || committed.entry.payload.offender !== 0)
271:           failures.push('Invalid proposer was not excluded by the certified control entry');
272:       }
273:       if (options.scenario === 7) {
274:         const committed = sessions.get(seat)?.exportSave().entries[maliciousHeight - 1];
275:         if (
```

## tools/sim/src/net.ts:345-480 (scenario8 injection/evidence)

```text
345:   }
346: 
347:   function peerTransport(seat: Seat): Transport {
348:     const identity = game.identities.get(seat);
349:     if (!identity) throw new Error('Missing transport identity');
350:     const transport = network.transport(identity.peerId);
351:     if (![3, 4, 5, 6, 7, 8].includes(options.scenario)) return transport;
352:     const rewrite = (bytes: Uint8Array): Uint8Array | null => {
353:       const decoded = unwrap(decodeProtocolMessage(bytes));
354:       if (
355:         options.scenario === 8 &&
356:         seat === 0 &&
357:         decoded.t === 'SNAPSHOT_REQ' &&
358:         faultInjected &&
359:         desyncObserved &&
360:         corruptedHeight !== null &&
361:         decoded.atSeq === corruptedHeight - 1
362:       )
363:         snapshotRequestAtSeqs.add(decoded.atSeq);
364:       if ([3, 4, 5].includes(options.scenario)) {
365:         if (
366:           decoded.t === 'PROPOSAL' &&
367:           !faultInjected &&
368:           decoded.proposal.body.entry.seq >= 20 &&
369:           decoded.proposal.body.entry.term === 1 &&
370:           (updates.get(seat)?.state.turn.number ?? 0) >= 2
371:         ) {
372:           const proposal = decoded.proposal.body.entry;
373:           if (options.scenario === 3 && !crashRequested) {
374:             crashRequested = { seat, seq: proposal.seq };
375:           }
376:           if ([4, 5].includes(options.scenario) && !partitionRequested)
377:             partitionRequested = {
378:               proposer: seat,
379:               commandSeat:
380:                 proposal.payload.kind === 'command' ? proposal.payload.signed.body.seat : null,
381:               seq: proposal.seq,
382:             };
383:           if (options.scenario === 4) partitionProposalSeen.add(seat);
384:         }
385:         return bytes;
386:       }
387:       if (options.scenario === 8) return bytes;
388:       if (seat !== 0) return bytes;
389:       if (decoded.t !== 'PROPOSAL') return bytes;
390:       const { entry } = decoded.proposal.body;
391:       if (
392:         maliciousHeight === null &&
393:         entry.seq >= 20 &&
394:         entry.term === 1 &&
395:         (options.scenario !== 7 || entry.payload.kind === 'command')
396:       ) {
397:         maliciousHeight = entry.seq;
398:         faultInjected = true;
399:         faultRevision = entry.seq - 1;
400:         if (options.scenario === 7 && entry.payload.kind === 'command')
401:           censoredCommandHash = toHex(hashValue(entry.payload.signed));
402:       }
403:       if (entry.seq !== maliciousHeight || entry.term !== 1) return bytes;
404:       if (options.scenario === 7) return null;
405:       const proposal = invalidCommandProposal(
406:         decoded.proposal,
407:         game.genesis,
408:         seat,
409:         identity.secretKey,
410:       );
411:       maliciousEntryHash = entryHash(proposal.body.entry);
412:       if (proposal.body.entry.payload.kind !== 'command')
413:         throw new Error('Invalid command injection lacks its signed command');
414:       maliciousCommandHash = toHex(hashValue(proposal.body.entry.payload.signed));
415:       return unwrap(encodeProtocolMessage({ t: 'PROPOSAL', proposal }));
416:     };
417:     return {
418:       self: transport.self,
419:       peers: () => transport.peers(),
420:       send: (to, bytes) => {
421:         const changed = rewrite(bytes);
422:         if (changed) transport.send(to, changed);
423:       },
424:       broadcast: (bytes) => {
425:         const changed = rewrite(bytes);
426:         if (changed) transport.broadcast(changed);
427:       },
428:       onMessage: (listener) =>
429:         transport.onMessage((from, bytes) => {
430:           if (options.scenario === 4 && partitionRequested) {
431:             const incoming = unwrap(decodeProtocolMessage(bytes));
432:             if (
433:               incoming.t === 'PROPOSAL' &&
434:               incoming.proposal.body.entry.seq === partitionRequested.seq
435:             )
436:               partitionProposalSeen.add(seat);
437:           }
438:           if (options.scenario === 8 && seat === 0 && !faultRecovered) {
439:             const current = updates.get(seat);
440:             if (
441:               corruptedHeight === null &&
442:               current &&
443:               current.revision >= 20 &&
444:               current.revision % keys.length !== 0
445:             )
446:               corruptedHeight = current.revision + 1;
447:             const decoded = unwrap(decodeProtocolMessage(bytes));
448:             if (
449:               decoded.t === 'SNAPSHOT_RES' &&
450:               from !== game.identities.get(0)?.peerId &&
451:               desyncObserved &&
452:               snapshotRequestAtSeqs.has(decoded.atSeq)
453:             )
454:               snapshotResponsePairs.add(`${from}:${decoded.atSeq}`);
455:             // Keep this peer's target-height voting record empty while the other three certify.
456:             if (
457:               (decoded.t === 'PROPOSAL' && decoded.proposal.body.entry.seq === corruptedHeight) ||
458:               (decoded.t === 'VOTE' && decoded.vote.body.seq === corruptedHeight)
459:             )
460:               return;
461:             if (
462:               !faultInjected &&
463:               decoded.t === 'COMMIT' &&
464:               decoded.certified.entry.seq === corruptedHeight
465:             ) {
466:               const session = sessions.get(seat);
467:               if (!session) throw new Error('Missing peer for cache corruption');
468:               corruptDerivedBank(session);
469:               faultInjected = true;
470:               faultRevision = decoded.certified.entry.seq - 1;
471:             }
472:           }
473:           listener(from, bytes);
474:         }),
475:       onPeerChange: (listener) => transport.onPeerChange(listener),
476:       disconnect: (peer) => transport.disconnect(peer),
477:     };
478:   }
479: 
480:   function observeNonVoterMessage(bytes: Uint8Array): void {
```

## tools/sim/src/net.ts:980-1005 (scenario8 injection/evidence)

```text
980:               !nonVoterMessageTypes.has('SUBMIT') ||
981:               ['PROPOSAL', 'VOTE', 'COMMIT'].some((type) => nonVoterMessageTypes.has(type)))
982:           )
983:             throw new Error('Non-voter traffic did not prove command and owned-master publication');
984:         }
985:         if (options.scenario === 2 && network.diagnostics().duplicateDeliveries === 0)
986:           throw new Error('The latency scenario completed without delivering a duplicate packet');
987:         if (
988:           options.scenario === 8 &&
989:           (!desyncObserved || !snapshotRequestAtSeqs.size || !snapshotResponsePairs.size)
990:         )
991:           throw new Error(
992:             'Desync did not trigger a matching snapshot request and response after corruption',
993:           );
994:         const hashes = new Set(
995:           [...updates.values()].map((update) => toHex(hashValue(update.state))),
996:         );
997:         if (hashes.size !== 1) throw new Error('Final public state diverged');
998:         const histories = [...sessions.values()].map((session) =>
999:           session.exportSave().entries.map(({ entry }) => entryHash(entry)),
1000:         );
1001:         const first = histories[0];
1002:         if (
1003:           !first ||
1004:           histories.some(
1005:             (history) =>
```

## tools/sim/src/net.ts:1290-1310 (scenario8 injection/evidence)

```text
1290:   );
1291: }
1292: 
1293: /** Deliberate in-memory fault injection. Durable certificates and voting records stay intact. */
1294: function corruptDerivedBank(session: P2PSession): void {
1295:   let current: unknown = session;
1296:   for (const property of ['replica', 'context', 'log', 'state', 'bank']) {
1297:     if (typeof current !== 'object' || current === null)
1298:       throw new Error(`Cannot inject derived-state corruption at ${property}`);
1299:     current = Reflect.get(current, property);
1300:   }
1301:   if (typeof current !== 'object' || current === null)
1302:     throw new Error('Missing derived bank cache');
1303:   const brick: unknown = Reflect.get(current, 'brick');
1304:   if (typeof brick !== 'number' || !Reflect.set(current, 'brick', brick + 1))
1305:     throw new Error('Could not corrupt the derived bank cache');
1306: }
```

## Prior Claude design review result

```text
# Design review: repairing corrupted local derived state (Stage 06 scenario 8)

## Classification: what can be repaired and what must stay terminal

Don't decide by looking at which field of the live context changed. Everything in `this.context` is a cache rebuilt from the journal, including membership, nonces and crypto metadata. The fault is a **recoverable cached-state failure** only if all of these hold after the controller is quiet:

1. The controller failure code is `consensus-context`. It is not `consensus-restore`, `-storage`, `-write-conflict`, `-effects` or `-controller`.
2. `journal.load()` returns a record, and its genesis matches both `this.genesisEntry` and the genesis requested in `options`.
3. `replayCertifiedPrefix` succeeds on that record.
4. The fresh replay is **stamp-identical to the context the stopped controller opened on**. That check covers the bytes and the engine/policy function references. The comparison is against that opening stamp, never the live head.
5. `record.height === fresh.head.seq + 1`, and the head equals the anchor captured when the controller was opened.
6. The durable safety record at that height has `revision === stopped.persistedRevision()`.
7. `ConsensusController.restore(fresh)` accepts that record byte-exact, and `checkLocalKey` passes.

**Authority or safety mutation, which stays terminal:** any of the following.
- A journal entry, genesis or height has moved or can't be replayed.
- The safety revision has moved (another writer).
- The safety bytes fail restore or need normalization.
- An engine or policy method was replaced, so the stamp's function references differ.
- The key doesn't match.
- The failure is `consensus-restore`, which means new terminal evidence was found.

## Concrete steps

### 1. `consensus.ts` / `consensus-controller.ts`: add accessors only; `checkContext` is unchanged

```ts
// OwnedConsensusState
matchesOpenedContext(candidate: ProposalContext): boolean; // try { sameContextStamp(this.stamp, contextStamp(candidate)) } catch { false }

// ConsensusController (usable after stopVoting; needs no key)
opensOn(context: ProposalContext): boolean { return this.owned.matchesOpenedContext(context); }
settled(): Promise<void> { return this.queue.then(() => undefined, () => undefined); }
```

### 2. `ReplicatedLog`: record an immutable anchor when a controller opens

- Refactor `openController(context)` so it **returns** the controller instead of assigning `this.controller`.
- When it opens, record primitives: `{ seq, headHash, genesisDigest, voters: ReadonlySet<PeerId> }`.
- Compute `genesisDigest` once from `this.genesisEntry`.
- During a hold, use these values and never `this.context.*`. The corruption can hit `membership.genesisDigest`, `head.seq` or `voters` just as easily as `bank`.

### 3. Hold state and where to mark it

```ts
private derivedRepair: {
  stopped: ConsensusController;              // kept only for opensOn/persistedRevision
  anchor: Anchor;
  heldCommits: Map<string, CertifiedEntry>;  // ≤4, memory only, seq === anchor.seq + 1, unverified
  lastRequestAt: number;
} | null = null;
```

`enterDerivedRepair()` is synchronous and idempotent. It does the following:
- Moves `this.controller` into the hold and sets `this.controller = null`. Any path that isn't gated then throws, and the existing `catch` disposes, so the fallback fails closed.
- Calls `clearConsensusTimers()` and `clearTimedVoteRetry()`.
- Emits `status({kind:'halted', code:'consensus-context'})`.
- Broadcasts `SNAPSHOT_REQ` built from the anchor.

Call it from two places:
- **`acceptCertified`, same-height branch:** if `dispatch({kind:'commit'})` returns `consensus-context`, call `enterDerivedRepair()` and then `retainHeldCommit(certified)`. Don't precheck against `this.context.membership`, because it is suspect.
- **`enqueue`, before the fatal check:** `if (code === 'consensus-context' && this.enterDerivedRepair()) return outcome;`. That call returns false when no controller exists, and the error then falls through to dispose. All other fatal codes keep disposing.

### 4. Stop controller and timer effects while still receiving a snapshot

Use one choke point: `enqueue(op, { duringRepair?: true })`.
- While a hold is active, any operation without that flag returns a non-fatal `replica-repairing` result.
- Only the transport receive wrapper, `pulse` and `repair()` carry the flag.
- This blocks, without auditing each call site: consensus and vote-retry timers, `submit`, membership, `maybePropose`, `offerAvailableInput`, beacon/deck/count/steal stores, cheat candidates, master reveal, recovery and `onCommit`.

Inside `receive`, right after decoding and **before** the voter check that uses `this.context`:
- If a hold is active, return `receiveDuringRepair(from, msg)`.
- Admit senders via `anchor.voters`.
- Handle `SNAPSHOT_RES` (atSeq and digest checked against the anchor, `admitExpensiveRequest` applied) by calling `repairNow(snapshot)`.
- Handle `COMMIT` by retaining it.
- Answer `PING` with `PONG`.
- Silently drop everything else: no strike and no `captureRejectedProofs`.

Also skip `captureRejectedProofs` in the transport wrapper whenever a hold is active.

In `pulse`: if a hold is active, only re-broadcast the rate-limited anchor `SNAPSHOT_REQ`. Send no heartbeat (it is signed and uses the corrupt head), no rebroadcast of submitted commands, no `resume`, no `captureCertifiedDelivery` and no offers.

In the `SNAPSHOT_RES` and `handleEffects('halt')` paths, never call `activeController().snapshot()` while a hold is active.

### 5. `repairNow`: reuse durable restoration without trusting the broken snapshot

```ts
private async repairNow(snapshot?: unknown) {
  const hold = this.derivedRepair;
  if (!hold) { /* existing certified-validation gate via activeController().snapshot() */ }
  else await hold.stopped.settled();                     // any in-flight save has resolved
  load journal: throw → hold ? non-fatal 'replica-storage' (stay held) : as today; null → failClosed
  genesis bytes === this.genesisEntry && === initialProposalContext(options…).log.head, else failClosed
  replay → !ok: failClosed (derived path must not return non-fatally here)
  record.height/head vs hold.anchor (not this.context) → failClosed('replica-journal')
  if (hold && !hold.stopped.opensOn(fresh)) → failClosed('replica-authority')
  if (hold && snapshot === undefined) → stay held            // Stage06: snapshot-gated
  verifyReplaySnapshot(snapshot, fresh) → non-fatal 'replica-snapshot', stay held, nothing swapped
  const safety = await journal.loadSafety(record.height)    // throw → stay held; null → failClosed
  if (hold && safety.revision !== hold.stopped.persistedRevision()) → failClosed('consensus-write-conflict')
  const next = await this.openController(fresh)             // ConsensusController.restore: byte-exact or fatal
  // ---- first mutation of replica state happens here ----
  swap context/entries/timers/caches; this.controller = next; this.derivedRepair = null
  haltKind === 'certified-validation' ? dispatch({kind:'resume-after-replay'}) : next.resume()
  for (const c of hold.heldCommits.values()) await this.acceptCertified(c)  // full validation on fresh parent
  requestSync(anchor.seq + 1); schedulePulse()
}
```

Nothing signs or persists before `restore` succeeds.
- The snapshot is only a cross-check. The local replay of the durable journal is the authority.
- `failClosed` must not rely on a live controller. Check that it doesn't dispatch `terminal-halt` through `activeController()`.

### 6. Avoiding duplicate votes when the context changes during a pending persistence

If `save` resolved and then `owned.commit()` failed:
- `revision` has already been incremented.
- The durable record holds a signed vote that was never broadcast.
- The existing `if (this.stopped)` guard prevents the old controller from emitting.

The repair then works like this:
1. `settled()` makes sure no save is still in flight.
2. The exact-revision check proves no other writer touched the record.
3. `restore` loads that record.
4. `resume()` **re-sends the stored signed bytes**; it doesn't sign again.
5. If the triggering proposal or vote is delivered again, the reducer finds the local vote already recorded.

If the `after` check caught the change before the save, the candidate was never persisted or sent, so a different vote after replay is not equivocation.

Never re-sign from the old controller's in-memory state, and never re-dispatch the triggering event before `restore`.

## Unsafe shortcuts

- **Removing `consensus-context` from `FATAL_CONTROLLER_ERRORS`.** A half-alive replica would keep pulsing, signing heartbeats and writing contribution stores from the corrupt context. It would also accept mutated membership or code without proof.
- **Re-stamping, weakening or bypassing `checkContext`, or patching the corrupt field back in place.**
- **Calling `ConsensusController.create`, `createConsensusState` or `journal.initialize` at the same height, or re-saving the record from old in-memory state.**
- **Installing the peer snapshot as state**, or treating a claimed majority as authority.
- **Comparing against the live `this.context.log.head` or its genesis digest**, or replaying `this.entries` instead of the durable journal.
- **Accepting any safety revision or a journal that has moved forward.** A storage conflict must stay terminal. There is no rollback, and no forward jump without verification.
- **Treating `consensus-restore` or terminal normalization as repairable.**
- **Striking the honest `COMMIT` sender, or persisting the held certificate before it is validated on the fresh parent.**

## Tests and counterexamples

1. **The given regression:** add the automatic retry of the held commit, i.e. the same test without re-injecting the `COMMIT`.
2. **Corruption also changes `membership.genesisDigest`, `head.seq` and `voters`.** Repair still works through the anchor, and the `SNAPSHOT_REQ` still carries the true digest and seq.
3. **Snapshot problems:** forged, wrong `atSeq`, or wrong digest → stays held, no `VOTE`, no store writes. A later valid snapshot repairs.
4. **Safety bytes tampered during the hold** → terminal and disposed. **A CAS revision bump by another writer** → `consensus-write-conflict` terminal.
5. **Journal failures:** `load` throws → stays held, then recovers on retry. Journal `null`, a tampered certificate, swapped genesis, or a height the journal has advanced → terminal, and the committed prefix is unchanged.
6. **Code mutation:** `context.log.engine.apply` or a policy derivation function is replaced → `opensOn` returns false → terminal.
7. **Mutation during a pending save:** use a store whose `save` mutates the context before resolving.
   - No `VOTE` goes out before repair.
   - After repair, exactly one prevote is broadcast, and its bytes equal the durable copy.
   - Re-delivering the proposal produces no second distinct signature.
8. **Lock preserved:** start with a persisted lock at round r, corrupt, then repair. Round, lock and votes must be byte-identical to the prior record.
9. **No effects during the hold:** fire pulse ticks, consensus timeouts, `submit`, `SYS_CONTRIB`, `DECK_CONTRIB` and `CHEAT_CLAIM`. Only `SNAPSHOT_REQ` and `PONG` should be sent, no stores are written, and the replica is not disposed.
10. **Held commits:** a held `COMMIT` with bad signatures is rejected after repair without affecting the repair. The held set stays capped at 4.
11. **Existing paths unchanged:** the certified-validation repair still passes. `consensus-restore`, `consensus-storage` and `consensus-write-conflict` still dispose.
12. **Replay equals incremental state:** the `advanceContext` result must stay stamp-identical to a full replay over a whole game. Otherwise step 4 of the classification would wrongly make honest peers terminal.

This was a read-only review: I didn't run any tools or change any files. Separately, the Atlassian and Google Drive connectors need authorization in your claude.ai connector settings before they can be used.
```

## Exact production/test diff

```diff
diff --git a/packages/protocol/src/consensus-controller.test.ts b/packages/protocol/src/consensus-controller.test.ts
index 41a5f97..94b17e4 100644
--- a/packages/protocol/src/consensus-controller.test.ts
+++ b/packages/protocol/src/consensus-controller.test.ts
@@ -217,6 +217,13 @@ describe('durable consensus controller', () => {
       ).toBe(true);
       const locked = controller.snapshot();
       expect(locked.ok && locked.value.locked?.hash).toBe(entryHash(candidate));
+      const durableLock = await options.store.load();
+      const exact = await restore({ ...options, requireExactRestore: true });
+      expect(exact.snapshot()).toEqual(locked);
+      expect(await options.store.load()).toEqual(durableLock);
+      expect((await exact.resume()).ok).toBe(true);
+      expect(await options.store.load()).toEqual(durableLock);
+      exact.dispose();
       expect(
         (await controller.dispatch({ kind: 'vote', vote: vote(1, 'precommit', null) })).ok,
       ).toBe(true);
@@ -478,16 +485,49 @@ describe('durable consensus controller', () => {
     const store = new PausableStore();
     const { options, candidate, emissions } = setup(store);
     const controller = await create(options);
+    const opened = {
+      ...options.context,
+      excludedProposers: [...options.context.excludedProposers],
+    };
     store.pauseUpdates = true;
     const pending = controller.dispatch({ kind: 'propose', candidate });
     await store.entered.promise;
+    let settled = false;
+    const settlement = controller.settled().then(() => {
+      settled = true;
+      return undefined;
+    });
+    await Promise.resolve();
+    expect(settled).toBe(false);
     options.context.excludedProposers = [1];
     store.resume.release();
     expect(errorCode(await pending)).toBe('consensus-context');
+    await settlement;
+    expect(settled).toBe(true);
+    const saved = await store.load();
+    if (!saved) throw new Error('Missing persisted vote after interrupted write');
+    expect(saved.revision).toBe(1);
+    expect(controller.matchesPersistedRecord(saved)).toBe(true);
+    expect(controller.opensOn(opened)).toBe(true);
+    expect(controller.opensOn(options.context)).toBe(false);
     expect(emissions).toHaveLength(0);
     expect(errorCode(await controller.dispatch({ kind: 'input-available' }))).toBe(
       'consensus-stopped',
     );
+    const recoveredEffects: ConsensusEffect[][] = [];
+    const repaired = await restore({
+      ...options,
+      context: opened,
+      requireExactRestore: true,
+      onEffects: (effects) => {
+        recoveredEffects.push([...effects]);
+      },
+    });
+    expect(await store.load()).toEqual(saved);
+    expect((await repaired.resume()).ok).toBe(true);
+    expect(recoveredEffects.flat().map((effect) => effect.kind)).toContain('broadcast-vote');
+    expect(await store.load()).toEqual(saved);
+    repaired.dispose();
   });
 
   test('does not persist an initial record when context stamping fails', async () => {
diff --git a/packages/protocol/src/consensus-controller.ts b/packages/protocol/src/consensus-controller.ts
index 2b7dea5..e3c385d 100644
--- a/packages/protocol/src/consensus-controller.ts
+++ b/packages/protocol/src/consensus-controller.ts
@@ -29,6 +29,8 @@ export interface ConsensusControllerOptions {
   secretKey: Uint8Array;
   /** One record for this game/key/height, retained across controller crashes. */
   store: SafetyStore;
+  /** Repair must reuse exact durable bytes without normalizing newly found terminal evidence. */
+  requireExactRestore?: boolean;
   /** Effects are at-least-once. Handlers must deduplicate committed sequence/value. */
   onEffects: (effects: readonly ConsensusEffect[]) => void | Promise<void>;
   /** Local admission only. It must not alter replay or objective validity. */
@@ -43,6 +45,7 @@ export interface ConsensusControllerOptions {
 export class ConsensusController {
   private queue: Promise<unknown> = Promise.resolve();
   private stopped = false;
+  private persistedBytes: Uint8Array;
   private readonly secretKey: Uint8Array;
   private readonly rejectedProposals = new Map<string, { code: string; message: string }>();
 
@@ -53,6 +56,7 @@ export class ConsensusController {
     private readonly owned: OwnedConsensusState,
   ) {
     this.secretKey = options.secretKey.slice();
+    this.persistedBytes = canonicalEncode(state);
   }
 
   /** Only for a genuinely new height; existing or lost stores are not reset here. */
@@ -109,7 +113,7 @@ export class ConsensusController {
     let revision = record.revision;
     const normalized = canonicalEncode(restored.value);
     if (!sameBytes(normalized, record.bytes)) {
-      if (restored.value.haltKind !== 'terminal')
+      if (options.requireExactRestore || restored.value.haltKind !== 'terminal')
         return failure('consensus-restore', 'Voting record changed without a terminal proof');
       try {
         if (!(await options.store.save(revision, normalized)))
@@ -139,6 +143,22 @@ export class ConsensusController {
     return snapshot;
   }
 
+  /** The opening stamp remains usable after the mutable derived context fails its guard. */
+  opensOn(context: ProposalContext): boolean {
+    return this.owned.matchesOpenedContext(context);
+  }
+
+  settled(): Promise<void> {
+    return this.queue.then(
+      () => undefined,
+      () => undefined,
+    );
+  }
+
+  matchesPersistedRecord(record: StoredSafety): boolean {
+    return record.revision === this.revision && sameBytes(record.bytes, this.persistedBytes);
+  }
+
   /** Expected CAS revision for atomically committing this controller's height. */
   persistedRevision(): number {
     return this.revision;
@@ -202,7 +222,8 @@ export class ConsensusController {
         return admitted;
       }
       try {
-        if (!(await this.options.store.save(this.revision, canonicalEncode(candidate)))) {
+        const bytes = canonicalEncode(candidate);
+        if (!(await this.options.store.save(this.revision, bytes))) {
           this.owned.discard();
           this.stopped = true;
           return failure(
@@ -218,6 +239,7 @@ export class ConsensusController {
           'Voting stopped because its state could not be persisted',
         );
       }
+      this.persistedBytes = canonicalEncode(candidate);
       this.revision += 1;
       const committed = this.owned.commit();
       if (!committed.ok) {
diff --git a/packages/protocol/src/consensus.ts b/packages/protocol/src/consensus.ts
index 1c6cbec..026bdd4 100644
--- a/packages/protocol/src/consensus.ts
+++ b/packages/protocol/src/consensus.ts
@@ -1628,6 +1628,7 @@ export type ConsensusEvent =
 
 /** Private, validated state for one controller height. Public reducers stay fully validating. */
 export interface OwnedConsensusState {
+  matchesOpenedContext(candidate: ProposalContext): boolean;
   snapshot(): Result<ConsensusState>;
   dispatch(
     event: ConsensusEvent,
@@ -1650,6 +1651,36 @@ class OwnedConsensusStateImpl implements OwnedConsensusState {
     ownedStates.add(state);
   }
 
+  matchesOpenedContext(candidate: ProposalContext): boolean {
+    try {
+      const replayed = contextStamp(candidate);
+      // Full replay rebuilds these record wrappers and ancestry closures. Engine,
+      // policy, prototypes and their function references must remain identical.
+      const rebuilt = new Set([
+        'context',
+        // runtimeReferences depth zero repeats the wrapper itself; deeper
+        // prototype references remain part of the comparison.
+        'context/prototype/0',
+        'log',
+        'log/prototype/0',
+        'context/verifyHistoricalCheat',
+        'context/verifyHistoricalAccusation',
+      ]);
+      const openedFunctions = this.stamp.functions.filter(([name]) => !rebuilt.has(name));
+      const replayedFunctions = replayed.functions.filter(([name]) => !rebuilt.has(name));
+      return (
+        sameBytes(this.stamp.contextBytes, replayed.contextBytes) &&
+        openedFunctions.length === replayedFunctions.length &&
+        openedFunctions.every(
+          ([name, reference], index) =>
+            name === replayedFunctions[index]?.[0] && reference === replayedFunctions[index]?.[1],
+        )
+      );
+    } catch {
+      return false;
+    }
+  }
+
   private checkContext(): Result<void> {
     let current: ContextStamp;
     try {
diff --git a/packages/protocol/src/replicated-log.test.ts b/packages/protocol/src/replicated-log.test.ts
index c1b7cf1..b207733 100644
--- a/packages/protocol/src/replicated-log.test.ts
+++ b/packages/protocol/src/replicated-log.test.ts
@@ -2499,4 +2499,143 @@ describe('replicated certified log adapter', () => {
     expect(replica.getContext().log.head.seq).toBe(1);
     replica.dispose();
   });
+
+  test.each(['unchanged', 'safety', 'locked-safety', 'engine'] as const)(
+    'repairs a corrupted derived context only with unchanged durable authority (%s)',
+    async (mutation) => {
+      const fixture = fourHumanFixture();
+      const engine = { ...fixture.engine };
+      const first = fixtureAt(fixture.identities, 0);
+      const second = fixtureAt(fixture.identities, 1);
+      const local = fixtureAt(fixture.identities, 3);
+      const journal = new MemoryProtocolJournal();
+      const transport = new CapturingTransport(local.peerId);
+      const statuses: string[] = [];
+      const replica = value(
+        await ReplicatedLog.create({
+          genesisEntry: fixture.entry,
+          engine,
+          policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
+          seat: 3,
+          secretKey: local.secretKey,
+          transport,
+          clock: new ManualClock(),
+          journal,
+          onStatus: (status) => statuses.push(status.kind === 'halted' ? status.code : status.kind),
+        }),
+      );
+      const parent = replica.getContext();
+      const safetyBefore = await journal.loadSafety(1);
+      if (!safetyBefore) throw new Error('Missing initial durable safety record');
+
+      let derived: unknown = replica;
+      for (const property of ['context', 'log', 'state', 'bank']) {
+        if (typeof derived !== 'object' || derived === null)
+          throw new Error(`Cannot corrupt derived state at ${property}`);
+        derived = Reflect.get(derived, property);
+      }
+      if (typeof derived !== 'object' || derived === null)
+        throw new Error('Missing derived bank state');
+      const brick = Reflect.get(derived, 'brick');
+      if (typeof brick !== 'number' || !Reflect.set(derived, 'brick', brick + 1))
+        throw new Error('Could not corrupt derived bank state');
+
+      const input: SystemInput = { kind: 'system', type: 'START_SEAT', seat: 0 };
+      const applied = value(fixture.engine.apply(parent.log.state, input));
+      const entry = signEntry(
+        {
+          seq: 1,
+          term: 1,
+          prevHash: entryHash(parent.log.head),
+          payload: { kind: 'system', input, evidence: stubEvidence(parent.log, input) },
+          stateHash: toHex(hashValue(applied.state)),
+          sequencer: first.peerId,
+        },
+        first.secretKey,
+      );
+      const certified = {
+        entry,
+        certificate: ([0, 1, 2] as const).map((seat) =>
+          signVote(
+            {
+              genesisDigest: genesisDigest(fixture.genesis),
+              epoch: 0,
+              seat,
+              seq: 1,
+              term: 1,
+              phase: 'precommit',
+              valueHash: entryHash(entry),
+            },
+            fixtureAt(fixture.identities, seat).secretKey,
+          ),
+        ),
+      };
+
+      transport.inject(second.peerId, { t: 'COMMIT', certified });
+      await replica.flush();
+      expect(statuses).toContain('consensus-context');
+      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(0);
+      expect(transport.sent).toContainEqual({
+        t: 'SNAPSHOT_REQ',
+        genesisDigest: parent.membership.genesisDigest,
+        atSeq: parent.log.head.seq,
+      });
+      expect((await journal.load())?.height).toBe(1);
+      expect(await journal.loadSafety(1)).toEqual(safetyBefore);
+      expect(replica.getContext().log.head.seq).toBe(0);
+
+      transport.inject(second.peerId, {
+        t: 'SNAPSHOT_RES',
+        genesisDigest: parent.membership.genesisDigest,
+        atSeq: parent.log.head.seq,
+        snapshot: { forged: true },
+      });
+      await replica.flush();
+      expect((await journal.load())?.height).toBe(1);
+      expect(await journal.loadSafety(1)).toEqual(safetyBefore);
+      expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(0);
+
+      if (mutation === 'safety') {
+        if (!(await journal.saveSafety(1, safetyBefore.revision, safetyBefore.bytes)))
+          throw new Error('Could not inject a competing durable safety revision');
+      } else if (mutation === 'locked-safety') {
+        const changed: unknown = canonicalDecode(safetyBefore.bytes);
+        if (typeof changed !== 'object' || changed === null || !journal['record'])
+          throw new Error('Missing durable safety fixture');
+        Reflect.set(changed, 'locked', { round: 1, hash: entryHash(entry), polka: [] });
+        // Deliberately corrupt durable bytes without advancing its CAS revision.
+        journal['record'].safety.bytes = canonicalEncode(changed);
+      } else if (mutation === 'engine') {
+        const apply = engine.apply;
+        engine.apply = (state, nextInput) => apply(state, nextInput);
+      }
+
+      transport.inject(second.peerId, {
+        t: 'SNAPSHOT_RES',
+        genesisDigest: parent.membership.genesisDigest,
+        atSeq: parent.log.head.seq,
+        snapshot: snapshotFromContext(parent),
+      });
+      await replica.flush();
+      // oxlint-disable vitest/no-conditional-expect -- Parameterized authority mutations intentionally have different terminal outcomes.
+      if (mutation !== 'unchanged') {
+        expect((await journal.load())?.height).toBe(1);
+        expect(transport.sent.filter((message) => message.t === 'VOTE')).toHaveLength(0);
+        expect(statuses).toContain(
+          mutation === 'engine' ? 'replica-authority' : 'consensus-write-conflict',
+        );
+        replica.dispose();
+        return;
+      }
+      // oxlint-enable vitest/no-conditional-expect
+      expect((await journal.load())?.height).toBe(2);
+      expect(replica.getContext().log.head).toEqual(entry);
+      expect((await journal.load())?.entries).toEqual([certified]);
+      const replayed = value(
+        replayCertifiedPrefix(fixture.entry, [certified], engine, replica['options'].policy),
+      );
+      expect(replica['activeController']().opensOn(replayed.context)).toBe(true);
+      replica.dispose();
+    },
+  );
 });
diff --git a/packages/protocol/src/replicated-log.ts b/packages/protocol/src/replicated-log.ts
index ea7632c..a1add29 100644
--- a/packages/protocol/src/replicated-log.ts
+++ b/packages/protocol/src/replicated-log.ts
@@ -339,6 +339,18 @@ export class ReplicatedLog {
   private queuedMessages = 0;
   private pulseTimer: unknown = null;
   private disposed = false;
+  private controllerAnchor: {
+    seq: number;
+    hash: string;
+    genesisDigest: string;
+    voters: readonly string[];
+  } | null = null;
+  private derivedRepair: {
+    stopped: ConsensusController;
+    anchor: NonNullable<ReplicatedLog['controllerAnchor']>;
+    heldCommits: Map<string, CertifiedEntry>;
+    lastRequestAt: number;
+  } | null = null;
 
   private constructor(
     private readonly options: ReplicatedLogOptions,
@@ -488,14 +500,18 @@ export class ReplicatedLog {
 
   /** Replays the certified parent before retrying a retained, authenticated certificate. */
   repair(snapshot?: unknown): Promise<Result<void>> {
-    return this.enqueue(() => this.repairNow(snapshot));
+    return this.enqueue(() => this.repairNow(snapshot), true);
   }
 
   private async repairNow(snapshot?: unknown): Promise<Result<void>> {
-    const state = this.activeController().snapshot();
-    if (!state.ok) return state;
-    if (state.value.haltKind !== 'certified-validation')
-      return failure('replica-repair', 'Only a certified validation halt can be repaired');
+    const hold = this.derivedRepair;
+    if (hold) await hold.stopped.settled();
+    else {
+      const state = this.activeController().snapshot();
+      if (!state.ok) return state;
+      if (state.value.haltKind !== 'certified-validation')
+        return failure('replica-repair', 'Only a certified validation halt can be repaired');
+    }
     let record: Awaited<ReturnType<ProtocolJournal['load']>>;
     try {
       record = await this.options.journal.load();
@@ -504,25 +520,67 @@ export class ReplicatedLog {
     }
     if (!record)
       return this.failClosed('replica-journal', 'Certified journal is missing during repair');
+    if (
+      !sameBytes(canonicalEncode(record.genesis), canonicalEncode(this.genesisEntry)) ||
+      !sameBytes(canonicalEncode(record.genesis), canonicalEncode(this.options.genesisEntry))
+    )
+      return this.failClosed('replica-genesis', 'Repair journal differs from the original genesis');
     const replayed = replayCertifiedPrefix(
       record.genesis,
       record.entries,
       this.options.engine,
       this.options.policy,
     );
-    if (!replayed.ok) return replayed;
+    if (!replayed.ok)
+      return hold ? this.failClosed(replayed.error.code, replayed.error.message) : replayed;
     const fresh = replayed.value.context;
     if (
       record.height !== fresh.log.head.seq + 1 ||
-      fresh.log.head.seq !== this.context.log.head.seq ||
-      entryHash(fresh.log.head) !== entryHash(this.context.log.head)
+      fresh.log.head.seq !== (hold?.anchor.seq ?? this.context.log.head.seq) ||
+      entryHash(fresh.log.head) !== (hold?.anchor.hash ?? entryHash(this.context.log.head))
     )
       return this.failClosed('replica-journal', 'Certified parent changed during repair');
+    if (hold && !hold.stopped.opensOn(fresh))
+      return this.failClosed(
+        'replica-authority',
+        'Durable replay differs from the controller opening context',
+      );
+    if (hold && snapshot === undefined)
+      return failure('replica-repairing', 'Derived repair requires a replay-verified snapshot');
     if (snapshot !== undefined) {
       const checked = verifyReplaySnapshot(snapshot, fresh);
       if (!checked.ok) return checked;
     }
-    this.activeController().dispose();
+    let restored: ConsensusController | null = null;
+    if (hold) {
+      const safety = record.safety;
+      if (!hold.stopped.matchesPersistedRecord(safety))
+        return this.failClosed(
+          'consensus-write-conflict',
+          'Durable vote or lock record changed during repair',
+        );
+      const local = checkLocalKey(this.options, fresh);
+      if (!local.ok) return this.failClosed(local.error.code, local.error.message);
+      for (const key of local.value.keys.values()) key.fill(0);
+      const opened = await this.restoreController(fresh, true);
+      if (!opened.ok) return this.failClosed(opened.error.code, opened.error.message);
+      restored = opened.value;
+      let stillStored: Awaited<ReturnType<ProtocolJournal['loadSafety']>>;
+      try {
+        stillStored = await this.options.journal.loadSafety(record.height);
+      } catch {
+        restored.dispose();
+        return failure('replica-storage', 'Could not recheck durable safety during repair');
+      }
+      if (!stillStored || !hold.stopped.matchesPersistedRecord(stillStored)) {
+        restored.dispose();
+        return this.failClosed(
+          'consensus-write-conflict',
+          'Durable safety changed while restoring repair',
+        );
+      }
+    }
+    if (!hold) this.activeController().dispose();
     this.controller = null;
     this.context = fresh;
     this.timerObserver.advance(fresh.log.timers ?? []);
@@ -535,9 +593,22 @@ export class ReplicatedLog {
     this.sentDeckPrefix = null;
     this.entries = replayed.value.entries;
     this.refreshHistoricalHumanPeers();
-    const opened = await this.openController();
-    if (!opened.ok) return this.failClosed(opened.error.code, opened.error.message);
-    return this.activeController().dispatch({ kind: 'resume-after-replay' });
+    if (!restored) {
+      const opened = await this.openController();
+      if (!opened.ok) return this.failClosed(opened.error.code, opened.error.message);
+      return this.activeController().dispatch({ kind: 'resume-after-replay' });
+    }
+    this.installController(restored, fresh);
+    this.derivedRepair = null;
+    const resumed = await restored.resume();
+    if (!resumed.ok) return resumed;
+    for (const certified of hold?.heldCommits.values() ?? []) {
+      // oxlint-disable-next-line no-await-in-loop -- Retained untrusted hints are fully validated on the freshly restored parent.
+      const accepted = await this.acceptCertified(certified);
+      if (!accepted.ok && FATAL_CONTROLLER_ERRORS.has(accepted.error.code)) return accepted;
+    }
+    this.schedulePulse();
+    return this.requestSync(this.context.log.head.seq + 1);
   }
 
   /** Resolves on matching commitment; another committed value requires renewed intent. */
@@ -858,6 +929,8 @@ export class ReplicatedLog {
   dispose(): void {
     if (this.disposed) return;
     this.disposed = true;
+    this.derivedRepair?.stopped.dispose();
+    this.derivedRepair = null;
     this.pendingTradeProofs.clear();
     this.tradeProofResponses.clear();
     this.tradeProofRequestsByFinalizer.clear();
@@ -1084,12 +1157,16 @@ export class ReplicatedLog {
     }
   }
 
-  private async openController(): Promise<Result<void>> {
-    const controller = await ConsensusController.restore({
-      context: this.context,
+  private restoreController(
+    context: ProposalContext,
+    exact = false,
+  ): Promise<Result<ConsensusController>> {
+    return ConsensusController.restore({
+      context,
+      requireExactRestore: exact,
       seat: this.options.seat,
       secretKey: this.secretKey,
-      store: journalSafetyStore(this.options.journal, this.context.log.head.seq + 1),
+      store: journalSafetyStore(this.options.journal, context.log.head.seq + 1),
       onEffects: (effects) => this.handleEffects(effects),
       admitLocalValue: (proposal) => this.canVoteForRecoveryProposal(proposal),
       beforePersist: (previous, next) => {
@@ -1097,16 +1174,97 @@ export class ReplicatedLog {
         return timed.ok ? this.admitRecoveryVotes(previous, next) : timed;
       },
     });
-    if (!controller.ok) return controller;
-    this.controller = controller.value;
+  }
+
+  private installController(controller: ConsensusController, context: ProposalContext): void {
+    this.controller = controller;
+    this.controllerAnchor = Object.freeze({
+      seq: context.log.head.seq,
+      hash: entryHash(context.log.head),
+      genesisDigest: context.membership.genesisDigest,
+      voters: Object.freeze(context.membership.voters.map((voter) => voter.publicKey)),
+    });
+  }
+
+  private async openController(): Promise<Result<void>> {
+    const opened = await this.restoreController(this.context);
+    if (!opened.ok) return opened;
+    this.installController(opened.value, this.context);
     return success(undefined);
   }
 
-  private enqueue<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
+  private enterDerivedRepair(): boolean {
+    if (this.derivedRepair) return true;
+    if (!this.controller || !this.controllerAnchor) return false;
+    const stopped = this.controller;
+    stopped.dispose();
+    this.controller = null;
+    this.derivedRepair = {
+      stopped,
+      anchor: this.controllerAnchor,
+      heldCommits: new Map(),
+      lastRequestAt: -Infinity,
+    };
+    this.clearConsensusTimers();
+    this.clearTimedVoteRetry();
+    this.status({ kind: 'halted', code: 'consensus-context' });
+    this.requestDerivedSnapshot();
+    this.schedulePulse();
+    return true;
+  }
+
+  private requestDerivedSnapshot(): Result<void> {
+    const hold = this.derivedRepair;
+    if (!hold || this.options.clock.now() - hold.lastRequestAt < 2_000) return success(undefined);
+    hold.lastRequestAt = this.options.clock.now();
+    return this.broadcast({
+      t: 'SNAPSHOT_REQ',
+      genesisDigest: hold.anchor.genesisDigest,
+      atSeq: hold.anchor.seq,
+    });
+  }
+
+  private retainHeldCommit(certified: CertifiedEntry): void {
+    const hold = this.derivedRepair;
+    if (
+      !hold ||
+      certified.entry.seq !== hold.anchor.seq + 1 ||
+      certified.entry.prevHash !== hold.anchor.hash ||
+      hold.heldCommits.size >= 4
+    )
+      return;
+    hold.heldCommits.set(entryHash(certified.entry), copyCanonical(certified));
+  }
+
+  private receiveDuringRepair(from: PeerId, message: ProtocolMessage): Promise<Result<void>> {
+    const hold = this.derivedRepair;
+    if (!hold || !hold.anchor.voters.includes(from)) return Promise.resolve(success(undefined));
+    if (message.t === 'SNAPSHOT_RES') {
+      if (
+        message.genesisDigest !== hold.anchor.genesisDigest ||
+        message.atSeq !== hold.anchor.seq ||
+        !this.admitExpensiveRequest(from, `snapshot-response/${toHex(hashValue(message.snapshot))}`)
+      )
+        return Promise.resolve(success(undefined));
+      return this.repairNow(message.snapshot);
+    }
+    if (message.t === 'COMMIT') this.retainHeldCommit(message.certified);
+    if (message.t === 'PING') return Promise.resolve(this.send(from, { t: 'PONG', n: message.n }));
+    return Promise.resolve(success(undefined));
+  }
+
+  private enqueue<T>(
+    operation: () => Promise<Result<T>>,
+    duringRepair = false,
+  ): Promise<Result<T>> {
     const result = this.queue.then(async (): Promise<Result<T>> => {
       if (this.disposed) return failure('replica-disposed', 'Replicated log is closed');
+      if (this.derivedRepair && !duringRepair)
+        return failure('replica-repairing', 'Awaiting certified derived-state repair');
       try {
         const outcome = await operation();
+        if (!outcome.ok && outcome.error.code === 'consensus-context' && this.enterDerivedRepair())
+          return outcome;
         if (!outcome.ok && FATAL_CONTROLLER_ERRORS.has(outcome.error.code)) {
           this.status({ kind: 'halted', code: outcome.error.code });
           this.dispose();
@@ -1148,10 +1306,10 @@ export class ReplicatedLog {
         this.queuedMessages += 1;
         void this.enqueue(async () => {
           const result = await this.receive(from, copy);
-          if (!result.ok && !FATAL_CONTROLLER_ERRORS.has(result.error.code))
+          if (!this.derivedRepair && !result.ok && !FATAL_CONTROLLER_ERRORS.has(result.error.code))
             await this.captureRejectedProofs(from, copy);
           return result;
-        }).then((result) => {
+        }, true).then((result) => {
           this.queuedMessages -= 1;
           const remaining = (this.queuedByPeer.get(from) ?? 1) - 1;
           if (remaining === 0) this.queuedByPeer.delete(from);
@@ -1172,10 +1330,11 @@ export class ReplicatedLog {
     this.unsubscribers.push(
       this.options.transport.onPeerChange((peer, online) => {
         void this.enqueue(async () => {
+          if (this.derivedRepair) return this.pulse();
           this.observeAllRecoveryPresence();
           if (online) this.cancelRecoveryForReturningPeer(peer);
           return this.pulse();
-        });
+        }, true);
       }),
     );
   }
@@ -1202,7 +1361,8 @@ export class ReplicatedLog {
 
   private knownSyncPeer(peer: PeerId): boolean {
     return (
-      this.context.membership.voters.some((voter) => voter.publicKey === peer) ||
+      (this.derivedRepair?.anchor.voters.includes(peer) ??
+        this.context.membership.voters.some((voter) => voter.publicKey === peer)) ||
       this.formerHumanPeer(peer)
     );
   }
@@ -1687,12 +1847,13 @@ export class ReplicatedLog {
 
   private async receive(from: PeerId, bytes: Uint8Array): Promise<Result<void>> {
     if (this.blockedPeers.has(from)) return success(undefined);
-    const voter = this.context.membership.voters.some((item) => item.publicKey === from);
-    if (!voter && !this.formerHumanPeer(from))
-      return failure('replica-peer', 'Sender is not a certified voter or historical human');
     const decoded = decodeProtocolMessage(bytes);
     if (!decoded.ok) return decoded;
     const message = decoded.value;
+    if (this.derivedRepair) return this.receiveDuringRepair(from, message);
+    const voter = this.context.membership.voters.some((item) => item.publicKey === from);
+    if (!voter && !this.formerHumanPeer(from))
+      return failure('replica-peer', 'Sender is not a certified voter or historical human');
     if (!voter && message.t !== 'SYNC_REQ')
       return failure('replica-peer', 'Former voters may only request certified history');
     switch (message.t) {
@@ -2137,7 +2298,10 @@ export class ReplicatedLog {
         return success(undefined);
       return this.requestSync(height);
     }
-    return this.activeController().dispatch({ kind: 'commit', certified });
+    const accepted = await this.activeController().dispatch({ kind: 'commit', certified });
+    if (!accepted.ok && accepted.error.code === 'consensus-context' && this.enterDerivedRepair())
+      this.retainHeldCommit(certified);
+    return accepted;
   }
 
   /** A cheap gate only; the certified parent decides the authoritative voter set. */
@@ -3590,7 +3754,7 @@ export class ReplicatedLog {
 
   private async handleEffects(effects: readonly ConsensusEffect[], index = 0): Promise<void> {
     const effect = effects[index];
-    if (!effect) return;
+    if (!effect || this.derivedRepair) return;
     switch (effect.kind) {
       case 'broadcast-proposal':
         this.requireSend(this.broadcast({ t: 'PROPOSAL', proposal: effect.proposal }));
@@ -3847,12 +4011,13 @@ export class ReplicatedLog {
     if (this.disposed) return;
     if (this.pulseTimer !== null) this.options.clock.clearTimeout(this.pulseTimer);
     this.pulseTimer = this.options.clock.setTimeout(() => {
-      void this.enqueue(() => this.pulse());
+      void this.enqueue(() => this.pulse(), true);
     }, 2_000);
   }
 
   private async pulse(): Promise<Result<void>> {
     try {
+      if (this.derivedRepair) return this.requestDerivedSnapshot();
       this.observeAllRecoveryPresence();
       this.notifyAutoTakeoverEligibility();
       const snapshot = this.activeController().snapshot();

```
