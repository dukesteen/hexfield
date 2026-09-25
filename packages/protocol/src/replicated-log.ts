import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { identityFromSecret, parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Engine, Result, Seat, SystemInput } from '@cp2p/engine';
import { ConsensusController } from './consensus-controller.js';
import type { ConsensusEffect, ConsensusState, Equivocation, TimeoutPhase } from './consensus.js';
import { createConsensusState } from './consensus.js';
import { objectiveEvidenceSeq, validateObjectiveAccusation } from './control.js';
import { entryBody, entryHash, signEntry } from './genesis.js';
import { journalSafetyStore } from './journal.js';
import type { ProtocolJournal } from './journal.js';
import { validateSignedCommand } from './log.js';
import type { ValidatedEntry } from './log.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import type { ProtocolMessage } from './messages.js';
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
import type { ExcludeProposerControl, LogEntry, SignedCommand, SystemEvidence } from './types.js';
import { genesisSchema, logEntrySchema } from './schemas.js';
import { MAX_MESSAGE_BYTES, parseCanonical } from './validation.js';
import { validateVote, verifyCertificate } from './votes.js';
import * as v from 'valibot';

const MAX_QUEUED_MESSAGES_PER_PEER = 8;
const MAX_QUEUED_MESSAGES_TOTAL = 32;
const INVALID_MESSAGE_LIMIT = 5;
const EXPENSIVE_REQUEST_WINDOW_MS = 10_000;
const EXPENSIVE_REQUESTS_PER_WINDOW = 3;
const MAX_PENDING_COMMANDS = 32;
const MAX_PENDING_COMMANDS_PER_SEAT = 4;

export type ReplicatedLogStatus =
  | { kind: 'pending'; commandHash: string }
  | { kind: 'sync'; fromSeq: number }
  | { kind: 'rejected'; code: string }
  | { kind: 'halted'; code: string };

export interface ReplicatedLogOptions {
  genesisEntry: unknown;
  engine: Engine;
  policy: ReplayPolicy;
  seat: Seat;
  secretKey: Uint8Array;
  transport: Transport;
  clock: ProtocolClock;
  journal: ProtocolJournal;
  systemInput?: (
    context: ProposalContext,
  ) => { input: SystemInput; evidence: SystemEvidence } | null;
  onCommit?: (
    validated: ValidatedEntry & CertifiedEntry,
    previous: ProposalContext,
    next: ProposalContext,
  ) => void;
  onStatus?: (status: ReplicatedLogStatus) => void;
}

interface PendingCommand {
  hash: string;
  signed: SignedCommand;
  resolve: (result: Result<void>) => void;
  pendingTimer: unknown;
}

/** Certified history plus one active, durable consensus height. */
export class ReplicatedLog {
  private controller: ConsensusController | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly secretKey: Uint8Array;
  private readonly self: PeerId;
  private readonly timers = new Map<string, unknown>();
  private readonly pending: PendingCommand[] = [];
  private readonly commands: SignedCommand[] = [];
  private accusation: ExcludeProposerControl | null = null;
  private readonly unsubscribers: Unsubscribe[] = [];
  private readonly queuedByPeer = new Map<PeerId, number>();
  private readonly invalidByPeer = new Map<PeerId, number>();
  private readonly blockedPeers = new Set<PeerId>();
  private readonly expensiveByPeer = new Map<PeerId, { startedAt: number; seen: Set<string> }>();
  private lastSyncRequest: { fromSeq: number; sentAt: number } | null = null;
  private queuedMessages = 0;
  private pulseTimer: unknown = null;
  private disposed = false;

  private constructor(
    private readonly options: ReplicatedLogOptions,
    private readonly genesisEntry: LogEntry,
    private context: ProposalContext,
    private entries: CertifiedEntry[],
  ) {
    this.secretKey = options.secretKey.slice();
    this.self = identityFromSecret(this.secretKey).peerId;
  }

