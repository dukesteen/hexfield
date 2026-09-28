# Read-only persistence lifecycle review

Review the supplied source only. Do not edit files, run games, execute code, or infer that pending acceptance passed. The new profile has not yet completed a full game. Focused helper and fixture tests are separate implementation checks.

The bounded Stage 10 profile adds periodic whole-session restarts and everyone-left/reopen to the existing verified scenario-1 runner. It keeps the default ten-point, four-human game and retained seat-scoped journals/stores. The existing nine Stage 07 scenarios keep their meaning when lifecycle is absent.

Please identify concrete defects, evidence gaps and likely runtime failures, with precise source references. Check especially:

1. Does each reached approximately 50-entry boundary rotate a peer without skipping a required boundary? Does every restart prove a subsequent actual common certified command, including everyone-left resumed in fixed non-seat order?
2. Are exact committed head, prefix, safety revision and safety bytes captured after disposal and checked before restored votes/persistence? Does the observer prove actual ordering, or merely name a boolean? Is common-head equality sufficient?
3. Does the fixture capture actual live owned private state at genesis and every certified sequence, including restore replay? Does terminal reconstruction compare every seat and sequence? Does the existing independent LocalGame audit establish exact transitive equality, rather than final score or public state agreement?
4. Are master buffers used only from protocol-delivered terminal audit input? Are foreign private reads during play avoided? Are result artifacts limited to public hashes and counts?
5. Can pending submissions, in-flight journal writes, disposed transports, duplicate messages or automatic inputs cause false errors or silent gaps? Is replay overhead bounded enough for a representative full game?
6. Are the focused tests meaningful, and which claims still need the full live profile and other focused private-state branches?

Head at bundle creation: 3b8a04ec8b390746a52d08a8d8c2e989cb0b6993. Sources include uncommitted lifecycle changes. The adjacent SHA-256 manifest fingerprints the full files. P2PSession and ReplicatedLog excerpts below supply relevant restore/commit ordering; their full-file hashes are in the manifest.

## docs/verification/p2p-acceptance-policy.md

```md
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

## tools/sim/src/net.ts

```ts
import { RandomBot, createBotRng } from '@cp2p/bots';
import { canonicalDecode, hashValue, toHex } from '@cp2p/codec';
import type { CommandShape, GameState, Pending, PrivateState, Result, Seat } from '@cp2p/engine';
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
  P2PSessionOptions,
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
import type { VerifiedNonVoterActor } from '@cp2p/protocol/testing';
import { deriveSeed } from './random-source.js';
import { invalidCommandProposal } from './net-adversary.js';
import { NonVoterCommand } from './non-voter-command.js';
import {
  PersistenceLifecycle,
  observeRestoredJournal,
  restartEvidence,
} from './persistence-lifecycle.js';
import type { LifecycleRestart } from './persistence-lifecycle.js';
import { observeOutgoingTransport } from './observed-transport.js';

