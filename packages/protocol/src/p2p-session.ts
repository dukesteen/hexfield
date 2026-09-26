import { identityFromSecret } from '@cp2p/crypto';
import type { SchnorrProof } from '@cp2p/crypto';
import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type {
  CommandShape,
  Engine,
  GameEvent,
  GameState,
  Input,
  LegalCommandSet,
  Pending,
  PrivateState,
  Result,
  Seat,
  SystemInput,
} from '@cp2p/engine';
import { entryHash } from './genesis.js';
import { signCommand } from './log.js';
import type { LogContext, ValidatedEntry } from './log.js';
import type { CertifiedEntry, ProposalContext } from './proposal.js';
import { ReplicatedLog } from './replicated-log.js';
import type { ReplicatedLogOptions, ReplicatedLogStatus } from './replicated-log.js';
import { initialProposalContext, replayCertifiedPrefix } from './replay.js';
import type {
  GameSession,
  SessionStatus,
  SessionTimer,
  SessionUpdate,
  SubmitOptions,
} from './session-types.js';
import type { ProtocolClock, Unsubscribe } from './transport.js';
import type { CommandBody, Genesis, LogEntry, SignedCommand, SystemEvidence } from './types.js';
import { logEntrySchema } from './schemas.js';
import { parseCanonical } from './validation.js';
import type { CountOperation } from './count-reveal.js';

/** Private state and system protocols are separate from the replicated public log. */
export interface SessionDriver {
  next(context: LogContext): { input: SystemInput; evidence: SystemEvidence } | null;
  /** Produce owner evidence bound to this exact parent, nonce and complete command before signing. */
  prepareCommand?(
    body: Omit<CommandBody, 'evidence'>,
    context: LogContext,
  ): Result<CommandBody['evidence']>;
  /** Owner-only exact-count proof for a frozen Monopoly victim request. */
  produceCountProof?(
    operation: CountOperation,
    seat: Seat,
    context: LogContext,
  ): Result<{ count: number; proof: SchnorrProof }>;
  /**
   * Handles each certified entry, including protocol-only entries with no engine input.
   * When present, this replaces `committed`; it owns engine and private consequences too.
   */
  committedEntry?(
    entry: ValidatedEntry & CertifiedEntry,
    before: LogContext,
    after: LogContext,
  ): Result<void>;
  /** Legacy engine-input callback, used only when `committedEntry` is absent. */
  committed(before: LogContext, input: Input, after: GameState): Result<void>;
  privateState(seat: Seat): PrivateState | null;
  getTimers?(): readonly SessionTimer[];
  dispose?(): void;
}

export interface P2PSessionOptions extends Omit<
  ReplicatedLogOptions,
  'systemInput' | 'onCommit' | 'onStatus' | 'countProof'
> {
  /** Fresh driver on both create and restore. Restore replays private consequences. */
  createDriver: (
    engine: Engine,
    genesis: Genesis,
    clock: ProtocolClock,
    ownedSeats: readonly Seat[],
  ) => SessionDriver;
  /** Bot keys only for bots hosted by this human. The human key is secretKey above. */
  botKeys?: ReadonlyMap<Seat, Uint8Array>;
}

/** Certified history is useful for replay, but does not authorize importing a voting key. */
export interface CertifiedHistory {
  mode: 'p2p';
  genesis: LogEntry;
  entries: readonly CertifiedEntry[];
}

/** GameSession publishes only persisted certified effects, never speculative proposals. */
export class P2PSession implements GameSession<CertifiedHistory> {
  readonly mode = 'p2p' as const;
  private replica: ReplicatedLog | null = null;
  private readonly keys = new Map<Seat, Uint8Array>();
  private readonly listeners = new Set<(update: SessionUpdate) => void>();
  private readonly events: GameEvent[] = [];
  private status: SessionStatus = { kind: 'running' };
  private protocolStatus: ReplicatedLogStatus | null = null;
  private automaticParent: string | null = null;
  private automaticScheduled = false;
  private automaticRetryTimer: unknown = null;
  private automaticRetryDelay = 250;
  private readonly inflight = new Set<Seat>();

  private constructor(
    private readonly options: P2PSessionOptions,
    private context: ProposalContext,
    private readonly driver: SessionDriver,
    private readonly genesisEntry: LogEntry,
  ) {
    this.keys.set(options.seat, options.secretKey.slice());
    for (const [seat, key] of options.botKeys ?? []) this.keys.set(seat, key.slice());
    if (context.log.state.result) this.status = { kind: 'complete' };
  }