  static async create(options: ReplicatedLogOptions): Promise<Result<ReplicatedLog>> {
    const initial = initialProposalContext(options.genesisEntry, options.engine, options.policy);
    if (!initial.ok) return initial;
    const key = checkLocalKey(options, initial.value);
    if (!key.ok) return key;
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
    const key = checkLocalKey(options, context);
    if (!key.ok) return key;
    const replica = new ReplicatedLog(options, record.genesis, context, replayed.value.entries);
    const opened = await replica.openController();
    if (!opened.ok) {
      replica.dispose();
      return opened;
    }
    const initialized = await replica.enqueue(async () => {
      const recovered = await replica.recoverPersistedAccusation();
      if (!recovered.ok) return recovered;
      replica.attachTransport();
      const resumed = await replica.activeController().resume();
      if (!resumed.ok) return resumed;
      return replica.offerAvailableInput();
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

  /** Replays the certified parent before retrying a retained, authenticated certificate. */
  repair(snapshot?: unknown): Promise<Result<void>> {
    return this.enqueue(() => this.repairNow(snapshot));
  }

  private async repairNow(snapshot?: unknown): Promise<Result<void>> {
    const state = this.activeController().snapshot();
    if (!state.ok) return state;
    if (state.value.haltKind !== 'certified-validation')
      return failure('replica-repair', 'Only a certified validation halt can be repaired');
    let record: Awaited<ReturnType<ProtocolJournal['load']>>;
    try {
      record = await this.options.journal.load();
    } catch {
      return failure('replica-storage', 'Could not read the certified journal for repair');
    }
    if (!record)
      return this.failClosed('replica-journal', 'Certified journal is missing during repair');
    const replayed = replayCertifiedPrefix(
      record.genesis,
      record.entries,
      this.options.engine,
      this.options.policy,
    );
    if (!replayed.ok) return replayed;
    const fresh = replayed.value.context;
    if (
      record.height !== fresh.log.head.seq + 1 ||
      fresh.log.head.seq !== this.context.log.head.seq ||
      entryHash(fresh.log.head) !== entryHash(this.context.log.head)
    )
      return this.failClosed('replica-journal', 'Certified parent changed during repair');
    if (snapshot !== undefined) {
      const checked = verifyReplaySnapshot(snapshot, fresh);
      if (!checked.ok) return checked;
    }
    this.activeController().dispose();
    this.controller = null;
    this.context = fresh;
    this.entries = replayed.value.entries;
    const opened = await this.openController();
    if (!opened.ok) return this.failClosed(opened.error.code, opened.error.message);
    return this.activeController().dispatch({ kind: 'resume-after-replay' });
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
    this.controller?.dispose();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    for (const handle of this.timers.values()) this.options.clock.clearTimeout(handle);
    this.timers.clear();
    if (this.pulseTimer !== null) this.options.clock.clearTimeout(this.pulseTimer);
    for (const pending of this.pending.splice(0)) {
      this.options.clock.clearTimeout(pending.pendingTimer);
      pending.resolve(
        failure(
          'replica-outcome-unknown',
          'The accepted command may have committed; restore and check the certified log before retrying',
        ),
      );
    }
    this.secretKey.fill(0);
  }

  private activeController(): ConsensusController {
    if (!this.controller) throw new Error('No active consensus controller');
    return this.controller;
  }

  private async openController(): Promise<Result<void>> {
    const controller = await ConsensusController.restore({
      context: this.context,
      seat: this.options.seat,
      secretKey: this.secretKey,
      store: journalSafetyStore(this.options.journal, this.context.log.head.seq + 1),
      onEffects: (effects) => this.handleEffects(effects),
    });
    if (!controller.ok) return controller;
    this.controller = controller.value;
    return success(undefined);
  }

  private enqueue<T>(operation: () => Promise<Result<T>>): Promise<Result<T>> {
    const result = this.queue.then(async (): Promise<Result<T>> => {
      if (this.disposed) return failure('replica-disposed', 'Replicated log is closed');
      try {
        const outcome = await operation();
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
        if (!this.context.membership.voters.some((voter) => voter.publicKey === from)) {
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
        void this.enqueue(() => this.receive(from, copy)).then((result) => {
          this.queuedMessages -= 1;
          const remaining = (this.queuedByPeer.get(from) ?? 1) - 1;
          if (remaining === 0) this.queuedByPeer.delete(from);
          else this.queuedByPeer.set(from, remaining);
          if (
            !result.ok &&
            (result.error.code === 'invalid-envelope' ||
              result.error.code === 'invalid-encoding' ||
              result.error.code === 'message-too-large' ||
              result.error.code.endsWith('-signature'))
          )
            this.strikePeer(from);
          return undefined;
        });
      }),
    );
    this.unsubscribers.push(
      this.options.transport.onPeerChange((_peer, online) => {
        if (online) void this.enqueue(() => this.pulse());
      }),
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

  /** Duplicate or excessive requests cannot repeatedly replay the full certified prefix. */
  private admitExpensiveRequest(peer: PeerId, key: string): boolean {
    const now = this.options.clock.now();
    let budget = this.expensiveByPeer.get(peer);
    if (
      !budget ||
      now < budget.startedAt ||
      now - budget.startedAt >= EXPENSIVE_REQUEST_WINDOW_MS
    ) {
      budget = { startedAt: now, seen: new Set() };
      this.expensiveByPeer.set(peer, budget);
    }
    if (budget.seen.has(key) || budget.seen.size >= EXPENSIVE_REQUESTS_PER_WINDOW) return false;
    budget.seen.add(key);
    return true;
  }

  private async receive(from: PeerId, bytes: Uint8Array): Promise<Result<void>> {
    if (this.blockedPeers.has(from)) return success(undefined);
    if (!this.context.membership.voters.some((voter) => voter.publicKey === from))
      return failure('replica-peer', 'Sender is not a certified voter');
    const decoded = decodeProtocolMessage(bytes);
    if (!decoded.ok) return decoded;
    const message = decoded.value;
    switch (message.t) {
      case 'SUBMIT': {
        const checked = validateSignedCommand(message.cmd, this.context.log);
        if (!checked.ok) return checked;
        if (!this.rememberCommand(checked.value)) return success(undefined);
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
        const received = await this.activeController().dispatch({
          kind: 'proposal',
          proposal: message.proposal,
        });
        if (!received.ok) {
          if (entry.payload.kind !== 'command') return received;
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
              evidence: { kind: 'invalid-command', proposal: message.proposal },
            });
            if (accused.ok) return success(undefined);
          } catch {
            // An invalid proposer index is not accusation evidence.
          }
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
      const envelope = this.precheckCertifiedEnvelope(certified);
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
      if (!checked.ok) return this.haltForHistoricalConflict();
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
      const envelope = this.precheckCertifiedEnvelope(certified);
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
    return this.activeController().dispatch({ kind: 'commit', certified });
  }

  /** Cheap Stage 06 fixed-voter signature gate before replay or sync work.
   * A future membership epoch will need the replayed historical voter set here.
   */
  private precheckCertifiedEnvelope(certified: CertifiedEntry): Result<void> {
    try {
      const entry = certified.entry;
      if (!verifyObject('entry', entryBody(entry), entry.sig, parsePeerId(entry.sequencer)))
        return failure('replica-certificate', 'Certified entry signature is invalid');
      const votes = verifyCertificate(certified.certificate, this.context.membership, {
        seq: entry.seq,
        term: entry.term,
        phase: 'precommit',
        valueHash: entryHash(entry),
      });
      return votes.ok ? success(undefined) : votes;
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
      return accepted.ok
        ? this.acceptCertifiedBatch(entries, more, from, index + 1, headBefore)
        : accepted;
    }
    if (more && this.context.log.head.seq <= headBefore)
      return failure('replica-sync', 'Continued sync response made no certified progress');
    return more ? this.requestSync(this.context.log.head.seq + 1) : success(undefined);
  }

  private async offerAvailableInput(): Promise<Result<void>> {
    const state = this.activeController().snapshot();
    if (!state.ok) return state;
    const available =
      this.accusation !== null ||
      this.commands.length > 0 ||
      this.systemCandidate() !== null ||
      state.value.valid !== null;
    if (!available) return success(undefined);
    const marked = await this.activeController().dispatch({ kind: 'input-available' });
    if (!marked.ok) return marked;
    return this.maybePropose();
  }

  private async maybePropose(): Promise<Result<void>> {
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

  private candidate(state: ConsensusState): LogEntry | null {
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
    const command = this.commands[0];
    const payload = command
      ? { kind: 'command' as const, signed: command }
      : this.systemCandidate();
    if (!payload) return null;
    const input =
      payload.kind === 'command'
        ? {
            kind: 'command' as const,
            seat: payload.signed.body.seat,
            command: payload.signed.body.command,
          }
        : payload.input;
    const applied = this.context.log.engine.apply(this.context.log.state, input);
    if (!applied.ok) return null;
    return signEntry(
      {
        seq: state.height,
        term: state.round,
        prevHash: entryHash(this.context.log.head),
        payload,
        stateHash: toHex(hashValue(applied.value.state)),
        sequencer: this.self,
      },
      this.secretKey,
    );
  }

  private systemCandidate(): {
    kind: 'system';
    input: SystemInput;
    evidence: SystemEvidence;
  } | null {
    try {
      const candidate = this.options.systemInput?.(this.context);
      return candidate ? { kind: 'system', ...candidate } : null;
    } catch {
      this.status({ kind: 'rejected', code: 'system-input' });
      return null;
    }
  }

  private rememberCommand(command: SignedCommand): boolean {
    const hash = commandHash(command);
    if (this.commands.some((known) => commandHash(known) === hash)) return true;
    if (
      this.commands.length >= MAX_PENDING_COMMANDS ||
      this.commands.filter((known) => known.body.seat === command.body.seat).length >=
        MAX_PENDING_COMMANDS_PER_SEAT
    )
      return false;
    this.commands.push(command);
    return true;
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
    if (!effect) return;
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
    const nextSafety = createConsensusState(
      next,
      this.options.seat,
      provenOffender,
      pendingAccusation,
    );
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
    this.entries.push({ entry: checked.value.entry, certificate: [...checked.value.certificate] });
    if (this.lastSyncRequest && next.log.head.seq >= this.lastSyncRequest.fromSeq)
      this.lastSyncRequest = null;
    this.commands.length = 0;
    this.accusation = pendingAccusation;
    this.clearConsensusTimers();
    const opened = await this.openController();
    if (!opened.ok) throw new Error(`Next voting controller failed: ${opened.error.code}`);
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
    this.settlePending(certified);
    if (pendingAccusation)
      this.requireSend(this.broadcast({ t: 'ACCUSE', control: pendingAccusation }));
    this.requireSend(this.broadcast({ t: 'COMMIT', certified }));
    void this.enqueue(() => this.offerAvailableInput());
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
      void this.enqueue(() => this.pulse());
    }, 2_000);
  }

  private async pulse(): Promise<Result<void>> {
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
    for (const pending of this.pending)
      this.requireSend(this.broadcast({ t: 'SUBMIT', cmd: pending.signed }));
    const recovered = await this.activeController().resume();
    if (!recovered.ok) return recovered;
    const offered = await this.offerAvailableInput();
    this.schedulePulse();
    return offered;
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
      message.body.genesisDigest !== this.context.membership.genesisDigest ||
      message.body.epoch !== this.context.membership.epoch
    )
      return failure('replica-heartbeat', 'Heartbeat signature or membership is invalid');
    if (message.body.head.seq > this.context.log.head.seq)
      return this.requestSync(this.context.log.head.seq + 1);
    if (
      message.body.head.seq === this.context.log.head.seq &&
      message.body.head.hash !== entryHash(this.context.log.head)
    )
      return failure('replica-conflict', 'Peer reports a conflicting certified head');
    return success(undefined);
  }

  private requestSync(fromSeq: number): Result<void> {
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
    try {
      this.options.transport.broadcast(encoded.value);
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

function checkLocalKey(options: ReplicatedLogOptions, context: ProposalContext): Result<void> {
  try {
    const local = identityFromSecret(options.secretKey).peerId;
    const voter = context.membership.voters.find((member) => member.seat === options.seat);
    return voter?.publicKey === local && options.transport.self === local
      ? success(undefined)
      : failure(
          'replica-key',
          'Local key and authenticated transport do not match the certified voter',
        );
  } catch {
    return failure('replica-key', 'Local voting key is invalid');
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
      lastNonces: new Map(context.log.lastNonces),
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
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