export interface NetworkGameOptions {
  seed: number;
  gameIndex: number;
  scenario: number;
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
  finalStateHash: string;
  finalLogHash: string;
  audits: {
    seat: Seat;
    ok: true;
    complete: true;
    finalHead: { seq: number; hash: string };
    cheatFindings: AuditReport['cheatFindings'];
  }[];
  lifecycle?: {
    profile: 'persistence';
    restarts: readonly LifecycleRestart[];
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

/** Full games through the real peer sessions, signatures, wire encoding and journals. */
export async function runNetworkGame(options: NetworkGameOptions): Promise<NetworkGameResult> {
  if (!Number.isInteger(options.scenario) || options.scenario < 1 || options.scenario > 9)
    throw new Error('This network scenario is not implemented yet');
  if (options.lifecycle && (options.security !== 'verified' || options.scenario !== 1))
    throw new Error('Persistence lifecycle requires clean scenario 1 with verified security');
  const lifecycle = options.lifecycle ? new PersistenceLifecycle() : null;
  let lifecycleObservedRevision = -1;
  const started = performance.now();
  const verified =
    options.security === 'verified'
      ? createVerifiedNetworkFixture({
          seed: options.seed,
          gameIndex: options.gameIndex,
          verifyLivePrivateStates: lifecycle !== null,
        })
      : null;
  const game =
    verified ?? createSimulationGenesis({ seed: options.seed, gameIndex: options.gameIndex });
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

  function observe(seat: Seat, update: SessionUpdate): void {
    const prior = updates.get(seat);
    if (prior && update.revision < prior.revision)
      failures.push(`Peer ${seat} rolled back a commit`);
    if (update.status.kind === 'error') {
      if (options.scenario === 8 && seat === 0 && faultInjected && !faultRecovered)
        desyncObserved = true;
      else if (
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
      update.revision >= corruptedHeight &&
      update.status.kind === 'running'
    )
      faultRecovered = true;
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
    await Promise.all([...sessions.values()].map((session) => session.flush()));
  }

  function progressDiagnostic(): string {
    return JSON.stringify({
      submission,
      peers: [...sessions].map(([seat, session]) => ({
        seat,
        revision: updates.get(seat)?.revision,
        turn: updates.get(seat)?.state.turn,
        result: updates.get(seat)?.state.result,
        pending: session.getPending(),
        protocol: session.getProtocolStatus(),
        audit: session.getAudit().kind,
        automaticParent: Reflect.get(session, 'automaticParent'),
      })),
    });
  }

  function peerTransport(seat: Seat): Transport {
    const identity = game.identities.get(seat);
    if (!identity) throw new Error('Missing transport identity');
    const transport = network.transport(identity.peerId);
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
            const current = updates.get(seat);
            if (
              corruptedHeight === null &&
              current &&
              current.revision >= 20 &&
              current.revision % keys.length !== 0
            )
              corruptedHeight = current.revision + 1;
            const decoded = unwrap(decodeProtocolMessage(bytes));
            if (
              decoded.t === 'SNAPSHOT_RES' &&
              from !== game.identities.get(0)?.peerId &&
              desyncObserved &&
              snapshotRequestAtSeqs.has(decoded.atSeq)
            )
              snapshotResponsePairs.add(`${from}:${decoded.atSeq}`);
            // Keep this peer's target-height voting record empty while the other three certify.
            if (
              (decoded.t === 'PROPOSAL' && decoded.proposal.body.entry.seq === corruptedHeight) ||
              (decoded.t === 'VOTE' && decoded.vote.body.seq === corruptedHeight)
            )
              return;
            if (
              !faultInjected &&
              decoded.t === 'COMMIT' &&
              decoded.certified.entry.seq === corruptedHeight
            ) {
              const session = sessions.get(seat);
              if (!session) throw new Error('Missing peer for cache corruption');
              corruptDerivedBank(session);
              faultInjected = true;
              faultRevision = decoded.certified.entry.seq - 1;
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
    return observeOutgoingTransport(network.transport(peerId), observeNonVoterMessage);
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
          if (parsed.ok && (parsed.value.t === 'PROPOSAL' || parsed.value.t === 'VOTE')) {
            if (!restoreEvidence.loadedBeforeVoting) {
              restoreEvidence.orderingViolations += 1;
              throw new Error('Restored session voted before validating its retained journal');
            }
            restoreEvidence.votingMessagesAfterLoad += 1;
          }
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
    for (const seat of event.seats) {
      const identity = game.identities.get(seat);
      const journal = journals.get(seat);
      const record = records.get(seat);
      if (!identity || !journal || !record) throw new Error('Missing lifecycle restore record');
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
    const bothHalvesSawProposal =
      [...partitionProposalSeen].some((seat) => seat < 2) &&
      [...partitionProposalSeen].some((seat) => seat >= 2);
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
          ? [seats.slice(0, 2), seats.slice(2)]
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
          throw new Error(`Peer ${seat} committed without a quorum during 2|2 partition`);
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
          certified.length !== 3 ||
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
        if (majority.length !== 3 || isolated === undefined)
          throw new Error('Missing 3|1 partition observations');
        const leastMajority = Math.min(...majority);
        majorityCommitsDuringPartition = leastMajority - faultRevision;
        isolatedCommitsDuringPartition = isolated - faultRevision;
        if (majorityCommitsDuringPartition < 1 || isolated >= leastMajority)
          throw new Error('The 3-peer quorum did not advance ahead of its isolated peer');
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
    const maxSteps = options.maxSteps ?? 1_000_000;
    for (let step = 0; step < maxSteps; step++) {
      if (options.maxElapsedMs !== undefined && performance.now() - started > options.maxElapsedMs)
        throw new Error(`Peer game exceeded ${options.maxElapsedMs} ms: ${progressDiagnostic()}`);
      // oxlint-disable-next-line no-await-in-loop -- Virtual network delivery and peer queues alternate causally.
      await flush();
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
            lifecycle.observe(history);
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
          unwrap(
            // oxlint-disable-next-line no-await-in-loop -- Each certified prefix authorizes the next private contribution.
            await (sameHead
              ? verifiedNonVoter.publishContributions()
              : verifiedNonVoter.advance(honest.exportSave().entries)),
          );
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
      if (
        [...updates.values()].every(
          (update) => update.state.result && update.revision === latest.revision,
        ) &&
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
        if (options.scenario === 4 && pausedPeersDuringPartition !== 4)
          throw new Error('The 2|2 partition was not observed long enough to prove a pause');
        if (options.scenario === 6) {
          if (maliciousHeight === null || !maliciousEntryHash || !maliciousCommandHash)
            throw new Error('No signed invalid proposal was recorded');
          if (!byzantineHalted || sessions.size !== 3)
            throw new Error('The Byzantine signer did not halt while three honest peers completed');
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
                voters.size !== 3 ||
                !([1, 2, 3] as const).every((voter) => voters.has(voter)) ||
                certified.certificate.some((vote) => vote.body.epoch !== 0) ||
                certified.entry.payload.kind === 'membership'
              )
                throw new Error(`Peer ${seat} changed the original three-of-four quorum`);
            }
            if (
              history
                .slice(maliciousHeight)
                .some(({ entry }) => entry.sequencer === game.identities.get(0)?.peerId)
            )
              throw new Error(`Excluded proposer authored a later entry at peer ${seat}`);
          }
          if (certifiedExclusionPeers !== 3)
            throw new Error('The three honest peers did not converge after exclusion');
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
        if (
          options.scenario === 8 &&
          (!desyncObserved || !snapshotRequestAtSeqs.size || !snapshotResponsePairs.size)
        )
          throw new Error(
            'Desync did not trigger a matching snapshot request and response after corruption',
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
          if (
            privateStates.checkedSequences !== latest.revision + 1 ||
            privateStates.capturedSnapshots !== (latest.revision + 1) * 4 ||
            privateStates.repeatedSnapshots === 0
          )
            throw new Error(
              'Lifecycle private-state comparison did not cover every owned certified state',
            );
          lifecycleEvidence = {
            profile: 'persistence',
            restarts: lifecycle.restarts,
            privateStates,
          };
        }
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
          finalStateHash: toHex(hashValue(latest.state)),
          finalLogHash,
          audits,
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
            actor.bot.decide(
              { state: latest.state, seat: 0, priv: privateState },
              pending,
              actor.rng,
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
          const chosen = actor.bot.decide(
            { state: latest.state, seat: pending.seat, priv: privateState },
            pending,
            actor.rng,
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
      if (!network.clock.runNext())
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
    players.find((item) => item.seat === state.turn.activeSeat)
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

```

## tools/sim/src/persistence-lifecycle.ts

```ts
import { hashValue, toHex } from '@cp2p/codec';
import type { Seat } from '@cp2p/engine';
import { entryHash } from '@cp2p/protocol';
import type { JournalRecord, ProtocolJournal } from '@cp2p/protocol';

export interface LifecycleRestart {
  readonly boundary: number;
  readonly kind: 'periodic' | 'everyone-left';
  readonly seats: readonly Seat[];
  readonly seq: number;
  continuedAtSeq: number | null;
  readonly restored: {
    seat: Seat;
    headHash: string;
    safetyRevision: number;
    safetyHash: string;
    loadedBeforeVoting: boolean;
    votingMessagesAfterLoad: number;
    orderingViolations: number;
  }[];
}

/** Test-only schedule. Each restart must demonstrate a subsequent certified command. */
export class PersistenceLifecycle {
  readonly restarts: LifecycleRestart[] = [];
  private nextBoundary = 50;
  private rotatedPeers = 0;
  private everyoneLeft = false;

  next(seq: number, turn: number): LifecycleRestart | null {
    if (this.restarts.some((event) => event.continuedAtSeq === null)) return null;
    const everyone =
      !this.everyoneLeft &&
      this.rotatedPeers >= 3 &&
      seq >= 150 &&
      turn >= 10 &&
      seq < this.nextBoundary;
    if (seq < this.nextBoundary && !everyone) return null;
    if (seq >= this.nextBoundary + 50)
      throw new Error('Persistence profile skipped a reached restart boundary');
    const rotatingSeat = ([0, 1, 2, 3] as const)[this.rotatedPeers % 4];
    if (rotatingSeat === undefined) throw new Error('Missing rotating peer');
    const seats: readonly Seat[] = everyone ? [2, 0, 3, 1] : [rotatingSeat];
    const event: LifecycleRestart = {
      boundary: everyone ? seq : this.nextBoundary,
      kind: everyone ? 'everyone-left' : 'periodic',
      seats,
      seq,
      continuedAtSeq: null,
      restored: [],
    };
    if (everyone) this.everyoneLeft = true;
    else {
      this.rotatedPeers += 1;
      this.nextBoundary += 50;
    }
    this.restarts.push(event);
    return event;
  }

  observe(entries: readonly { entry: { seq: number; payload: { kind: string } } }[]): void {
    for (const event of this.restarts) {
      if (event.continuedAtSeq !== null) continue;
      const command = entries.find(
        ({ entry }) => entry.seq > event.seq && entry.payload.kind === 'command',
      );
      if (command) event.continuedAtSeq = command.entry.seq;
    }
  }

  finish(finalSeq?: number): void {
    if (finalSeq !== undefined && finalSeq >= this.nextBoundary)
      throw new Error('Lifecycle finished past an untested restart boundary');
    if (!this.everyoneLeft || this.rotatedPeers < 4)
      throw new Error('Lifecycle game did not exercise everyone-left and every rotating peer');
    if (
      this.restarts.some(
        (event) =>
          event.continuedAtSeq === null ||
          event.restored.length !== event.seats.length ||
          event.restored.some(
            (restored) =>
              !restored.loadedBeforeVoting ||
              restored.orderingViolations !== 0 ||
              restored.votingMessagesAfterLoad === 0,
          ),
      )
    )
      throw new Error(
        'Lifecycle restart lacks exact restoration or certified command continuation',
      );
  }
}

/** Observe the first durable load, before restored consensus can persist or transmit votes. */
export function observeRestoredJournal(
  journal: ProtocolJournal,
  expected: JournalRecord,
  evidence: LifecycleRestart['restored'][number],
): ProtocolJournal {
  let loaded = false;
  const requireLoaded = () => {
    if (!loaded) {
      evidence.orderingViolations += 1;
      throw new Error('Restore persisted before validating its retained record');
    }
  };
  return {
    async load() {
      const record = await journal.load();
      if (!loaded) {
        if (!record || toHex(hashValue(record)) !== toHex(hashValue(expected)))
          throw new Error('Restored durable prefix or safety differs before voting');
        loaded = true;
        evidence.loadedBeforeVoting = true;
      }
      return record;
    },
    initialize: (genesis, safety) => {
      requireLoaded();
      return journal.initialize(genesis, safety);
    },
    loadSafety: (height) => {
      requireLoaded();
      return journal.loadSafety(height);
    },
    saveSafety: (height, revision, bytes) => {
      requireLoaded();
      return journal.saveSafety(height, revision, bytes);
    },
    commit: (height, revision, certified, safety) => {
      requireLoaded();
      return journal.commit(height, revision, certified, safety);
    },
  };
}

export function restartEvidence(
  seat: Seat,
  record: JournalRecord,
): LifecycleRestart['restored'][number] {
  const head = record.entries.at(-1)?.entry ?? record.genesis;
  return {
    seat,
    headHash: entryHash(head),
    safetyRevision: record.safety.revision,
    safetyHash: toHex(hashValue(record.safety.bytes)),
    loadedBeforeVoting: false,
    votingMessagesAfterLoad: 0,
    orderingViolations: 0,
  };
}

```

## tools/sim/src/persistence-lifecycle.test.ts

```ts
import { describe, expect, test } from 'vitest';
import { MemoryProtocolJournal } from '@cp2p/protocol';
import { createSimulationGenesis } from '@cp2p/protocol/testing';
import {
  PersistenceLifecycle,
  observeRestoredJournal,
  restartEvidence,
} from './persistence-lifecycle.js';

function continued(lifecycle: PersistenceLifecycle, seq: number): void {
  lifecycle.observe([{ entry: { seq, payload: { kind: 'command' } } }]);
}

describe('persistence lifecycle schedule', () => {
  test('rotates every peer, closes everyone in non-seat order, and requires command continuation', () => {
    const lifecycle = new PersistenceLifecycle();
    expect(lifecycle.next(49, 10)).toBeNull();
    const first = lifecycle.next(50, 10);
    expect(first?.seats).toEqual([0]);
    expect(lifecycle.next(100, 10)).toBeNull();
    lifecycle.observe([{ entry: { seq: 51, payload: { kind: 'system' } } }]);
    expect(first?.continuedAtSeq).toBeNull();
    continued(lifecycle, 52);
    expect(lifecycle.next(100, 10)?.seats).toEqual([1]);
    continued(lifecycle, 101);
    expect(lifecycle.next(150, 10)?.seats).toEqual([2]);
    continued(lifecycle, 151);
    expect(lifecycle.next(151, 10)?.seats).toEqual([2, 0, 3, 1]);
    continued(lifecycle, 152);
    expect(lifecycle.next(200, 10)?.seats).toEqual([3]);
    continued(lifecycle, 201);
    expect(() => lifecycle.finish()).toThrow('exact restoration');
    for (const event of lifecycle.restarts)
      for (const seat of event.seats)
        event.restored.push({
          seat,
          headHash: 'head',
          safetyHash: 'safety',
          safetyRevision: 1,
          loadedBeforeVoting: true,
          votingMessagesAfterLoad: 1,
          orderingViolations: 0,
        });
    expect(() => lifecycle.finish(249)).not.toThrow();
    expect(() => lifecycle.finish(250)).toThrow('untested restart boundary');
  });

  test('rejects skipped approximately fifty-entry boundaries', () => {
    expect(() => new PersistenceLifecycle().next(100, 10)).toThrow('skipped');
  });
});

describe('durable restoration observation', () => {
  test('verifies the retained certified prefix and exact safety record on its first load', async () => {
    const fixture = createSimulationGenesis({ seed: 42 });
    const journal = new MemoryProtocolJournal();
    expect(await journal.initialize(fixture.entry, new Uint8Array([1, 2, 3]))).toBe(true);
    const record = await journal.load();
    if (!record) throw new Error('Missing journal record');
    const evidence = restartEvidence(0, record);
    const restored = observeRestoredJournal(journal, record, evidence);
    expect(evidence.loadedBeforeVoting).toBe(false);
    expect(await restored.load()).toEqual(record);
    expect(evidence.loadedBeforeVoting).toBe(true);
    // Once restoration loaded the durable state, ordinary consensus may advance its safety revision.
    expect(
      await restored.saveSafety(record.height, record.safety.revision, new Uint8Array([4])),
    ).toBe(true);
    expect((await restored.load())?.safety.revision).toBe(1);
    for (const identity of fixture.identities.values()) identity.secretKey.fill(0);
  });

  test('refuses safety persistence before the retained record has been validated', async () => {
    const fixture = createSimulationGenesis({ seed: 44 });
    const journal = new MemoryProtocolJournal();
    await journal.initialize(fixture.entry, new Uint8Array([1]));
    const record = await journal.load();
    if (!record) throw new Error('Missing journal record');
    const evidence = restartEvidence(0, record);
    const restored = observeRestoredJournal(journal, record, evidence);
    expect(() =>
      restored.saveSafety(record.height, record.safety.revision, new Uint8Array([2])),
    ).toThrow('before validating');
    expect((await journal.load())?.safety).toEqual(record.safety);
    expect(evidence.orderingViolations).toBe(1);
    for (const identity of fixture.identities.values()) identity.secretKey.fill(0);
  });

  test('rejects a safety change before the restoring session reads its durable record', async () => {
    const fixture = createSimulationGenesis({ seed: 43 });
    const journal = new MemoryProtocolJournal();
    await journal.initialize(fixture.entry, new Uint8Array([1, 2, 3]));
    const record = await journal.load();
    if (!record) throw new Error('Missing journal record');
    const evidence = restartEvidence(0, record);
    const restored = observeRestoredJournal(journal, record, evidence);
    await journal.saveSafety(record.height, record.safety.revision, new Uint8Array([4]));
    await expect(restored.load()).rejects.toThrow('prefix or safety');
    expect(evidence.loadedBeforeVoting).toBe(false);
    for (const identity of fixture.identities.values()) identity.secretKey.fill(0);
  });
});

```

## tools/sim/src/observed-transport.ts

```ts
import type { Transport } from '@cp2p/protocol';

/** Delegate explicitly: spreading a class transport loses its prototype methods. */
export function observeOutgoingTransport(
  transport: Transport,
  observe: (message: Uint8Array) => void,
): Transport {
  return {
    self: transport.self,
    peers: () => transport.peers(),
    send(to, bytes) {
      observe(bytes);
      transport.send(to, bytes);
    },
    broadcast(bytes) {
      observe(bytes);
      transport.broadcast(bytes);
    },
    onMessage: (listener) => transport.onMessage(listener),
    onPeerChange: (listener) => transport.onPeerChange(listener),
    disconnect: (peer) => transport.disconnect(peer),
  };
}

```

## tools/sim/src/net-batch.ts

```ts
import { Worker } from 'node:worker_threads';
import { runNetworkGame } from './net.js';
import type { NetworkGameResult } from './net.js';

const MAX_WORKERS = 16;

export interface NetBatchOptions {
  seeds: number;
  startIndex: number;
  seed: number;
  scenario: number;
  parallel: number;
  security?: 'stub' | 'verified';
  lifecycle?: 'persistence';
  maxElapsedMs?: number;
}

export interface NetBatchFailure {
  gameIndex: number;
  message: string;
}

export interface NetBatchPart {
  results: NetworkGameResult[];
  failures: NetBatchFailure[];
}

export interface NetBatchResult extends NetBatchPart {
  options: NetBatchOptions;
  requestedSeeds: number;
  completedGames: number;
  averageTurns: number | null;
  averageInputs: number | null;
  averageVirtualMilliseconds: number | null;
  averageElapsedMilliseconds: number | null;
}

export function parseNetBatchOptions(args: readonly string[]): NetBatchOptions {
  const values = new Map<string, string>();
  const accepted = new Set([
    'scenario',
    'seeds',
    'start-index',
    'seed',
    'parallel',
    'security',
    'lifecycle',
    'max-elapsed-ms',
  ]);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!flag?.startsWith('--')) throw new Error(`Unexpected network argument ${String(flag)}`);
    const name = flag.slice(2);
    if (!accepted.has(name)) throw new Error(`Unknown network option --${name}`);
    if (values.has(name)) throw new Error(`Duplicate network option --${name}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`--${name} needs an integer value`);
    if (name === 'security') {
      if (value !== 'stub' && value !== 'verified')
        throw new Error('--security must be stub or verified');
    } else if (name === 'lifecycle') {
      if (value !== 'persistence') throw new Error('--lifecycle must be persistence');
    } else if (!/^-?\d+$/.test(value)) throw new Error(`--${name} needs an integer value`);
    values.set(name, value);
    index++;
  }
  const parse = (name: string, fallback: number): number => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new Error(`--${name} needs a safe integer`);
    return value;
  };
  const security = values.get('security') === 'verified' ? 'verified' : 'stub';
  const maxElapsedMs = values.has('max-elapsed-ms') ? parse('max-elapsed-ms', 0) : undefined;
  const options: NetBatchOptions = {
    scenario: parse('scenario', 1),
    seeds: parse('seeds', 1),
    startIndex: parse('start-index', 0),
    seed: parse('seed', 42),
    parallel: parse('parallel', 1),
    ...(values.has('security') ? { security } : {}),
    ...(values.has('lifecycle') ? { lifecycle: 'persistence' as const } : {}),
    ...(maxElapsedMs === undefined ? {} : { maxElapsedMs }),
  };
  if (options.scenario < 1 || options.scenario > 9)
    throw new Error('--scenario must be between 1 and 9');
  if (options.seeds < 1) throw new Error('--seeds must be positive');
  if (options.startIndex < 0) throw new Error('--start-index must be non-negative');
  if (options.startIndex > Number.MAX_SAFE_INTEGER - (options.seeds - 1))
    throw new Error('--start-index and --seeds exceed the safe game-index range');
  if (options.seed < 0) throw new Error('--seed must be non-negative');
  if (options.parallel < 1 || options.parallel > MAX_WORKERS)
    throw new Error(`--parallel must be between 1 and ${MAX_WORKERS}`);
  if (maxElapsedMs !== undefined && maxElapsedMs <= 0)
    throw new Error('--max-elapsed-ms must be positive');
  validateLifecycleOptions(options);
  return options;
}

function validateLifecycleOptions(options: NetBatchOptions): void {
  if (
    options.lifecycle === 'persistence' &&
    (options.security !== 'verified' || options.scenario !== 1)
  ) {
    throw new Error('--lifecycle persistence requires --security verified and --scenario 1');
  }
}

/** Partition a deterministic contiguous game-index range across worker slices. */
export function partitionGameIndices(options: NetBatchOptions): number[][] {
  const workers = Math.min(options.parallel, options.seeds);
  return Array.from({ length: workers }, (_, workerIndex) =>
    Array.from(
      { length: Math.ceil((options.seeds - workerIndex) / workers) },
      (_unused, offset) => options.startIndex + workerIndex + offset * workers,
    ).filter((gameIndex) => gameIndex < options.startIndex + options.seeds),
  );
}

async function runWorker(indices: number[], options: NetBatchOptions): Promise<NetBatchPart> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./net-worker.js', import.meta.url), {
      workerData: {
        seed: options.seed,
        scenario: options.scenario,
        gameIndices: indices,
        ...(options.security === undefined ? {} : { security: options.security }),
        ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
        ...(options.maxElapsedMs === undefined ? {} : { maxElapsedMs: options.maxElapsedMs }),
      },
    });
    let settled = false;
    worker.once('message', (message: NetBatchPart) => {
      settled = true;
      resolve(message);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`Network simulation worker exited with code ${code}`));
    });
  });
}

async function runIndices(
  gameIndices: readonly number[],
  options: NetBatchOptions,
): Promise<NetBatchPart> {
  const results: NetworkGameResult[] = [];
  const failures: NetBatchFailure[] = [];
  for (const gameIndex of gameIndices) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Keep each worker's deterministic slice sequential.
      const result = await runNetworkGame({
        seed: options.seed,
        gameIndex,
        scenario: options.scenario,
        ...(options.security === undefined ? {} : { security: options.security }),
        ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
        ...(options.maxElapsedMs === undefined ? {} : { maxElapsedMs: options.maxElapsedMs }),
      });
      results.push(result);
    } catch (error) {
      failures.push({ gameIndex, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { results, failures };
}

/** Run contiguous deterministic game indices with a hard worker limit. */
export async function runNetworkBatch(options: NetBatchOptions): Promise<NetBatchResult> {
  validateLifecycleOptions(options);
  if (options.startIndex > Number.MAX_SAFE_INTEGER - (options.seeds - 1))
    throw new Error('Network game-index range exceeds the safe integer limit');
  const gameIndices = partitionGameIndices(options);
  const parts =
    gameIndices.length === 1
      ? [await runIndices(gameIndices[0] ?? [], options)]
      : await Promise.all(gameIndices.map((indices) => runWorker(indices, options)));
  const results = parts
    .flatMap((part) => part.results)
    .toSorted((a, b) => a.gameIndex - b.gameIndex);
  const failures = parts
    .flatMap((part) => part.failures)
    .toSorted((a, b) => a.gameIndex - b.gameIndex);
  const total = (select: (result: NetworkGameResult) => number) =>
    results.reduce((sum, result) => sum + select(result), 0);
  const completedGames = results.length;
  const average = (select: (result: NetworkGameResult) => number) =>
    completedGames ? total(select) / completedGames : null;
  return {
    options,
    requestedSeeds: options.seeds,
    completedGames,
    averageTurns: average((result) => result.turns),
    averageInputs: average((result) => result.inputs),
    averageVirtualMilliseconds: average((result) => result.virtualMilliseconds),
    averageElapsedMilliseconds: average((result) => result.elapsedMilliseconds),
    results,
    failures,
  };
}

```

## tools/sim/src/net-worker.ts

```ts
import { parentPort, workerData } from 'node:worker_threads';
import * as v from 'valibot';
import { runNetworkGame } from './net.js';
import type { NetworkGameResult } from './net.js';
import type { NetBatchFailure, NetBatchPart } from './net-batch.js';

const safeInteger = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(Number.MAX_SAFE_INTEGER),
);
const workerSchema = v.strictObject({
  seed: safeInteger,
  scenario: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(9)),
  gameIndices: v.pipe(v.array(safeInteger), v.minLength(1)),
  security: v.optional(v.picklist(['stub', 'verified'])),
  lifecycle: v.optional(v.literal('persistence')),
  maxElapsedMs: v.optional(v.pipe(safeInteger, v.minValue(1))),
});

async function execute(): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error('Network worker has no parent port');
  const parsed = v.safeParse(workerSchema, workerData);
  if (!parsed.success) throw new Error('Network worker received invalid job data');
  const results: NetworkGameResult[] = [];
  const failures: NetBatchFailure[] = [];
  for (const gameIndex of parsed.output.gameIndices) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Keep each worker's deterministic slice sequential.
      const result = await runNetworkGame({
        seed: parsed.output.seed,
        gameIndex,
        scenario: parsed.output.scenario,
        ...(parsed.output.security === undefined ? {} : { security: parsed.output.security }),
        ...(parsed.output.lifecycle === undefined ? {} : { lifecycle: parsed.output.lifecycle }),
        ...(parsed.output.maxElapsedMs === undefined
          ? {}
          : { maxElapsedMs: parsed.output.maxElapsedMs }),
      });
      results.push(result);
    } catch (error) {
      failures.push({ gameIndex, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const result: NetBatchPart = { results, failures };
  port.postMessage(result);
}

await execute();

```

## packages/protocol/src/testing/verified-network-fixture.ts

```ts
import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { scalarToBytes } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Seat } from '@cp2p/engine';
import { reconstructPrivateSeats } from '../private-replay.js';
import { auditCertifiedGame } from '../audit.js';
import type { AuditReport } from '../audit-types.js';
import { createBeaconSecretSource } from '../beacon-source.js';
import type { BeaconSecretProvider } from '../beacon-source.js';
import { MemoryBeaconContributionStore } from '../beacon-contributions.js';
import { MemoryCheatCandidateStore } from '../cheat-candidates.js';
import { MemoryCountContributionStore } from '../count-contributions.js';
import { deckCeremonyId, genesisDeckDefinitions, validateDeckCeremony } from '../deck-genesis.js';
import type { DeckDefinition } from '../deck-setup.js';
import { createDeckSecretSource } from '../deck-source.js';
import type { DeckContributionStore } from '../deck-outbox.js';
import {
  GENESIS_PREVIOUS_HASH,
  genesisBody,
  genesisDigest,
  genesisId,
  signEntry,
  signVerifiedGenesis,
} from '../genesis.js';
import { createHandSecretSource } from '../hand-source.js';
import type { MasterRevealStore } from '../master-reveal.js';
import { MemoryStealDeliveryStore } from '../steal-contributions.js';
import { createStealSecretSource } from '../steal-source.js';
import type { Genesis, GenesisBody } from '../types.js';
import type { ReplayPolicy } from '../replay.js';
import type { P2PSessionOptions } from '../p2p-session.js';
import { VerifiedSessionDriver } from '../verified-session-driver.js';
import { createGenesisDeckFixture } from './deck-fixture.js';
import { createSimulationGenesis } from './simulation-genesis.js';

const HUMAN_SEATS = [0, 1, 2, 3] as const satisfies readonly Seat[];
const BEACON_LENGTH = 128;

class MemoryDeckContributionStore implements DeckContributionStore {
  readonly #records = new Map<string, Uint8Array>();

  async load(id: string): Promise<Uint8Array | null> {
    return this.#records.get(id)?.slice() ?? null;
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.#records.has(id)) return false;
    this.#records.set(id, bytes.slice());
    return true;
  }

  dispose(): void {
    for (const bytes of this.#records.values()) bytes.fill(0);
    this.#records.clear();
  }
}

class MemoryMasterRevealStore implements MasterRevealStore {
  readonly #records = new Map<string, Uint8Array>();

  async load(id: string): Promise<Uint8Array | null> {
    return this.#records.get(id)?.slice() ?? null;
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.#records.has(id)) return false;
    this.#records.set(id, bytes.slice());
    return true;
  }

  dispose(): void {
    for (const bytes of this.#records.values()) bytes.fill(0);
    this.#records.clear();
  }
}

interface SeatStores {
  readonly beacon: MemoryBeaconContributionStore;
  readonly cheat: MemoryCheatCandidateStore;
  readonly count: MemoryCountContributionStore;
  readonly deck: MemoryDeckContributionStore;
  readonly masterReveal: MemoryMasterRevealStore;
  readonly steal: MemoryStealDeliveryStore;
}

export type VerifiedNetworkSessionOptions = Pick<
  P2PSessionOptions,
  | 'genesisEntry'
  | 'engine'
  | 'policy'
  | 'beaconSource'
  | 'beaconContributions'
  | 'cheatCandidateStore'
  | 'countContributionStore'
  | 'stealDeliveryStore'
  | 'deckSetupPasses'
  | 'createDeckSource'
  | 'deckContributions'
  | 'createDriver'
  | 'masterReveal'
  | 'auditRunner'
>;

export interface VerifiedNetworkFixtureOptions {
  readonly seed: number;
  readonly gameIndex?: number;
  readonly vpTarget?: number;
  /** Compare session-owned snapshots with terminal reconstruction and the independent audit. */
  readonly verifyLivePrivateStates?: boolean;
}

/**
 * Real four-human verified genesis for network simulations. Sources and durable
 * in-memory outboxes are seat-scoped and remain stable for the fixture lifetime.
 */
export function createVerifiedNetworkFixture(options: VerifiedNetworkFixtureOptions) {
  const simulation = createSimulationGenesis({
    seed: options.seed,
    gameIndex: options.gameIndex ?? 0,
    humanCount: HUMAN_SEATS.length,
    ...(options.vpTarget === undefined
      ? {}
      : {
          config: {
            modules: [{ id: 'base', version: '1.0.0' }],
            seats: [...HUMAN_SEATS],
            options: { base: { mapLayout: 'random', vpTarget: options.vpTarget } },
          },
        }),
  });
  const genesisDraft: GenesisBody = {
    ...genesisBody(simulation.genesis),
    security: 'verified',
    commitments: {},
  };
  const deck = createGenesisDeckFixture(genesisDraft, simulation.identities);
  const decks = genesisDeckDefinitions(deck.body);
  if (!decks.ok)
    throw new Error(`Verified fixture deck definitions failed: ${decks.error.message}`);
  const masterSecrets = new Map<Seat, Uint8Array>(
    HUMAN_SEATS.map((seat) => [seat, scalarToBytes(BigInt(17 + seat))]),
  );
  const providers = new Map<Seat, BeaconSecretProvider>();
  const stores = new Map<Seat, SeatStores>();
  const dispose = (): void => {
    for (const provider of providers.values()) provider.dispose();
    for (const bytes of masterSecrets.values()) bytes.fill(0);
    for (const identity of simulation.identities.values()) identity.secretKey.fill(0);
    for (const seatStores of stores.values()) {
      seatStores.deck.dispose();
      seatStores.masterReveal.dispose();
    }
  };

  try {
    const ceremonyId = deckCeremonyId(deck.body);
    for (const seat of HUMAN_SEATS) {
      const master = masterSecrets.get(seat);
      if (!master) throw new Error(`Missing fixture master for seat ${seat}`);
      providers.set(seat, createBeaconSecretSource(master, { ceremonyId, seat }, BEACON_LENGTH));
      stores.set(seat, {
        beacon: new MemoryBeaconContributionStore(),
        cheat: new MemoryCheatCandidateStore(),
        count: new MemoryCountContributionStore(),
        deck: new MemoryDeckContributionStore(),
        masterReveal: new MemoryMasterRevealStore(),
        steal: new MemoryStealDeliveryStore(),
      });
    }

    const body: GenesisBody = {
      ...deck.body,
      commitments: {
        ...deck.body.commitments,
        beaconChains: HUMAN_SEATS.map((seat) => {
          const provider = providers.get(seat);
          if (!provider) throw new Error(`Missing beacon provider for seat ${seat}`);
          return {
            seat,
            length: BEACON_LENGTH,
            tip: toBase64Url(provider.initialCommitment.tip),
          };
        }),
      },
    };
    const genesis: Genesis = {
      ...body,
      gameId: genesisId(body),
      signatures: HUMAN_SEATS.map((seat) => {
        const identity = simulation.identities.get(seat);
        if (!identity) throw new Error(`Missing fixture identity for seat ${seat}`);
        const signed = signVerifiedGenesis(body, deck.transcripts, seat, identity.secretKey);
        if (!signed.ok) throw new Error(`Verified genesis signing failed: ${signed.error.message}`);
        return signed.value;
      }),
    };
    const policy: ReplayPolicy = {
      genesis: {
        verifyCommitments: (candidate) => validateDeckCeremony(candidate, deck.transcripts),
      },
      // Command and supported system evidence use the protocol's built-in strict verifiers.
      entry: {},
    };
    const state = simulation.engine.createGame(genesis.config, fromBase64Url(genesis.genesisSeed));
    const sequencer = simulation.identities.get(HUMAN_SEATS[0]);
    if (!sequencer) throw new Error('Missing initial fixture sequencer');
    const entry = signEntry(
      {
        seq: 0,
        term: 1,
        prevHash: GENESIS_PREVIOUS_HASH,
        payload: { kind: 'genesis', genesis },
        stateHash: toHex(hashValue(state)),
        sequencer: sequencer.peerId,
      },
      sequencer.secretKey,
    );
    const deckSetupPasses = deck.transcripts.flatMap((transcript) =>
      transcript.passes.map((pass) => ({ deckId: transcript.deckId, pass })),
    );
    const definitions = new Map<string, DeckDefinition>(
      decks.value.map((item) => [item.deckId, item]),
    );
    const digest = genesisDigest(genesis);

    const livePrivateHashes = new Map<number, Map<Seat, string>>();
    let repeatedPrivateSnapshots = 0;
    let checkedPrivateSequences = 0;
    const capturePrivateState = (driver: VerifiedSessionDriver, seat: Seat, seq: number) => {
      if (!options.verifyLivePrivateStates) return;
      const ownedState = driver.privateState(seat);
      if (!ownedState) throw new Error(`Missing owned private state at ${seat}/${seq}`);
      const hash = toHex(hashValue(ownedState));
      const hashes = livePrivateHashes.get(seq) ?? new Map<Seat, string>();
      const prior = hashes.get(seat);
      if (prior !== undefined) {
        if (prior !== hash) throw new Error(`Restored private state differs at ${seat}/${seq}`);
        repeatedPrivateSnapshots += 1;
      }
      hashes.set(seat, hash);
      livePrivateHashes.set(seq, hashes);
    };
    const sessionOptions = (seat: Seat): VerifiedNetworkSessionOptions => {
      const master = masterSecrets.get(seat);
      const provider = providers.get(seat);
      const seatStores = stores.get(seat);
      const identity = simulation.identities.get(seat);
      if (!master || !provider || !seatStores || !identity)
        throw new RangeError(`Seat ${seat} is not an owned human fixture seat`);
      const createDeckSource = (deckId: string, ownedSeat: Seat) => {
        if (ownedSeat !== seat)
          throw new RangeError(`Seat ${seat} does not own deck seat ${ownedSeat}`);
        const definition = definitions.get(deckId);
        if (!definition) throw new RangeError(`Unknown fixture deck ${deckId}`);
        return createDeckSecretSource(master, definition, seat);
      };
      return {
        genesisEntry: entry,
        engine: simulation.engine,
        policy,
        beaconSource: provider.source,
        beaconContributions: seatStores.beacon,
        cheatCandidateStore: seatStores.cheat,
        countContributionStore: seatStores.count,
        stealDeliveryStore: seatStores.steal,
        deckSetupPasses,
        createDeckSource,
        deckContributions: seatStores.deck,
        masterReveal: {
          store: seatStores.masterReveal,
          loadOwnedMaster: async (requestedSeat: Seat) =>
            requestedSeat === seat ? master.slice() : null,
        },
        auditRunner: (input) => {
          let report: AuditReport;
          try {
            if (options.verifyLivePrivateStates && checkedPrivateSequences === 0) {
              const rebuilt = reconstructPrivateSeats({
                genesisEntry: input.genesisEntry,
                entries: input.entries,
                engine: simulation.engine,
                policy,
                secrets: input.masters,
                verifyPrivateState(seq, states) {
                  const hashes = livePrivateHashes.get(seq);
                  if (
                    !hashes ||
                    hashes.size !== HUMAN_SEATS.length ||
                    states.size !== hashes.size ||
                    [...states].some(
                      ([ownedSeat, privateState]) =>
                        hashes.get(ownedSeat) !== toHex(hashValue(privateState)),
                    )
                  )
                    return failure(
                      'fixture-live-private-state',
                      'Live owned state differs from terminal reconstruction',
                      { seq },
                    );
                  return success(undefined);
                },
              });
              if (!rebuilt.ok) throw new Error(`${rebuilt.error.code}: ${rebuilt.error.message}`);
              rebuilt.value.dispose();
              checkedPrivateSequences = input.entries.length + 1;
              if (livePrivateHashes.size !== checkedPrivateSequences)
                throw new Error('Live private capture omitted a certified sequence');
            }
            report = auditCertifiedGame({
              genesisEntry: input.genesisEntry,
              entries: input.entries,
              masters: input.masters,
              engine: simulation.engine,
              policy,
            });
          } finally {
            for (const item of input.masters) item.master.fill(0);
          }
          return { result: Promise.resolve(report), cancel() {} };
        },
        createDriver: (engine, signedGenesis, _clock, ownedSeats) => {
          if (ownedSeats.length !== 1 || ownedSeats[0] !== seat)
            throw new RangeError(`Seat ${seat} driver may own only its human seat`);
          const driver = new VerifiedSessionDriver(
            engine,
            signedGenesis,
            ownedSeats,
            createDeckSource,
            (ownedSeat) => {
              if (ownedSeat !== seat)
                throw new RangeError(`Seat ${seat} does not own seat ${ownedSeat}`);
              return createHandSecretSource(master, digest, seat);
            },
            (ownedSeat) => {
              if (ownedSeat !== seat)
                throw new RangeError(`Seat ${seat} does not own seat ${ownedSeat}`);
              const owner = genesis.seats.find((item) => item.seat === seat);
              if (!owner || owner.kind !== 'human') throw new Error('Fixture seat is not human');
              return createStealSecretSource(master, genesis.ceremonyNonce, seat, owner.publicKey);
            },
          );
          capturePrivateState(driver, seat, 0);
          if (options.verifyLivePrivateStates) {
            const committed = driver.committedEntry.bind(driver);
            driver.committedEntry = (...args) => {
              const applied = committed(...args);
              if (applied.ok) capturePrivateState(driver, seat, args[0].entry.seq);
              return applied;
            };
          }
          return driver;
        },
      };
    };

    return {
      engine: simulation.engine,
      identities: simulation.identities,
      genesis,
      entry,
      policy,
      sessionOptions,
      privateStateEvidence: () => ({
        capturedSequences: livePrivateHashes.size,
        capturedSnapshots: [...livePrivateHashes.values()].reduce(
          (sum, hashes) => sum + hashes.size,
          0,
        ),
        checkedSequences: checkedPrivateSequences,
        repeatedSnapshots: repeatedPrivateSnapshots,
        snapshotDigest: toHex(
          hashValue(
            [...livePrivateHashes]
              .map(([seq, hashes]) => ({
                seq,
                seats: [...hashes].toSorted(([a], [b]) => a - b),
              }))
              .toSorted((a, b) => a.seq - b.seq),
          ),
        ),
      }),
      mastersForAudit: () =>
        HUMAN_SEATS.map((seat) => {
          const master = masterSecrets.get(seat);
          if (!master) throw new Error(`Fixture master for seat ${seat} is unavailable`);
          return { seat, master: master.slice() };
        }),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

```

## packages/protocol/src/testing/verified-network-fixture.test.ts

```ts
import { scalarToBytes } from '@cp2p/crypto';
import { describe, expect, test } from 'vitest';
import { genesisDeckDefinitions } from '../deck-genesis.js';
import { validateGenesisEntry } from '../genesis.js';
import { VirtualClock } from './virtual-clock.js';
import { createVerifiedNetworkFixture } from './verified-network-fixture.js';

describe('verified network fixture', () => {
  test('builds strict four-human 25-card genesis with seat-scoped reusable options', async () => {
    const fixture = createVerifiedNetworkFixture({
      seed: 802,
      gameIndex: 3,
      vpTarget: 3,
      verifyLivePrivateStates: true,
    });
    try {
      expect(fixture.genesis.security).toBe('verified');
      expect(fixture.genesis.seats).toHaveLength(4);
      expect(fixture.genesis.seats.every((seat) => seat.kind === 'human')).toBe(true);
      expect(fixture.genesis.commitments.beaconChains).toMatchObject([
        { seat: 0, length: 128 },
        { seat: 1, length: 128 },
        { seat: 2, length: 128 },
        { seat: 3, length: 128 },
      ]);
      expect(fixture.genesis.commitments.escrow).toHaveLength(4);
      expect(validateGenesisEntry(fixture.entry, fixture.engine, fixture.policy.genesis).ok).toBe(
        true,
      );
      const deck = genesisDeckDefinitions(fixture.genesis);
      expect(deck.ok).toBe(true);
      if (!deck.ok) return;
      expect(deck.value.find((item) => item.deckId === 'dev')?.cards).toHaveLength(25);

      const seatZero = fixture.sessionOptions(0);
      const restoredSeatZero = fixture.sessionOptions(0);
      const seatOne = fixture.sessionOptions(1);
      expect(seatZero.beaconContributions).toBe(restoredSeatZero.beaconContributions);
      expect(seatZero.deckContributions).toBe(restoredSeatZero.deckContributions);
      expect(seatZero.masterReveal?.store).toBe(restoredSeatZero.masterReveal?.store);
      expect(seatZero.beaconContributions).not.toBe(seatOne.beaconContributions);
      expect(seatZero.masterReveal?.store).not.toBe(seatOne.masterReveal?.store);
      expect('secretKey' in seatZero).toBe(false);

      const ownMaster = await seatZero.masterReveal?.loadOwnedMaster(0);
      const foreignMaster = await seatZero.masterReveal?.loadOwnedMaster(1);
      expect(ownMaster).toEqual(scalarToBytes(17n));
      expect(foreignMaster).toBeNull();
      ownMaster?.fill(0);

      expect(() => seatZero.createDeckSource?.('dev', 1)).toThrow(/does not own/);
      expect(() =>
        seatZero.createDriver(fixture.engine, fixture.genesis, new VirtualClock(), [0, 1]),
      ).toThrow(/may own only its human seat/);
      const driver = seatZero.createDriver(
        fixture.engine,
        fixture.genesis,
        new VirtualClock(),
        [0],
      );
      try {
        expect(driver.privateState(0)?.seat).toBe(0);
        expect(driver.privateState(1)).toBeNull();
      } finally {
        driver.dispose?.();
      }

      const restoredDriver = restoredSeatZero.createDriver(
        fixture.engine,
        fixture.genesis,
        new VirtualClock(),
        [0],
      );
      restoredDriver.dispose?.();
      expect(fixture.privateStateEvidence()).toMatchObject({
        capturedSequences: 1,
        capturedSnapshots: 1,
        checkedSequences: 0,
        repeatedSnapshots: 1,
      });

      const masterCopies = fixture.mastersForAudit();
      expect(masterCopies.map(({ seat }) => seat)).toEqual([0, 1, 2, 3]);
      expect(masterCopies[0]?.master).toEqual(scalarToBytes(17n));
      for (const { master } of masterCopies) master.fill(0);

      const beacon = seatZero.beaconSource;
      expect(beacon?.link(0, 1)).toHaveLength(32);
      expect(beacon?.extension(1)).toMatchObject({ length: 128 });
      expect(beacon?.extension(1).tip).toHaveLength(32);
    } finally {
      fixture.dispose();
    }
  }, 30_000);
});

```

## packages/protocol/src/private-replay.ts

```ts
import { toBase64Url } from '@cp2p/codec';
import { scalarFromBytes } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Engine, PrivateState, Result, Seat } from '@cp2p/engine';
import { createBeaconSecretSource } from './beacon-source.js';
import type { BeaconSecretProvider } from './beacon-source.js';
import { deckCeremonyId } from './deck-genesis.js';
import { createDeckSecretSource } from './deck-source.js';
import { genesisDigest } from './genesis.js';
import { verifyRevealedMaster } from './genesis-secrets.js';
import { createHandSecretSource } from './hand-source.js';
import type { ProposalContext } from './proposal.js';
import { initialProposalContext, replayCertifiedPrefix } from './replay.js';
import type { ReplayPolicy } from './replay.js';
import { createStealSecretSource } from './steal-source.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';

export interface ReconstructedPrivateSeats {
  readonly context: ProposalContext;
  /** Contains only requested seats and checks their public openings after every entry. */
  readonly driver: VerifiedSessionDriver;
  /** Relinquish one owned seat without discarding other reconstructed seats. */
  releaseSeat(seat: Seat): void;
  /** Disposes the driver and clears its retained master copies. */
  dispose(): void;
}

/**
 * Reconstruct already-owned or authorized-revealed seats from certified history.
 * This does not request secrets, authorize disclosure, activate controllers or
 * constitute a complete game audit. The caller must establish the right to use
 * every supplied master before invoking it. Deck setup must be fully certified.
 * No partially rebuilt hand is returned.
 */
export function reconstructPrivateSeats(input: {
  readonly genesisEntry: unknown;
  readonly entries: readonly unknown[];
  readonly engine: Engine;
  readonly policy: ReplayPolicy;
  readonly secrets: readonly { readonly seat: Seat; readonly master: Uint8Array }[];
  /** Independent check of detached snapshots, provisional until the entire replay succeeds. */
  readonly verifyPrivateState?: (
    seq: number,
    states: ReadonlyMap<Seat, PrivateState>,
  ) => Result<void>;
}): Result<ReconstructedPrivateSeats> {
  const masters = new Map<Seat, Uint8Array>();
  const beacons = new Map<Seat, { length: number; provider: BeaconSecretProvider }>();
  let driver: VerifiedSessionDriver | undefined;
  let retained = false;
  const releaseSeat = (seat: Seat) => {
    driver?.relinquishSeats([seat]);
    const master = masters.get(seat);
    master?.fill(0);
    masters.delete(seat);
    const beacon = beacons.get(seat);
    beacon?.provider.dispose();
    beacons.delete(seat);
  };
  const dispose = () => {
    for (const seat of masters.keys()) releaseSeat(seat);
    driver?.dispose();
  };
  try {
    if (!Array.isArray(input.secrets) || input.secrets.length < 1 || input.secrets.length > 6)
      return failure('private-replay-seats', 'Supply one through six distinct owned seat secrets');
    for (const { seat, master } of input.secrets) {
      if (
        !Number.isSafeInteger(seat) ||
        seat < 0 ||
        seat > 5 ||
        masters.has(seat) ||
        !(master instanceof Uint8Array) ||
        master.length !== 32
      )
        return failure('private-replay-secrets', 'Seat secrets are malformed or duplicated');
      const copy = new Uint8Array(master);
      masters.set(seat, copy);
      scalarFromBytes(copy, { nonzero: true });
    }

    // Authenticate the whole supplied branch before reporting any secret mismatch.
    // A corrupt imported certificate must not be attributed to a departed owner.
    const publicReplay = replayCertifiedPrefix(
      input.genesisEntry,
      input.entries,
      input.engine,
      input.policy,
    );
    if (!publicReplay.ok)
      return failure('private-replay-history', 'Certified history could not be verified', {
        reason: publicReplay.error.code,
      });
    const { genesis, crypto } = publicReplay.value.context.log;
    if (genesis.security !== 'verified' || !crypto)
      return failure('private-replay-security', 'Private reconstruction requires verified history');
    for (const [seat, master] of masters) {
      const verified = verifyRevealedMaster(genesis, crypto.decks, seat, master);
      if (!verified.ok) return verified;
    }
    const initial = initialProposalContext(input.genesisEntry, input.engine, input.policy);
    if (!initial.ok) return initial;
    const initialBeacon = initial.value.log.crypto?.beacon;
    if (!initialBeacon)
      return failure('private-replay-beacon', 'Verified genesis has no beacon state');
    const ceremonyId = deckCeremonyId(genesis);
    for (const chain of initialBeacon.chains) {
      const master = masters.get(chain.seat);
      if (master)
        beacons.set(chain.seat, {
          length: chain.length,
          provider: createBeaconSecretSource(
            master,
            { ceremonyId, seat: chain.seat },
            chain.length,
          ),
        });
    }
    const getMaster = (seat: Seat): Uint8Array => {
      const master = masters.get(seat);
      if (!master) throw new Error('Seat is not owned by this private replay');
      return master;
    };
    driver = new VerifiedSessionDriver(
      input.engine,
      genesis,
      [...masters.keys()],
      (deckId, seat) => {
        const deck = crypto.decks.decks.find(
          (item) => item.commitment.definition.deckId === deckId,
        );
        if (!deck) throw new Error('Private replay deck is not in certified genesis');
        return createDeckSecretSource(getMaster(seat), deck.commitment.definition, seat);
      },
      (seat) => createHandSecretSource(getMaster(seat), genesisDigest(genesis), seat),
      (seat) => {
        const owner = genesis.seats.find((item) => item.seat === seat);
        if (!owner) throw new Error('Private replay seat is not in certified genesis');
        return createStealSecretSource(
          getMaster(seat),
          genesis.ceremonyNonce,
          seat,
          owner.publicKey,
        );
      },
    );
    const activeDriver = driver;
    const verifyPrivateState = (seq: number): Result<void> => {
      if (!input.verifyPrivateState) return success(undefined);
      const states = new Map<Seat, PrivateState>();
      for (const seat of masters.keys()) {
        const state = activeDriver.privateState(seat);
        if (!state)
          return failure('verified-private-missing', 'Owned private state is missing', { seq });
        states.set(seat, state);
      }
      return input.verifyPrivateState(seq, states);
    };
    const initialPrivateCheck = verifyPrivateState(initial.value.log.head.seq);
    if (!initialPrivateCheck.ok) return initialPrivateCheck;
    let prior = initial.value;
    const rebuilt = replayCertifiedPrefix(
      input.genesisEntry,
      publicReplay.value.entries,
      input.engine,
      input.policy,
      (entry, next) => {
        const beacon = next.log.crypto?.beacon;
        if (!beacon) return failure('private-replay-beacon', 'Certified beacon state is missing');
        for (const chain of beacon.chains) {
          let source = beacons.get(chain.seat);
          if (!source) continue;
          if (source.length !== chain.length) {
            source.provider.dispose();
            source = {
              length: chain.length,
              provider: createBeaconSecretSource(
                getMaster(chain.seat),
                { ceremonyId, seat: chain.seat },
                chain.length,
              ),
            };
            beacons.set(chain.seat, source);
          }
          const expected =
            chain.index > 0
              ? source.provider.source.link(chain.chainEpoch, chain.index)
              : chain.chainEpoch === 0
                ? source.provider.initialCommitment.tip
                : source.provider.source.extension(chain.chainEpoch).tip;
          try {
            if (toBase64Url(expected) !== chain.tip)
              return failure(
                'master-beacon-history',
                'Master does not reproduce a certified beacon link',
                {
                  seat: chain.seat,
                  seq: entry.entry.seq,
                },
              );
          } finally {
            expected.fill(0);
          }
        }
        const applied = activeDriver.committedEntry(entry, prior.log, next.log);
        if (!applied.ok) return applied;
        const checked = verifyPrivateState(entry.entry.seq);
        if (!checked.ok) return checked;
        prior = next;
        return success(undefined);
      },
    );
    if (!rebuilt.ok) return rebuilt;
    // Chain sources are needed only for historical checks, not subsequent hand proofs.
    for (const source of beacons.values()) source.provider.dispose();
    beacons.clear();
    retained = true;
    return success({ context: rebuilt.value.context, driver: activeDriver, releaseSeat, dispose });
  } catch {
    return failure('private-replay-failed', 'Could not reconstruct the requested private seats');
  } finally {
    if (!retained) dispose();
  }
}

```

## packages/protocol/src/audit.ts

```ts
import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { scalarFromBytes } from '@cp2p/crypto';
import { LocalGame, RESOURCES, failure, success } from '@cp2p/engine';
import type { Engine, PrivateInputData, Result, Seat } from '@cp2p/engine';
import { decodeDeckCard } from './deck-draw.js';
import { createDeckSecretSource } from './deck-source.js';
import { entryHash } from './genesis.js';
import { verifyRevealedMaster } from './genesis-secrets.js';
import { reconstructPrivateSeats } from './private-replay.js';
import { initialProposalContext, replayCertifiedPrefix } from './replay.js';
import type { ReplayPolicy } from './replay.js';
import { openStealContribution } from './steal-delivery.js';
import { createStealSecretSource } from './steal-source.js';
import type { AuditEntryRef, AuditInputError, AuditReport, AuditViolation } from './audit-types.js';
import type { ProposalContext } from './proposal.js';
import type { Genesis } from './types.js';

const MAX_DIAGNOSTICS = 16;

function isSeat(value: unknown): value is Seat {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5;
}

export interface AuditCertifiedGameInput {
  readonly genesisEntry: unknown;
  readonly entries: readonly unknown[];
  readonly engine: Engine;
  readonly policy: ReplayPolicy;
  readonly masters: readonly { readonly seat: Seat; readonly master: Uint8Array }[];
}

function ref(entry: Parameters<typeof entryHash>[0]): AuditEntryRef {
  return { seq: entry.seq, hash: entryHash(entry) };
}

function issue(seq: number, seat: Seat | null, kind: string): AuditViolation {
  return { seq, seat, kind, detail: kind };
}

function selectedResource(
  hand: Readonly<Record<string, number>>,
  index: number,
): (typeof RESOURCES)[number] | null {
  let cursor = index;
  for (const resource of RESOURCES) {
    cursor -= hand[resource] ?? 0;
    if (cursor < 0) return resource;
  }
  return null;
}

function privateDataFor(
  input: NonNullable<Parameters<LocalGame['applyRecorded']>[0]>,
  prior: ProposalContext,
  next: ProposalContext,
  game: LocalGame,
  masters: ReadonlyMap<Seat, Uint8Array>,
  genesis: Genesis,
): Result<Partial<Record<Seat, PrivateInputData>>> {
  if (input.kind !== 'system') return success({});
  if (input.type === 'CARD_DEALT') {
    if (!isSeat(input.seat) || !genesis.config.seats.includes(input.seat))
      return failure('audit-draw-seat', 'Certified draw seat is invalid');
    const deck = next.log.crypto?.decks.decks.find(
      (item) => item.commitment.definition.deckId === input.deck,
    );
    const slot = deck?.slots.find((item) => item.slotId === input.slotId);
    const master = masters.get(input.seat);
    if (!deck || !slot || slot.seat !== input.seat || !master)
      return failure('audit-draw-context', 'Certified draw lacks its original receipt or master');
    const source = createDeckSecretSource(master, deck.commitment.definition, input.seat);
    try {
      const decoded = decodeDeckCard(
        deck.setup,
        slot.receipt,
        source.lock(slot.receipt.operation.position),
        slot.unlockSigners,
      );
      return decoded.ok ? success({ [input.seat]: { card: decoded.value.card } }) : decoded;
    } finally {
      source.dispose();
    }
  }
  if (input.type === 'STEAL_RESULT') {
    const fixed = prior.log.crypto?.steal?.fixed;
    const operation = fixed?.operation;
    if (
      !fixed ||
      !operation ||
      input.thief !== operation.thief.seat ||
      input.victim !== operation.victim.seat
    )
      return failure('audit-steal-context', 'Certified steal lacks its fixed operation');
    const victimHand = game.privateView(operation.victim.seat)?.hand;
    const victimTotal = victimHand
      ? RESOURCES.reduce((sum, resource) => sum + (victimHand[resource] ?? 0), 0)
      : -1;
    const expected = victimHand ? selectedResource(victimHand, operation.index) : null;
    if (!expected || victimTotal !== operation.handSize)
      return failure('audit-steal-index', 'Frozen index differs from the omniscient victim hand');
    const master = masters.get(operation.thief.seat);
    const owner = genesis.seats.find((seat) => seat.seat === operation.thief.seat);
    if (!master || !owner)
      return failure('audit-steal-master', 'Original thief master is unavailable');
    const source = createStealSecretSource(
      master,
      genesis.ceremonyNonce,
      operation.thief.seat,
      owner.publicKey,
    );
    try {
      const opened = openStealContribution(
        operation,
        fixed.contribution,
        source.encryptionSecret(),
        fixed.signer,
      );
      if (!opened.ok) return opened;
      if (opened.value.resource !== expected)
        return failure(
          'audit-steal-resource',
          'Certified transfer differs from the frozen victim card',
        );
      return success({
        [operation.thief.seat]: { resource: expected },
        [operation.victim.seat]: { resource: expected },
      });
    } finally {
      source.dispose();
    }
  }
  return success({});
}

/** Reconstruct a finished certified game without treating bad reveal input as an accusation. */
export function auditCertifiedGame(input: AuditCertifiedGameInput): AuditReport {
  const violations: AuditViolation[] = [];
  const inputErrors: AuditInputError[] = [];
  const masters = new Map<Seat, Uint8Array>();
  let terminal: AuditEntryRef | null = null;
  let finalHead: AuditEntryRef | null = null;
  let historyError: { code: string } | null = null;
  let auditError: AuditReport['auditError'] = null;
  let finalHiddenVictoryPoints: AuditReport['finalHiddenVictoryPoints'] = null;
  let cheatFindings: AuditReport['cheatFindings'] = [];
  let missingSeats: Seat[] = [];
  let complete = false;
  const report = (): AuditReport => ({
    ok:
      complete &&
      violations.length === 0 &&
      inputErrors.length === 0 &&
      !historyError &&
      !auditError,
    complete,
    missingSeats,
    violations,
    inputErrors,
    cheatFindings,
    terminal,
    finalHead,
    historyError,
    auditError,
    finalHiddenVictoryPoints,
  });
  const processingFailure = (seq: number, code: string): AuditReport => {
    auditError = { seq, code };
    complete = false;
    return report();
  };
  try {
    const publicReplay = replayCertifiedPrefix(
      input.genesisEntry,
      input.entries,
      input.engine,
      input.policy,
      (entry, next) => {
        if (!terminal && next.log.state.result) terminal = ref(entry.entry);
        return success(undefined);
      },
    );
    if (!publicReplay.ok) {
      historyError = { code: publicReplay.error.code };
      return report();
    }
    const { context } = publicReplay.value;
    const { genesis, crypto } = context.log;
    finalHead = ref(context.log.head);
    cheatFindings = crypto?.cheats.slice(0, MAX_DIAGNOSTICS) ?? [];
    if (!terminal || !context.log.state.result) return report();
    if (genesis.security !== 'verified' || !crypto) {
      historyError = { code: 'audit-unverified-game' };
      return report();
    }
    if (!Array.isArray(input.masters)) {
      inputErrors.push({ seat: null, kind: 'master-list' });
      return report();
    }
    const seats = new Set(genesis.seats.map((seat) => seat.seat));
    const seen = new Set<Seat>();
    for (const reveal of input.masters) {
      if (!reveal || !seats.has(reveal.seat) || seen.has(reveal.seat)) {
        if (inputErrors.length < MAX_DIAGNOSTICS)
          inputErrors.push({ seat: null, kind: 'master-seat-or-duplicate' });
        continue;
      }
      seen.add(reveal.seat);
      if (!(reveal.master instanceof Uint8Array) || reveal.master.length !== 32) {
        if (inputErrors.length < MAX_DIAGNOSTICS)
          inputErrors.push({ seat: reveal.seat, kind: 'master-scalar' });
        continue;
      }
      const copy = reveal.master.slice();
      try {
        scalarFromBytes(copy, { nonzero: true });
      } catch {
        copy.fill(0);
        if (inputErrors.length < MAX_DIAGNOSTICS)
          inputErrors.push({ seat: reveal.seat, kind: 'master-scalar' });
        continue;
      }
      masters.set(reveal.seat, copy);
    }
    missingSeats = genesis.seats.map((seat) => seat.seat).filter((seat) => !masters.has(seat));
    for (const [seat, master] of masters) {
      const verified = verifyRevealedMaster(genesis, crypto.decks, seat, toBase64Url(master));
      if (verified.ok) continue;
      if (verified.error.code === 'master-public-key' || verified.error.code === 'master-reveal') {
        if (inputErrors.length < MAX_DIAGNOSTICS)
          inputErrors.push({ seat, kind: verified.error.code });
      } else if (
        [
          'master-encryption-key',
          'master-beacon-tip',
          'master-shuffle-key',
          'master-lock-key',
        ].includes(verified.error.code)
      ) {
        violations.push(issue(0, seat, verified.error.code));
      } else return processingFailure(0, verified.error.code);
    }
    complete = missingSeats.length === 0 && inputErrors.length === 0;
    if (!complete || violations.length) return report();

    const initial = initialProposalContext(input.genesisEntry, input.engine, input.policy);
    if (!initial.ok) {
      historyError = { code: initial.error.code };
      return report();
    }
    const recorded = LocalGame.createRecorded(
      input.engine,
      genesis.config,
      fromBase64Url(genesis.genesisSeed),
    );
    if (!recorded.ok) {
      return processingFailure(0, recorded.error.code);
    }
    const game = recorded.value;
    if (toHex(hashValue(game.state)) !== initial.value.log.head.stateHash) {
      return processingFailure(0, 'audit-genesis-state');
    }
    const privateHashes = new Map<number, ReadonlyMap<Seat, string>>();
    const rememberPrivateHashes = (seq: number): Result<void> => {
      const hashes = new Map<Seat, string>();
      for (const seat of genesis.config.seats) {
        const privateState = game.privateView(seat);
        if (!privateState)
          return failure(
            'audit-omniscient-private-missing',
            'Omniscient private state is missing',
            {
              seq,
            },
          );
        hashes.set(seat, toHex(hashValue(privateState)));
      }
      privateHashes.set(seq, hashes);
      return success(undefined);
    };
    const initialPrivateHashes = rememberPrivateHashes(initial.value.log.head.seq);
    if (!initialPrivateHashes.ok) return processingFailure(0, initialPrivateHashes.error.code);
    let prior = initial.value;
    let failureSeq = 0;
    let failureSeat: Seat | null = null;
    const privateReplay = replayCertifiedPrefix(
      input.genesisEntry,
      publicReplay.value.entries,
      input.engine,
      input.policy,
      (entry, next) => {
        failureSeq = entry.entry.seq;
        const recordedInput = entry.input;
        if (recordedInput) {
          failureSeat = null;
          try {
            const data = privateDataFor(recordedInput, prior, next, game, masters, genesis);
            if (!data.ok) {
              // Only this mismatch identifies the signer of the fixed hidden transfer.
              // A draw failure does not prove misconduct by the receiving player.
              if (data.error.code === 'audit-steal-resource' && recordedInput.kind === 'system')
                failureSeat = isSeat(recordedInput.victim) ? recordedInput.victim : null;
              return data;
            }
            const applied = game.applyRecorded(recordedInput, data.value);
            if (!applied.ok) return applied;
          } catch {
            return failure('audit-private-input', 'Could not reconstruct certified private input');
          }
        }
        if (
          toHex(hashValue(game.state)) !== next.log.head.stateHash ||
          toHex(hashValue(game.state)) !== toHex(hashValue(next.log.state))
        )
          return failure('audit-state-hash', 'Omniscient state differs from the certified state');
        prior = next;
        return rememberPrivateHashes(entry.entry.seq);
      },
    );
    if (!privateReplay.ok) {
      if (
        [
          'driver-error',
          'audit-private-input',
          'audit-state-hash',
          'audit-omniscient-private-missing',
          'audit-draw-context',
          'audit-draw-seat',
          'audit-steal-context',
          'audit-steal-master',
          'steal-recipient-key',
          'deck-owner-lock',
          'missing-private-state',
        ].includes(privateReplay.error.code)
      )
        return processingFailure(failureSeq, privateReplay.error.code);
      violations.push(issue(failureSeq, failureSeat, privateReplay.error.code));
      complete = true;
      return report();
    }
    if (toHex(hashValue(game.state.result)) !== toHex(hashValue(context.log.state.result))) {
      return processingFailure((terminal as AuditEntryRef).seq, 'audit-terminal-result');
    }
    const crossCheck = reconstructPrivateSeats({
      genesisEntry: input.genesisEntry,
      entries: publicReplay.value.entries,
      engine: input.engine,
      policy: input.policy,
      secrets: [...masters].map(([seat, master]) => ({ seat, master })),
      verifyPrivateState(seq, states) {
        const expected = privateHashes.get(seq);
        if (
          !expected ||
          states.size !== expected.size ||
          [...states].some(([seat, state]) => toHex(hashValue(state)) !== expected.get(seat))
        )
          return failure(
            'audit-private-state',
            'Reconstructed private state differs from the omniscient replay',
            { seq },
          );
        return success(undefined);
      },
    });
    if (!crossCheck.ok) {
      const details = crossCheck.error.details;
      const seq =
        details &&
        typeof details === 'object' &&
        'seq' in details &&
        typeof details.seq === 'number'
          ? details.seq
          : context.log.head.seq;
      if (
        [
          'private-replay-failed',
          'private-replay-beacon',
          'crypto-context-required',
          'verified-private-missing',
          'audit-private-state',
        ].includes(crossCheck.error.code)
      )
        return processingFailure(seq, crossCheck.error.code);
      violations.push(issue(seq, null, crossCheck.error.code));
    } else {
      crossCheck.value.dispose();
      const counts: Partial<Record<Seat, number>> = {};
      for (const seat of genesis.config.seats) {
        const privateState = game.privateView(seat);
        const publicSeat = game.state.seats.find((item) => item.seat === seat);
        if (!privateState || !publicSeat)
          return processingFailure(context.log.head.seq, 'audit-final-private-state');
        counts[seat] = publicSeat.cardSlots.filter(
          (slot) => !slot.revealed && privateState.slots[slot.slotId] === 'victoryPoint',
        ).length;
      }
      finalHiddenVictoryPoints = counts;
    }
    complete = true;
    return report();
  } catch {
    return processingFailure(finalHead?.seq ?? 0, 'audit-internal-failure');
  } finally {
    for (const master of masters.values()) master.fill(0);
  }
}

```

## packages/protocol/src/p2p-session.ts

```ts
190:   }
191: 
192:   /**
193:    * First activation of a newly established game key only. The key owner must
194:    * retain it with this journal and use restore for every subsequent opening.
195:    * An empty replacement journal does not authorize reuse of an old raw key.
196:    */
197:   static create(options: P2PSessionOptions): Promise<Result<P2PSession>> {
198:     return P2PSession.open(options, false);
199:   }
200: 
201:   static restore(options: P2PSessionOptions): Promise<Result<P2PSession>> {
202:     return P2PSession.open(options, true);
203:   }
204: 
205:   private static async open(
206:     options: P2PSessionOptions,
207:     restoring: boolean,
208:   ): Promise<Result<P2PSession>> {
209:     let session: P2PSession | null = null;
210:     try {
211:       if (
212:         options.botDelayMs !== undefined &&
213:         (!Number.isFinite(options.botDelayMs) ||
214:           options.botDelayMs < 0 ||
215:           options.botDelayMs > 60_000)
216:       )
217:         return failure('session-bot-delay', 'Bot delay must be between zero and 60 seconds');
218:       const initial = initialProposalContext(options.genesisEntry, options.engine, options.policy);
219:       if (!initial.ok) return initial;
220:       const context = initial.value;
221:       if (!restoring) {
222:         const keys = validateSessionKeys(context.log, options);
223:         if (!keys.ok) return keys;
224:       }
225:       const ownedSeats = [options.seat, ...(options.botKeys?.keys() ?? [])];
226:       const driver = options.createDriver(
227:         options.engine,
228:         context.log.genesis,
229:         options.clock,
230:         ownedSeats,
231:       );
232:       session = new P2PSession(options, context, driver, context.log.head);
233:       for (const { seat } of context.log.genesis.seats) {
234:         const privateState = driver.privateState(seat);
235:         const owned = session.keys.has(seat);
236:         if (
237:           (owned && (!privateState || privateState.seat !== seat)) ||
238:           (!owned && context.log.genesis.security === 'verified' && privateState !== null)
239:         ) {
240:           session.dispose();
241:           return failure(
242:             'session-driver-seats',
243:             'Private driver ownership differs from local keys',
244:           );
245:         }
246:       }
247:       const sources = driver.validateSources?.();
248:       if (sources && !sources.ok) {
249:         session.dispose();
250:         return sources;
251:       }
252:       const openedSession = session;
253:       if (restoring) {
254:         const saved = await options.journal.load();
255:         if (!saved || entryHash(saved.genesis) !== entryHash(context.log.head)) {
256:           session.dispose();
257:           return failure('session-save', 'Saved certified history does not match this genesis');
258:         }
259:         session.replayingHistory = true;
260:         const replayed = replayCertifiedPrefix(
261:           saved.genesis,
262:           saved.entries,
263:           options.engine,
264:           options.policy,
265:           (validated, next) => openedSession.applyCommit(validated, next),
266:         );
267:         if (!replayed.ok) {
268:           session.dispose();
269:           return replayed;
270:         }
271:         session.replayingHistory = false;
272:         const reconciled = session.reconcileBotOwnership();
273:         if (!reconciled.ok) {
274:           session.dispose();
275:           return reconciled;
276:         }
277:         // A transfer can replace the same seat's genesis keys. Validate against
278:         // certified current ownership after private replay, before opening any
279:         // signing replica. Replica.restore independently checks safety and keys.
280:         const keys = validateSessionKeys(replayed.value.context.log, options);
281:         if (!keys.ok) {
282:           session.dispose();
283:           return keys;
284:         }
285:       }
286:       // Runtime callers may still pass raw proof callbacks despite the public type.
287:       // Only this session's owned private driver may supply that authority.
288:       const safeOptions = { ...options };
289:       Reflect.deleteProperty(safeOptions, 'countProof');
290:       Reflect.deleteProperty(safeOptions, 'stealContribution');
291:       Reflect.deleteProperty(safeOptions, 'stealResponse');
292:       Reflect.deleteProperty(safeOptions, 'tradeProof');
293:       Reflect.deleteProperty(safeOptions, 'onTradeProofResponse');
294:       Reflect.deleteProperty(safeOptions, 'onAuthorityChange');
295:       Reflect.deleteProperty(safeOptions, 'onMasterReveal');
350:                 failure('trade-proof-source', 'Trade proof driver is unavailable'),
351:             }
352:           : {}),
353:         onTradeProofResponse: (response) => openedSession.receiveTradeProof(response),
354:         onRecoveryCandidate: () => openedSession.emit([]),
355:         onTakeoverEligible: (seat) => openedSession.requestAutomaticTakeover(seat),
356:         onAuthorityChange: (current) => openedSession.installRecovery(current),
357:         onMasterReveal: ({ packet }) => {
358:           openedSession.auditReveals.set(packet.body.originalSeat, copyCanonical(packet));
359:           openedSession.maybeAudit();
360:         },
361:         onCommit: (validated, previous, next) => {
362:           const applied = openedSession.applyCommit(validated, next, previous.log);
363:           if (!applied.ok) {
364:             openedSession.status = { kind: 'error', message: applied.error.message };
365:             for (const seat of openedSession.tradeIntents.keys()) openedSession.cancelPending(seat);
366:             throw new Error(`${applied.error.code}: ${applied.error.message}`);
367:           }
368:           cacheCommittedPublicSnapshot(next, options.savePublicSnapshot);
369:           const activating =
370:             validated.entry.payload.kind === 'membership' &&
371:             next.log.recovery?.pending === null &&
372:             next.log.authority?.controllers.some(
373:               (controller) =>
374:                 controller.kind === 'bot' &&
375:                 controller.status === 'active' &&
376:                 controller.hostSeat === options.seat &&
377:                 controller.activatedAt.seq > 0 &&
378:                 !openedSession.keys.has(controller.seat),
379:             );
380:           if (activating) openedSession.recoveryInstalling = true;
381:           if (validated.entry.payload.kind !== 'membership') {
382:             const updated = options.onCertifiedNonMembershipCommit?.({
383:               seq: next.log.head.seq,
384:               hash: entryHash(next.log.head),
385:             });
386:             if (updated && !updated.ok)
387:               throw new Error(`Certified route bookkeeping failed: ${updated.error.code}`);
388:           }
389:           openedSession.emit(validated.events);
390:           openedSession.maybeAudit();
391:           if (!activating) openedSession.maybeAutomatic();
392:         },
393:         onStatus: (status) => {
394:           openedSession.protocolStatus = status;
395:           if (status.kind === 'halted') {
396:             openedSession.cancelAudit();
397:             openedSession.status = { kind: 'error', message: status.code };
398:             for (const seat of openedSession.tradeIntents.keys()) openedSession.cancelPending(seat);
399:             openedSession.clearBotTimer();
400:           } else if (status.kind === 'retired') {
401:             openedSession.cancelAudit();
402:             openedSession.status = {
403:               kind: 'error',
404:               message: 'This seat has a new controller. Its previous signing key is retired.',
405:             };
406:             for (const seat of openedSession.tradeIntents.keys()) openedSession.cancelPending(seat);
407:             openedSession.clearAutomaticRetry();
408:             openedSession.clearBotTimer();
409:             openedSession.releasePrivateState();
410:           }
411:           openedSession.emit([]);
412:         },
413:       };
414:       const replica = await (restoring
415:         ? ReplicatedLog.restore(replicaOptions)
416:         : ReplicatedLog.create(replicaOptions));
417:       if (!replica.ok) {
418:         session.dispose();
419:         return replica;
420:       }
421:       session.replica = replica.value;
422:       if (entryHash(replica.value.getContext().log.head) !== entryHash(session.context.log.head)) {
423:         session.dispose();
424:         return failure('session-replay-head', 'Certified journal changed during private replay');
425:       }
426:       session.schedulePrivateTimeout();
427:       session.maybeAutomatic();
428:       session.maybeAudit();
429:       return success(session);
430:     } catch (error) {
431:       session?.dispose();
432:       return failure('session-open', String(error));
433:     }
434:   }
435: 
436:   getState(): GameState {
437:     return this.options.engine.project(this.context.log.state, this.options.seat).state;
438:   }
439:   getCommittedHead(): { seq: number; hash: string } {
440:     return { seq: this.context.log.head.seq, hash: entryHash(this.context.log.head) };
441:   }
442:   getPrivate(seat: Seat): PrivateState | null {
443:     return this.status.kind === 'disposed' || !this.keys.has(seat)
444:       ? null
445:       : this.driver.privateState(seat);
1590:   private applyCommit(
1591:     entry: ValidatedEntry & CertifiedEntry,
1592:     next: ProposalContext,
1593:     before: LogContext = this.context.log,
1594:   ): Result<void> {
1595:     if (
1596:       entryHash(before.head) !== entryHash(this.context.log.head) ||
1597:       entry.entry.prevHash !== entryHash(before.head) ||
1598:       entry.entry.seq !== before.head.seq + 1
1599:     )
1600:       return failure('session-replay-head', 'Private state does not match the committed parent');
1601:     if (this.driver.committedEntry) {
1602:       const applied = this.driver.committedEntry(
1603:         detachedValidated(entry),
1604:         detachedLogContext(before),
1605:         detachedLogContext(next.log),
1606:       );
1607:       if (!applied.ok) return applied;
1608:     } else if (entry.input) {
1609:       const applied = this.driver.committed(
1610:         detachedLogContext(before),
1611:         copyCanonical(entry.input),
1612:         copyCanonical(next.log.state),
1613:       );
1614:       if (!applied.ok) return applied;
1615:     }
1616:     this.context = next;
1617:     if (!this.replayingHistory && entry.entry.payload.kind === 'membership') {
1618:       const reconciled = this.reconcileBotOwnership();
1619:       if (!reconciled.ok) return reconciled;
1620:     }
1621:     if (entry.input?.kind === 'command') this.verifiedMoves += 1;
1622:     for (const intent of this.tradeIntents.values())
1623:       intent.finishWait?.(failure('trade-proof-parent', 'The certified parent changed'));
1624:     this.clearAutomaticRetry();
1625:     this.clearBotTimer();
1626:     this.automaticParent = null;
1627:     this.automaticRetryDelay = 250;
1628:     if (this.protocolStatus?.kind === 'halted' || this.protocolStatus?.kind === 'rejected')
1629:       this.protocolStatus = null;
1630:     if (this.protocolStatus?.kind === 'sync' && next.log.head.seq >= this.protocolStatus.fromSeq)
1631:       this.protocolStatus = null;
1632:     this.events.push(...entry.events);
1633:     this.status = next.log.recovery?.void
1634:       ? { kind: 'void' }
1635:       : next.log.state.result
1636:         ? { kind: 'complete' }
1637:         : { kind: 'running' };
1638:     this.schedulePrivateTimeout();
1639:     return success(undefined);
1640:   }
1641: 
1642:   private maybeAutomatic(): void {
1643:     if (
1644:       this.automaticScheduled ||
1645:       !this.replica ||
1646:       this.status.kind !== 'running' ||
1647:       this.recoveryInstalling
1648:     )
1649:       return;
1650:     this.automaticScheduled = true;
```

## packages/protocol/src/replicated-log.ts

```ts
350:     this.secretKey = local.signingKey;
351:     this.deckKeys = local.keys;
352:     this.deckSetupPasses = local.passes;
353:     this.createDeckSource = options.createDeckSource;
354:     this.timerObserver = new LocalTimerObserver(options.clock, context.log.timers ?? []);
355:     if (options.beaconSource) this.beaconSources.set(options.seat, options.beaconSource);
356:     for (const [seat, source] of options.beaconSources ?? []) this.beaconSources.set(seat, source);
357:     const identity = identityFromSecret(this.secretKey);
358:     this.self = identity.peerId;
359:     identity.secretKey.fill(0);
360:     this.refreshHistoricalHumanPeers();
361:   }
362: 
363:   static async create(options: ReplicatedLogOptions): Promise<Result<ReplicatedLog>> {
364:     const initial = initialProposalContext(options.genesisEntry, options.engine, options.policy);
365:     if (!initial.ok) return initial;
366:     const key = checkLocalKey(options, initial.value);
367:     if (!key.ok) return key;
368:     for (const keyBytes of key.value.keys.values()) keyBytes.fill(0);
369:     const safety = createConsensusState(initial.value, options.seat);
370:     if (!safety.ok) return safety;
371:     try {
372:       const initialized = await options.journal.initialize(
373:         initial.value.log.head,
374:         canonicalEncode(safety.value),
375:       );
376:       if (!initialized)
377:         return failure(
378:           'replica-exists',
379:           'Restore the existing certified journal instead of reinitializing it',
380:         );
381:     } catch {
382:       return failure(
383:         'replica-storage',
384:         'Could not initialize the certified journal and voting record',
385:       );
386:     }
387:     return ReplicatedLog.restore(options);
388:   }
389: 
390:   static async restore(options: ReplicatedLogOptions): Promise<Result<ReplicatedLog>> {
391:     let record: Awaited<ReturnType<ProtocolJournal['load']>>;
392:     try {
393:       record = await options.journal.load();
394:     } catch {
395:       return failure('replica-storage', 'Could not read the certified journal');
396:     }
397:     if (!record) return failure('replica-missing', 'Certified journal or safety state is missing');
398:     const requested = initialProposalContext(options.genesisEntry, options.engine, options.policy);
399:     if (!requested.ok) return requested;
400:     if (!sameBytes(canonicalEncode(requested.value.log.head), canonicalEncode(record.genesis)))
401:       return failure('replica-genesis', 'Requested genesis differs from the certified journal');
402:     const replayed = replayCertifiedPrefix(
403:       record.genesis,
404:       record.entries,
405:       options.engine,
406:       options.policy,
407:     );
408:     if (!replayed.ok) return replayed;
409:     const context = replayed.value.context;
410:     if (record.height !== context.log.head.seq + 1 || !record.safety)
411:       return failure('replica-journal', 'Certified prefix and active safety height disagree');
412:     let localPublicKey: string;
413:     try {
414:       const identity = identityFromSecret(options.secretKey);
415:       localPublicKey = identity.peerId;
416:       identity.secretKey.fill(0);
417:     } catch {
418:       return failure('replica-key', 'Local signing key is invalid');
419:     }
420:     if (
421:       !context.membership.voters.some(
422:         (voter) => voter.seat === options.seat && voter.publicKey === localPublicKey,
423:       )
424:     ) {
425:       let marker: unknown;
426:       try {
427:         marker = canonicalDecode(record.safety.bytes);
428:       } catch {
429:         return failure('replica-retirement', 'Retired signing record is malformed');
430:       }
431:       const checked = restoreRetiredSafety(marker, context, options.seat, localPublicKey);
432:       if (!checked.ok) return checked;
433:       return failure('replica-retired', 'This signing key was retired by certified membership');
434:     }
435:     const key = checkLocalKey(options, context);
436:     if (!key.ok) return key;
437:     const replica = new ReplicatedLog(
438:       options,
439:       record.genesis,
440:       context,
441:       replayed.value.entries,
442:       key.value,
443:     );
444:     const opened = await replica.openController();
445:     if (!opened.ok) {
446:       replica.dispose();
447:       return opened;
448:     }
449:     const initialized = await replica.enqueue(async () => {
450:       const installed = await replica.installAuthorityOwnership();
451:       if (!installed.ok) return installed;
452:       const recovered = await replica.recoverPersistedAccusation();
453:       if (!recovered.ok) return recovered;
454:       const cheats = await replica.recoverCheatCandidates();
455:       if (!cheats.ok) return cheats;
456:       replica.attachTransport();
457:       replica.observeAllRecoveryPresence();
458:       replica.broadcastNextCheatClaim();
459:       const resumed = await replica.activeController().resume();
460:       if (!resumed.ok) return resumed;
461:       await replica.captureCertifiedDelivery();
462:       const offered = await replica.offerAvailableInput();
463:       if (!offered.ok) return offered;
464:       // A one-shot commit hint can arrive before restore attaches its listener.
465:       // Request the next certified height while an authenticated peer is present.
466:       return replica.requestSync(replica.context.log.head.seq + 1);
467:     });
468:     if (!initialized.ok) {
469:       replica.dispose();
470:       return initialized;
471:     }
472:     replica.schedulePulse();
473:     return success(replica);
474:   }
475: 
476:   /** Detached public context. The certified prefix remains the only authority. */
477:   getContext(): ProposalContext {
478:     return detachedContext(this.context);
479:   }
480: 
3580:       if (!snapshot.ok) return snapshot;
3581:     }
3582:     if (snapshot.value.halted || snapshot.value.decision) return success(undefined);
3583:     if (snapshot.value.pendingAccusation)
3584:       return this.rememberAccusation(snapshot.value.pendingAccusation);
3585:     const evidence = snapshot.value.equivocations[0];
3586:     return evidence
3587:       ? this.rememberAccusation(controlForEquivocation(evidence))
3588:       : success(undefined);
3589:   }
3590: 
3591:   private async handleEffects(effects: readonly ConsensusEffect[], index = 0): Promise<void> {
3592:     const effect = effects[index];
3593:     if (!effect) return;
3594:     switch (effect.kind) {
3595:       case 'broadcast-proposal':
3596:         this.requireSend(this.broadcast({ t: 'PROPOSAL', proposal: effect.proposal }));
3597:         break;
3598:       case 'broadcast-vote':
3599:         this.requireSend(this.broadcast({ t: 'VOTE', vote: effect.vote }));
3600:         break;
3601:       case 'schedule-timeout':
3602:         this.scheduleConsensusTimeout(effect.phase, effect.round);
3603:         break;
3604:       case 'request-value':
3605:         void this.enqueue(() => this.maybePropose());
3606:         break;
3607:       case 'request-proposal':
3608:         this.requireSend(
3609:           this.broadcast({
3610:             t: 'PROPOSAL_REQ',
3611:             genesisDigest: this.context.membership.genesisDigest,
3612:             epoch: this.context.membership.epoch,
3613:             seq: this.context.log.head.seq + 1,
3614:             term: effect.round,
3615:             valueHash: effect.hash,
3616:           }),
3617:         );
3618:         break;
3619:       case 'commit':
3620:         await this.persistCommit(effect.certified);
3621:         break;
3622:       case 'equivocation': {
3623:         void this.enqueue(() => this.rememberAccusation(controlForEquivocation(effect.evidence)));
3624:         break;
3625:       }
3626:       case 'halt': {
3627:         this.status({ kind: 'halted', code: effect.reason });
3628:         const state = this.activeController().snapshot();
3629:         if (state.ok && state.value.haltKind === 'certified-validation')
3630:           this.requireSend(
3631:             this.broadcast({
3632:               t: 'SNAPSHOT_REQ',
3633:               genesisDigest: this.context.membership.genesisDigest,
3634:               atSeq: this.context.log.head.seq,
3635:             }),
3636:           );
3637:         break;
3638:       }
3639:     }
3640:     await this.handleEffects(effects, index + 1);
3641:   }
3642: 
3643:   private async persistCommit(certified: CertifiedEntry): Promise<void> {
3644:     const previous = this.context;
3645:     const checked = validateCertifiedEntry(certified, previous);
3646:     if (!checked.ok) throw new Error(`Certified entry failed replay: ${checked.error.code}`);
3647:     const advanced = advanceContext(previous, checked.value);
3648:     if (!advanced.ok) throw new Error(`Certified context failed: ${advanced.error.code}`);
3649:     const next = advanced.value;
3650:     const prior = this.activeController().snapshot();
3651:     if (!prior.ok) throw new Error(`Voting record failed: ${prior.error.code}`);
3652:     const controlProof =
3653:       checked.value.entry.payload.kind === 'control'
3654:         ? objectiveProofParentHash(checked.value.entry.payload, previous)
3655:         : null;
3680:       !current ||
3681:       current.revision !== this.activeController().persistedRevision() ||
3682:       !sameBytes(current.bytes, canonicalEncode(snapshot.value)) ||
3683:       !(await this.options.journal.commit(
3684:         certified.entry.seq,
3685:         this.activeController().persistedRevision(),
3686:         certified,
3687:         canonicalEncode(nextSafety.value),
3688:       ))
3689:     )
3690:       throw new Error('Certified journal commit lost its safety CAS');
3691:     this.activeController().dispose();
3692:     this.context = next;
3693:     this.observeAllRecoveryPresence();
3694:     if (checked.value.entry.payload.kind === 'membership') this.pruneRetiredBotOwnership();
3695:     this.timerObserver.advance(next.log.timers ?? []);
3696:     this.clearTimedVoteRetry();
3697:     this.clearRecoveryCandidate();
3698:     this.pendingTradeProofs.clear();
3699:     this.tradeProofResponses.clear();
3700:     this.tradeProofRequestsByFinalizer.clear();
3701:     this.entries.push({ entry: checked.value.entry, certificate: [...checked.value.certificate] });
3702:     this.rememberHumanActivation(checked.value.entry);
3703:     if (checked.value.entry.payload.kind === 'cheat-proof') {
3704:       const id = cheatCandidateId(checked.value.entry.payload.claim);
3705:       this.cheatCandidates.delete(id);
3706:       try {
3707:         await this.options.cheatCandidateStore?.delete(id);
3708:       } catch {
3709:         // A stale auxiliary record is removed during restore after certified replay.
3710:       }
3711:     }
3712:     if (this.lastSyncRequest && next.log.head.seq >= this.lastSyncRequest.fromSeq)
3713:       this.lastSyncRequest = null;
3714:     this.commands.length = 0;
3715:     this.rejectedCommands.clear();
3716:     this.rejectedProposals.clear();
3717:     this.rejectedDeckContributions.clear();
3718:     this.rejectedCountContributions.clear();
3719:     this.rejectedStealMessages.clear();
3720:     this.sentCountContributions.clear();
3721:     this.sentBeaconOperations.clear();
3722:     this.preparedRecovery = null;
3723:     this.sentRecoveryPackets.clear();
3724:     this.accusation = pendingAccusation;
3725:     this.clearConsensusTimers();
3726:     this.refreshPreparedStealStage();
3727:     if (!retired) {
3728:       const opened = await this.openController();
3729:       if (!opened.ok) throw new Error(`Next voting controller failed: ${opened.error.code}`);
3730:     }
3731:     try {
3732:       this.options.onCommit?.(
3733:         detachedValidated(checked.value),
3734:         detachedContext(previous),
3735:         detachedContext(next),
3736:       );
3737:     } catch {
3738:       this.status({ kind: 'halted', code: 'commit-application' });
3739:       this.dispose();
3740:       throw new Error('Committed private-state application failed');
3741:     }
3742:     if (!retired && checked.value.entry.payload.kind === 'membership') {
3743:       const installed = await this.installAuthorityOwnership();
3744:       if (!installed.ok) {
3745:         this.status({ kind: 'halted', code: installed.error.code });
3746:         this.dispose();
3747:         throw new Error(`Certified recovery key installation failed: ${installed.error.code}`);
3748:       }
3749:     }
3750:     this.settlePending(certified);
3751:     const sent = this.broadcast({ t: 'COMMIT', certified });
3752:     if (retired) {
3753:       if (!sent.ok) this.status({ kind: 'rejected', code: sent.error.code });
3754:     } else this.requireSend(sent);
3755:     if (checked.value.entry.payload.kind === 'membership') {
3756:       try {
3757:         const routed = this.options.onMembershipCommitted?.(this.getEntries());
3758:         if (routed && !routed.ok) throw new Error(routed.error.code);
3759:       } catch {
3760:         this.status({ kind: 'halted', code: 'membership-routing' });
3761:         this.dispose();
3762:         throw new Error('Certified membership routing failed');
3763:       }
3764:     }
3765:     // Report a matching membership commit only after the final COMMIT is sent
3766:     // on the old route and the new route is installed. A failed hook disposes
3767:     // with an outcome-unknown result instead of reporting false success.
3768:     this.settleMembership(certified);
3769:     if (retired) {
3770:       this.status({ kind: 'retired', seat: this.options.seat });
3771:       this.dispose();
3772:       return;
3773:     }
3774:     if (pendingAccusation)
3775:       this.requireSend(this.broadcast({ t: 'ACCUSE', control: pendingAccusation }));
3776:     void this.enqueue(async () => {
3777:       await this.captureCertifiedDelivery();
3778:       return this.offerAvailableInput();
3779:     });
3780:   }
3781: 
3782:   private settlePending(certified: CertifiedEntry): void {
3783:     const committed =
3784:       certified.entry.payload.kind === 'command'
3785:         ? commandHash(certified.entry.payload.signed)
```

## Runner diff from committed source

```diff
diff --git a/tools/sim/src/net.ts b/tools/sim/src/net.ts
index f09c668..2007701 100644
--- a/tools/sim/src/net.ts
+++ b/tools/sim/src/net.ts
@@ -35,6 +35,12 @@ import type { VerifiedNonVoterActor } from '@cp2p/protocol/testing';
 import { deriveSeed } from './random-source.js';
 import { invalidCommandProposal } from './net-adversary.js';
 import { NonVoterCommand } from './non-voter-command.js';
+import {
+  PersistenceLifecycle,
+  observeRestoredJournal,
+  restartEvidence,
+} from './persistence-lifecycle.js';
+import type { LifecycleRestart } from './persistence-lifecycle.js';
 import { observeOutgoingTransport } from './observed-transport.js';
 
 export interface NetworkGameOptions {
@@ -45,6 +51,8 @@ export interface NetworkGameOptions {
   /** Stage 07 acceptance uses genuine private sources and proofs on the same fault schedules. */
   security?: 'stub' | 'verified';
   maxElapsedMs?: number;
+  /** Representative Stage 10 persistence trace on the clean verified four-human game. */
+  lifecycle?: 'persistence';
   onProgress?: (progress: {
     revision: number;
     turn: number;
@@ -72,6 +80,17 @@ export interface NetworkGameResult {
     finalHead: { seq: number; hash: string };
     cheatFindings: AuditReport['cheatFindings'];
   }[];
+  lifecycle?: {
+    profile: 'persistence';
+    restarts: readonly LifecycleRestart[];
+    privateStates: {
+      capturedSequences: number;
+      capturedSnapshots: number;
+      checkedSequences: number;
+      repeatedSnapshots: number;
+      snapshotDigest: string;
+    };
+  };
   faultInjected: boolean;
   faultRecovered: boolean;
   faultEvidence: {
@@ -101,10 +120,18 @@ function unwrap<T>(result: Result<T>): T {
 export async function runNetworkGame(options: NetworkGameOptions): Promise<NetworkGameResult> {
   if (!Number.isInteger(options.scenario) || options.scenario < 1 || options.scenario > 9)
     throw new Error('This network scenario is not implemented yet');
+  if (options.lifecycle && (options.security !== 'verified' || options.scenario !== 1))
+    throw new Error('Persistence lifecycle requires clean scenario 1 with verified security');
+  const lifecycle = options.lifecycle ? new PersistenceLifecycle() : null;
+  let lifecycleObservedRevision = -1;
   const started = performance.now();
   const verified =
     options.security === 'verified'
-      ? createVerifiedNetworkFixture({ seed: options.seed, gameIndex: options.gameIndex })
+      ? createVerifiedNetworkFixture({
+          seed: options.seed,
+          gameIndex: options.gameIndex,
+          verifyLivePrivateStates: lifecycle !== null,
+        })
       : null;
   const game =
     verified ?? createSimulationGenesis({ seed: options.seed, gameIndex: options.gameIndex });
@@ -437,19 +464,37 @@ export async function runNetworkGame(options: NetworkGameOptions): Promise<Netwo
     nonVoterWake = network.clock.setTimeout(wakeNonVoter, 250);
   }
 
-  async function open(seat: Seat, restoring: boolean): Promise<void> {
+  async function open(
+    seat: Seat,
+    restoring: boolean,
+    restoreJournal?: P2PSessionOptions['journal'],
+    restoreEvidence?: LifecycleRestart['restored'][number],
+  ): Promise<void> {
     const identity = game.identities.get(seat);
     const journal = journals.get(seat);
     if (!identity || !journal) throw new Error('Missing simulation identity or journal');
+    const transport = peerTransport(seat);
+    const restoredTransport = restoreEvidence
+      ? observeOutgoingTransport(transport, (bytes) => {
+          const parsed = decodeProtocolMessage(bytes);
+          if (parsed.ok && (parsed.value.t === 'PROPOSAL' || parsed.value.t === 'VOTE')) {
+            if (!restoreEvidence.loadedBeforeVoting) {
+              restoreEvidence.orderingViolations += 1;
+              throw new Error('Restored session voted before validating its retained journal');
+            }
+            restoreEvidence.votingMessagesAfterLoad += 1;
+          }
+        })
+      : transport;
     const sessionOptions: P2PSessionOptions = {
       genesisEntry: game.entry,
       engine: game.engine,
       policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
       seat,
       secretKey: identity.secretKey,
-      transport: peerTransport(seat),
+      transport: restoredTransport,
       clock: network.clock,
-      journal,
+      journal: restoreJournal ?? journal,
       createDriver: (
         engine: typeof game.engine,
         genesis: typeof game.genesis,
@@ -464,6 +509,57 @@ export async function runNetworkGame(options: NetworkGameOptions): Promise<Netwo
     sessions.set(seat, session);
   }
 
+  async function restartLifecycle(event: LifecycleRestart): Promise<void> {
+    const records = new Map<
+      Seat,
+      NonNullable<Awaited<ReturnType<MemoryProtocolJournal['load']>>>
+    >();
+    const preCrashHeads = new Map<Seat, { seq: number; hash: string }>();
+    for (const seat of event.seats) {
+      const session = sessions.get(seat);
+      if (!session || session.getCommittedHead().seq !== event.seq)
+        throw new Error('Lifecycle restart requires a common certified head');
+      preCrashHeads.set(seat, session.getCommittedHead());
+    }
+    for (const seat of event.seats) crash(seat);
+    if (event.kind === 'everyone-left' && sessions.size !== 0)
+      throw new Error('Everyone-left trace did not close every session');
+    for (const seat of event.seats) {
+      const journal = journals.get(seat);
+      if (!journal) throw new Error('Missing lifecycle journal');
+      // oxlint-disable-next-line no-await-in-loop -- Observe the retained safety after disposal stops queued consensus work.
+      const record = await journal.load();
+      const preCrash = preCrashHeads.get(seat);
+      if (
+        !record ||
+        record.height !== event.seq + 1 ||
+        entryHash(record.entries.at(-1)?.entry ?? record.genesis) !== preCrash?.hash
+      )
+        throw new Error('Retained lifecycle journal differs from its pre-crash committed head');
+      records.set(seat, record);
+    }
+    for (const seat of event.seats) {
+      const identity = game.identities.get(seat);
+      const journal = journals.get(seat);
+      const record = records.get(seat);
+      if (!identity || !journal || !record) throw new Error('Missing lifecycle restore record');
+      network.restart(identity.peerId);
+      const evidence = restartEvidence(seat, record);
+      event.restored.push(evidence);
+      // oxlint-disable-next-line no-await-in-loop -- Fixed non-seat order is part of the everyone-left trace.
+      await open(seat, true, observeRestoredJournal(journal, record, evidence), evidence);
+      const head = sessions.get(seat)?.getCommittedHead();
+      if (
+        !evidence.loadedBeforeVoting ||
+        evidence.orderingViolations !== 0 ||
+        head?.seq !== event.seq ||
+        head.hash !== evidence.headHash
+      )
+        throw new Error('Lifecycle restore changed its exact certified head');
+      offline.delete(seat);
+    }
+  }
+
   function crash(seat: Seat): void {
     const identity = game.identities.get(seat);
     if (!identity) throw new Error('Missing crashed peer');
@@ -700,6 +796,34 @@ export async function runNetworkGame(options: NetworkGameOptions): Promise<Netwo
         }
       const latest = [...updates.values()].toSorted((a, b) => b.revision - a.revision)[0];
       if (!latest) throw new Error('No peer state available');
+      const lifecycleHead = lifecycle ? sessions.values().next().value?.getCommittedHead() : null;
+      if (
+        lifecycle &&
+        sessions.size === 4 &&
+        [...sessions.values()].every(
+          (session) =>
+            session.getCommittedHead().seq === latest.revision &&
+            session.getCommittedHead().hash === lifecycleHead?.hash,
+        )
+      ) {
+        if (latest.revision !== lifecycleObservedRevision) {
+          lifecycleObservedRevision = latest.revision;
+          if (lifecycle.restarts.some((event) => event.continuedAtSeq === null)) {
+            const history = sessions.values().next().value?.exportSave().entries;
+            if (!history) throw new Error('Lifecycle certified history is missing');
+            lifecycle.observe(history);
+          }
+        }
+        if ((!submission || submission.result?.ok) && !latest.state.result) {
+          const restart = lifecycle.next(latest.revision, latest.state.turn.number);
+          if (restart) {
+            submission = null;
+            // oxlint-disable-next-line no-await-in-loop -- Dispose and restore whole sessions before the next virtual delivery.
+            await restartLifecycle(restart);
+            continue;
+          }
+        }
+      }
       // oxlint-disable-next-line no-await-in-loop -- Crash recovery must restore durable journals before the next delivery.
       await advanceFault(latest);
       if (verified && options.scenario === 6 && byzantineHalted && faultRecovered) {
@@ -875,7 +999,26 @@ export async function runNetworkGame(options: NetworkGameOptions): Promise<Netwo
             });
           }
         }
+        let lifecycleEvidence: NetworkGameResult['lifecycle'];
+        if (lifecycle && verified) {
+          lifecycle.finish(latest.revision);
+          const privateStates = verified.privateStateEvidence();
+          if (
+            privateStates.checkedSequences !== latest.revision + 1 ||
+            privateStates.capturedSnapshots !== (latest.revision + 1) * 4 ||
+            privateStates.repeatedSnapshots === 0
+          )
+            throw new Error(
+              'Lifecycle private-state comparison did not cover every owned certified state',
+            );
+          lifecycleEvidence = {
+            profile: 'persistence',
+            restarts: lifecycle.restarts,
+            privateStates,
+          };
+        }
         return {
+          ...(lifecycleEvidence ? { lifecycle: lifecycleEvidence } : {}),
           security: game.genesis.security,
           protocolVersion: game.genesis.protocolVersion,
           seed: options.seed,

```