  /**
   * First activation of a newly established game key only. The key owner must
   * retain it with this journal and use restore for every subsequent opening.
   * An empty replacement journal does not authorize reuse of an old raw key.
   */
  static create(options: P2PSessionOptions): Promise<Result<P2PSession>> {
    return P2PSession.open(options, false);
  }

  static restore(options: P2PSessionOptions): Promise<Result<P2PSession>> {
    return P2PSession.open(options, true);
  }

  private static async open(
    options: P2PSessionOptions,
    restoring: boolean,
  ): Promise<Result<P2PSession>> {
    let session: P2PSession | null = null;
    try {
      const initial = initialProposalContext(options.genesisEntry, options.engine, options.policy);
      if (!initial.ok) return initial;
      const context = initial.value;
      const human = context.log.genesis.seats.find((seat) => seat.seat === options.seat);
      if (human?.kind !== 'human' || !keyMatches(options.secretKey, human.publicKey))
        return failure('session-key', 'The local human key does not match genesis');
      for (const [seat, key] of options.botKeys ?? []) {
        const bot = context.log.genesis.seats.find((item) => item.seat === seat);
        if (
          bot?.kind !== 'bot' ||
          bot.botHost !== human.publicKey ||
          !keyMatches(key, bot.publicKey)
        )
          return failure('session-bot-key', 'Bot key is not hosted by this human');
      }
      const ownedSeats = [options.seat, ...(options.botKeys?.keys() ?? [])];
      const driver = options.createDriver(
        options.engine,
        context.log.genesis,
        options.clock,
        ownedSeats,
      );
      session = new P2PSession(options, context, driver, context.log.head);
      for (const { seat } of context.log.genesis.seats) {
        const privateState = driver.privateState(seat);
        const owned = session.keys.has(seat);
        if (
          (owned && (!privateState || privateState.seat !== seat)) ||
          (!owned && context.log.genesis.security === 'verified' && privateState !== null)
        ) {
          session.dispose();
          return failure(
            'session-driver-seats',
            'Private driver ownership differs from local keys',
          );
        }
      }
      const openedSession = session;
      if (restoring) {
        const saved = await options.journal.load();
        if (!saved || entryHash(saved.genesis) !== entryHash(context.log.head)) {
          session.dispose();
          return failure('session-save', 'Saved certified history does not match this genesis');
        }
        const replayed = replayCertifiedPrefix(
          saved.genesis,
          saved.entries,
          options.engine,
          options.policy,
          (validated, next) => openedSession.applyCommit(validated, next),
        );
        if (!replayed.ok) {
          session.dispose();
          return replayed;
        }
      }
      // Runtime callers may still pass a raw countProof despite the public type.
      // Only this session's owned private driver may supply that authority.
      const safeOptions = { ...options };
      Reflect.deleteProperty(safeOptions, 'countProof');
      const replicaOptions: ReplicatedLogOptions = {
        ...safeOptions,
        systemInput: (current) => driver.next(current.log),
        ...(driver.produceCountProof
          ? {
              countProof: (operation: CountOperation, seat: Seat, current: LogContext) =>
                driver.produceCountProof?.(operation, seat, detachedLogContext(current)) ??
                failure('count-proof-source', 'Count proof driver is unavailable'),
            }
          : {}),
        onCommit: (validated, previous, next) => {
          const applied = openedSession.applyCommit(validated, next, previous.log);
          if (!applied.ok) {
            openedSession.status = { kind: 'error', message: applied.error.message };
            throw new Error(`${applied.error.code}: ${applied.error.message}`);
          }
          openedSession.emit(validated.events);
          openedSession.maybeAutomatic();
        },
        onStatus: (status) => {
          openedSession.protocolStatus = status;
          if (status.kind === 'halted')
            openedSession.status = { kind: 'error', message: status.code };
          openedSession.emit([]);
        },
      };
      const replica = await (restoring
        ? ReplicatedLog.restore(replicaOptions)
        : ReplicatedLog.create(replicaOptions));
      if (!replica.ok) {
        session.dispose();
        return replica;
      }
      session.replica = replica.value;
      if (entryHash(replica.value.getContext().log.head) !== entryHash(session.context.log.head)) {
        session.dispose();
        return failure('session-replay-head', 'Certified journal changed during private replay');
      }
      session.maybeAutomatic();
      return success(session);
    } catch (error) {
      session?.dispose();
      return failure('session-open', String(error));
    }
  }

