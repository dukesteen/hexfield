import { identityFromSecret } from '@cp2p/crypto';
import { canonicalDecode, canonicalEncode, fromBase64Url } from '@cp2p/codec';
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
} from '@cp2p/engine';
import { entryHash, genesisDigest } from './genesis.js';
import { signCommand } from './log.js';
import type { LogContext, ValidatedEntry } from './log.js';
import type { CertifiedEntry, ProposalContext } from './proposal.js';
import { ReplicatedLog } from './replicated-log.js';
import type { ReplicatedLogOptions, ReplicatedLogStatus } from './replicated-log.js';
import type { RecoveredReplicaOwnership } from './replicated-log.js';
import type { RecoveryApprovalCandidate, RecoveryApprovalPreview } from './recovery-facade.js';
import { loadRecoveredHost } from './recovered-host.js';
import type { RecoveredHost } from './recovered-host.js';
import type { RecoveryPrivateStore } from './recovery-private.js';
import { loadPreparedRecoveryReadiness, prepareRecoveryReadiness } from './recovery-readiness.js';
import type { RecoveryReadinessStore } from './recovery-readiness.js';
import type { RecoveryReadiness } from './recovery-types.js';
import { quorumSize } from './votes.js';
import { chooseBotPending } from './bot-pending.js';
import { initialProposalContext, replayCertifiedPrefix } from './replay.js';
import { timedDiscardCommand } from './turn-timeout.js';
import type {
  GameSession,
  SessionStatus,
  SessionTimer,
  SessionUpdate,
  SubmitOptions,
} from './session-types.js';
import type { ProtocolClock, Unsubscribe } from './transport.js';
import type { CommandBody, Genesis, LogEntry, SignedCommand } from './types.js';
import { logEntrySchema } from './schemas.js';
import { parseCanonical } from './validation.js';
import type { CountOperation } from './count-reveal.js';
import type { StealContributionProducer, StealResponseProducer } from './steal-contributions.js';
import {
  planTradeProof,
  signTradeProofRequest,
  tradeProofRequestId,
} from './trade-proof-delivery.js';
import type {
  IndexedHandProof,
  SignedTradeProofRequest,
  SignedTradeProofResponse,
} from './trade-proof-delivery.js';

import type { SessionDriver } from './session-driver.js';
import type { SignedMasterReveal } from './master-reveal.js';
import type {
  SessionAuditInput,
  SessionAuditJob,
  SessionAuditRunner,
  SessionAuditState,
} from './session-audit-types.js';
export type { SessionDriver } from './session-driver.js';

export interface P2PSessionOptions extends Omit<
  ReplicatedLogOptions,
  | 'systemInput'
  | 'onCommit'
  | 'onStatus'
  | 'countProof'
  | 'stealContribution'
  | 'stealResponse'
  | 'tradeProof'
  | 'onTradeProofResponse'
  | 'onAuthorityChange'
  | 'onRecoveryCandidate'
  | 'onMasterReveal'
> {
  auditRunner?: SessionAuditRunner;
  /** Fresh driver on both create and restore. Restore replays private consequences. */
  createDriver: (
    engine: Engine,
    genesis: Genesis,
    clock: ProtocolClock,
    ownedSeats: readonly Seat[],
  ) => SessionDriver;
  /** Bot keys only for bots hosted by this human. The human key is secretKey above. */
  botKeys?: ReadonlyMap<Seat, Uint8Array>;
  /** Private recovery records and reserved replacement keys, retained with this journal. */
  recoveryStore?: RecoveryPrivateStore & RecoveryReadinessStore;
  /** The bot sees only its own hand and the public state; commands still require validation. */
  decideBot?: (
    view: { state: GameState; priv: PrivateState; seat: Seat },
    pending: Extract<Pending, { kind: 'player' }>,
    level: 'easy' | 'medium' | 'hard',
  ) => CommandShape | null;
  /** Delay between committed state and a bot choice. Defaults to 350 ms. */
  botDelayMs?: number;
}

/** Certified history is useful for replay, but does not authorize importing a voting key. */
export interface CertifiedHistory {
  mode: 'p2p';
  genesis: LogEntry;
  entries: readonly CertifiedEntry[];
}

interface TradeIntent {
  seat: Seat;
  termsHash: string;
  deadline: number;
  cancelled: boolean;
  request: SignedTradeProofRequest | null;
  finishWait: ((result: Result<readonly IndexedHandProof[]>) => void) | null;
  retryTimer: unknown;
}

const TRADE_WAIT_MS = 10_000;
const TRADE_RETRY_MS = 250;
const TRADE_PARENT_RETRIES = 3;

