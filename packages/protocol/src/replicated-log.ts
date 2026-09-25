import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { identityFromSecret, parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Engine, Result, Seat, SystemInput } from '@cp2p/engine';
import { ConsensusController } from './consensus-controller.js';
import type { ConsensusEffect, ConsensusState, TimeoutPhase } from './consensus.js';
import { createConsensusState } from './consensus.js';
import { entryHash, signEntry } from './genesis.js';
import { journalSafetyStore } from './journal.js';
import type { ProtocolJournal } from './journal.js';
import { validateSignedCommand } from './log.js';
import type { ValidatedEntry } from './log.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import type { ProtocolMessage } from './messages.js';
import { proposerFor, validateCertifiedEntry } from './proposal.js';
import type { CertifiedEntry, ProposalContext } from './proposal.js';
import { initialProposalContext, replayCertifiedPrefix } from './replay.js';
import type { ReplayPolicy } from './replay.js';
import type { PeerId, ProtocolClock, Transport, Unsubscribe } from './transport.js';
import type { LogEntry, SignedCommand, SystemEvidence } from './types.js';
import { genesisSchema, logEntrySchema } from './schemas.js';
import * as v from 'valibot';

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
  private readonly unsubscribers: Unsubscribe[] = [];
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
    replica.attachTransport();
    const resumed = await replica.activeController().resume();
    if (!resumed.ok) {
      replica.dispose();
      return resumed;
    }
    const offered = await replica.enqueue(() => replica.offerAvailableInput());
    if (!offered.ok) {
      replica.dispose();
      return offered;
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
  repair(): Promise<Result<void>> {
    return this.enqueue(async () => {
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
      this.activeController().dispose();
      this.controller = null;
      this.context = fresh;
      this.entries = replayed.value.entries;
      const opened = await this.openController();
      if (!opened.ok) return this.failClosed(opened.error.code, opened.error.message);
      return this.activeController().dispatch({ kind: 'resume-after-replay' });
    });
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
        const hash = commandHash(checked.value);
        acceptedHash = hash;
        const pendingTimer = this.options.clock.setTimeout(
          () => this.status({ kind: 'pending', commandHash: hash }),
          10_000,
        );
        this.pending.push({ hash, signed: checked.value, resolve, pendingTimer });
        this.rememberCommand(checked.value);
        const sent = this.broadcast({ t: 'SUBMIT', cmd: checked.value });
        if (!sent.ok) return sent;
        return this.offerAvailableInput();
      }).then((result) => {
        if (!result.ok) {
          if (acceptedHash) this.resolvePending(acceptedHash, result);
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
        failure('replica-disposed', 'The replicated log was closed before commitment'),
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
        const copy = bytes.slice();
        void this.enqueue(() => this.receive(from, copy));
      }),
    );
    this.unsubscribers.push(
      this.options.transport.onPeerChange((_peer, online) => {
        if (online) void this.enqueue(() => this.pulse());
      }),
    );
  }

  private async receive(from: PeerId, bytes: Uint8Array): Promise<Result<void>> {
    if (!this.context.membership.voters.some((voter) => voter.publicKey === from))
      return failure('replica-peer', 'Sender is not a certified voter');
    const decoded = decodeProtocolMessage(bytes);
    if (!decoded.ok) return decoded;
    const message = decoded.value;
    switch (message.t) {
      case 'SUBMIT': {
        const checked = validateSignedCommand(message.cmd, this.context.log);
        if (!checked.ok) return checked;
        this.rememberCommand(checked.value);
        return this.offerAvailableInput();
      }
      case 'PROPOSAL':
        return this.activeController().dispatch({ kind: 'proposal', proposal: message.proposal });
      case 'VOTE':
        return this.activeController().dispatch({ kind: 'vote', vote: message.vote });
      case 'COMMIT':
        return this.acceptCertified(message.certified);
      case 'PROPOSAL_REQ':
        return this.sendRequestedProposal(from, message);
      case 'SYNC_REQ':
        if (message.genesisDigest !== this.context.membership.genesisDigest)
          return failure('replica-sync', 'Sync request belongs to another game');
        return this.sendCertifiedBatch(from, message.fromSeq, message.toSeq);
      case 'SYNC_RES':
        if (message.genesisDigest !== this.context.membership.genesisDigest)
          return failure('replica-sync', 'Sync response belongs to another game');
        if (message.more && message.entries.length === 0)
          return failure(
            'replica-sync',
            'A continued sync response must advance the certified prefix',
          );
        return this.acceptCertifiedBatch(message.entries, message.more);
      case 'HEARTBEAT':
        return this.receiveHeartbeat(from, message);
      case 'PING':
        return this.send(from, { t: 'PONG', n: message.n });
      case 'PONG':
        return success(undefined);
    }
    return failure('replica-message', 'Unknown protocol message');
  }

  private async acceptCertified(certified: CertifiedEntry): Promise<Result<void>> {
    const height = this.context.log.head.seq + 1;
    if (certified.entry.seq < height) {
      if (certified.entry.seq < 1)
        return failure('replica-certificate', 'Genesis is not a certified next entry');
      const previous = replayCertifiedPrefix(
        this.genesisEntry,
        this.entries.slice(0, certified.entry.seq - 1),
        this.options.engine,
        this.options.policy,
      );
      if (!previous.ok) return previous;
      const checked = validateCertifiedEntry(certified, previous.value.context);
      if (!checked.ok) return checked;
      const local = this.entries[certified.entry.seq - 1];
      return local && entryHash(local.entry) === checked.value.hash
        ? success(undefined)
        : this.failClosed(
            'replica-conflict',
            'A verified certificate conflicts with local history',
          );
    }
    if (certified.entry.seq > height) return this.requestSync(height);
    return this.activeController().dispatch({ kind: 'commit', certified });
  }

  private async acceptCertifiedBatch(
    entries: readonly CertifiedEntry[],
    more: boolean,
    index = 0,
  ): Promise<Result<void>> {
    const certified = entries[index];
    if (certified) {
      const accepted = await this.acceptCertified(certified);
      return accepted.ok ? this.acceptCertifiedBatch(entries, more, index + 1) : accepted;
    }
    return more ? this.requestSync(this.context.log.head.seq + 1) : success(undefined);
  }

  private async offerAvailableInput(): Promise<Result<void>> {
    const state = this.activeController().snapshot();
    if (!state.ok) return state;
    const available =
      this.commands.length > 0 || this.systemCandidate() !== null || state.value.valid !== null;
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

  private rememberCommand(command: SignedCommand): void {
    const hash = commandHash(command);
    if (this.commands.some((known) => commandHash(known) === hash)) return;
    if (this.commands.length >= 32) this.commands.shift();
    this.commands.push(command);
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
      case 'equivocation':
        this.status({ kind: 'rejected', code: 'equivocation' });
        break;
      case 'halt':
        this.status({ kind: 'halted', code: effect.reason });
        break;
    }
    await this.handleEffects(effects, index + 1);
  }

  private async persistCommit(certified: CertifiedEntry): Promise<void> {
    const previous = this.context;
    const checked = validateCertifiedEntry(certified, previous);
    if (!checked.ok) throw new Error(`Certified entry failed replay: ${checked.error.code}`);
    const next: ProposalContext = {
      ...previous,
      log: {
        ...previous.log,
        head: checked.value.entry,
        state: checked.value.state,
        lastNonces: checked.value.lastNonces,
      },
    };
    const nextSafety = createConsensusState(next, this.options.seat);
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
    this.commands.length = 0;
    this.settlePending(certified);
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
    this.status({ kind: 'sync', fromSeq });
    return this.broadcast({
      t: 'SYNC_REQ',
      genesisDigest: this.context.membership.genesisDigest,
      fromSeq,
    });
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

const FATAL_CONTROLLER_ERRORS = new Set([
  'consensus-effects',
  'consensus-storage',
  'consensus-write-conflict',
  'consensus-controller',
  'consensus-stopped',
]);

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