  getState(): GameState {
    return this.options.engine.project(this.context.log.state, this.options.seat).state;
  }
  getCommittedHead(): { seq: number; hash: string } {
    return { seq: this.context.log.head.seq, hash: entryHash(this.context.log.head) };
  }
  getPrivate(seat: Seat): PrivateState | null {
    return this.status.kind === 'disposed' || !this.keys.has(seat)
      ? null
      : this.driver.privateState(seat);
  }
  getPending(): readonly Pending[] {
    return this.status.kind === 'running'
      ? this.options.engine.getPending(this.context.log.state)
      : [];
  }
  getTimers(): readonly SessionTimer[] {
    return this.status.kind === 'running' ? (this.driver.getTimers?.() ?? []) : [];
  }
  getEvents(): readonly GameEvent[] {
    return [...this.events];
  }
  getProtocolStatus(): ReplicatedLogStatus | null {
    return this.protocolStatus;
  }
  controllableSeats(): Seat[] {
    return [this.options.seat];
  }

  getLegalCommands(seat: Seat): LegalCommandSet {
    const privateState = this.getPrivate(seat);
    if (this.status.kind !== 'running' || !privateState) return { commands: [], templates: [] };
    const automatic = this.automaticCommand(privateState);
    return !automatic.ok || automatic.value
      ? { commands: [], templates: [] }
      : this.options.engine.getLegalCommands(this.context.log.state, seat, privateState);
  }

  validate(seat: Seat, command: CommandShape): Result<void> {
    if (this.status.kind !== 'running')
      return failure('session-inactive', 'Peer session is not running');
    const privateState = this.getPrivate(seat);
    if (!privateState)
      return failure('seat-not-controllable', 'This peer does not control the seat');
    const automatic = this.automaticCommand(privateState);
    if (!automatic.ok) return automatic;
    if (automatic.value && !sameCommand(automatic.value, command))
      return failure('automatic-input-pending', 'An automatic action must finish first');
    const input: Input = { kind: 'command', seat, command };
    const publicCheck = this.options.engine.validate(this.context.log.state, input);
    if (!publicCheck.ok) return publicCheck;
    const privateCheck = this.options.engine.applyPrivate(
      privateState,
      this.context.log.state,
      input,
    );
    return privateCheck.ok ? success(undefined) : privateCheck;
  }

  async submit(
    seat: Seat,
    command: CommandShape,
    options: SubmitOptions = {},
  ): Promise<Result<void>> {
    const replica = this.replica;
    if (!replica) return failure('session-opening', 'Peer session has not finished opening');
    if (
      options.expectedRevision !== undefined &&
      options.expectedRevision !== this.context.log.head.seq
    )
      return failure('stale-revision', 'Board changed; choose the action again');
    if (this.inflight.has(seat))
      return failure('command-pending', 'This seat already has an uncommitted command');
    let prepared: Result<SignedCommand>;
    try {
      prepared = this.prepareSubmission(seat, command);
    } catch {
      // No command has reached the replica yet, so an automatic caller may safely retry.
      return failure('session-command-preparation', 'Could not prepare the local command');
    }
    if (!prepared.ok) return prepared;
    this.inflight.add(seat);
    try {
      return await replica.submit(prepared.value);
    } finally {
      this.inflight.delete(seat);
      this.maybeAutomatic();
    }
  }

  private prepareSubmission(seat: Seat, command: CommandShape): Result<SignedCommand> {
    const valid = this.validate(seat, command);
    if (!valid.ok) return valid;
    const key = this.keys.get(seat);
    if (!key) return failure('session-key', 'Seat key is unavailable');
    const { log } = this.context;
    const body: Omit<CommandBody, 'evidence'> = {
      gameId: log.genesis.gameId,
      genesisDigest: this.context.membership.genesisDigest,
      seat,
      nonce: (log.lastNonces.get(seat) ?? 0) + 1,
      headSeq: log.head.seq,
      headHash: entryHash(log.head),
      command,
    };
    let evidence: CommandBody['evidence'];
    try {
      const prepared = this.driver.prepareCommand?.(copyCanonical(body), detachedLogContext(log));
      if (prepared && !prepared.ok) return prepared;
      evidence = prepared?.value;
    } catch {
      return failure('session-command-proof', "Could not prepare this command's private proof");
    }
    return success(signCommand(evidence === undefined ? body : { ...body, evidence }, key));
  }