/** GameSession publishes only persisted certified effects, never speculative proposals. */
export class P2PSession implements GameSession<CertifiedHistory> {
  readonly mode = 'p2p' as const;
  private replica: ReplicatedLog | null = null;
  private readonly keys = new Map<Seat, Uint8Array>();
  private readonly listeners = new Set<(update: SessionUpdate) => void>();
  private readonly events: GameEvent[] = [];
  private verifiedMoves = 0;
  private status: SessionStatus = { kind: 'running' };
  private protocolStatus: ReplicatedLogStatus | null = null;
  private automaticParent: string | null = null;
  private automaticScheduled = false;
  private automaticRetryTimer: unknown = null;
  private automaticRetryDelay = 250;
  private readonly inflight = new Set<Seat>();
  private readonly tradeIntents = new Map<Seat, TradeIntent>();
  private privateStateReleased = false;
  private readonly recoveredHosts: RecoveredHost[] = [];
  private recoveryInstalling = false;
  private botTimer: unknown = null;
  private privateTimeoutTimer: unknown = null;
  private botParent: string | null = null;
  private readonly auditReveals = new Map<Seat, SignedMasterReveal>();
  private auditState: SessionAuditState = { kind: 'not-started' };
  private auditJob: {
    headHash: string;
    headSeq: number;
    terminal: { seq: number; hash: string };
    job: SessionAuditJob;
    masters: SessionAuditInput['masters'];
  } | null = null;
  private auditedHead: string | null = null;

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
      if (
        options.botDelayMs !== undefined &&
        (!Number.isFinite(options.botDelayMs) ||
          options.botDelayMs < 0 ||
          options.botDelayMs > 60_000)
      )
        return failure('session-bot-delay', 'Bot delay must be between zero and 60 seconds');
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
      const sources = driver.validateSources?.();
      if (sources && !sources.ok) {
        session.dispose();
        return sources;
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
      // Runtime callers may still pass raw proof callbacks despite the public type.
      // Only this session's owned private driver may supply that authority.
      const safeOptions = { ...options };
      Reflect.deleteProperty(safeOptions, 'countProof');
      Reflect.deleteProperty(safeOptions, 'stealContribution');
      Reflect.deleteProperty(safeOptions, 'stealResponse');
      Reflect.deleteProperty(safeOptions, 'tradeProof');
      Reflect.deleteProperty(safeOptions, 'onTradeProofResponse');
      Reflect.deleteProperty(safeOptions, 'onAuthorityChange');
      Reflect.deleteProperty(safeOptions, 'onMasterReveal');
      const recoveryPrivateStore =
        options.masterReveal?.recoveryPrivateStore ??
        options.recoveryStore ??
        options.recoveryParticipant?.store;
      const replicaOptions: ReplicatedLogOptions = {
        ...safeOptions,
        ...(options.masterReveal
          ? {
              masterReveal: {
                ...options.masterReveal,
                ...(recoveryPrivateStore ? { recoveryPrivateStore } : {}),
              },
            }
          : {}),
        ...(options.createDeckSource
          ? {
              createDeckSource: (deckId: string, seat: Seat) =>
                openedSession.createDeckSource(deckId, seat),
            }
          : {}),
        systemInput: (current) => driver.next(current.log),
        ...(driver.produceCountProof
          ? {
              countProof: (operation: CountOperation, seat: Seat, current: LogContext) =>
                driver.produceCountProof?.(operation, seat, detachedLogContext(current)) ??
                failure('count-proof-source', 'Count proof driver is unavailable'),
            }
          : {}),
        ...(driver.produceStealContribution
          ? {
              stealContribution: (...args: Parameters<StealContributionProducer>) =>
                driver.produceStealContribution?.(
                  args[0],
                  args[1],
                  detachedLogContext(args[2]),
                  args[3],
                ) ?? failure('steal-proof-source', 'Steal proof driver is unavailable'),
            }
          : {}),
        ...(driver.produceStealResponse
          ? {
              stealResponse: (...args: Parameters<StealResponseProducer>) =>
                driver.produceStealResponse?.(
                  args[0],
                  args[1],
                  detachedLogContext(args[2]),
                  args[3],
                ) ?? failure('steal-response-source', 'Steal response driver is unavailable'),
            }
          : {}),
        ...(driver.produceTradeProofs
          ? {
              tradeProof: (request: SignedTradeProofRequest, current: LogContext) =>
                driver.produceTradeProofs?.(copyCanonical(request), detachedLogContext(current)) ??
                failure('trade-proof-source', 'Trade proof driver is unavailable'),
            }
          : {}),
        onTradeProofResponse: (response) => openedSession.receiveTradeProof(response),
        onRecoveryCandidate: () => openedSession.emit([]),
        onAuthorityChange: (current) => openedSession.installRecovery(current),
        onMasterReveal: ({ packet }) => {
          openedSession.auditReveals.set(packet.body.originalSeat, copyCanonical(packet));
          openedSession.maybeAudit();
        },
        onCommit: (validated, previous, next) => {
          const applied = openedSession.applyCommit(validated, next, previous.log);
          if (!applied.ok) {
            openedSession.status = { kind: 'error', message: applied.error.message };
            for (const seat of openedSession.tradeIntents.keys()) openedSession.cancelPending(seat);
            throw new Error(`${applied.error.code}: ${applied.error.message}`);
          }
          const activating =
            validated.entry.payload.kind === 'membership' &&
            next.log.recovery?.pending === null &&
            next.log.authority?.controllers.some(
              (controller) =>
                controller.kind === 'bot' &&
                controller.status === 'active' &&
                controller.hostSeat === options.seat &&
                controller.activatedAt.seq > 0 &&
                !openedSession.keys.has(controller.seat),
            );
          if (activating) openedSession.recoveryInstalling = true;
          openedSession.emit(validated.events);
          openedSession.maybeAudit();
          if (!activating) openedSession.maybeAutomatic();
        },
        onStatus: (status) => {
          openedSession.protocolStatus = status;
          if (status.kind === 'halted') {
            openedSession.cancelAudit();
            openedSession.status = { kind: 'error', message: status.code };
            for (const seat of openedSession.tradeIntents.keys()) openedSession.cancelPending(seat);
            openedSession.clearBotTimer();
          } else if (status.kind === 'retired') {
            openedSession.cancelAudit();
            openedSession.status = {
              kind: 'error',
              message: 'This seat was replaced by a bot. Its previous signing key is retired.',
            };
            for (const seat of openedSession.tradeIntents.keys()) openedSession.cancelPending(seat);
            openedSession.clearAutomaticRetry();
            openedSession.clearBotTimer();
            openedSession.releasePrivateState();
          }
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
      session.schedulePrivateTimeout();
      session.maybeAutomatic();
      session.maybeAudit();
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
    return this.status.kind === 'running'
      ? this.context.log.genesis.security === 'verified'
        ? (this.replica?.getTimers() ?? [])
        : (this.driver.getTimers?.() ?? [])
      : [];
  }
  getEvents(): readonly GameEvent[] {
    return [...this.events];
  }
  getProtocolStatus(): ReplicatedLogStatus | null {
    return this.protocolStatus;
  }
  getAudit(): SessionAuditState {
    return copyCanonical(this.auditState);
  }
  getFairness() {
    if (this.context.log.genesis.security !== 'verified') return null;
    return {
      head: this.getCommittedHead(),
      verifiedMoves: this.verifiedMoves,
      findings: (this.context.log.crypto?.cheats ?? []).map((finding) => ({
        seat: finding.seat,
        kind: finding.kind,
        at: { ...finding.at },
        evidenceId: finding.evidenceId,
      })),
    };
  }
  retryAudit(): boolean {
    if (this.status.kind !== 'complete' || this.auditState.kind !== 'error') return false;
    this.auditedHead = null;
    this.maybeAudit();
    return true;
  }
  controllableSeats(): Seat[] {
    return this.keys.has(this.options.seat) ? [this.options.seat] : [];
  }

  getLegalCommands(seat: Seat): LegalCommandSet {
    const privateState = this.getPrivate(seat);
    if (this.status.kind !== 'running' || this.recoveryInstalling || !privateState)
      return { commands: [], templates: [] };
    const automatic = this.automaticCommand(privateState);
    return !automatic.ok || automatic.value
      ? { commands: [], templates: [] }
      : this.options.engine.getLegalCommands(this.context.log.state, seat, privateState);
  }

  validate(seat: Seat, command: CommandShape): Result<void> {
    if (this.status.kind !== 'running')
      return failure('session-inactive', 'Peer session is not running');
    if (this.recoveryInstalling)
      return failure('session-recovery-loading', 'The recovered seat is still being restored');
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
    if (this.inflight.has(seat) || this.tradeIntents.has(seat))
      return failure('command-pending', 'This seat already has an uncommitted command');
    let prepared: Result<SignedCommand>;
    try {
      prepared = this.prepareSubmission(seat, command);
    } catch {
      // No command has reached the replica yet, so an automatic caller may safely retry.
      return failure('session-command-preparation', 'Could not prepare the local command');
    }
    if (!prepared.ok) {
      if (prepared.error.code === 'hand-proof-owner' && command.type === 'CONFIRM_TRADE')
        return this.submitTrade(seat, command);
      return prepared;
    }
    this.inflight.add(seat);
    try {
      return await replica.submit(prepared.value);
    } finally {
      this.inflight.delete(seat);
      this.maybeAutomatic();
    }
  }

  private commandBody(seat: Seat, command: CommandShape): Omit<CommandBody, 'evidence'> {
    const { log } = this.context;
    return {
      gameId: log.genesis.gameId,
      genesisDigest: this.context.membership.genesisDigest,
      seat,
      nonce: (log.lastNonces.get(seat) ?? 0) + 1,
      headSeq: log.head.seq,
      headHash: entryHash(log.head),
      command,
    };
  }

  private prepareSubmission(
    seat: Seat,
    command: CommandShape,
    external?: readonly IndexedHandProof[],
  ): Result<SignedCommand> {
    const valid = this.validate(seat, command);
    if (!valid.ok) return valid;
    const key = this.keys.get(seat);
    if (!key) return failure('session-key', 'Seat key is unavailable');
    const { log } = this.context;
    const body = this.commandBody(seat, command);
    let evidence: CommandBody['evidence'];
    try {
      const prepared = this.driver.prepareCommand?.(
        copyCanonical(body),
        detachedLogContext(log),
        external === undefined ? undefined : copyCanonical(external),
      );
      if (prepared && !prepared.ok) return prepared;
      evidence = prepared?.value;
    } catch {
      return failure('session-command-proof', "Could not prepare this command's private proof");
    }
    return success(signCommand(evidence === undefined ? body : { ...body, evidence }, key));
  }

  /** Cancels only pre-admission proof preparation, never an accepted command. */
  cancelPending(seat: Seat): boolean {
    const intent = this.tradeIntents.get(seat);
    if (!intent) return false;
    intent.cancelled = true;
    this.tradeIntents.delete(seat);
    intent.finishWait?.(failure('trade-proof-cancelled', 'Trade preparation was cancelled'));
    this.maybeAutomatic();
    return true;
  }

  private async submitTrade(seat: Seat, command: CommandShape): Promise<Result<void>> {
    const replica = this.replica;
    const key = this.keys.get(seat);
    if (!replica || !key || !this.driver.prepareCommand)
      return failure('trade-proof-unavailable', 'Trade proof delivery is unavailable');
    const initial = planTradeProof(this.commandBody(seat, command), this.context.log);
    if (!initial.ok) return initial;
    const intent: TradeIntent = {
      seat,
      termsHash: initial.value.termsHash,
      deadline: this.options.clock.now() + TRADE_WAIT_MS,
      cancelled: false,
      request: null,
      finishWait: null,
      retryTimer: null,
    };
    this.tradeIntents.set(seat, intent);
    let admitted = false;
    try {
      for (let attempt = 0; attempt <= TRADE_PARENT_RETRIES; attempt++) {
        if (intent.cancelled || this.status.kind !== 'running')
          return failure('trade-proof-cancelled', 'Trade preparation is no longer active');
        if (this.options.clock.now() >= intent.deadline)
          return failure('trade-proof-timeout', 'The other player did not provide a trade proof');
        const valid = this.validate(seat, initial.value.body.command);
        if (!valid.ok) return valid;
        const plan = planTradeProof(
          this.commandBody(seat, initial.value.body.command),
          this.context.log,
        );
        if (!plan.ok) return plan;
        if (plan.value.termsHash !== intent.termsHash)
          return failure('trade-proof-terms-changed', 'The selected trade terms changed');
        let proofs: readonly IndexedHandProof[] | undefined;
        if (plan.value.indices.length > 0 && !this.keys.has(plan.value.owner)) {
          const request = signTradeProofRequest(plan.value.body, key);
          // oxlint-disable-next-line no-await-in-loop -- Every fresh-parent attempt requires its own bound response.
          const received = await this.waitForTradeProof(intent, request);
          if (!received.ok) {
            if (received.error.code === 'trade-proof-parent') continue;
            return received;
          }
          proofs = received.value;
        }
        if (intent.cancelled || this.status.kind !== 'running')
          return failure('trade-proof-cancelled', 'Trade preparation is no longer active');
        if (entryHash(this.context.log.head) !== plan.value.body.headHash) continue;
        if (this.options.clock.now() >= intent.deadline)
          return failure('trade-proof-timeout', 'The trade proof arrived too late');
        const uninterrupted = this.checkTradePriority(seat);
        if (!uninterrupted.ok) return uninterrupted;
        const prepared = this.prepareSubmission(seat, initial.value.body.command, proofs);
        if (!prepared.ok) return prepared;
        const ready = this.checkTradePriority(seat);
        if (!ready.ok) return ready;
        if (this.options.clock.now() >= intent.deadline)
          return failure('trade-proof-timeout', 'Trade preparation took too long');
        // Move the reservation atomically. Cancellation stops being safe at admission.
        this.tradeIntents.delete(seat);
        this.inflight.add(seat);
        admitted = true;
        // oxlint-disable-next-line no-await-in-loop -- Only the final command is submitted; keep its reservation until completion.
        return await replica.submit(prepared.value);
      }
      return failure('trade-proof-stale', 'The board kept changing; confirm the trade again');
    } catch {
      return admitted
        ? failure(
            'replica-outcome-unknown',
            'The trade may have committed; restore and check the certified log before retrying',
          )
        : failure('trade-proof-preparation', 'Could not prepare this trade');
    } finally {
      intent.finishWait?.(failure('trade-proof-cancelled', 'Trade preparation ended'));
      if (this.tradeIntents.get(seat) === intent) this.tradeIntents.delete(seat);
      if (admitted) this.inflight.delete(seat);
      this.maybeAutomatic();
    }
  }

  private checkTradePriority(seat: Seat): Result<void> {
    try {
      const own = this.getPrivate(seat);
      const automatic = own ? this.automaticCommand(own) : null;
      const expired = this.getTimers().some(
        (timer) =>
          timer.seat === seat &&
          !timer.paused &&
          (timer.remainingMs <= 0 ||
            (timer.expiresAt !== null && timer.expiresAt <= this.options.clock.now())),
      );
      return !own || !automatic?.ok || automatic.value || expired
        ? failure('trade-proof-interrupted', 'An automatic action or timer takes priority')
        : success(undefined);
    } catch {
      return failure('trade-proof-preparation', 'Could not check the current trade priority');
    }
  }

  private waitForTradeProof(
    intent: TradeIntent,
    request: SignedTradeProofRequest,
  ): Promise<Result<readonly IndexedHandProof[]>> {
    return new Promise((resolve) => {
      const requestId = tradeProofRequestId(request.body);
      let finished = false;
      const finish = (result: Result<readonly IndexedHandProof[]>) => {
        if (finished) return;
        finished = true;
        if (intent.retryTimer !== null) this.options.clock.clearTimeout(intent.retryTimer);
        intent.retryTimer = null;
        intent.request = null;
        intent.finishWait = null;
        this.replica?.cancelTradeProofRequest(requestId);
        resolve(result);
      };
      intent.request = request;
      intent.finishWait = finish;
      const retry = () => {
        intent.retryTimer = null;
        if (intent.cancelled || this.status.kind !== 'running' || !this.replica) {
          finish(failure('trade-proof-cancelled', 'Trade preparation is no longer active'));
          return;
        }
        if (this.options.clock.now() >= intent.deadline) {
          finish(failure('trade-proof-timeout', 'The other player did not provide a trade proof'));
          return;
        }
        if (entryHash(this.context.log.head) !== request.body.headHash) {
          finish(failure('trade-proof-parent', 'The certified parent changed'));
          return;
        }
        try {
          const priority = this.checkTradePriority(intent.seat);
          if (!priority.ok) {
            finish(priority);
            return;
          }
          const sent = this.replica.requestTradeProof(request);
          if (
            !sent.ok &&
            sent.error.code !== 'replica-transport' &&
            sent.error.code !== 'trade-proof-stale-head' &&
            sent.error.code !== 'trade-proof-parent'
          ) {
            finish(sent);
            return;
          }
          // The replica advances its head before asynchronous journal/controller
          // work publishes the session head. Wait for that publication instead
          // of spending fresh-parent attempts on the same stale body.
        } catch {
          finish(failure('trade-proof-preparation', 'Could not request the other player’s proof'));
          return;
        }
        if (!finished)
          intent.retryTimer = this.options.clock.setTimeout(
            retry,
            Math.max(0, Math.min(TRADE_RETRY_MS, intent.deadline - this.options.clock.now())),
          );
      };
      retry();
    });
  }

  private receiveTradeProof(response: SignedTradeProofResponse): void {
    for (const intent of this.tradeIntents.values()) {
      const request = intent.request;
      if (request && tradeProofRequestId(request.body) === response.body.requestId) {
        intent.finishWait?.(success(copyCanonical(response.body.proofs)));
        return;
      }
    }
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

  /** Submit an already signed readiness statement or recovery activation for certification. */
  submitRecovery(change: unknown): Promise<Result<void>> {
    if (!this.replica || this.status.kind !== 'running' || this.recoveryInstalling)
      return Promise.resolve(failure('session-inactive', 'Peer session is unavailable'));
    return this.replica.submitRecovery(change);
  }

  previewRecoveryAuthorization(change: unknown): Result<RecoveryApprovalCandidate> {
    return this.replica
      ? this.replica.previewRecoveryAuthorization(change)
      : failure('session-unavailable', 'The verified session is not running');
  }

  getRecoveryCandidate(): RecoveryApprovalCandidate | null {
    return this.replica?.getRecoveryCandidate() ?? null;
  }

  approveRecoveryAuthorization(change: unknown): Promise<Result<RecoveryApprovalPreview>> {
    return this.replica
      ? this.replica.approveRecoveryAuthorization(change)
      : Promise.resolve(failure('session-unavailable', 'The verified session is not running'));
  }

  clearRecoveryApproval(): void {
    this.replica?.clearRecoveryApproval();
  }

  /** Explicit vote-mode takeover request; fresh bot keys are reserved before gossip. */
  async requestTakeover(
    departedSeat: Seat,
    botLevel: 'easy' | 'medium' | 'hard',
  ): Promise<Result<void>> {
    const replica = this.replica;
    if (
      !replica ||
      this.privateStateReleased ||
      this.status.kind !== 'running' ||
      this.recoveryInstalling
    )
      return failure('session-recovery-unavailable', 'The game session is unavailable');
    const store = this.options.recoveryStore ?? this.options.recoveryParticipant?.store;
    if (!store) return failure('session-recovery-store', 'Takeover needs durable recovery storage');
    const context = replica.getContext();
    const authority = context.log.authority;
    const hostSeat = this.options.seat;
    const hostKey = this.keys.get(hostSeat);
    const host = authority?.controllers.find((item) => item.seat === hostSeat);
    const departed = authority?.controllers.find((item) => item.seat === departedSeat);
    if (
      !authority ||
      !hostKey ||
      context.log.recovery?.pending ||
      context.log.state.result !== null ||
      host?.kind !== 'human' ||
      host.status !== 'active' ||
      departed?.kind !== 'human' ||
      departed.status !== 'active' ||
      departedSeat === hostSeat
    )
      return failure('session-recovery-context', 'Certified authority cannot start this takeover');
    const recoverers = authority.controllers
      .filter(
        (item) => item.kind === 'human' && item.status === 'active' && item.seat !== departedSeat,
      )
      .map(({ seat, publicKey }) => ({ seat, publicKey }));
    if (recoverers.length < quorumSize(context.membership.voters.length))
      return failure('recovery-quorum', 'Remaining humans cannot meet the old voter quorum');
    if (Math.min(...recoverers.map((item) => item.seat)) !== hostSeat)
      return failure('recovery-host', 'The lowest surviving human seat initiates this takeover');
    const available = await replica.canStartRecoveryRequest();
    if (!available.ok) return available;
    const affected = authority.controllers.filter(
      (item) => item.seat === departedSeat || item.hostSeat === departedSeat,
    );
    const parent = { seq: context.log.head.seq, hash: entryHash(context.log.head) };
    const restored = await loadPreparedRecoveryReadiness(
      context.log,
      hostSeat,
      departedSeat,
      hostKey,
      store,
    );
    if (!restored.ok) return restored;
    let authorization = restored.value;
    if (authorization) {
      if (authorization.statement.botLevel !== botLevel)
        return failure('recovery-bot-level-conflict', 'Stored takeover uses another bot level');
    } else {
      const replacements: { seat: Seat; secretKey: Uint8Array }[] = [];
      try {
        const runtimeCrypto: unknown = Reflect.get(globalThis, 'crypto');
        const getRandomValues =
          runtimeCrypto && typeof runtimeCrypto === 'object'
            ? Reflect.get(runtimeCrypto, 'getRandomValues')
            : null;
        if (typeof getRandomValues !== 'function')
          return failure('session-recovery-entropy', 'Secure random generation is unavailable');
        for (const controller of affected) {
          const secretKey = new Uint8Array(32);
          Reflect.apply(getRandomValues, runtimeCrypto, [secretKey]);
          replacements.push({ seat: controller.seat, secretKey });
        }
        const statement: RecoveryReadiness = {
          genesisDigest: genesisDigest(context.log.genesis),
          parent,
          nextEpoch: authority.epoch + 1,
          departedSeat,
          hostSeat,
          botLevel,
          replacements: replacements.map(({ seat, secretKey }) => {
            const identity = identityFromSecret(secretKey);
            try {
              return { seat, publicKey: identity.peerId };
            } finally {
              identity.secretKey.fill(0);
            }
          }),
          recoverers,
          previous: null,
        };
        const prepared = await prepareRecoveryReadiness(
          statement,
          context.log,
          hostKey,
          replacements,
          store,
        );
        if (!prepared.ok) return prepared;
        authorization = prepared.value;
      } catch {
        return failure('session-recovery-entropy', 'Could not create fresh replacement keys');
      } finally {
        for (const replacement of replacements) replacement.secretKey.fill(0);
      }
    }
    if (
      this.replica !== replica ||
      this.privateStateReleased ||
      entryHash(replica.getContext().log.head) !== parent.hash
    )
      return failure('recovery-parent', 'Certified parent changed during takeover preparation');
    return replica.approveAndSubmitRecovery(authorization);
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
    for (const seat of this.tradeIntents.keys()) this.cancelPending(seat);
    this.clearAutomaticRetry();
    this.clearBotTimer();
    this.clearPrivateTimeout();
    this.cancelAudit();
    this.auditReveals.clear();
    this.replica?.dispose();
    this.status = { kind: 'disposed' };
    this.releasePrivateState();
    this.emit([]);
    this.listeners.clear();
  }

  private releasePrivateState(): void {
    if (this.privateStateReleased) return;
    this.privateStateReleased = true;
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
    try {
      this.driver.dispose?.();
    } catch {
      // Session keys and public lifecycle must still close if private cleanup fails.
    }
    for (const recovered of this.recoveredHosts) {
      try {
        recovered.dispose();
      } catch {
        // Continue clearing every separately retained recovery bundle.
      }
    }
    this.recoveredHosts.length = 0;
  }

  private createDeckSource(deckId: string, seat: Seat) {
    const recovered = this.recoveredHosts.find((bundle) => bundle.keys.has(seat));
    if (recovered) return recovered.createDeckSource(deckId, seat);
    if (!this.options.createDeckSource) throw new Error('Owned deck source is unavailable');
    return this.options.createDeckSource(deckId, seat);
  }

  private async installRecovery(
    current: ProposalContext,
  ): Promise<Result<RecoveredReplicaOwnership | null>> {
    this.recoveryInstalling = true;
    let recovered: RecoveredHost | null = null;
    let retained = false;
    let ready = false;
    try {
      const parent = entryHash(current.log.head);
      if (this.privateStateReleased || parent !== entryHash(this.context.log.head))
        return failure('session-recovery-parent', 'Private state differs from the certified head');
      const seats =
        current.log.authority?.controllers.filter(
          (controller) =>
            controller.kind === 'bot' &&
            controller.status === 'active' &&
            controller.hostSeat === this.options.seat &&
            controller.activatedAt.seq > 0 &&
            !this.keys.has(controller.seat),
        ) ?? [];
      if (seats.length === 0) {
        ready = true;
        return success(null);
      }
      const store = this.options.recoveryStore ?? this.options.recoveryParticipant?.store;
      if (!store || !this.driver.adoptRecovered)
        return failure(
          'session-recovery-store',
          'Recovery needs retained replacement keys, private records and an owned recovery driver',
        );
      const loaded = await loadRecoveredHost({
        journal: this.options.journal,
        engine: this.options.engine,
        policy: this.options.policy,
        hostSeat: this.options.seat,
        privateStore: store,
        readinessStore: store,
        seats: seats.map(({ seat }) => seat),
      });
      if (!loaded.ok) return loaded;
      recovered = loaded.value;
      if (
        this.privateStateReleased ||
        parent !== entryHash(this.context.log.head) ||
        parent !== entryHash(recovered.context.log.head)
      )
        return failure('session-recovery-parent', 'Certified head changed while restoring the bot');
      const adopted = this.driver.adoptRecovered(recovered.driver, detachedLogContext(current.log));
      if (!adopted.ok) return adopted;
      const replicaKeys = new Map<Seat, Uint8Array>();
      for (const [seat, key] of recovered.keys) {
        this.keys.set(seat, key.slice());
        replicaKeys.set(seat, key.slice());
      }
      this.recoveredHosts.push(recovered);
      retained = true;
      ready = true;
      this.automaticParent = null;
      return success({
        keys: replicaKeys,
        beaconSources: recovered.beaconSources,
        createDeckSource: (deckId, seat) => this.createDeckSource(deckId, seat),
      });
    } catch {
      return failure('session-recovery-load', 'Could not install the certified recovered seat');
    } finally {
      if (!retained) recovered?.dispose();
      this.recoveryInstalling = false;
      if (ready) this.maybeAutomatic();
      else if (!this.privateStateReleased) {
        this.status = { kind: 'error', message: 'Could not restore the recovered bot.' };
        this.clearAutomaticRetry();
        this.clearBotTimer();
      }
    }
  }

  private cancelAudit(): void {
    const running = this.auditJob;
    this.auditJob = null;
    for (const { master } of running?.masters ?? []) if (master.byteLength) master.fill(0);
    try {
      running?.job.cancel();
    } catch {
      // Audit cleanup cannot interfere with certified gameplay or private-state disposal.
    }
  }

  private maybeAudit(): void {
    if (!this.replica || this.status.kind !== 'complete') return;
    const runner = this.options.auditRunner;
    if (!runner || !this.options.masterReveal) {
      if (this.auditState.kind !== 'unavailable') {
        this.auditState = { kind: 'unavailable' };
        this.emit([]);
      }
      return;
    }
    const headHash = entryHash(this.context.log.head);
    if (this.auditJob?.headHash === headHash || this.auditedHead === headHash) return;
    this.cancelAudit();
    const missingSeats = this.context.log.genesis.seats
      .filter(({ seat }) => !this.auditReveals.has(seat))
      .map(({ seat }) => seat);
    if (missingSeats.length > 0) {
      this.auditState = { kind: 'awaiting-reveals', missingSeats };
      this.emit([]);
      return;
    }
    const input: SessionAuditInput = {
      genesisEntry: copyCanonical(this.genesisEntry),
      entries: this.replica.getEntries(),
      masters: [...this.auditReveals].map(([seat, packet]) => ({
        seat,
        master: fromBase64Url(packet.body.master),
      })),
    };
    try {
      const terminal = this.auditReveals.values().next().value?.body.result;
      if (!terminal) throw new Error('Missing certified audit result');
      const job = runner(input);
      this.auditJob = {
        headHash,
        headSeq: this.context.log.head.seq,
        terminal: { ...terminal },
        job,
        masters: input.masters,
      };
      this.auditState = { kind: 'verifying' };
      this.emit([]);
      void this.finishAudit(this.auditJob, input);
    } catch {
      for (const { master } of input.masters) if (master.byteLength) master.fill(0);
      this.auditedHead = headHash;
      this.auditState = { kind: 'error', code: 'audit-worker-start' };
      this.emit([]);
    }
  }

  private async finishAudit(
    running: {
      headHash: string;
      headSeq: number;
      terminal: { seq: number; hash: string };
      job: SessionAuditJob;
    },
    input: SessionAuditInput,
  ): Promise<void> {
    try {
      const report = await running.job.result;
      if (this.auditJob !== running || this.status.kind !== 'complete') return;
      const incompleteReplay =
        (report.historyError !== null || report.auditError !== null) &&
        !report.ok &&
        !report.complete;
      if (
        this.context.log.head.seq !== running.headSeq ||
        entryHash(this.context.log.head) !== running.headHash ||
        (!incompleteReplay && (!report.terminal || !report.finalHead)) ||
        (report.terminal &&
          (report.terminal.seq !== running.terminal.seq ||
            report.terminal.hash !== running.terminal.hash)) ||
        (report.finalHead &&
          (report.finalHead.seq !== running.headSeq || report.finalHead.hash !== running.headHash))
      ) {
        this.auditState = { kind: 'error', code: 'audit-report-context' };
      } else this.auditState = { kind: 'complete', report: copyCanonical(report) };
    } catch {
      if (this.auditJob !== running || this.status.kind !== 'complete') return;
      this.auditState = { kind: 'error', code: 'audit-worker' };
    } finally {
      for (const { master } of input.masters) if (master.byteLength) master.fill(0);
      if (this.auditJob === running) {
        this.auditedHead = running.headHash;
        this.auditJob = null;
        this.emit([]);
      }
    }
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
    if (entry.input?.kind === 'command') this.verifiedMoves += 1;
    for (const intent of this.tradeIntents.values())
      intent.finishWait?.(failure('trade-proof-parent', 'The certified parent changed'));
    this.clearAutomaticRetry();
    this.clearBotTimer();
    this.automaticParent = null;
    this.automaticRetryDelay = 250;
    if (this.protocolStatus?.kind === 'halted' || this.protocolStatus?.kind === 'rejected')
      this.protocolStatus = null;
    this.events.push(...entry.events);
    this.status = next.log.state.result ? { kind: 'complete' } : { kind: 'running' };
    this.schedulePrivateTimeout();
    return success(undefined);
  }

  private maybeAutomatic(): void {
    if (
      this.automaticScheduled ||
      !this.replica ||
      this.status.kind !== 'running' ||
      this.recoveryInstalling
    )
      return;
    this.automaticScheduled = true;
    void Promise.resolve().then(() => {
      this.automaticScheduled = false;
      const parent = entryHash(this.context.log.head);
      try {
        this.submitAutomatic();
        this.scheduleBot();
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
      if (input?.kind === 'command' && input.seat === privateState.seat)
        return success(input.command);
      if (this.context.log.genesis.security !== 'verified') return success(null);
      const expired = this.getTimers().some(
        (timer) =>
          timer.seat === privateState.seat &&
          timer.phase === 'discard' &&
          !timer.paused &&
          timer.remainingMs === 0,
      );
      if (!expired) return success(null);
      const pending = this.options.engine
        .getPending(this.context.log.state)
        .some(
          (item) =>
            item.kind === 'player' &&
            item.seat === privateState.seat &&
            item.allowed.includes('DISCARD'),
        );
      if (!pending) return success(null);
      return timedDiscardCommand(this.context.log.state, privateState);
    } catch {
      return failure('automatic-input-unavailable', 'Could not determine the automatic action');
    }
  }

  private submitAutomatic(): void {
    if (!this.replica || this.status.kind !== 'running' || this.recoveryInstalling) return;
    const parent = entryHash(this.context.log.head);
    if (this.automaticParent === parent) return;
    const privates = new Map<Seat, PrivateState>();
    for (const seat of this.keys.keys()) {
      const state = this.getPrivate(seat);
      if (state) privates.set(seat, state);
    }
    const input = this.options.engine.getAutomaticInput(this.context.log.state, privates);
    let automatic = input?.kind === 'command' && this.keys.has(input.seat) ? input : null;
    if (!automatic) {
      for (const [seat, privateState] of privates) {
        const prepared = this.automaticCommand(privateState);
        if (prepared.ok && prepared.value?.type === 'DISCARD') {
          automatic = { kind: 'command', seat, command: prepared.value };
          break;
        }
      }
    }
    if (!automatic) return;
    this.cancelPending(automatic.seat);
    if (this.inflight.has(automatic.seat)) return;
    this.automaticParent = parent;
    void this.submit(automatic.seat, automatic.command)
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

  private hostedBots(): Set<Seat> {
    const { log } = this.context;
    if (log.authority)
      return new Set(
        log.authority.controllers
          .filter(
            (controller) =>
              controller.kind === 'bot' &&
              controller.status === 'active' &&
              controller.hostSeat === this.options.seat &&
              this.keys.has(controller.seat),
          )
          .map(({ seat }) => seat),
      );
    const host = log.genesis.seats.find(({ seat }) => seat === this.options.seat);
    return new Set(
      log.genesis.seats
        .filter(
          (seat) =>
            seat.kind === 'bot' && seat.botHost === host?.publicKey && this.keys.has(seat.seat),
        )
        .map(({ seat }) => seat),
    );
  }

  private botLevel(seat: Seat): 'easy' | 'medium' | 'hard' {
    const { log } = this.context;
    const controller = log.authority?.controllers.find((item) => item.seat === seat);
    const activated = log.recovery?.completed.find(
      (item) =>
        item.activation.seq === controller?.activatedAt.seq &&
        item.activation.hash === controller.activatedAt.hash,
    );
    return (
      log.recovery?.authorizations.find(
        (item) =>
          item.entry.seq === activated?.authorization.seq &&
          item.entry.hash === activated.authorization.hash,
      )?.statement.botLevel ?? 'easy'
    );
  }

  private scheduleBot(): void {
    if (
      !this.options.decideBot ||
      !this.replica ||
      this.status.kind !== 'running' ||
      this.recoveryInstalling ||
      this.botTimer !== null
    )
      return;
    const parent = entryHash(this.context.log.head);
    if (this.botParent === parent || this.automaticParent === parent) return;
    const chosen = chooseBotPending(this.context.log.state, this.getPending(), this.hostedBots());
    if (!chosen || this.inflight.has(chosen.seat)) return;
    this.botParent = parent;
    this.botTimer = this.options.clock.setTimeout(() => {
      this.botTimer = null;
      if (
        this.status.kind !== 'running' ||
        this.recoveryInstalling ||
        parent !== entryHash(this.context.log.head)
      )
        return;
      const pending = chooseBotPending(
        this.context.log.state,
        this.getPending(),
        this.hostedBots(),
      );
      if (!pending || pending.seat !== chosen.seat || this.inflight.has(pending.seat)) return;
      const priv = this.getPrivate(pending.seat);
      if (!priv) return;
      try {
        const command = this.options.decideBot?.(
          { state: copyCanonical(this.context.log.state), priv, seat: pending.seat },
          copyCanonical(pending),
          this.botLevel(pending.seat),
        );
        if (!command) return;
        void this.submit(pending.seat, command)
          .then((result) => {
            if (!result.ok && parent === entryHash(this.context.log.head)) {
              this.botParent = null;
              this.retryAutomatic(parent, result.error.code);
            }
            return undefined;
          })
          .catch(() => {
            this.protocolStatus = { kind: 'rejected', code: 'session-bot-submit' };
            this.emit([]);
          });
      } catch {
        this.protocolStatus = { kind: 'rejected', code: 'session-bot-decision' };
        this.emit([]);
      }
    }, this.options.botDelayMs ?? 350);
  }

  private clearBotTimer(): void {
    if (this.botTimer !== null) this.options.clock.clearTimeout(this.botTimer);
    this.botTimer = null;
    this.botParent = null;
  }

  private schedulePrivateTimeout(): void {
    this.clearPrivateTimeout();
    if (
      !this.replica ||
      this.status.kind !== 'running' ||
      this.context.log.genesis.security !== 'verified'
    )
      return;
    const next = this.getTimers()
      .filter(
        (timer) =>
          timer.phase === 'discard' &&
          this.keys.has(timer.seat) &&
          !timer.paused &&
          timer.remainingMs > 0,
      )
      .toSorted((a, b) => a.remainingMs - b.remainingMs)[0];
    if (!next) return;
    this.privateTimeoutTimer = this.options.clock.setTimeout(() => {
      this.privateTimeoutTimer = null;
      this.maybeAutomatic();
      this.schedulePrivateTimeout();
    }, next.remainingMs);
  }

  private clearPrivateTimeout(): void {
    if (this.privateTimeoutTimer !== null)
      this.options.clock.clearTimeout(this.privateTimeoutTimer);
    this.privateTimeoutTimer = null;
  }

  private update(events: readonly GameEvent[]): SessionUpdate {
    return {
      revision: this.context.log.head.seq,
      state: this.getState(),
      events,
      pending: this.getPending(),
      timers: this.getTimers(),
      status: this.status,
      audit: this.getAudit(),
      fairness: this.getFairness(),
      recoveryCandidate: this.getRecoveryCandidate(),
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
    ...(context.timers
      ? {
          timers: context.timers.map((timer) => ({
            ...timer,
            pendingSince: { ...timer.pendingSince },
          })),
        }
      : {}),
    ...(context.authority ? { authority: copyCanonical(context.authority) } : {}),
    ...(context.recovery ? { recovery: copyCanonical(context.recovery) } : {}),
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
    ...(entry.authority ? { authority: copyCanonical(entry.authority) } : {}),
    ...(entry.recovery ? { recovery: copyCanonical(entry.recovery) } : {}),
  };
}
