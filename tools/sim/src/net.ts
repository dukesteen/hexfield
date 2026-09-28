import { RandomBot, createBotRng } from '@cp2p/bots';
import { setImmediate as yieldEventLoop } from 'node:timers/promises';
import { canonicalDecode, hashValue, toHex } from '@cp2p/codec';
import type { CommandShape, GameState, Pending, PrivateState, Result, Seat } from '@cp2p/engine';
import { moduleSelection } from '@cp2p/engine';
import {
  MemoryProtocolJournal,
  P2PSession,
  advanceContext,
  decodeProtocolMessage,
  encodeProtocolMessage,
  entryHash,
  genesisDigest,
  initialProposalContext,
  proposerFor,
  quorumSize,
  signCommand,
  validateCertifiedEntry,
} from '@cp2p/protocol';
import type {
  AuditReport,
  CertifiedEntry,
  ProposalContext,
  ProtocolClock,
  ProtocolMessage,
  P2PSessionOptions,
  SessionAuditState,
  SessionUpdate,
  Transport,
} from '@cp2p/protocol';
import {
  SimulationDriver,
  createMemnet,
  createSimulationGenesis,
  createVerifiedNetworkFixture,
  createVerifiedNonVoterActor,
} from '@cp2p/protocol/testing';
import type { VerifiedNetworkAuditTiming, VerifiedNonVoterActor } from '@cp2p/protocol/testing';
import { deriveSeed } from './random-source.js';
import { invalidCommandProposal } from './net-adversary.js';
import { NonVoterCommand } from './non-voter-command.js';
import {
  PersistenceLifecycle,
  observeRestoredJournal,
  restartEvidence,
} from './persistence-lifecycle.js';
import type { LifecycleHistoryEntry, LifecycleRestart } from './persistence-lifecycle.js';
import { observeOutgoingTransport } from './observed-transport.js';
import { createVerifiedNetworkAuditJob } from './node-audit-client.js';

export interface NetworkGameOptions {
  seed: number;
  gameIndex: number;
  scenario: number;
  /** Four seats by default; six uses the five-six module (stub security only). */
  players?: 4 | 6;
  maxSteps?: number;
  /** Stage 07 acceptance uses genuine private sources and proofs on the same fault schedules. */
  security?: 'stub' | 'verified';
  maxElapsedMs?: number;
  /** Representative Stage 10 persistence trace on the clean verified four-human game. */
  lifecycle?: 'persistence';
  onProgress?: (progress: {
    revision: number;
    turn: number;
    virtualMilliseconds: number;
    elapsedMilliseconds: number;
  }) => void;
}