  subscribe(listener: (update: SessionUpdate) => void): Unsubscribe {
    if (this.status.kind === 'disposed') return () => {};
    this.listeners.add(listener);
    this.notify(listener, []);
    return () => {
      this.listeners.delete(listener);
    };
  }

  exportSave(): CertifiedHistory {
    if (!this.replica || this.status.kind === 'disposed')
      throw new Error('Peer session is unavailable');
    const genesis = parseCanonical(this.genesisEntry, logEntrySchema);
    if (!genesis.ok) throw new Error('Stored genesis cannot be exported');
    return { mode: 'p2p', genesis: genesis.value, entries: this.replica.getEntries() };
  }

  async flush(): Promise<void> {
    await this.replica?.flush();
  }

  /** Rebuilds a halted peer from its certified journal without discarding its votes. */
  async repair(): Promise<Result<void>> {
    if (!this.replica || this.status.kind === 'disposed')
      return failure('session-inactive', 'Peer session is unavailable');
    const repaired = await this.replica.repair();
    if (repaired.ok) {
      this.protocolStatus = null;
      this.emit([]);
      this.maybeAutomatic();
    }
    return repaired;
  }

  dispose(): void {
    if (this.status.kind === 'disposed') return;
    this.clearAutomaticRetry();
    this.replica?.dispose();
    this.status = { kind: 'disposed' };
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
    try {
      this.driver.dispose?.();
    } catch {
      // Session keys and public lifecycle must still close if private cleanup fails.
    }
    this.emit([]);
    this.listeners.clear();
  }

  private applyCommit(
    entry: ValidatedEntry & CertifiedEntry,
    next: ProposalContext,
    before: LogContext = this.context.log,
  ): Result<void> {
    if (
      entryHash(before.head) !== entryHash(this.context.log.head) ||
      entry.entry.prevHash !== entryHash(before.head) ||
      entry.entry.seq !== before.head.seq + 1
    )
      return failure('session-replay-head', 'Private state does not match the committed parent');
    if (this.driver.committedEntry) {
      const applied = this.driver.committedEntry(
        detachedValidated(entry),
        detachedLogContext(before),
        detachedLogContext(next.log),
      );
      if (!applied.ok) return applied;
    } else if (entry.input) {
      const applied = this.driver.committed(
        detachedLogContext(before),
        copyCanonical(entry.input),
        copyCanonical(next.log.state),
      );
      if (!applied.ok) return applied;
    }
    this.context = next;
    this.clearAutomaticRetry();
    this.automaticParent = null;
    this.automaticRetryDelay = 250;
    if (this.protocolStatus?.kind === 'halted' || this.protocolStatus?.kind === 'rejected')
      this.protocolStatus = null;
    this.events.push(...entry.events);
    this.status = next.log.state.result ? { kind: 'complete' } : { kind: 'running' };
    return success(undefined);
  }

  private maybeAutomatic(): void {
    if (this.automaticScheduled || !this.replica || this.status.kind !== 'running') return;
    this.automaticScheduled = true;
    void Promise.resolve().then(() => {
      this.automaticScheduled = false;
      const parent = entryHash(this.context.log.head);
      try {
        this.submitAutomatic();
      } catch {
        this.retryAutomatic(parent, 'session-automatic-input');
      }
      return undefined;
    });
  }

  private automaticCommand(privateState: PrivateState): Result<CommandShape | null> {
    try {
      const input = this.options.engine.getAutomaticInput(
        this.context.log.state,
        new Map([[privateState.seat, privateState]]),
      );
      return success(
        input?.kind === 'command' && input.seat === privateState.seat ? input.command : null,
      );
    } catch {
      return failure('automatic-input-unavailable', 'Could not determine the automatic action');
    }
  }

