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
import { createLiveMasterRevealCoordinator } from './master-reveal.js';
import type {
  MasterRevealCoordinator,
  MasterRevealOptions,
  MasterRevealVerdict,
  SignedMasterReveal,
  Terminal,
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
import type { VoteContext } from './votes.js';
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

// Available in supported browsers/workers and Node 22, without importing DOM globals.
declare const structuredClone: <T>(value: T) => T;

/** Certified history plus one active, durable consensus height. */
export class ReplicatedLog {
  private controller: ConsensusController | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly secretKey: Uint8Array;
  private readonly self: PeerId;
  private readonly genesisHash: string;
  private readonly matchesReplayPolicy: () => boolean;
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
  private firstResult: EntryRef | null = null;
  private terminalCheckpoint: Terminal | null = null;
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
  private contextCheckQueued = false;
  private controllerAnchor: {
    seq: number;
    hash: string;
    genesisDigest: string;
    voters: readonly string[];
    membership: VoteContext;
  } | null = null;
  private derivedRepair: {
    stopped: ConsensusController;
    anchor: NonNullable<ReplicatedLog['controllerAnchor']>;
    heldCommits: Map<string, CertifiedEntry>;
    lastRequestAt: number;
    replayed?: {
      context: ProposalContext;
      entries: CertifiedEntry[];
      snapshotHash: string;
      prefixHash: string;
      firstResult: EntryRef | null;
    };
  } | null = null;

  private constructor(
    private readonly options: ReplicatedLogOptions,
    private readonly genesisEntry: LogEntry,
    private context: ProposalContext,
    private entries: CertifiedEntry[],
    local: LocalConfiguration,
  ) {
    this.genesisHash = entryHash(genesisEntry);
    const { engine, policy } = options;
    const { genesis, entry } = policy;
    const { allowStub, verifyCommitments } = genesis;
    this.matchesReplayPolicy = () =>
      this.options === options &&
      options.engine === engine &&
      options.policy === policy &&
      policy.genesis === genesis &&
      policy.entry === entry &&
      genesis.allowStub === allowStub &&
      genesis.verifyCommitments === verifyCommitments;
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
    let firstResult: EntryRef | null = null;
    const replayed = replayCertifiedPrefix(
      record.genesis,
      record.entries,
      options.engine,
      options.policy,
      (entry, next) => {
        if (!firstResult && next.log.state.result !== null)
          firstResult = { seq: entry.entry.seq, hash: entryHash(entry.entry) };
        return success(undefined);
      },
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
    replica.firstResult = firstResult;
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
      replica.mintTerminalCheckpoint();
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
    // Entries are already owned, validated wire values; export only needs a detached copy.
    return structuredClone(this.entries);
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
    const originalController = hold?.stopped ?? this.activeController();
    const originalContext = this.context;
    const current = () =>
      !this.disposed && this.derivedRepair === hold && this.context === originalContext;
    if (hold) await hold.stopped.settled();
    else {
      const state = this.activeController().snapshot();
      if (!state.ok) return state;
      if (state.value.haltKind !== 'certified-validation')
        return failure('replica-repair', 'Only a certified validation halt can be repaired');
    }
    if (!current()) return failure('replica-disposed', 'Repair was invalidated');
    this.terminalCheckpoint = null;
    if (
      hold?.replayed &&
      snapshot !== undefined &&
      // verifyReplaySnapshot uses this same canonical hash equality.
      toHex(hashValue(snapshot)) !== hold.replayed.snapshotHash
    )
      return failure('snapshot-mismatch', 'Snapshot differs from the certified replay');
    let record: Awaited<ReturnType<ProtocolJournal['load']>>;
    try {
      record = await this.options.journal.load();
    } catch {
      return failure('replica-storage', 'Could not read the certified journal for repair');
    }
    if (!current()) return failure('replica-disposed', 'Repair was invalidated');
    if (!record)
      return this.failClosed('replica-journal', 'Certified journal is missing during repair');
    if (
      !sameBytes(canonicalEncode(record.genesis), canonicalEncode(this.genesisEntry)) ||
      !sameBytes(canonicalEncode(record.genesis), canonicalEncode(this.options.genesisEntry))
    )
      return this.failClosed('replica-genesis', 'Repair journal differs from the original genesis');
    const prefixHash = toHex(hashValue({ genesis: record.genesis, entries: record.entries }));
    if (hold?.replayed && prefixHash !== hold.replayed.prefixHash)
      return this.failClosed('replica-journal', 'Certified journal changed during repair');
    let firstResult: EntryRef | null = hold?.replayed?.firstResult ?? null;
    const replayed = hold?.replayed
      ? success(hold.replayed)
      : replayCertifiedPrefix(
          record.genesis,
          record.entries,
          this.options.engine,
          this.options.policy,
          (entry, next) => {
            if (!firstResult && next.log.state.result !== null)
              firstResult = { seq: entry.entry.seq, hash: entryHash(entry.entry) };
            return success(undefined);
          },
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
    if (!originalController.opensOn(fresh))
      return this.failClosed(
        'replica-authority',
        'Durable replay differs from the controller opening context',
      );
    if (hold && !hold.replayed)
      hold.replayed = {
        context: fresh,
        entries: replayed.value.entries,
        snapshotHash: toHex(hashValue(snapshotFromContext(fresh))),
        prefixHash,
        firstResult,
      };
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
      if (!current()) {
        if (opened.ok) opened.value.dispose();
        return failure('replica-disposed', 'Repair was invalidated');
      }
      if (!opened.ok) return this.failClosed(opened.error.code, opened.error.message);
      restored = opened.value;
      let stillStored: Awaited<ReturnType<ProtocolJournal['loadSafety']>>;
      try {
        stillStored = await this.options.journal.loadSafety(record.height);
      } catch {
        restored.dispose();
        return failure('replica-storage', 'Could not recheck durable safety during repair');
      }
      if (!current()) {
        restored.dispose();
        return failure('replica-disposed', 'Repair was invalidated');
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
    this.firstResult = firstResult;
    this.timerObserver.advance(fresh.log.timers ?? []);
    this.clearTimedVoteRetry();
    this.clearRecoveryCandidate();
    this.rejectedCommands.clear();
    this.rejectedProposals.clear();
    this.rejectedDeckContributions.clear();
    this.rejectedCountContributions.clear();
    this.rejectedStealMessages.clear();
    this.rejectedMasterReveals.clear();
    this.preparedDeckPrefix = null;
    this.sentDeckPrefix = null;
    this.entries = replayed.value.entries;
    this.refreshHistoricalHumanPeers();
    for (const [id, claim] of this.cheatCandidates)
      if (!this.verifiedCheatClaim(claim).ok) this.cheatCandidates.delete(id);
    if (!restored) {
      const opened = await this.openController();
      if (!opened.ok) return this.failClosed(opened.error.code, opened.error.message);
      const resumed = await this.activeController().dispatch({ kind: 'resume-after-replay' });
      if (resumed.ok) this.mintTerminalCheckpoint();
      return resumed;
    }
    this.installController(restored, fresh);
    this.derivedRepair = null;
    const resumed = await restored.resume();
    if (this.disposed || this.controller !== restored) {
      restored.dispose();
      return failure('replica-disposed', 'Repair was invalidated');
    }
    if (!resumed.ok) return resumed;
    this.mintTerminalCheckpoint();
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
    this.terminalCheckpoint = null;
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
    if (this.derivedRepair || this.controller?.hasContextFault())
      return failure('replica-repairing', 'Awaiting certified derived-state repair');
    const context = this.controller?.snapshot();
    if (context && !context.ok) {
      if (context.error.code !== 'consensus-context')
        return this.failClosed(context.error.code, context.error.message);
      this.queueContextCheck();
      return failure('replica-repairing', 'Awaiting certified derived-state repair');
    }
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
      membership: Object.freeze({
        ...context.membership,
        voters: Object.freeze(
          context.membership.voters.map((voter) => Object.freeze({ ...voter })),
        ),
      }),
    });
  }

  private async openController(): Promise<Result<void>> {
    const context = this.context;
    const hold = this.derivedRepair;
    const opened = await this.restoreController(context);
    if (this.disposed || this.context !== context || this.derivedRepair !== hold) {
      if (opened.ok) opened.value.dispose();
      return failure('replica-disposed', 'Controller opening was invalidated');
    }
    if (!opened.ok) return opened;
    this.installController(opened.value, context);
    return success(undefined);
  }

  private enterDerivedRepair(): boolean {
    this.terminalCheckpoint = null;
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
    const hash = entryHash(certified.entry);
    if (hold.heldCommits.has(hash)) return;
    if (
      !verifyObject(
        'entry',
        entryBody(certified.entry),
        certified.entry.sig,
        parsePeerId(certified.entry.sequencer),
      )
    )
      return;
    const certificate = verifyCertificate(certified.certificate, hold.anchor.membership, {
      seq: certified.entry.seq,
      term: certified.entry.term,
      phase: 'precommit',
      valueHash: hash,
    });
    if (!certificate.ok) return;
    hold.heldCommits.set(hash, copyCanonical(certified));
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
      if (this.controller?.hasContextFault() && this.enterDerivedRepair())
        return failure('consensus-context', 'Certified context changed; awaiting durable replay');
      if (this.derivedRepair && !duringRepair)
        return failure('replica-repairing', 'Awaiting certified derived-state repair');
      const repairing = this.derivedRepair;
      try {
        const outcome = await operation();
        if (
          ((!repairing && this.derivedRepair) ||
            this.controller?.hasContextFault() ||
            (!outcome.ok && outcome.error.code === 'consensus-context')) &&
          this.enterDerivedRepair()
        )
          return failure('consensus-context', 'Certified context changed; awaiting durable replay');
        if (!outcome.ok && FATAL_CONTROLLER_ERRORS.has(outcome.error.code)) {
          this.status({ kind: 'halted', code: outcome.error.code });
          this.dispose();
        }
        return outcome;
      } catch {
        if (
          ((!repairing && this.derivedRepair) || this.controller?.hasContextFault()) &&
          this.enterDerivedRepair()
        )
          return failure('consensus-context', 'Certified context changed; awaiting durable replay');
        this.status({ kind: 'halted', code: 'replica-transition' });
        this.dispose();
        return failure('replica-transition', 'Replicated log transition failed');
      }
    });
    this.queue = result;
    return result;
  }

  /** Synchronous ingress may detect a fault while a persisted transition is awaiting storage. */
  private queueContextCheck(): void {
    if (this.contextCheckQueued || this.disposed) return;
    this.contextCheckQueued = true;
    void this.enqueue(() => Promise.resolve(success(undefined)), true).then(() => {
      this.contextCheckQueued = false;
      return undefined;
    });
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
          if (
            !this.derivedRepair &&
            !this.controller?.hasContextFault() &&
            !result.ok &&
            !FATAL_CONTROLLER_ERRORS.has(result.error.code)
          )
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
          const checked = this.activeController().snapshot();
          if (!checked.ok) return checked;
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
    if (this.derivedRepair) return;
    const checked = this.controller?.snapshot();
    if (checked && !checked.ok) {
      if (checked.error.code === 'consensus-context') this.queueContextCheck();
      else this.failClosed(checked.error.code, checked.error.message);
      return;
    }
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
    this.masterRevealCoordinator ??= createLiveMasterRevealCoordinator(
      {
        ...this.options.masterReveal,
        journal: this.options.journal,
        engine: this.options.engine,
        policy: this.options.policy,
        localSeat: this.options.seat,
        signingKey: this.secretKey,
      },
      () => this.readTerminalCheckpoint(),
    );
    return this.masterRevealCoordinator;
  }

  /** Called only after certified commit, or full replay and controller restoration. */
  private mintTerminalCheckpoint(): void {
    this.terminalCheckpoint =
      !this.disposed && !this.derivedRepair && this.firstResult && this.context.log.state.result
        ? Object.freeze({
            context: this.context,
            result: Object.freeze({ ...this.firstResult }),
            head: Object.freeze({
              seq: this.context.log.head.seq,
              hash: entryHash(this.context.log.head),
            }),
            genesisHash: this.genesisHash,
          })
        : null;
  }

  /** Reuse prior validation only while its controller and durable branch still agree. */
  private async readTerminalCheckpoint(): Promise<Result<Terminal>> {
    const checkpoint = this.terminalCheckpoint;
    const controller = this.controller;
    const current = (): boolean => {
      if (
        !checkpoint ||
        !controller ||
        this.disposed ||
        this.derivedRepair ||
        this.terminalCheckpoint !== checkpoint ||
        this.controller !== controller ||
        this.context !== checkpoint.context
      )
        return false;
      try {
        const state = controller.snapshot();
        if (
          this.matchesReplayPolicy() &&
          state.ok &&
          !state.value.halted &&
          controller.opensOn(checkpoint.context)
        )
          return true;
      } catch {
        // A mutated policy getter is not a new authority to disclose a master.
      }
      if (this.terminalCheckpoint === checkpoint) this.terminalCheckpoint = null;
      return false;
    };
    if (!checkpoint || !controller || !current())
      return failure('master-reveal-context', 'Verified terminal context is unavailable');
    try {
      const record = await this.options.journal.load();
      if (!current())
        return failure('master-reveal-stale', 'Verified terminal context changed during read');
      const head = record?.entries.at(-1)?.entry ?? record?.genesis;
      if (
        !record ||
        !head ||
        record.height !== head.seq + 1 ||
        record.entries.length !== head.seq ||
        head.seq !== checkpoint.head.seq ||
        entryHash(head) !== checkpoint.head.hash ||
        entryHash(record.genesis) !== checkpoint.genesisHash ||
        !controller.matchesPersistedRecord(record.safety)
      )
        return failure('master-reveal-journal', 'Durable journal differs from verified checkpoint');
      return success(checkpoint);
    } catch {
      return failure('master-reveal-journal', 'Could not read verified terminal journal');
    }
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
          if (FATAL_CONTROLLER_ERRORS.has(received.error.code)) return received;
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
      this.derivedRepair ||
      this.controller?.hasContextFault() ||
      this.context.log.genesis.security !== 'verified'
    )
      return;
    const checked = this.controller?.snapshot();
    if (checked && !checked.ok) {
      if (checked.error.code !== 'consensus-context')
        this.failClosed(checked.error.code, checked.error.message);
      return;
    }
    if (
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
    if (!effect || this.disposed || this.derivedRepair) return;
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
    const prior = this.activeController().snapshot();
    if (!prior.ok) throw new Error(`Voting record failed: ${prior.error.code}`);
    const previous = this.context;
    const checked = validateCertifiedEntry(certified, previous);
    if (!checked.ok) throw new Error(`Certified entry failed replay: ${checked.error.code}`);
    const advanced = advanceContext(previous, checked.value);
    if (!advanced.ok) throw new Error(`Certified context failed: ${advanced.error.code}`);
    const next = advanced.value;
    this.terminalCheckpoint = null;
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
    if (!this.firstResult && previous.log.state.result === null && next.log.state.result !== null)
      this.firstResult = { seq: checked.value.entry.seq, hash: entryHash(checked.value.entry) };
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
      this.mintTerminalCheckpoint();
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
      const snapshot = this.activeController().snapshot();
      if (!snapshot.ok) return snapshot;
      this.observeAllRecoveryPresence();
      this.notifyAutoTakeoverEligibility();
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