export interface NetworkGameResult {
  security: 'stub' | 'verified';
  protocolVersion: number;
  seed: number;
  gameIndex: number;
  scenario: number;
  turns: number;
  inputs: number;
  virtualMilliseconds: number;
  elapsedMilliseconds: number;
  operationTimings: Record<
    string,
    { calls: number; totalMilliseconds: number; maximumMilliseconds: number }
  >;
  finalStateHash: string;
  finalLogHash: string;
  audits: {
    seat: Seat;
    ok: true;
    complete: true;
    finalHead: { seq: number; hash: string };
    cheatFindings: AuditReport['cheatFindings'];
  }[];
  auditTimings?: readonly VerifiedNetworkAuditTiming[];
  lifecycle?: {
    profile: 'persistence';
    restarts: readonly LifecycleRestart[];
    inputCounts: Record<string, number>;
    privateStates: {
      capturedSequences: number;
      capturedSnapshots: number;
      checkedSequences: number;
      repeatedSnapshots: number;
      snapshotDigest: string;
    };
  };
  faultInjected: boolean;
  faultRecovered: boolean;
  faultEvidence: {
    injectedAtRevision: number;
    majorityCommitsDuringPartition: number | null;
    isolatedCommitsDuringPartition: number | null;
    pausedPeersDuringPartition: number;
    replacementTerm: number | null;
    censoredCommandCommitted: boolean;
    snapshotRequests: number;
    snapshotResponses: number;
    derivedContextDiagnostic: string | null;
    snapshotRepairAdopted: boolean;
    repairSnapshotParentSeq: number | null;
    repairSnapshotHash: string | null;
    continuationCommandHash: string | null;
    duplicateDeliveries: number;
    certifiedExclusionPeers: number;
    byzantineCommandCommits: number;
    rejectedProposalHash: string | null;
    nonVoterMessageTypes: string[];
    nonVoterPublishedMaster: boolean;
  };
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function beaconPosition({
  seat,
  chainEpoch,
  index,
  length,
}: {
  seat: Seat;
  chainEpoch: number;
  index: number;
  length: number;
}) {
  return { seat, chainEpoch, index, length };
}

/** Full games through the real peer sessions, signatures, wire encoding and journals. */
export async function runNetworkGame(options: NetworkGameOptions): Promise<NetworkGameResult> {
  if (!Number.isInteger(options.scenario) || options.scenario < 1 || options.scenario > 9)
    throw new Error('This network scenario is not implemented yet');
  if (options.lifecycle && (options.security !== 'verified' || options.scenario !== 1))
    throw new Error('Persistence lifecycle requires clean scenario 1 with verified security');
  const players = options.players ?? 4;
  if (players === 6 && options.security === 'verified')
    throw new Error('Six-peer network games use stub security');
  const lifecycle = options.lifecycle ? new PersistenceLifecycle() : null;
  let lifecycleObservedRevision = -1;
  const started = performance.now();
  const verified =
    options.security === 'verified'
      ? createVerifiedNetworkFixture({
          seed: options.seed,
          gameIndex: options.gameIndex,
          verifyLivePrivateStates: lifecycle !== null,
          auditExecutor: createVerifiedNetworkAuditJob,
        })
      : null;
  const game =
    verified ??
    createSimulationGenesis({
      seed: options.seed,
      gameIndex: options.gameIndex,
      ...(players === 6
        ? {
            config: {
              modules: moduleSelection(['base', 'five-six']),
              seats: [0, 1, 2, 3, 4, 5],
              options: { base: { mapLayout: 'random' } },
            },
          }
        : {}),
    });
  const keys = [...game.identities.values()];
  const network = createMemnet({
    peers: keys.map((identity) => identity.peerId),
    seed: options.seed + options.gameIndex,
    defaultLink:
      options.scenario === 2
        ? { latencyMs: 225, jitterMs: 175, duplicateProbability: 0.1 }
        : { latencyMs: 1 },
  });
  const sessions = new Map<Seat, P2PSession>();
  const updates = new Map<Seat, SessionUpdate>();
  const journals = new Map(
    game.genesis.config.seats.map((seat) => [seat, new MemoryProtocolJournal()]),
  );
  const stateHashes = new Map<number, string>();
  const logHashes = new Map<number, string>();
  const offline = new Set<Seat>();
  let faultInjected = false;
  let faultRecovered = false;
  let recoverAt = Infinity;
  let faultRevision = 0;
  let partitionStableRevisions: Map<Seat, number> | null = null;
  let partitionCheckAt = Infinity;
  let partitionRequested: { proposer: Seat; commandSeat: Seat | null; seq: number } | null = null;
  const partitionProposalSeen = new Set<Seat>();
  let partitionIsolatedSeat: Seat | null = null;
  let majorityCommitsDuringPartition: number | null = null;
  let isolatedCommitsDuringPartition: number | null = null;
  let pausedPeersDuringPartition = 0;
  let replacementTerm: number | null = null;
  let censoredCommandCommitted = false;
  let crashRequested: { seat: Seat; seq: number } | null = null;
  let crashedProposalHeight: number | null = null;
  let crashedProposerSeat: Seat | null = null;
  const intentionallyInterruptedSubmissions = new WeakSet<object>();
  let maliciousHeight: number | null = null;
  let maliciousEntryHash: string | null = null;
  let maliciousCommandHash: string | null = null;
  let censoredCommandHash: string | null = null;
  let corruptedHeight: number | null = null;
  let desyncObserved = false;
  let derivedContextDiagnostic: string | null = null;
  let snapshotRepairAdopted = false;
  let repairSnapshotParentSeq: number | null = null;
  let repairSnapshotHash: string | null = null;
  let continuationCommandHash: string | null = null;
  const snapshotRequestAtSeqs = new Set<number>();
  const snapshotResponsePairs = new Set<string>();
  let certifiedExclusionPeers = 0;
  let byzantineHalted = false;
  let byzantineSubmissionRevision: number | null = null;
  let byzantineSubmissionHash: string | null = null;
  let byzantineCommandCommits = 0;
  let verifiedNonVoter: VerifiedNonVoterActor | null = null;
  let nonVoterCommand: NonVoterCommand | null = null;
  let nonVoterContributionRetryAt = 0;
  let nonVoterWake: unknown = null;
  let nonVoterPublishedMaster = false;
  const nonVoterMessageTypes = new Set<string>();
  let byzantinePrivateCache: {
    revision: number;
    privateState: PrivateState;
    context: ProposalContext;
    driver: SimulationDriver;
  } | null = null;
  const bots = new Map(
    game.genesis.config.seats.map((seat) => [
      seat,
      {
        bot: new RandomBot(game.engine),
        rng: createBotRng(deriveSeed(options.seed, options.gameIndex, 'net-bot', seat)),
      },
    ]),
  );
  const failures: string[] = [];
  let submission: { seat: Seat; result: Result<void> | null } | null = null;
  let lastProgressMilliseconds = 0;
  let highestProgressRevision = -1;
  let terminalReachedMilliseconds: number | null = null;
  const operationTimings: NetworkGameResult['operationTimings'] = {};
  const packetCounts = new Map<
    Seat,
    { sent: Map<string, number>; received: Map<string, number> }
  >();

  function countPacket(seat: Seat, direction: 'sent' | 'received', bytes: Uint8Array): void {
    const decoded = decodeProtocolMessage(bytes);
    if (!decoded.ok) return;
    const message: ProtocolMessage = decoded.value;
    let key: string;
    if (message.t === 'SYS_CONTRIB') key = `SYS_CONTRIB/${message.contribution.kind}`;
    else if (message.t === 'MASTER_REVEAL') {
      const { publisherSeat, originalSeat } = message.reveal.body;
      if (
        !game.genesis.config.seats.includes(publisherSeat) ||
        !game.genesis.config.seats.includes(originalSeat)
      )
        return;
      key = `MASTER_REVEAL/${publisherSeat}/${originalSeat}`;
    } else return;
    let counters = packetCounts.get(seat);
    if (!counters) {
      counters = { sent: new Map(), received: new Map() };
      packetCounts.set(seat, counters);
    }
    const counts = counters[direction];
    if (counts.size >= 64 && !counts.has(key)) return;
    counts.set(key, Math.min(Number.MAX_SAFE_INTEGER, (counts.get(key) ?? 0) + 1));
  }

  function checkDeadline(): void {
    if (options.maxElapsedMs !== undefined && performance.now() - started > options.maxElapsedMs)
      throw new Error(`Peer game exceeded ${options.maxElapsedMs} ms: ${progressDiagnostic()}`);
  }

  function recordOperation(name: string, operationStarted: number): void {
    const elapsed = performance.now() - operationStarted;
    const timing = (operationTimings[name] ??= {
      calls: 0,
      totalMilliseconds: 0,
      maximumMilliseconds: 0,
    });
    timing.calls++;
    timing.totalMilliseconds += elapsed;
    timing.maximumMilliseconds = Math.max(timing.maximumMilliseconds, elapsed);
  }

  function measure<T>(name: string, operation: () => T): T {
    const operationStarted = performance.now();
    try {
      return operation();
    } finally {
      recordOperation(name, operationStarted);
    }
  }

  function observe(seat: Seat, update: SessionUpdate): void {
    const prior = updates.get(seat);
    const session = sessions.get(seat);
    const protocolStatus = session?.getProtocolStatus();
    if (prior && update.revision < prior.revision)
      failures.push(`Peer ${seat} rolled back a commit`);
    if (update.status.kind === 'error') {
      if (
        options.scenario === 8 &&
        seat === 0 &&
        faultInjected &&
        protocolStatus?.kind === 'halted' &&
        protocolStatus.code === 'consensus-context'
      ) {
        desyncObserved = true;
        derivedContextDiagnostic = protocolStatus.code;
      } else if (
        options.scenario === 6 &&
        seat === 0 &&
        faultInjected &&
        ['Objective evidence implicates the local signing key', 'replica-fault-limit'].includes(
          update.status.message,
        )
      )
        byzantineHalted = true;
      else failures.push(`Peer ${seat}: ${update.status.message}`);
    }
    if (prior?.revision !== update.revision) {
      if (update.revision > highestProgressRevision) {
        highestProgressRevision = update.revision;
        lastProgressMilliseconds = performance.now() - started;
      }
      if (update.state.result && terminalReachedMilliseconds === null)
        terminalReachedMilliseconds = performance.now() - started;
      const hash = toHex(hashValue(update.state));
      const known = stateHashes.get(update.revision);
      if (known !== undefined && known !== hash)
        failures.push(`Public state diverged at revision ${update.revision}`);
      stateHashes.set(update.revision, hash);
    }
    const head = sessions.get(seat)?.getCommittedHead();
    if (head) {
      const known = logHashes.get(head.seq);
      if (known !== undefined && known !== head.hash)
        failures.push(`Committed log value diverged at revision ${head.seq}`);
      logHashes.set(head.seq, head.hash);
    }
    updates.set(seat, update);
    if (
      options.scenario === 8 &&
      seat === 0 &&
      desyncObserved &&
      corruptedHeight !== null &&
      protocolStatus === null &&
      update.revision >= corruptedHeight &&
      update.status.kind === 'running' &&
      repairSnapshotParentSeq === corruptedHeight - 1 &&
      repairSnapshotHash !== null
    )
      snapshotRepairAdopted = true;
    if (
      options.scenario === 8 &&
      seat === 0 &&
      snapshotRepairAdopted &&
      !faultRecovered &&
      corruptedHeight !== null &&
      update.revision > corruptedHeight &&
      protocolStatus === null
    ) {
      const continued = session?.exportSave().entries[update.revision - 1];
      if (continued?.entry.payload.kind === 'command') {
        continuationCommandHash = entryHash(continued.entry);
        faultRecovered = true;
      }
    }
    if (
      (options.scenario === 6 || seat === 0) &&
      maliciousHeight !== null &&
      update.revision >= maliciousHeight &&
      !faultRecovered
    ) {
      if (options.scenario === 6) {
        const committed = sessions.get(seat)?.exportSave().entries[maliciousHeight - 1];
        if (committed?.entry.payload.kind !== 'control' || committed.entry.payload.offender !== 0)
          failures.push('Invalid proposer was not excluded by the certified control entry');
      }
      if (options.scenario === 7) {
        const committed = sessions.get(seat)?.exportSave().entries[maliciousHeight - 1];
        if (
          committed?.entry.payload.kind !== 'command' ||
          toHex(hashValue(committed.entry.payload.signed)) !== censoredCommandHash ||
          committed.entry.term <= 1 ||
          committed.entry.sequencer === game.identities.get(seat)?.peerId
        )
          failures.push('Censored command was not committed unchanged by a later proposer');
        else {
          censoredCommandCommitted = true;
          replacementTerm = committed.entry.term;
        }
      }
      faultRecovered = true;
    }
    if (
      (seat === 0 || (options.scenario === 6 && seat === 1)) &&
      prior?.revision !== update.revision
    )
      options.onProgress?.({
        revision: update.revision,
        turn: update.state.turn.number,
        virtualMilliseconds: network.clock.now(),
        elapsedMilliseconds: performance.now() - started,
      });
  }

  async function flush(): Promise<void> {
    const operationStarted = performance.now();
    try {
      await Promise.all([...sessions.values()].map((session) => session.flush()));
    } finally {
      recordOperation('sessionFlush', operationStarted);
    }
  }

  async function waitForTerminalAudits(): Promise<void> {
    if (!verified) return;
    checkDeadline();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const completed = verified.waitForAudits();
    try {
      if (options.maxElapsedMs === undefined) await completed;
      else {
        const limit = options.maxElapsedMs;
        await Promise.race([
          completed,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`Peer game exceeded ${limit} ms: ${progressDiagnostic()}`)),
              Math.max(0, Math.ceil(limit - (performance.now() - started))),
            );
          }),
        ]);
      }
      checkDeadline();
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  function progressDiagnostic(): string {
    const latest = [...updates.values()].toSorted(
      (left, right) => right.revision - left.revision,
    )[0];
    return JSON.stringify({
      elapsedMilliseconds: performance.now() - started,
      lastProgressMilliseconds,
      terminalReachedMilliseconds,
      virtualMilliseconds: network.clock.now(),
      public: latest
        ? {
            revision: latest.revision,
            turn: latest.state.turn.number,
            phase: latest.state.turn.phase,
            result: latest.state.result,
            publicVp: latest.state.seats.map(({ seat, publicVp }) => ({ seat, publicVp })),
          }
        : null,
      auditTimings: verified?.auditTimingEvidence() ?? [],
      operationTimings,
      submission,
      peers: [...sessions].map(([seat, session]) => ({
        seat,
        head: session.getCommittedHead(),
        revision: updates.get(seat)?.revision,
        turn: updates.get(seat)?.state.turn,
        phase: updates.get(seat)?.state.turn.phase,
        publicVp: updates.get(seat)?.state.seats.map(({ seat: publicSeat, publicVp }) => ({
          seat: publicSeat,
          publicVp,
        })),
        result: updates.get(seat)?.state.result,
        pending: session.getPending(),
        protocol: session.getProtocolStatus(),
        beacon: (() => {
          const beacon = session['context'].log.crypto?.beacon;
          return beacon
            ? {
                round: beacon.round,
                chains: beacon.chains.map(beaconPosition),
                active: beacon.active
                  ? {
                      epoch: beacon.active.epoch,
                      round: beacon.active.round,
                      participants: beacon.active.participants.map(beaconPosition),
                    }
                  : null,
              }
            : null;
        })(),
        packets: (() => {
          const counts = packetCounts.get(seat);
          return {
            sent: Object.fromEntries(counts?.sent ?? []),
            received: Object.fromEntries(counts?.received ?? []),
          };
        })(),
        audit: (() => {
          const audit: SessionAuditState = session.getAudit();
          return audit.kind === 'awaiting-reveals'
            ? { kind: audit.kind, missingSeats: audit.missingSeats }
            : { kind: audit.kind };
        })(),
        automaticParent: Reflect.get(session, 'automaticParent'),
      })),
    });
  }

  function countingTransport(seat: Seat, raw: Transport): Transport {
    // Sent counts are emissions; received counts include duplicate wire deliveries.
    return {
      self: raw.self,
      peers: () => raw.peers(),
      send: (to, bytes) => {
        countPacket(seat, 'sent', bytes);
        raw.send(to, bytes);
      },
      broadcast: (bytes) => {
        countPacket(seat, 'sent', bytes);
        raw.broadcast(bytes);
      },
      onMessage: (listener) =>
        raw.onMessage((from, bytes) => {
          countPacket(seat, 'received', bytes);
          listener(from, bytes);
        }),
      onPeerChange: (listener) => raw.onPeerChange(listener),
      disconnect: (peer) => raw.disconnect(peer),
    };
  }

  function peerTransport(seat: Seat): Transport {
    const identity = game.identities.get(seat);
    if (!identity) throw new Error('Missing transport identity');
    const transport = countingTransport(seat, network.transport(identity.peerId));
    if (![3, 4, 5, 6, 7, 8].includes(options.scenario)) return transport;
    const rewrite = (bytes: Uint8Array): Uint8Array | null => {
      const decoded = unwrap(decodeProtocolMessage(bytes));
      if (
        options.scenario === 8 &&
        seat === 0 &&
        decoded.t === 'SNAPSHOT_REQ' &&
        faultInjected &&
        desyncObserved &&
        corruptedHeight !== null &&
        decoded.atSeq === corruptedHeight - 1
      )
        snapshotRequestAtSeqs.add(decoded.atSeq);
      if ([3, 4, 5].includes(options.scenario)) {
        if (
          decoded.t === 'PROPOSAL' &&
          !faultInjected &&
          decoded.proposal.body.entry.seq >= 20 &&
          decoded.proposal.body.entry.term === 1 &&
          (updates.get(seat)?.state.turn.number ?? 0) >= 2
        ) {
          const proposal = decoded.proposal.body.entry;
          if (options.scenario === 3 && !crashRequested) {
            crashRequested = { seat, seq: proposal.seq };
          }
          if ([4, 5].includes(options.scenario) && !partitionRequested)
            partitionRequested = {
              proposer: seat,
              commandSeat:
                proposal.payload.kind === 'command' ? proposal.payload.signed.body.seat : null,
              seq: proposal.seq,
            };
          if (options.scenario === 4) partitionProposalSeen.add(seat);
        }
        return bytes;
      }
      if (options.scenario === 8) return bytes;
      if (seat !== 0) return bytes;
      if (decoded.t !== 'PROPOSAL') return bytes;
      const { entry } = decoded.proposal.body;
      if (
        maliciousHeight === null &&
        entry.seq >= 20 &&
        entry.term === 1 &&
        (options.scenario !== 7 || entry.payload.kind === 'command')
      ) {
        maliciousHeight = entry.seq;
        faultInjected = true;
        faultRevision = entry.seq - 1;
        if (options.scenario === 7 && entry.payload.kind === 'command')
          censoredCommandHash = toHex(hashValue(entry.payload.signed));
      }
      if (entry.seq !== maliciousHeight || entry.term !== 1) return bytes;
      if (options.scenario === 7) return null;
      const proposal = invalidCommandProposal(
        decoded.proposal,
        game.genesis,
        seat,
        identity.secretKey,
      );
      maliciousEntryHash = entryHash(proposal.body.entry);
      if (proposal.body.entry.payload.kind !== 'command')
        throw new Error('Invalid command injection lacks its signed command');
      maliciousCommandHash = toHex(hashValue(proposal.body.entry.payload.signed));
      return unwrap(encodeProtocolMessage({ t: 'PROPOSAL', proposal }));
    };
    return {
      self: transport.self,
      peers: () => transport.peers(),
      send: (to, bytes) => {
        const changed = rewrite(bytes);
        if (changed) transport.send(to, changed);
      },
      broadcast: (bytes) => {
        const changed = rewrite(bytes);
        if (changed) transport.broadcast(changed);
      },
      onMessage: (listener) =>
        transport.onMessage((from, bytes) => {
          if (options.scenario === 4 && partitionRequested) {
            const incoming = unwrap(decodeProtocolMessage(bytes));
            if (
              incoming.t === 'PROPOSAL' &&
              incoming.proposal.body.entry.seq === partitionRequested.seq
            )
              partitionProposalSeen.add(seat);
          }
          if (options.scenario === 8 && seat === 0 && !faultRecovered) {
            const decoded = unwrap(decodeProtocolMessage(bytes));
            const session = sessions.get(seat);
            const head = session?.getCommittedHead();
            const vote = decoded.t === 'VOTE' ? decoded.vote.body : null;
            if (
              !faultInjected &&
              corruptedHeight === null &&
              session &&
              head &&
              head.seq >= 20 &&
              head.seq % keys.length !== 0 &&
              vote?.seq === head.seq + 1 &&
              vote.phase === 'precommit' &&
              vote.valueHash !== null
            ) {
              corruptedHeight = vote.seq;
              faultRevision = head.seq;
              corruptDerivedBank(session);
              faultInjected = true;
            }
            if (
              decoded.t === 'SNAPSHOT_RES' &&
              from !== game.identities.get(0)?.peerId &&
              desyncObserved &&
              corruptedHeight !== null &&
              decoded.atSeq === corruptedHeight - 1 &&
              snapshotRequestAtSeqs.has(corruptedHeight - 1)
            ) {
              snapshotResponsePairs.add(`${from}:${decoded.atSeq}`);
              repairSnapshotParentSeq ??= decoded.atSeq;
              repairSnapshotHash ??= toHex(hashValue(decoded.snapshot));
            }
          }
          listener(from, bytes);
        }),
      onPeerChange: (listener) => transport.onPeerChange(listener),
      disconnect: (peer) => transport.disconnect(peer),
    };
  }

  function observeNonVoterMessage(bytes: Uint8Array): void {
    const message = unwrap(decodeProtocolMessage(bytes));
    nonVoterMessageTypes.add(message.t);
    if (['PROPOSAL', 'VOTE', 'COMMIT'].includes(message.t)) {
      failures.push(`Excluded non-voter emitted ${message.t}`);
      throw new Error(`Excluded non-voter emitted ${message.t}`);
    }
    if (message.t === 'MASTER_REVEAL') {
      if (message.reveal.body.publisherSeat !== 0 || message.reveal.body.originalSeat !== 0)
        throw new Error('Excluded actor published a foreign master');
      nonVoterPublishedMaster = true;
    }
  }

  function nonVoterTransport(peerId: string): Transport {
    return observeOutgoingTransport(
      countingTransport(0, network.transport(peerId)),
      observeNonVoterMessage,
    );
  }

  function wakeNonVoter(): void {
    // Keep retries alive even when no peer has scheduled another delivery or timeout.
    nonVoterWake = network.clock.setTimeout(wakeNonVoter, 250);
  }

  async function open(
    seat: Seat,
    restoring: boolean,
    restoreJournal?: P2PSessionOptions['journal'],
    restoreEvidence?: LifecycleRestart['restored'][number],
  ): Promise<void> {
    const identity = game.identities.get(seat);
    const journal = journals.get(seat);
    if (!identity || !journal) throw new Error('Missing simulation identity or journal');
    const transport = peerTransport(seat);
    const restoredTransport = restoreEvidence
      ? observeOutgoingTransport(transport, (bytes) => {
          const parsed = decodeProtocolMessage(bytes);
          if (!parsed.ok || (parsed.value.t !== 'PROPOSAL' && parsed.value.t !== 'VOTE')) return;
          if (!restoreEvidence.loadedBeforeVoting) {
            restoreEvidence.orderingViolations += 1;
            throw new Error('Restored session voted before validating its retained journal');
          }
          restoreEvidence.votingMessagesAfterLoad += 1;
          if (parsed.value.t !== 'VOTE') return;
          const { seq, phase, valueHash } = parsed.value.vote.body;
          if (
            phase === 'precommit' &&
            valueHash !== null &&
            !restoreEvidence.precommits.some(
              (vote) => vote.seq === seq && vote.valueHash === valueHash,
            )
          )
            restoreEvidence.precommits.push({ seq, valueHash });
        })
      : transport;
    const sessionOptions: P2PSessionOptions = {
      genesisEntry: game.entry,
      engine: game.engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat,
      secretKey: identity.secretKey,
      transport: restoredTransport,
      clock: network.clock,
      journal: restoreJournal ?? journal,
      createDriver: (
        engine: typeof game.engine,
        genesis: typeof game.genesis,
        clock: ProtocolClock,
      ) => new SimulationDriver(engine, genesis, clock),
      ...verified?.sessionOptions(seat),
    };
    const session = unwrap(
      await (restoring ? P2PSession.restore(sessionOptions) : P2PSession.create(sessionOptions)),
    );
    session.subscribe((update) => observe(seat, update));
    sessions.set(seat, session);
  }

  async function restartLifecycle(event: LifecycleRestart): Promise<void> {
    const records = new Map<
      Seat,
      NonNullable<Awaited<ReturnType<MemoryProtocolJournal['load']>>>
    >();
    const preCrashHeads = new Map<Seat, { seq: number; hash: string }>();
    for (const seat of event.seats) {
      const session = sessions.get(seat);
      if (!session || session.getCommittedHead().seq !== event.seq)
        throw new Error('Lifecycle restart requires a common certified head');
      preCrashHeads.set(seat, session.getCommittedHead());
    }
    for (const seat of event.seats) crash(seat);
    if (event.kind === 'everyone-left' && sessions.size !== 0)
      throw new Error('Everyone-left trace did not close every session');
    const allClosedAt = network.clock.now();
    if (event.kind === 'everyone-left') network.clock.advanceBy(2_000);
    let lastReopenedAt: number | null = null;
    for (const seat of event.seats) {
      const journal = journals.get(seat);
      if (!journal) throw new Error('Missing lifecycle journal');
      // oxlint-disable-next-line no-await-in-loop -- Observe the retained safety after disposal stops queued consensus work.
      const record = await journal.load();
      const preCrash = preCrashHeads.get(seat);
      if (
        !record ||
        record.height !== event.seq + 1 ||
        entryHash(record.entries.at(-1)?.entry ?? record.genesis) !== preCrash?.hash
      )
        throw new Error('Retained lifecycle journal differs from its pre-crash committed head');
      records.set(seat, record);
    }
    for (const [index, seat] of event.seats.entries()) {
      const identity = game.identities.get(seat);
      const journal = journals.get(seat);
      const record = records.get(seat);
      if (!identity || !journal || !record) throw new Error('Missing lifecycle restore record');
      const reopenedAt = network.clock.now();
      if (event.kind === 'everyone-left') {
        event.closedForMilliseconds ??= reopenedAt - allClosedAt;
        if (lastReopenedAt !== null) event.reopenGapsMilliseconds.push(reopenedAt - lastReopenedAt);
        lastReopenedAt = reopenedAt;
      }
      network.restart(identity.peerId);
      const evidence = restartEvidence(seat, record);
      event.restored.push(evidence);
      // oxlint-disable-next-line no-await-in-loop -- Fixed non-seat order is part of the everyone-left trace.
      await open(seat, true, observeRestoredJournal(journal, record, evidence), evidence);
      const head = sessions.get(seat)?.getCommittedHead();
      if (
        !evidence.loadedBeforeVoting ||
        evidence.orderingViolations !== 0 ||
        head?.seq !== event.seq ||
        head.hash !== evidence.headHash
      )
        throw new Error('Lifecycle restore changed its exact certified head');
      offline.delete(seat);
      if (event.kind === 'everyone-left' && index < event.seats.length - 1) {
        network.clock.advanceBy(250);
        // oxlint-disable-next-line no-await-in-loop -- Let the restored quorum process before the next seat rejoins.
        await flush();
      }
    }
  }

  function crash(seat: Seat): void {
    const identity = game.identities.get(seat);
    if (!identity) throw new Error('Missing crashed peer');
    if (submission?.seat === seat && submission.result === null)
      intentionallyInterruptedSubmissions.add(submission);
    sessions.get(seat)?.dispose();
    sessions.delete(seat);
    network.crash(identity.peerId);
    offline.add(seat);
  }

  /** After self-evidence halts the faulty session, this actor sends commands but never votes. */
  function byzantinePrivate(history: readonly CertifiedEntry[]) {
    if (!byzantinePrivateCache) {
      const driver = new SimulationDriver(game.engine, game.genesis, network.clock);
      const privateState = driver.privateState(0);
      if (!privateState) throw new Error('Stub actor has no initial private state');
      byzantinePrivateCache = {
        revision: 0,
        privateState,
        driver,
        context: unwrap(
          initialProposalContext(game.entry, game.engine, {
            genesis: { allowStub: true },
            entry: { allowStub: true },
          }),
        ),
      };
    }
    const cached = byzantinePrivateCache;
    const accepted = history[cached.revision - 1]?.entry ?? game.entry;
    if (
      history.length < cached.revision ||
      entryHash(accepted) !== entryHash(cached.context.log.head)
    )
      throw new Error('Stub actor prefix changed an accepted head');
    for (const certified of history.slice(cached.revision)) {
      const validated = unwrap(validateCertifiedEntry(certified, cached.context));
      const next = unwrap(advanceContext(cached.context, validated));
      if (validated.input)
        unwrap(cached.driver.committed(cached.context.log, validated.input, next.log.state));
      cached.context = next;
      cached.revision = next.log.head.seq;
    }
    const privateState = cached.driver.privateState(0);
    if (!privateState) throw new Error('Byzantine actor lost its own private hand');
    cached.privateState = privateState;
    return cached;
  }

  async function survivorsReadyForCrash(proposer: Seat, seq: number): Promise<boolean> {
    const voters = game.genesis.seats.filter((seat) => seat.kind === 'human');
    const ready = await Promise.all(
      voters
        .filter((voter) => voter.seat !== proposer)
        .map(async (voter) => {
          const session = sessions.get(voter.seat);
          const journal = journals.get(voter.seat);
          if (!session || !journal || session.getCommittedHead().seq !== seq - 1) return false;
          const record = await journal.loadSafety(seq);
          if (!record) return false;
          const state = canonicalDecode(record.bytes);
          if (typeof state !== 'object' || state === null) return false;
          const timers = Reflect.get(state, 'timers');
          if (
            Reflect.get(state, 'height') !== seq ||
            Reflect.get(state, 'round') !== 1 ||
            Reflect.get(state, 'inputKnown') !== true ||
            typeof timers !== 'object' ||
            timers === null ||
            Reflect.get(timers, 'propose') !== true
          )
            return false;
          return true;
        }),
    );
    return ready.filter(Boolean).length >= quorumSize(voters.length);
  }

  async function advanceFault(latest: SessionUpdate): Promise<void> {
    const now = network.clock.now();
    if (!faultInjected && options.scenario === 3 && crashRequested) {
      if (!(await survivorsReadyForCrash(crashRequested.seat, crashRequested.seq))) {
        crashRequested = null;
      } else {
        faultInjected = true;
        faultRevision = crashRequested.seq - 1;
        crashedProposalHeight = crashRequested.seq;
        crashedProposerSeat = crashRequested.seat;
        recoverAt = now + 20_000;
        const expected = proposerFor(
          crashRequested.seq,
          1,
          {
            genesisDigest: genesisDigest(game.genesis),
            epoch: 0,
            voters: game.genesis.seats.filter((seat) => seat.kind === 'human'),
          },
          [],
        );
        if (expected.seat !== crashRequested.seat)
          throw new Error('Crash hook did not observe the elected proposer');
        crash(crashRequested.seat);
      }
    }
    const requestedPartition = partitionRequested;
    const half = game.genesis.config.seats.length / 2;
    const bothHalvesSawProposal =
      [...partitionProposalSeen].some((seat) => seat < half) &&
      [...partitionProposalSeen].some((seat) => seat >= half);
    if (
      !faultInjected &&
      [4, 5].includes(options.scenario) &&
      requestedPartition &&
      (options.scenario === 5 || bothHalvesSawProposal)
    ) {
      faultInjected = true;
      faultRevision = requestedPartition.seq - 1;
      recoverAt = now + 30_000;
      const seats = game.genesis.config.seats;
      const isolated = seats.find(
        (seat) => seat !== requestedPartition.proposer && seat !== requestedPartition.commandSeat,
      );
      if (isolated === undefined) throw new Error('No non-actor peer to isolate');
      partitionIsolatedSeat = options.scenario === 5 ? isolated : null;
      const groups =
        options.scenario === 4
          ? [seats.slice(0, seats.length / 2), seats.slice(seats.length / 2)]
          : [seats.filter((seat) => seat !== isolated), [isolated]];
      network.partition(
        groups.map((group) =>
          group.map((seat) => {
            const identity = game.identities.get(seat);
            if (!identity) throw new Error('Partition seat has no identity');
            return identity.peerId;
          }),
        ),
      );
      partitionCheckAt = now + 2000;
    }
    if (
      !faultInjected &&
      options.scenario === 9 &&
      latest.state.turn.number >= 2 &&
      [...updates.values()].every((update) => update.revision === latest.revision)
    ) {
      faultInjected = true;
      faultRevision = latest.revision;
      recoverAt = now + 30_000;
      crash(0);
      crash(1);
    }
    if (faultInjected && !faultRecovered && options.scenario === 4 && now >= partitionCheckAt) {
      partitionStableRevisions ??= new Map(
        [...updates].map(([seat, update]) => [seat, update.revision]),
      );
      pausedPeersDuringPartition = 0;
      for (const [seat, update] of updates) {
        if (
          update.revision !== partitionStableRevisions.get(seat) ||
          update.revision > faultRevision + 1
        )
          throw new Error(`Peer ${seat} committed without a quorum during an even partition`);
        pausedPeersDuringPartition++;
      }
    }
    if (faultInjected && !faultRecovered && now >= recoverAt) {
      if (options.scenario === 3) {
        const targetHeight = crashedProposalHeight;
        const crashedSeat = crashedProposerSeat;
        if (targetHeight === null || crashedSeat === null)
          throw new Error('Missing crashed proposal identity');
        const certified = [...sessions.values()].map(
          (session) => session.exportSave().entries[targetHeight - 1],
        );
        if (
          certified.length !== game.genesis.config.seats.length - 1 ||
          certified.some(
            (item) =>
              !item ||
              item.entry.term <= 1 ||
              item.entry.sequencer === game.identities.get(crashedSeat)?.peerId,
          ) ||
          new Set(certified.map((item) => item && entryHash(item.entry))).size !== 1
        )
          throw new Error('Survivors did not certify a replacement before proposer restart');
        replacementTerm = certified[0]?.entry.term ?? null;
      }
      if (options.scenario === 5) {
        const majority = [...updates]
          .filter(([seat]) => seat !== partitionIsolatedSeat)
          .map(([, update]) => update.revision);
        const isolated = updates.get(partitionIsolatedSeat ?? 0)?.revision;
        if (majority.length !== game.genesis.config.seats.length - 1 || isolated === undefined)
          throw new Error('Missing majority/isolated partition observations');
        const leastMajority = Math.min(...majority);
        majorityCommitsDuringPartition = leastMajority - faultRevision;
        isolatedCommitsDuringPartition = isolated - faultRevision;
        if (majorityCommitsDuringPartition < 1 || isolated >= leastMajority)
          throw new Error('The majority quorum did not advance ahead of its isolated peer');
      }
      for (const seat of offline) {
        const identity = game.identities.get(seat);
        if (!identity) throw new Error('Missing restarting peer');
        network.restart(identity.peerId);
      }
      await Promise.all([...offline].map((seat) => open(seat, true)));
      offline.clear();
      network.heal();
      faultRecovered = true;
    }
  }

  try {
    await Promise.all(game.genesis.config.seats.map((seat) => open(seat, false)));
    checkDeadline();
    const maxSteps = options.maxSteps ?? 1_000_000;
    for (let step = 0; step < maxSteps; step++) {
      checkDeadline();
      if (verified && step % 256 === 0) {
        // Let worker messages settle without altering virtual packet/timer order.
        // oxlint-disable-next-line no-await-in-loop -- Real worker delivery must not starve behind virtual microtasks.
        await yieldEventLoop();
      }
      // oxlint-disable-next-line no-await-in-loop -- Virtual network delivery and peer queues alternate causally.
      await flush();
      checkDeadline();
      if (options.scenario === 6 && byzantineHalted && sessions.has(0)) {
        if (submission?.seat === 0 && submission.result === null)
          intentionallyInterruptedSubmissions.add(submission);
        sessions.get(0)?.dispose();
        sessions.delete(0);
        updates.delete(0);
      }
      if (failures.length) throw new Error(failures[0]);
      if (verified)
        for (const [seat, session] of sessions) {
          const audit = session.getAudit();
          if (audit.kind === 'error')
            throw new Error(`Peer ${seat} terminal audit failed: ${audit.code}`);
        }
      const latest = [...updates.values()].toSorted((a, b) => b.revision - a.revision)[0];
      if (!latest) throw new Error('No peer state available');
      const lifecycleHead = lifecycle ? sessions.values().next().value?.getCommittedHead() : null;
      if (
        lifecycle &&
        sessions.size === 4 &&
        [...sessions.values()].every(
          (session) =>
            session.getCommittedHead().seq === latest.revision &&
            session.getCommittedHead().hash === lifecycleHead?.hash,
        )
      ) {
        if (latest.revision !== lifecycleObservedRevision) {
          lifecycleObservedRevision = latest.revision;
          if (lifecycle.restarts.some((event) => event.continuedAtSeq === null)) {
            const history = sessions.values().next().value?.exportSave().entries;
            if (!history) throw new Error('Lifecycle certified history is missing');
            lifecycle.observe(
              history.map(({ entry }): LifecycleHistoryEntry => ({
                seq: entry.seq,
                kind: entry.payload.kind,
                hash: entryHash(entry),
              })),
            );
          }
        }
        if ((!submission || submission.result?.ok) && !latest.state.result) {
          const restart = lifecycle.next(latest.revision, latest.state.turn.number);
          if (restart) {
            submission = null;
            // oxlint-disable-next-line no-await-in-loop -- Dispose and restore whole sessions before the next virtual delivery.
            await restartLifecycle(restart);
            continue;
          }
        }
      }
      // oxlint-disable-next-line no-await-in-loop -- Crash recovery must restore durable journals before the next delivery.
      await advanceFault(latest);
      if (verified && options.scenario === 6 && byzantineHalted && faultRecovered) {
        const honest = [...sessions].find(
          ([seat]) => updates.get(seat)?.revision === latest.revision,
        )?.[1];
        const identity = game.identities.get(0);
        if (!honest || !identity)
          throw new Error('Excluded actor lacks an honest certified prefix');
        verifiedNonVoter ??= unwrap(
          createVerifiedNonVoterActor({
            seat: 0,
            identity,
            sessionOptions: verified.sessionOptions(0),
            transport: nonVoterTransport(identity.peerId),
            clock: network.clock,
          }),
        );
        if (nonVoterWake === null) wakeNonVoter();
        const actorHead = verifiedNonVoter.head();
        const honestHead = honest.getCommittedHead();
        // New prefixes authorize new artifacts; same-parent retries follow virtual time.
        const sameHead = actorHead.seq === honestHead.seq && actorHead.hash === honestHead.hash;
        if (!sameHead || network.clock.now() >= nonVoterContributionRetryAt) {
          nonVoterContributionRetryAt = network.clock.now() + 250;
          const operationStarted = performance.now();
          try {
            unwrap(
              // oxlint-disable-next-line no-await-in-loop -- Each certified prefix authorizes the next private contribution.
              await (sameHead
                ? verifiedNonVoter.publishContributions()
                : verifiedNonVoter.advance(
                    measure('actorExport', () => honest.exportSave().entries),
                  )),
            );
          } finally {
            recordOperation(sameHead ? 'actorContribution' : 'actorAdvance', operationStarted);
          }
        }
        // A peer may finish queued async work during private proof preparation.
        if ([...updates.values()].some((update) => update.revision > latest.revision)) continue;
        if (nonVoterCommand && submission?.seat === 0) {
          nonVoterCommand.pump(network.clock.now(), honest.getCommittedHead());
          const result = nonVoterCommand.result();
          if (result?.ok) {
            byzantineSubmissionRevision = result.value.body.headSeq;
            byzantineSubmissionHash = toHex(hashValue(result.value));
          } else if (result) submission.result = result;
        }
      }
      const allTerminal = [...updates.values()].every(
        (update) => update.state.result && update.revision === latest.revision,
      );
      if (
        verified &&
        allTerminal &&
        [...sessions.values()].some((session) => session.getAudit().kind === 'verifying') &&
        [...sessions.values()].every((session) =>
          ['verifying', 'complete'].includes(session.getAudit().kind),
        )
      ) {
        // All peers have their reveals. Await real worker completion instead of
        // racing through virtual heartbeat timers while CPU audits are running.
        // oxlint-disable-next-line no-await-in-loop -- Terminal worker jobs finish before result validation.
        await waitForTerminalAudits();
        continue;
      }
      if (
        allTerminal &&
        (!verified ||
          [...sessions.values()].every((session) => session.getAudit().kind === 'complete'))
      ) {
        if (options.scenario > 2 && (!faultInjected || !faultRecovered))
          throw new Error('Game completed without exercising fault recovery');
        if (options.scenario === 3) {
          const committed = sessions.values().next().value?.exportSave().entries[
            (crashedProposalHeight ?? 0) - 1
          ];
          if (
            !committed ||
            committed.entry.term <= 1 ||
            committed.entry.sequencer === game.identities.get(crashedProposerSeat ?? 0)?.peerId
          )
            throw new Error('Crashed proposer was not replaced in a later round');
          replacementTerm = committed.entry.term;
        }
        if (
          options.scenario === 4 &&
          pausedPeersDuringPartition !== game.genesis.config.seats.length
        )
          throw new Error('The even partition was not observed long enough to prove a pause');
        if (options.scenario === 6) {
          if (maliciousHeight === null || !maliciousEntryHash || !maliciousCommandHash)
            throw new Error('No signed invalid proposal was recorded');
          const honest = game.genesis.config.seats.length - 1;
          if (!byzantineHalted || sessions.size !== honest)
            throw new Error('The Byzantine signer did not halt while the honest peers completed');
          certifiedExclusionPeers = 0;
          for (const [seat, session] of sessions) {
            const history = session.exportSave().entries;
            const control = history[maliciousHeight - 1];
            if (
              control?.entry.payload.kind !== 'control' ||
              control.entry.payload.action !== 'exclude-proposer' ||
              control.entry.payload.offender !== 0 ||
              control.entry.payload.evidence.kind !== 'invalid-command' ||
              entryHash(control.entry.payload.evidence.proposal.body.entry) !== maliciousEntryHash
            )
              throw new Error(`Peer ${seat} lacks the certified offender-0 exclusion`);
            certifiedExclusionPeers++;
            if (
              history.some(
                ({ entry }) =>
                  entryHash(entry) === maliciousEntryHash ||
                  (entry.payload.kind === 'command' &&
                    toHex(hashValue(entry.payload.signed)) === maliciousCommandHash),
              )
            )
              throw new Error(`Peer ${seat} committed the rejected command`);
            for (const certified of history.slice(maliciousHeight - 1)) {
              const voters = new Set(certified.certificate.map((vote) => vote.body.seat));
              if (
                voters.size < quorumSize(game.genesis.config.seats.length) ||
                voters.has(0) ||
                certified.certificate.some((vote) => vote.body.epoch !== 0) ||
                certified.entry.payload.kind === 'membership'
              )
                throw new Error(`Peer ${seat} changed the original voter quorum`);
            }
            if (
              history
                .slice(maliciousHeight)
                .some(({ entry }) => entry.sequencer === game.identities.get(0)?.peerId)
            )
              throw new Error(`Excluded proposer authored a later entry at peer ${seat}`);
          }
          if (certifiedExclusionPeers !== honest)
            throw new Error('The honest peers did not converge after exclusion');
          if (byzantineCommandCommits < 1)
            throw new Error('The faulty actor supplied no later certified player command');
          if (
            verified &&
            (!nonVoterPublishedMaster ||
              !nonVoterMessageTypes.has('SUBMIT') ||
              ['PROPOSAL', 'VOTE', 'COMMIT'].some((type) => nonVoterMessageTypes.has(type)))
          )
            throw new Error('Non-voter traffic did not prove command and owned-master publication');
        }
        if (options.scenario === 2 && network.diagnostics().duplicateDeliveries === 0)
          throw new Error('The latency scenario completed without delivering a duplicate packet');
        const repairParentSeq = corruptedHeight === null ? null : corruptedHeight - 1;
        const matchingRepairSnapshot =
          repairParentSeq !== null &&
          [...snapshotResponsePairs].some((pair) => pair.endsWith(`:${repairParentSeq}`));
        if (
          options.scenario === 8 &&
          (!desyncObserved ||
            derivedContextDiagnostic !== 'consensus-context' ||
            repairParentSeq === null ||
            !snapshotRequestAtSeqs.has(repairParentSeq) ||
            !matchingRepairSnapshot ||
            !snapshotRepairAdopted ||
            repairSnapshotParentSeq !== repairParentSeq ||
            repairSnapshotHash === null ||
            !faultRecovered ||
            continuationCommandHash === null)
        )
          throw new Error(
            'Derived-context repair did not adopt the parent snapshot and certify a later command',
          );
        const hashes = new Set(
          [...updates.values()].map((update) => toHex(hashValue(update.state))),
        );
        if (hashes.size !== 1) throw new Error('Final public state diverged');
        const histories = [...sessions.values()].map((session) =>
          session.exportSave().entries.map(({ entry }) => entryHash(entry)),
        );
        const first = histories[0];
        if (
          !first ||
          histories.some(
            (history) =>
              history.length !== first.length ||
              history.some((hash, index) => hash !== first[index]),
          )
        )
          throw new Error('Committed log values diverged');
        const finalLogHash = first.at(-1);
        if (!finalLogHash) throw new Error('Completed game has no certified history');
        const audits: NetworkGameResult['audits'] = [];
        if (verified) {
          for (const [seat, session] of sessions) {
            const audit = session.getAudit();
            if (
              audit.kind !== 'complete' ||
              !audit.report.ok ||
              !audit.report.complete ||
              audit.report.finalHead?.hash !== finalLogHash ||
              audit.report.finalHead.seq !== latest.revision
            )
              throw new Error(`Verified peer ${seat} did not pass its terminal audit`);
            // Scenario 6's bad-signature proposal is certified as control evidence.
            // It excuses no bad private proof from the otherwise honest player endpoint.
            if (audit.report.cheatFindings.length !== 0)
              throw new Error(`Verified peer ${seat} reported unexpected private-proof misconduct`);
            audits.push({
              seat,
              ok: true,
              complete: true,
              finalHead: audit.report.finalHead,
              cheatFindings: audit.report.cheatFindings,
            });
          }
        }
        let lifecycleEvidence: NetworkGameResult['lifecycle'];
        if (lifecycle && verified) {
          lifecycle.finish(latest.revision);
          const privateStates = verified.privateStateEvidence();
          const expectedRepeatedSnapshots = lifecycle.restarts.reduce(
            (total, event) => total + event.seats.length * (event.seq + 1),
            0,
          );
          if (
            privateStates.checkedSequences !== latest.revision + 1 ||
            privateStates.capturedSnapshots !== (latest.revision + 1) * 4 ||
            privateStates.repeatedSnapshots !== expectedRepeatedSnapshots
          )
            throw new Error(
              'Lifecycle private-state comparison did not cover every owned certified state',
            );
          const inputCounts: Record<string, number> = {};
          const history = sessions.values().next().value?.exportSave().entries;
          if (!history) throw new Error('Missing lifecycle terminal history');
          for (const { entry, certificate } of history) {
            if (
              entry.payload.kind === 'control' ||
              entry.payload.kind === 'membership' ||
              certificate.some((vote) => vote.body.epoch !== 0)
            )
              throw new Error('Honest persistence game changed authority or accused a player');
            let type: string | null = null;
            if (entry.payload.kind === 'command') type = entry.payload.signed.body.command.type;
            else if (entry.payload.kind === 'system') type = entry.payload.input.type;
            if (type) inputCounts[type] = (inputCounts[type] ?? 0) + 1;
          }
          lifecycleEvidence = {
            profile: 'persistence',
            restarts: lifecycle.restarts,
            inputCounts,
            privateStates,
          };
        }
        checkDeadline();
        return {
          ...(lifecycleEvidence ? { lifecycle: lifecycleEvidence } : {}),
          security: game.genesis.security,
          protocolVersion: game.genesis.protocolVersion,
          seed: options.seed,
          gameIndex: options.gameIndex,
          scenario: options.scenario,
          turns: latest.state.turn.number,
          inputs: latest.revision,
          virtualMilliseconds: network.clock.now(),
          elapsedMilliseconds: performance.now() - started,
          operationTimings,
          finalStateHash: toHex(hashValue(latest.state)),
          finalLogHash,
          audits,
          ...(verified ? { auditTimings: verified.auditTimingEvidence() } : {}),
          faultInjected,
          faultRecovered,
          faultEvidence: {
            injectedAtRevision: faultRevision,
            majorityCommitsDuringPartition,
            isolatedCommitsDuringPartition,
            pausedPeersDuringPartition,
            replacementTerm,
            censoredCommandCommitted,
            snapshotRequests: snapshotRequestAtSeqs.size,
            snapshotResponses: snapshotResponsePairs.size,
            derivedContextDiagnostic,
            snapshotRepairAdopted,
            repairSnapshotParentSeq,
            repairSnapshotHash,
            continuationCommandHash,
            duplicateDeliveries: network.diagnostics().duplicateDeliveries,
            certifiedExclusionPeers,
            byzantineCommandCommits,
            rejectedProposalHash: maliciousEntryHash,
            nonVoterMessageTypes: [...nonVoterMessageTypes].toSorted(),
            nonVoterPublishedMaster,
          },
        };
      }
      if (submission?.result) {
        const disposedByIntentionalCrash =
          intentionallyInterruptedSubmissions.has(submission) &&
          !submission.result.ok &&
          ['replica-outcome-unknown', 'replica-disposed'].includes(submission.result.error.code);
        const staleActorPreparation =
          verifiedNonVoter !== null &&
          submission.seat === 0 &&
          !submission.result.ok &&
          ['non-voter-stale-head', 'non-voter-trade-stale'].includes(submission.result.error.code);
        if (
          !submission.result.ok &&
          !['renewed-intent', 'command-pending'].includes(submission.result.error.code) &&
          !disposedByIntentionalCrash &&
          !staleActorPreparation
        )
          throw new Error(`Submission rejected: ${submission.result.error.code}`);
        submission = null;
        nonVoterCommand?.cancel();
        nonVoterCommand = null;
      }
      if (byzantineSubmissionRevision !== null && latest.revision > byzantineSubmissionRevision) {
        const history = [...sessions]
          .find(([seat]) => updates.get(seat)?.revision === latest.revision)?.[1]
          .exportSave().entries;
        if (
          history
            ?.slice(byzantineSubmissionRevision)
            .some(
              ({ entry }) =>
                entry.payload.kind === 'command' &&
                toHex(hashValue(entry.payload.signed)) === byzantineSubmissionHash,
            )
        )
          byzantineCommandCommits++;
        submission = null;
        nonVoterCommand?.cancel();
        nonVoterCommand = null;
        byzantineSubmissionRevision = null;
        byzantineSubmissionHash = null;
      }
      if (!submission && !latest.state.result) {
        const pendingActions = game.engine.getPending(latest.state);
        let nonVoterAutomatic: CommandShape | null = null;
        if (
          options.scenario === 6 &&
          byzantineHalted &&
          faultRecovered &&
          pendingActions.some(
            (item) =>
              item.kind === 'player' && item.seat === 0 && item.allowed.includes('CLAIM_VICTORY'),
          )
        ) {
          const honest = [...sessions].find(
            ([seat]) => updates.get(seat)?.revision === latest.revision,
          )?.[1];
          if (!honest) throw new Error('Missing honest prefix for non-voter automatic input');
          const priv = verifiedNonVoter
            ? verifiedNonVoter.privateState()
            : byzantinePrivate(honest.exportSave().entries).privateState;
          if (!priv) throw new Error('Non-voter has no owned private state for automatic input');
          const automatic = game.engine.getAutomaticInput(
            latest.state,
            new Map([[0 as Seat, priv]]),
          );
          if (automatic?.kind === 'command' && automatic.seat === 0)
            nonVoterAutomatic = automatic.command;
        }
        const pending = choosePending(latest.state, pendingActions, nonVoterAutomatic ? 0 : null);
        const session = pending ? sessions.get(pending.seat) : undefined;
        const owned = pending ? updates.get(pending.seat) : undefined;
        if (options.scenario === 6 && byzantineHalted && faultRecovered && pending?.seat === 0) {
          const honest = [...sessions].find(
            ([seat]) => updates.get(seat)?.revision === latest.revision,
          )?.[1];
          const identity = game.identities.get(0);
          const actor = bots.get(0);
          if (!honest || !identity || !actor)
            throw new Error('Byzantine command actor lacks certified history or identity');
          const history = honest.exportSave().entries;
          const rebuilt = verified ? null : byzantinePrivate(history);
          const privateState = verifiedNonVoter?.privateState() ?? rebuilt?.privateState;
          const actorHead =
            verifiedNonVoter?.head() ??
            (rebuilt && {
              seq: rebuilt.context.log.head.seq,
              hash: entryHash(rebuilt.context.log.head),
            });
          if (
            !privateState ||
            actorHead?.seq !== latest.revision ||
            actorHead.hash !== honest.getCommittedHead().hash
          )
            throw new Error(
              'Byzantine command actor lacks its private state at the certified head',
            );
          const chosen =
            nonVoterAutomatic ??
            measure('actorDecide', () =>
              actor.bot.decide(
                { state: latest.state, seat: 0, priv: privateState },
                pending,
                actor.rng,
              ),
            );
          if (verifiedNonVoter) {
            submission = { seat: 0, result: null };
            nonVoterCommand = new NonVoterCommand(verifiedNonVoter, chosen, actorHead);
            nonVoterCommand.pump(network.clock.now(), actorHead);
          } else {
            if (!rebuilt) throw new Error('Stub actor has no reconstructed state');
            const { log } = rebuilt.context;
            const signed = signCommand(
              {
                gameId: log.genesis.gameId,
                genesisDigest: rebuilt.context.membership.genesisDigest,
                seat: 0,
                nonce: (log.lastNonces.get(0) ?? 0) + 1,
                headSeq: log.head.seq,
                headHash: entryHash(log.head),
                command: chosen,
              },
              identity.secretKey,
            );
            network
              .transport(identity.peerId)
              .broadcast(unwrap(encodeProtocolMessage({ t: 'SUBMIT', cmd: signed })));
            submission = { seat: 0, result: null };
            byzantineSubmissionRevision = latest.revision;
            byzantineSubmissionHash = toHex(hashValue(signed));
          }
        }
        if (pending && session && owned?.revision === latest.revision) {
          const actor = bots.get(pending.seat);
          const privateState = session.getPrivate(pending.seat);
          if (!actor || !privateState) throw new Error('Simulation actor is missing its own hand');
          const chosen = measure('botDecide', () =>
            actor.bot.decide(
              { state: latest.state, seat: pending.seat, priv: privateState },
              pending,
              actor.rng,
            ),
          );
          const waiting = { seat: pending.seat, result: null as Result<void> | null };
          submission = waiting;
          void session
            .submit(pending.seat, chosen, { expectedRevision: latest.revision })
            .then((result) => {
              waiting.result = result;
              return undefined;
            });
          // oxlint-disable-next-line no-await-in-loop -- Submission must enter the queue before virtual time advances.
          await flush();
        }
      }
      if (!measure('networkDelivery', () => network.clock.runNext()))
        throw new Error('Live peer game has no queued network/timer work');
      if (network.clock.now() > 7_200_000)
        throw new Error(`Peer game exceeded two virtual hours: ${progressDiagnostic()}`);
    }
    throw new Error(`Peer game exceeded ${maxSteps} network steps: ${progressDiagnostic()}`);
  } finally {
    if (nonVoterWake !== null) network.clock.clearTimeout(nonVoterWake);
    nonVoterCommand?.cancel();
    verifiedNonVoter?.dispose();
    for (const session of sessions.values()) session.dispose();
    network.dispose();
    verified?.dispose();
  }
}