  private submitAutomatic(): void {
    if (!this.replica || this.status.kind !== 'running') return;
    const parent = entryHash(this.context.log.head);
    if (this.automaticParent === parent) return;
    const privates = new Map<Seat, PrivateState>();
    for (const seat of this.keys.keys()) {
      const state = this.getPrivate(seat);
      if (state) privates.set(seat, state);
    }
    const input = this.options.engine.getAutomaticInput(this.context.log.state, privates);
    if (input?.kind !== 'command' || !this.keys.has(input.seat)) return;
    if (this.inflight.has(input.seat)) return;
    this.automaticParent = parent;
    void this.submit(input.seat, input.command)
      .then((result) => {
        if (entryHash(this.context.log.head) !== parent) this.maybeAutomatic();
        else if (!result.ok) this.retryAutomatic(parent, result.error.code);
        return undefined;
      })
      .catch(() => {
        // Includes failures while scheduling recovery; allow later activity to try again.
        if (this.status.kind === 'running' && entryHash(this.context.log.head) === parent) {
          this.automaticParent = null;
          this.protocolStatus = { kind: 'rejected', code: 'session-automatic-input' };
          this.emit([]);
        }
      });
  }

  private retryAutomatic(parent: string, code: string): void {
    if (this.status.kind !== 'running' || entryHash(this.context.log.head) !== parent) return;
    this.automaticParent = parent;
    this.protocolStatus = { kind: 'rejected', code };
    this.emit([]);
    if (
      this.automaticRetryTimer !== null ||
      this.status.kind !== 'running' ||
      entryHash(this.context.log.head) !== parent
    )
      return;
    // Resolved submission failures are pre-admission rejections at this parent.
    // Accepted commands remain pending in ReplicatedLog and are never resubmitted here.
    this.automaticRetryTimer = this.options.clock.setTimeout(() => {
      this.automaticRetryTimer = null;
      if (this.status.kind !== 'running' || entryHash(this.context.log.head) !== parent) return;
      this.automaticParent = null;
      this.maybeAutomatic();
    }, this.automaticRetryDelay);
    this.automaticRetryDelay = Math.min(this.automaticRetryDelay * 2, 4_000);
  }

  private clearAutomaticRetry(): void {
    if (this.automaticRetryTimer === null) return;
    this.options.clock.clearTimeout(this.automaticRetryTimer);
    this.automaticRetryTimer = null;
  }

  private update(events: readonly GameEvent[]): SessionUpdate {
    return {
      revision: this.context.log.head.seq,
      state: this.getState(),
      events,
      pending: this.getPending(),
      timers: this.getTimers(),
      status: this.status,
    };
  }
  private emit(events: readonly GameEvent[]): void {
    for (const listener of this.listeners) this.notify(listener, events);
  }

  private notify(listener: (update: SessionUpdate) => void, events: readonly GameEvent[]): void {
    try {
      const update = this.update(events);
      listener(update);
    } catch {
      // A view callback cannot undo a durable commit or stop the other subscribers.
      if (this.protocolStatus?.kind !== 'rejected' && this.protocolStatus?.kind !== 'halted')
        this.protocolStatus = { kind: 'rejected', code: 'session-listener' };
    }
  }
}

function sameCommand(left: CommandShape, right: CommandShape): boolean {
  const a = canonicalEncode(left);
  const b = canonicalEncode(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function keyMatches(key: Uint8Array, publicKey: string): boolean {
  const identity = identityFromSecret(key);
  try {
    return identity.peerId === publicKey;
  } finally {
    identity.secretKey.fill(0);
  }
}

function copyCanonical<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only validated protocol values use this detached canonical clone.
  return canonicalDecode(canonicalEncode(value)) as T;
}

function detachedLogContext(context: LogContext): LogContext {
  return {
    ...context,
    engine: { ...context.engine },
    genesis: copyCanonical(context.genesis),
    head: copyCanonical(context.head),
    state: copyCanonical(context.state),
    lastNonces: new Map(context.lastNonces),
    crypto: copyCanonical(context.crypto),
  };
}

function detachedValidated(
  entry: ValidatedEntry & CertifiedEntry,
): ValidatedEntry & CertifiedEntry {
  return {
    ...entry,
    entry: copyCanonical(entry.entry),
    certificate: copyCanonical([...entry.certificate]),
    input: copyCanonical(entry.input),
    state: copyCanonical(entry.state),
    events: copyCanonical([...entry.events]),
    lastNonces: new Map(entry.lastNonces),
    crypto: copyCanonical(entry.crypto),
  };
}