function choosePending(state: GameState, pending: readonly Pending[], nonVoterSeat: Seat | null) {
  const players = pending.filter(
    (item): item is Extract<Pending, { kind: 'player' }> =>
      item.kind === 'player' &&
      (item.seat === nonVoterSeat || item.allowed.some((type) => type !== 'CLAIM_VICTORY')),
  );
  return (
    players.find((item) => item.allowed.includes('DISCARD')) ??
    players.find(
      (item) => item.seat !== state.turn.activeSeat && item.allowed.includes('RESPOND_TRADE'),
    ) ??
    players.find((item) => item.seat === state.turn.activeSeat) ??
    (players.length === 1 ? players[0] : undefined)
  );
}

/** Deliberate in-memory fault injection. Durable certificates and voting records stay intact. */
function corruptDerivedBank(session: P2PSession): void {
  let current: unknown = session;
  for (const property of ['replica', 'context', 'log', 'state', 'bank']) {
    if (typeof current !== 'object' || current === null)
      throw new Error(`Cannot inject derived-state corruption at ${property}`);
    current = Reflect.get(current, property);
  }
  if (typeof current !== 'object' || current === null)
    throw new Error('Missing derived bank cache');
  const brick: unknown = Reflect.get(current, 'brick');
  if (typeof brick !== 'number' || !Reflect.set(current, 'brick', brick + 1))
    throw new Error('Could not corrupt the derived bank cache');
}
