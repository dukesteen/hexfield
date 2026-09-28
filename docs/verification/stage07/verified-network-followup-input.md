Read-only follow-up security/correctness review of a TEST-ONLY real-cryptography network runner and non-voting seat actor. Previous review identified per-loop contribution floods, missing automatic victory commands, missing SUBMIT retry, actor async/prefix races and insufficient acceptance assertions. Current source below incorporates fixes. Focus on concrete remaining defects, especially how the runner schedules retries and handles asynchronous head changes, strict 3-of-4 certificates after proposer exclusion, per-seat private authority, and honest terminal audits. The actor focused test has SYNTHETIC quorum-certified exclusion/next command, explicitly not live replica acceptance. Scenario6 live full-game is still pending; don't interpret that test as proof of it. Alternate wrapper reuse retains a previously validated signed entry, not a new certificate. This code never ships to browser gameplay. Don't alter files or use tools. Return findings with severity/path/why, and distinguish test limitations from actual correctness defects. Do not request repeated unrelated full suites.


### tools/sim/src/net.ts
```
import { RandomBot, createBotRng } from '@cp2p/bots';
import { canonicalDecode, hashValue, toHex } from '@cp2p/codec';
import { success } from '@cp2p/engine';
import type { GameState, Pending, PrivateState, Result, Seat } from '@cp2p/engine';
import {
  MemoryProtocolJournal,
  P2PSession,
  decodeProtocolMessage,
  encodeProtocolMessage,
  entryHash,
  genesisDigest,
  initialProposalContext,
  proposerFor,
  quorumSize,
  replayCertifiedPrefix,
  signCommand,
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

export interface NetworkGameOptions {
  seed: number;
  gameIndex: number;
  scenario: number;
  maxSteps?: number;
  /** Stage 07 acceptance uses genuine private sources and proofs on the same fault schedules. */
  security?: 'stub' | 'verified';
  maxElapsedMs?: number;
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
  const started = performance.now();
  const verified =
    options.security === 'verified'
      ? createVerifiedNetworkFixture({ seed: options.seed, gameIndex: options.gameIndex })
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
  let nonVoterPublishedMaster = false;
  const nonVoterMessageTypes = new Set<string>();
  let byzantinePrivateCache: {
    revision: number;
    privateState: PrivateState;
    context: ProposalContext;
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
    if (['PROPOSAL', 'VOTE', 'COMMIT'].includes(message.t))
      throw new Error(`Excluded non-voter emitted ${message.t}`);
    if (message.t === 'MASTER_REVEAL') {
      if (message.reveal.body.publisherSeat !== 0 || message.reveal.body.originalSeat !== 0)
        throw new Error('Excluded actor published a foreign master');
      nonVoterPublishedMaster = true;
    }
  }

  function nonVoterTransport(peerId: string): Transport {
    const transport = network.transport(peerId);
    return {
      ...transport,
      send(to, bytes) {
        observeNonVoterMessage(bytes);
        transport.send(to, bytes);
      },
      broadcast(bytes) {
        observeNonVoterMessage(bytes);
        transport.broadcast(bytes);
      },
    };
  }

  async function open(seat: Seat, restoring: boolean): Promise<void> {
    const identity = game.identities.get(seat);
    const journal = journals.get(seat);
    if (!identity || !journal) throw new Error('Missing simulation identity or journal');
    const sessionOptions: P2PSessionOptions = {
      genesisEntry: game.entry,
      engine: game.engine,
      policy: { genesis: { allowStub: true }, entry: { allowStub: true } },
      seat,
      secretKey: identity.secretKey,
      transport: peerTransport(seat),
      clock: network.clock,
      journal,
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
    if (byzantinePrivateCache?.revision === history.length) return byzantinePrivateCache;
    const driver = new SimulationDriver(game.engine, game.genesis, network.clock);
    let before = unwrap(
      initialProposalContext(game.entry, game.engine, {
        genesis: { allowStub: true },
        entry: { allowStub: true },
      }),
    );
    const replayed = unwrap(
      replayCertifiedPrefix(
        game.entry,
        history,
        game.engine,
        { genesis: { allowStub: true }, entry: { allowStub: true } },
        (entry, next) => {
          const applied = entry.input
            ? driver.committed(before.log, entry.input, next.log.state)
            : success(undefined);
          if (applied.ok) before = next;
          return applied;
        },
      ),
    );
    if (replayed.context.log.head.seq !== history.length)
      throw new Error('Byzantine actor replay did not reach the certified head');
    const privateState = driver.privateState(0);
    if (!privateState) throw new Error('Byzantine actor lost its own private hand');
    byzantinePrivateCache = { revision: history.length, privateState, context: replayed.context };
    return byzantinePrivateCache;
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
        if (nonVoterCommand && submission?.seat === 0) {
          nonVoterCommand.pump(network.clock.now(), honestHead);
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
            if (
              audit.report.cheatFindings.some(
                (finding) => options.scenario !== 6 || finding.seat !== 0,
              )
            )
              throw new Error(`Verified peer ${seat} reported misconduct by an honest player`);
            audits.push({
              seat,
              ok: true,
              complete: true,
              finalHead: audit.report.finalHead,
              cheatFindings: audit.report.cheatFindings,
            });
          }
        }
        return {
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
            nonVoterMessageTypes: [...nonVoterMessageTypes].sort(),
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
        const pending = choosePending(
          latest.state,
          game.engine.getPending(latest.state),
          options.scenario === 6 && byzantineHalted && faultRecovered ? 0 : null,
        );
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
          const automatic = game.engine.getAutomaticInput(
            latest.state,
            new Map([[0 as Seat, privateState]]),
          );
          const chosen =
            automatic?.kind === 'command' && automatic.seat === 0
              ? automatic.command
              : actor.bot.decide(
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


### tools/sim/src/non-voter-command.ts
```
import { failure } from '@cp2p/engine';
import type { CommandShape, Result } from '@cp2p/engine';
import type { SignedCommand } from '@cp2p/protocol';
import type { VerifiedNonVoterActor } from '@cp2p/protocol/testing';

const RETRY_MS = 250;

/** Keep one intent while virtual deliveries run, resending only at its original parent. */
export class NonVoterCommand {
  readonly #actor: Pick<VerifiedNonVoterActor, 'submit'>;
  readonly #command: CommandShape;
  readonly #parent: { seq: number; hash: string };
  #result: Result<SignedCommand> | null = null;
  #inFlight = false;
  #cancelled = false;
  #retryAt = -Infinity;

  constructor(
    actor: Pick<VerifiedNonVoterActor, 'submit'>,
    command: CommandShape,
    parent: { seq: number; hash: string },
  ) {
    this.#actor = actor;
    this.#command = command;
    this.#parent = { ...parent };
  }

  result(): Result<SignedCommand> | null {
    return this.#result;
  }

  pump(now: number, head: { seq: number; hash: string }): void {
    if (head.seq !== this.#parent.seq || head.hash !== this.#parent.hash) {
      this.#result ??= failure(
        'non-voter-stale-head',
        'Actor submission parent is no longer current',
      );
      this.cancel();
      return;
    }
    if (this.#cancelled || this.#inFlight || now < this.#retryAt || this.#result?.ok === false)
      return;
    this.#inFlight = true;
    this.#retryAt = now + RETRY_MS;
    // Do not await here: preparing a trade needs future virtual network deliveries.
    void Promise.resolve()
      .then(() => this.#actor.submit(this.#command, this.#parent))
      .then((result) => {
        if (!this.#cancelled) this.#result = result;
        return undefined;
      })
      .catch(() => {
        if (!this.#cancelled)
          this.#result = failure('non-voter-submit-threw', 'Actor submission threw unexpectedly');
      })
      .finally(() => {
        this.#inFlight = false;
      });
  }

  cancel(): void {
    this.#cancelled = true;
  }
}

```


### tools/sim/src/non-voter-command.test.ts
```
import { describe, expect, test, vi } from 'vitest';
import { success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { signCommand } from '@cp2p/protocol';
import type { SignedCommand } from '@cp2p/protocol';
import { createSimulationGenesis } from '@cp2p/protocol/testing';
import type { VerifiedNonVoterActor } from '@cp2p/protocol/testing';
import { genesisDigest, entryHash } from '@cp2p/protocol';
import { NonVoterCommand } from './non-voter-command.js';

const fixture = createSimulationGenesis({ seed: 42 });
const identity = fixture.identities.get(0);
if (!identity) throw new Error('Missing fixture identity');
const parent = { seq: 0, hash: entryHash(fixture.entry) };
const command = { type: 'END_TURN' };
const signed = signCommand(
  {
    gameId: fixture.genesis.gameId,
    genesisDigest: genesisDigest(fixture.genesis),
    seat: 0,
    nonce: 1,
    headSeq: parent.seq,
    headHash: parent.hash,
    command,
  },
  identity.secretKey,
);
identity.secretKey.fill(0);

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    // oxlint-disable-next-line no-await-in-loop -- Drain the queued submit and completion microtasks.
    await Promise.resolve();
  }
}

describe('non-voter command delivery', () => {
  test('retries a dropped SUBMIT at the same parent without flooding each network delivery', async () => {
    const submit = vi.fn<VerifiedNonVoterActor['submit']>(async () => success(signed));
    const delivery = new NonVoterCommand({ submit }, command, parent);
    delivery.pump(0, parent);
    await settle();
    expect(delivery.result()).toEqual(success(signed));
    for (let now = 1; now < 250; now++) delivery.pump(now, parent);
    expect(submit).toHaveBeenCalledTimes(1);
    delivery.pump(250, parent);
    await settle();
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0]).toEqual(submit.mock.calls[1]);
    delivery.pump(500, { seq: 1, hash: 'new-certified-head' });
    delivery.pump(750, parent);
    await settle();
    expect(submit).toHaveBeenCalledTimes(2);
    // The caller can still count the signed command that the new head certified.
    expect(delivery.result()).toEqual(success(signed));
  });

  test('keeps async trade preparation singular and discards its late result after a same-height fork', async () => {
    let finish: ((value: Result<SignedCommand>) => void) | undefined;
    const submit = vi.fn<VerifiedNonVoterActor['submit']>(
      () =>
        new Promise<Result<SignedCommand>>((resolve) => {
          finish = resolve;
        }),
    );
    const delivery = new NonVoterCommand({ submit }, command, parent);
    delivery.pump(0, parent);
    await settle();
    delivery.pump(1000, parent);
    expect(submit).toHaveBeenCalledTimes(1);
    delivery.pump(1001, { ...parent, hash: 'different-same-height-parent' });
    finish?.(success(signed));
    await settle();
    expect(delivery.result()).toMatchObject({ ok: false, error: { code: 'non-voter-stale-head' } });
  });

  test('surfaces a thrown submit as a failure instead of leaving the game waiting forever', async () => {
    const submit = vi.fn<VerifiedNonVoterActor['submit']>(() => {
      throw new Error('prepare failed');
    });
    const delivery = new NonVoterCommand({ submit }, command, parent);
    delivery.pump(0, parent);
    await settle();
    expect(delivery.result()).toMatchObject({
      ok: false,
      error: { code: 'non-voter-submit-threw' },
    });
    delivery.pump(1000, parent);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

```


### tools/sim/src/net-adversary.ts
```
import { identityFromSecret, parsePeerId, verifyObject } from '@cp2p/crypto';
import {
  entryBody,
  genesisDigest,
  proposerFor,
  signCommand,
  signEntry,
  signProposal,
} from '@cp2p/protocol';
import type { Genesis, SignedProposal } from '@cp2p/protocol';
import type { Seat } from '@cp2p/engine';

/** Replaces only the Byzantine proposer's outbound proposal with signed objective misconduct. */
export function invalidCommandProposal(
  original: SignedProposal,
  genesis: Genesis,
  offenderSeat: Seat,
  offenderKey: Uint8Array,
): SignedProposal {
  const offender = genesis.seats.find((seat) => seat.seat === offenderSeat);
  const identity = identityFromSecret(offenderKey);
  const entry = original.body.entry;
  const digest = genesisDigest(genesis);
  if (
    offender?.kind !== 'human' ||
    offender.publicKey !== identity.peerId ||
    original.body.genesisDigest !== digest ||
    original.body.epoch !== 0 ||
    entry.seq < 1 ||
    !Number.isSafeInteger(entry.seq) ||
    entry.term < 1 ||
    !Number.isSafeInteger(entry.term) ||
    entry.sequencer !== identity.peerId ||
    original.body.validRound !== null ||
    original.body.prevotes.length !== 0
  )
    throw new Error('The fault hook requires this voter’s unjustified current proposal');
  const voters = genesis.seats
    .filter((seat) => seat.kind === 'human')
    .map((seat) => ({ seat: seat.seat, publicKey: seat.publicKey }));
  if (
    proposerFor(entry.seq, entry.term, { genesisDigest: digest, epoch: 0, voters }).seat !==
      offenderSeat ||
    !verifyObject('entry', entryBody(entry), entry.sig, parsePeerId(identity.peerId)) ||
    !verifyObject('proposal', original.body, original.sig, parsePeerId(identity.peerId))
  )
    throw new Error('The fault hook cannot replace an unsigned or unelected proposal');
  const otherSeat = genesis.seats.find((seat) => seat.seat !== offenderSeat);
  if (!otherSeat) throw new Error('An invalid command needs another configured seat');
  const signed = signCommand(
    {
      gameId: genesis.gameId,
      genesisDigest: digest,
      seat: otherSeat.seat,
      nonce: Number.MAX_SAFE_INTEGER,
      headSeq: entry.seq - 1,
      headHash: entry.prevHash,
      command: { type: 'END_TURN' },
    },
    offenderKey,
  );
  const replaced = signEntry(
    {
      ...entryBody(entry),
      payload: { kind: 'command', signed },
    },
    offenderKey,
  );
  return signProposal({ ...original.body, entry: replaced }, offenderKey);
}

```


### tools/sim/src/net-batch.ts
```
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
  return options;
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


### tools/sim/src/cli.ts
```
import { existsSync, readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { fromBase64Url, hashValue, toHex } from '@cp2p/codec';
import { createBaseEngine, RESOURCES } from '@cp2p/engine';
import type { GameState, Input, PrivateState, Seat } from '@cp2p/engine';
import { runBatch } from './batch.js';
import type { BatchOptions, BatchResult } from './batch.js';
import { runGame, SimulationFailure } from './run-game.js';
import { fuzz } from './fuzz.js';
import { updateGoldens } from './golden.js';
import { readReplay, verifyReplay } from './replay.js';
import type { ReplayFile } from './replay.js';
import { sourceFingerprint } from './provenance.js';
import { parseNetBatchOptions, runNetworkBatch } from './net-batch.js';
import {
  applyP99Milliseconds,
  diceChiSquare,
  dicePValue,
  emptySummary,
  mergeSummary,
} from './stats.js';

type ParsedArgs = Record<string, string | boolean>;

function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < args.length; index++) {
    const part = args[index];
    if (!part?.startsWith('--')) throw new Error(`Unexpected argument ${String(part)}`);
    const key = part.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) parsed[key] = true;
    else {
      parsed[key] = next;
      index++;
    }
  }
  return parsed;
}

function integer(value: string | boolean | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`--${name} needs an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`--${name} needs a safe integer`);
  return number;
}

function parseBaseOptions(value: string | boolean | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'string') throw new Error('--options needs a JSON object');
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('--options needs a JSON object');
  return Object.fromEntries(Object.entries(parsed));
}

function runOptions(args: ParsedArgs, verify: boolean): BatchOptions & { parallel: number } {
  if (args.modules !== undefined && args.modules !== 'base')
    throw new Error('Only --modules base is available in Stage04');
  if (
    args.bots !== undefined &&
    (typeof args.bots !== 'string' || args.bots.split(',').some((bot) => bot !== 'random'))
  )
    throw new Error('Only random bots are available in Stage04');
  return {
    games: integer(args.games, 1, 'games'),
    players: integer(args.players, 4, 'players'),
    seed: integer(args.seed, 42, 'seed'),
    parallel: integer(args.parallel, 1, 'parallel'),
    baseOptions: parseBaseOptions(args.options),
    verify,
  };
}

function workerBatch(batchOptions: BatchOptions): Promise<BatchResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: batchOptions,
    });
    let settled = false;
    worker.once('message', (message: BatchResult) => {
      settled = true;
      resolve(message);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`Simulation worker exited with code ${code}`));
    });
  });
}

async function runCommand(args: ParsedArgs, bench: boolean): Promise<void> {
  const { parallel, ...batch } = runOptions(args, !bench);
  if (!Number.isSafeInteger(batch.games) || batch.games < 1)
    throw new Error('--games must be positive');
  if (!Number.isSafeInteger(parallel) || parallel < 1)
    throw new Error('--parallel must be positive');
  if (bench && parallel !== 1) throw new Error('Benchmark requires --parallel 1');
  const fingerprint = sourceFingerprint();
  const warmupGames = bench ? 5 : 0;
  if (warmupGames) {
    const warmup = runBatch({
      ...batch,
      games: batch.games + warmupGames,
      startIndex: batch.games,
    });
    if (warmup.failures.length) {
      console.log(
        JSON.stringify({
          mode: 'bench',
          seed: batch.seed,
          players: batch.players,
          requestedGames: batch.games,
          warmupGames,
          warmupFailures: warmup.failures,
          sourceFingerprint: fingerprint,
          sourceUnchanged: sourceFingerprint() === fingerprint,
        }),
      );
      process.exitCode = 1;
      return;
    }
  }
  const started = performance.now();
  const parts =
    parallel === 1
      ? [runBatch(batch)]
      : await Promise.all(
          Array.from({ length: Math.min(parallel, batch.games) }, (_, index) =>
            workerBatch({ ...batch, startIndex: index, stride: Math.min(parallel, batch.games) }),
          ),
        );
  const summary = emptySummary();
  const failures = parts
    .flatMap((part) => part.failures)
    .toSorted((a, b) => a.gameIndex - b.gameIndex);
  for (const part of parts) mergeSummary(summary, part.summary);
  const output = {
    mode: bench ? 'bench' : 'run',
    seed: batch.seed,
    players: batch.players,
    baseOptions: batch.baseOptions,
    requestedGames: batch.games,
    parallel,
    warmupGames,
    verifyInvariants: batch.verify !== false,
    completedGames: summary.games,
    failedGames: failures.length,
    averageTurns: summary.games ? summary.turns / summary.games : null,
    averageInputs: summary.games ? summary.inputs / summary.games : null,
    wins: summary.wins,
    dice: summary.dice,
    diceChiSquare: diceChiSquare(summary.dice),
    dicePValue: dicePValue(summary.dice),
    commands: summary.commands,
    awardSwingPercent: summary.games ? (100 * summary.awardSwingGames) / summary.games : null,
    averageApplyMillisecondsPerGame: summary.games
      ? summary.applyNanoseconds / 1e6 / summary.games
      : null,
    averageGameMilliseconds: summary.games ? summary.gameNanoseconds / 1e6 / summary.games : null,
    applyP99Milliseconds: applyP99Milliseconds(summary),
    elapsedMilliseconds: performance.now() - started,
    sourceFingerprint: fingerprint,
    sourceUnchanged: sourceFingerprint() === fingerprint,
    failures,
  };
  console.log(JSON.stringify(output));
  if (failures.length) process.exitCode = 1;
}

export function failureMatches(category: string, observed: string): boolean {
  if (category === 'accepted-invalid') return observed === 'validated';
  if (category === 'dead-turn' || category === 'dead-stall') return observed === category;
  if (category === 'public-invariant') return observed === 'public-invariant';
  if (category === 'private-failure') return observed === 'private-failure';
  if (category === 'input-rejected') return observed === 'input-rejected';
  if (category === 'driver-failure') return observed === 'driver-failure';
  if (category === 'apply-rejected') return observed === 'apply-rejected';
  if (category === 'invariant-violation' || category === 'trace-public-violation')
    return observed === 'invariant-violation';
  if (category === 'state-mutation') return observed === 'state-mutation';
  if (category === 'private-invariant-violation' || category === 'trace-private-violation')
    return observed === 'private-invariant-violation';
  if (category === 'plausible-private-rejected' || category === 'trace-private-rejected')
    return observed === 'private-rejected';
  if (category === 'plausible-private-throw' || category === 'trace-private-throw')
    return observed === 'private-throw';
  if (category === 'validate-throw') return observed === 'validate-throw';
  if (category === 'plausible-throw' || category === 'trace-throw')
    return observed === 'apply-throw';
  if (category === 'invariant-throw' || category === 'trace-invariant-throw')
    return observed === 'invariant-throw';
  if (category === 'trace-rejected') return observed === 'rejected';
  return false;
}

function replayPrivates(
  engine: ReturnType<typeof createBaseEngine>,
  replay: ReplayFile,
): Map<Seat, PrivateState> {
  let before = engine.createGame(replay.config, fromBase64Url(replay.genesisSeed));
  let privates = new Map(
    before.config.seats.map((seat) => [seat, engine.createPrivateState(seat)]),
  );
  for (const input of replay.inputs) {
    const applied = engine.apply(before, input);
    if (!applied.ok) throw new Error(`Replay prefix rejected ${applied.error.code}`);
    const next = new Map<Seat, PrivateState>();
    for (const seat of before.config.seats) {
      const prior = privates.get(seat);
      if (!prior) throw new Error(`Replay prefix missing seat ${seat}`);
      const updated = engine.applyPrivate(prior, before, input);
      if (!updated.ok) throw new Error(`Replay prefix private reject ${updated.error.code}`);
      next.set(seat, updated.value);
    }
    privates = next;
    before = applied.value.state;
  }
  return privates;
}

function observePrivateAttempt(
  engine: ReturnType<typeof createBaseEngine>,
  before: GameState,
  after: GameState,
  input: Input,
  original: unknown,
  privates: ReadonlyMap<Seat, PrivateState>,
): string {
  const originalCard =
    typeof original === 'object' &&
    original !== null &&
    'type' in original &&
    original.type === 'CARD_DEALT' &&
    'card' in original &&
    typeof original.card === 'string'
      ? original.card
      : undefined;
  const privateData =
    input.kind === 'system' &&
    input.type === 'CARD_DEALT' &&
    input.card === undefined &&
    originalCard !== undefined
      ? { card: originalCard }
      : undefined;
  const next = new Map<Seat, PrivateState>();
  for (const seat of before.config.seats) {
    const prior = privates.get(seat);
    if (!prior) return 'private-rejected';
    let updated: ReturnType<typeof engine.applyPrivate>;
    try {
      updated = engine.applyPrivate(prior, before, input, privateData);
    } catch {
      return 'private-throw';
    }
    if (!updated.ok) return 'private-rejected';
    next.set(seat, updated.value);
  }
  for (const holder of after.seats) {
    const priv = next.get(holder.seat);
    if (!priv) return 'private-invariant-violation';
    let total = 0;
    for (const resource of RESOURCES) {
      const count = priv.hand[resource];
      if (
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < holder.resources.min[resource] ||
        count > holder.resources.max[resource]
      )
        return 'private-invariant-violation';
      total += count;
    }
    if (total !== holder.resources.total) return 'private-invariant-violation';
  }
  try {
    return engine.checkPrivateInvariants(after, next).length
      ? 'private-invariant-violation'
      : 'accepted-valid';
  } catch {
    return 'private-throw';
  }
}

function observeAttempt(
  engine: ReturnType<typeof createBaseEngine>,
  state: ReturnType<typeof verifyReplay>,
  attempted: unknown,
  category: string,
  original: unknown,
  privates: ReadonlyMap<Seat, PrivateState>,
): string {
  // Fuzz failure payloads deliberately contain malformed inputs.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const input = attempted as Input;
  const beforeHash = toHex(hashValue(state));
  let valid: ReturnType<typeof engine.validate>;
  try {
    valid = engine.validate(state, input);
  } catch {
    return 'validate-throw';
  }
  if (toHex(hashValue(state)) !== beforeHash) return 'state-mutation';
  if (!valid.ok) return 'rejected';
  if (category === 'accepted-invalid') return 'validated';
  let applied: ReturnType<typeof engine.apply>;
  try {
    applied = engine.apply(state, input);
  } catch {
    return 'apply-throw';
  }
  if (toHex(hashValue(state)) !== beforeHash) return 'state-mutation';
  if (!applied.ok) return 'apply-rejected';
  try {
    if (engine.checkInvariants(applied.value.state).length) return 'invariant-violation';
  } catch {
    return 'invariant-throw';
  }
  return observePrivateAttempt(engine, state, applied.value.state, input, original, privates);
}

/** Replay a valid prefix and compare the observed failure with its recorded category. */
export function replayCommand(path: string): Record<string, unknown> {
  const replay = readReplay(path);
  const sidecar = path.replace(/\.replay\.json$/, '.failure.json');
  const hasFailure = existsSync(sidecar);
  const engine = createBaseEngine();
  const state = verifyReplay(engine, replay, { allowFinalInvariantFailure: hasFailure });
  if (!hasFailure) {
    return { path, inputs: replay.inputs.length, turn: state.turn.number, result: state.result };
  }
  const sidecarData: unknown = JSON.parse(readFileSync(sidecar, 'utf8'));
  if (typeof sidecarData !== 'object' || sidecarData === null)
    throw new Error('Failure sidecar is malformed');
  const failure = Object.fromEntries(Object.entries(sidecarData));
  if (typeof failure.category !== 'string' || typeof failure.source !== 'string')
    throw new Error('Failure sidecar lacks source or category');
  let observed: string;
  if (failure.source === 'run') {
    if (
      typeof failure.seed !== 'number' ||
      typeof failure.gameIndex !== 'number' ||
      typeof failure.players !== 'number' ||
      typeof failure.maxTurns !== 'number' ||
      typeof failure.maxInputsWithoutTurn !== 'number' ||
      typeof failure.baseOptions !== 'object' ||
      failure.baseOptions === null
    )
      throw new Error('Run failure sidecar is malformed');
    try {
      runGame({
        seed: failure.seed,
        gameIndex: failure.gameIndex,
        players: failure.players,
        maxTurns: failure.maxTurns,
        maxInputsWithoutTurn: failure.maxInputsWithoutTurn,
        // The recorded run may have used the benchmark's diagnostic setting.
        verify: failure.verify !== false,
        // Checked above; the JSON sidecar uses only base option fields.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        baseOptions: failure.baseOptions as Record<string, unknown>,
      });
      observed = 'completed';
    } catch (error) {
      if (error instanceof SimulationFailure) {
        observed =
          toHex(hashValue(error.inputs)) === toHex(hashValue(replay.inputs)) &&
          toHex(hashValue(error.attemptedInput ?? null)) ===
            toHex(hashValue(failure.attemptedInput ?? null))
            ? error.category
            : 'different-prefix';
      } else observed = 'driver-throw';
    }
  } else if (failure.source === 'fuzz') {
    if (typeof failure.stateHash !== 'string')
      throw new Error('Fuzz failure sidecar lacks state hash');
    if (toHex(hashValue(state)) !== failure.stateHash) observed = 'different-state';
    else {
      try {
        const privates = replayPrivates(engine, replay);
        observed = observeAttempt(
          engine,
          state,
          failure.attemptedInput,
          failure.category,
          failure.originalInput,
          privates,
        );
      } catch {
        observed = 'prefix-private-failure';
      }
    }
  } else throw new Error(`Unknown failure source ${failure.source}`);
  return {
    path,
    inputs: replay.inputs.length,
    turn: state.turn.number,
    result: state.result,
    recordedFailure: failure.message,
    category: failure.category,
    observed,
    reproduced: failureMatches(failure.category, observed),
  };
}

/** Entry point for `pnpm sim`. Output is one machine-readable JSON line. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  if (command === 'run' || command === 'bench')
    return runCommand(parseArgs(rest), command === 'bench');
  if (command === 'replay') {
    const path = rest[0];
    if (!path || rest.length !== 1) throw new Error('Usage: pnpm sim replay <file>');
    const result = replayCommand(path);
    console.log(JSON.stringify(result));
    if (result.reproduced === false) process.exitCode = 1;
    return;
  }
  if (command === 'golden') {
    if (rest.length !== 1 || rest[0] !== '--update')
      throw new Error('Golden fixtures can only be regenerated with --update');
    console.log(JSON.stringify(updateGoldens({ update: true })));
    return;
  }
  if (command === 'fuzz') {
    const args = parseArgs(rest);
    const fingerprint = sourceFingerprint();
    console.log(
      JSON.stringify({
        ...fuzz({
          seed: integer(args.seed, 42, 'seed'),
          iterations: integer(args.iterations, 50_000, 'iterations'),
        }),
        sourceFingerprint: fingerprint,
        sourceUnchanged: sourceFingerprint() === fingerprint,
      }),
    );
    return;
  }
  if (command === 'net') {
    const options = parseNetBatchOptions(rest);
    const fingerprint = sourceFingerprint();
    const result = await runNetworkBatch(options);
    console.log(
      JSON.stringify({
        mode: 'net',
        ...result,
        parallel: Math.min(options.parallel, options.seeds),
        sourceFingerprint: fingerprint,
        sourceUnchanged: sourceFingerprint() === fingerprint,
      }),
    );
    if (result.failures.length) process.exitCode = 1;
    return;
  }
  throw new Error('Usage: pnpm sim <run|bench|net|fuzz|replay|golden> [options]');
}

```


### packages/protocol/src/testing/verified-non-voter-actor.ts
```
import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import * as v from 'valibot';
import { enumerateCommands } from '@cp2p/engine';
import type { CommandShape, LegalCommandSet, Result, Seat } from '@cp2p/engine';
import type { PrivateState } from '@cp2p/engine';
import { prepareBeaconContribution } from '../beacon-contributions.js';
import { BeaconInbox } from '../beacon-inbox.js';
import { resolveArtifactSigner } from '../authority.js';
import { prepareCountContribution } from '../count-contributions.js';
import { CountInbox } from '../count-inbox.js';
import { DeckInbox } from '../deck-inbox.js';
import { prepareDeckUnlock } from '../deck-outbox.js';
import { entryHash } from '../genesis.js';
import { MasterRevealCoordinator } from '../master-reveal.js';
import type { ProtocolJournal } from '../journal.js';
import { signCommand } from '../command-validation.js';
import { decodeProtocolMessage, encodeProtocolMessage } from '../messages.js';
import type { ProtocolMessage } from '../messages.js';
import { prepareStealContribution, prepareStealResponse } from '../steal-contributions.js';
import { StealInbox } from '../steal-inbox.js';
import {
  planTradeProof,
  signTradeProofRequest,
  signTradeProofResponse,
  tradeProofHost,
  tradeProofRequestId,
  verifyTradeProofResponse,
  verifyTradeProofRequest,
} from '../trade-proof-delivery.js';
import type { IndexedHandProof, SignedTradeProofRequest } from '../trade-proof-delivery.js';
import { advanceContext, validateCertifiedEntry } from '../proposal.js';
import type { CertifiedEntry, ProposalContext } from '../proposal.js';
import { initialProposalContext } from '../replay.js';
import { logEntrySchema, signedCommandSchema } from '../schemas.js';
import { parseCanonical } from '../validation.js';
import type { VerifiedNetworkSessionOptions } from './verified-network-fixture.js';
import type { ProtocolClock, Transport, Unsubscribe } from '../transport.js';
import type { SignedCommand } from '../types.js';
import type { Genesis } from '../types.js';

const MAX_PREFIX_ENTRIES = 20_000;
const TRADE_REQUEST_TIMEOUT_MS = 10_000;
const TRADE_REQUEST_RETRY_MS = 250;
const OUTBOUND_TYPES = new Set<ProtocolMessage['t']>([
  'SUBMIT',
  'MASTER_REVEAL',
  'SYS_CONTRIB',
  'DECK_CONTRIB',
  'COUNT_CONTRIB',
  'STEAL_CONTRIB',
  'STEAL_RESPONSE',
  'TRADE_PROOF_REQUEST',
  'TRADE_PROOF_RESPONSE',
]);

const commandShapeSchema = v.objectWithRest({ type: v.string() }, v.unknown());

function detachSignedCommand(value: SignedCommand): Result<SignedCommand> {
  return parseCanonical(canonicalDecode(canonicalEncode(value)), signedCommandSchema);
}

export interface VerifiedNonVoterActorOptions {
  readonly seat: Seat;
  readonly identity: { readonly peerId: string; readonly secretKey: Uint8Array };
  /** One already-scoped option value; no callback can request another seat's secrets. */
  readonly sessionOptions: VerifiedNetworkSessionOptions;
  readonly transport: Transport;
  readonly clock: ProtocolClock;
}

export interface VerifiedNonVoterActor {
  readonly seat: Seat;
  advance(entries: readonly CertifiedEntry[]): Promise<Result<void>>;
  submit(
    command: CommandShape,
    expectedHead: { readonly seq: number; readonly hash: string },
  ): Promise<Result<SignedCommand>>;
  legalCommands(): LegalCommandSet;
  publishContributions(): Promise<Result<void>>;
  privateState(): PrivateState | null;
  head(): { readonly seq: number; readonly hash: string };
  dispose(): void;
}

/**
 * A strict replaying player endpoint with no consensus journal or safety state.
 * It can keep producing its own authenticated protocol artifacts after its
 * proposer is excluded, but cannot submit proposals, votes, or certificates.
 */
export function createVerifiedNonVoterActor(
  options: VerifiedNonVoterActorOptions,
): Result<VerifiedNonVoterActor> {
  const { seat, identity, sessionOptions, transport, clock } = options;
  let signingKey: Uint8Array | null = null;
  let driver: ReturnType<VerifiedNetworkSessionOptions['createDriver']> | null = null;
  let disposed = false;
  let context: ProposalContext | null = null;
  const entries: CertifiedEntry[] = [];
  let pendingCommand: {
    readonly seq: number;
    readonly hash: string;
    readonly command: CommandShape;
    readonly signed?: SignedCommand;
  } | null = null;
  const beaconInbox = new BeaconInbox();
  const deckInbox = new DeckInbox();
  const countInbox = new CountInbox();
  const stealInbox = new StealInbox();
  let unsubscribe: Unsubscribe | null = null;
  let pendingTrade: {
    request: SignedTradeProofRequest;
    requestId: string;
    context: ProposalContext;
    finish: (result: Result<readonly IndexedHandProof[]>) => void;
    timer: unknown;
    deadline: number;
  } | null = null;
  let masterReveal: MasterRevealCoordinator | null = null;
  const sentArtifacts = new Map<string, number>();
  const tradeResponses = new Map<string, unknown>();

  const parsedGenesis = parseCanonical(sessionOptions.genesisEntry, logEntrySchema);
  if (!parsedGenesis.ok || parsedGenesis.value.payload.kind !== 'genesis')
    return failure('non-voter-genesis', 'Actor needs the signed verified genesis entry');
  const genesisEntry = parsedGenesis.value;
  if (transport.self !== identity.peerId)
    return failure('non-voter-identity', 'Transport identity differs from the owned seat');

  try {
    signingKey = new Uint8Array(identity.secretKey);
    const derived = identityFromSecret(signingKey);
    const matches = derived.peerId === identity.peerId;
    derived.secretKey.fill(0);
    if (!matches) {
      signingKey.fill(0);
      return failure('non-voter-identity', 'Owned signing key does not match its peer');
    }
    const initialized = initialProposalContext(
      genesisEntry,
      sessionOptions.engine,
      sessionOptions.policy,
    );
    if (!initialized.ok) {
      signingKey.fill(0);
      return initialized;
    }
    const genesis: Genesis = initialized.value.log.genesis;
    if (genesis.security !== 'verified') {
      signingKey.fill(0);
      return failure('non-voter-security', 'Actor only supports verified games');
    }
    const seatGenesis = genesis.seats.find((candidate) => candidate.seat === seat);
    if (seatGenesis?.kind !== 'human' || seatGenesis.publicKey !== identity.peerId) {
      signingKey.fill(0);
      return failure('non-voter-seat', 'Identity does not own this human genesis seat');
    }
    context = initialized.value;
    driver = sessionOptions.createDriver(sessionOptions.engine, genesis, clock, [seat]);
    const revealOptions = sessionOptions.masterReveal;
    if (revealOptions) {
      const readonlyJournal: ProtocolJournal = {
        async load() {
          const current = context;
          if (!current) return null;
          return {
            genesis: genesisEntry,
            entries: [...entries],
            height: current.log.head.seq + 1,
            safety: { revision: 0, bytes: new Uint8Array() },
          };
        },
        async initialize() {
          return false;
        },
        async loadSafety() {
          return null;
        },
        async saveSafety() {
          return false;
        },
        async commit() {
          return false;
        },
      };
      masterReveal = new MasterRevealCoordinator({
        journal: readonlyJournal,
        engine: sessionOptions.engine,
        policy: sessionOptions.policy,
        localSeat: seat,
        signingKey,
        store: revealOptions.store,
        loadOwnedMaster: async (ownedSeat) =>
          ownedSeat === seat ? revealOptions.loadOwnedMaster(ownedSeat) : null,
      });
    }
  } catch {
    driver?.dispose?.();
    masterReveal?.dispose();
    signingKey?.fill(0);
    return failure('non-voter-open', 'Could not initialize scoped verified private state');
  }

  const contextNow = (): ProposalContext => {
    if (disposed || !context || !driver) throw new Error('Non-voter actor is disposed');
    return context;
  };

  const transmit = (message: unknown, recipient?: string): Result<void> => {
    if (disposed) return failure('non-voter-disposed', 'Non-voter actor is disposed');
    const encoded = encodeProtocolMessage(message);
    if (!encoded.ok) return encoded;
    const decoded = decodeProtocolMessage(encoded.value);
    if (!decoded.ok || !OUTBOUND_TYPES.has(decoded.value.t))
      return failure('non-voter-outbound', 'Actor cannot send consensus or unsupported messages');
    const current = contextNow();
    const outgoing = decoded.value;
    if (outgoing.t === 'SUBMIT') {
      const body = outgoing.cmd.body;
      if (
        body.seat !== seat ||
        body.gameId !== current.log.genesis.gameId ||
        body.genesisDigest !== current.membership.genesisDigest ||
        body.headSeq !== current.log.head.seq ||
        body.headHash !== entryHash(current.log.head) ||
        body.nonce !== (current.log.lastNonces.get(seat) ?? 0) + 1 ||
        !pendingCommand ||
        pendingCommand.seq !== body.headSeq ||
        pendingCommand.hash !== body.headHash ||
        !sameCanonical(pendingCommand.command, body.command) ||
        (pendingCommand.signed !== undefined && pendingCommand.signed.sig !== outgoing.cmd.sig)
      )
        return failure(
          'non-voter-command-context',
          'Command is not bound to the actor current head',
        );
    } else if (
      'genesisDigest' in outgoing &&
      outgoing.genesisDigest !== current.membership.genesisDigest
    ) {
      return failure('non-voter-message-context', 'Sideband message belongs to another game');
    } else if (outgoing.t === 'MASTER_REVEAL') {
      if (
        outgoing.reveal.body.publisherSeat !== seat ||
        outgoing.reveal.body.originalSeat !== seat ||
        outgoing.reveal.body.genesisDigest !== current.membership.genesisDigest ||
        current.log.state.result === null
      )
        return failure('non-voter-reveal-context', 'Reveal is not for the actor’s terminal seat');
    } else if (outgoing.t === 'TRADE_PROOF_REQUEST') {
      const request = verifyTradeProofRequest(outgoing.request, current.log);
      if (
        !request.ok ||
        outgoing.request.body.seat !== seat ||
        outgoing.request.body.headSeq !== current.log.head.seq ||
        outgoing.request.body.headHash !== entryHash(current.log.head)
      )
        return failure(
          'non-voter-trade-context',
          'Trade proof request is not bound to the actor head',
        );
    }
    const owned =
      (outgoing.t === 'SYS_CONTRIB' && outgoing.contribution.signed.body.seat === seat) ||
      (outgoing.t === 'DECK_CONTRIB' &&
        outgoing.contribution.unlocks.at(-1)?.body.seat === seat &&
        outgoing.contribution.operationId === deckInbox.operationId()) ||
      (outgoing.t === 'COUNT_CONTRIB' && outgoing.contribution.body.seat === seat) ||
      (outgoing.t === 'STEAL_CONTRIB' && outgoing.contribution.body.seat === seat) ||
      (outgoing.t === 'STEAL_RESPONSE' &&
        (outgoing.response.kind === 'receipt'
          ? outgoing.response.value.body.seat
          : outgoing.response.value.body.binding.seat) === seat) ||
      (outgoing.t === 'MASTER_REVEAL' && outgoing.reveal.body.publisherSeat === seat) ||
      (outgoing.t === 'TRADE_PROOF_REQUEST' && outgoing.request.body.seat === seat) ||
      (outgoing.t === 'TRADE_PROOF_RESPONSE' && outgoing.response.body.seat === seat);
    if (outgoing.t !== 'SUBMIT' && !owned)
      return failure('non-voter-outbound-owner', 'Actor may send only its own verified artifacts');
    // Bound repeated sideband sends by virtual time. Commands retain their own retry policy.
    const artifactKey =
      outgoing.t === 'SUBMIT' || outgoing.t === 'TRADE_PROOF_REQUEST'
        ? null
        : `${recipient ?? '*'}:${Array.from(encoded.value).join(',')}`;
    if (artifactKey !== null) {
      const previous = sentArtifacts.get(artifactKey);
      if (previous !== undefined && clock.now() - previous < TRADE_REQUEST_RETRY_MS)
        return success(undefined);
    }
    try {
      if (recipient === undefined) transport.broadcast(encoded.value);
      else transport.send(recipient, encoded.value);
      if (artifactKey !== null) {
        sentArtifacts.set(artifactKey, clock.now());
        if (sentArtifacts.size > 128) {
          const oldest = sentArtifacts.keys().next().value;
          if (oldest !== undefined) sentArtifacts.delete(oldest);
        }
      }
      return success(undefined);
    } catch {
      return failure('non-voter-transport', 'Could not send the actor message');
    }
  };

  const refreshInboxes = (current: ProposalContext): Result<void> => {
    for (const refreshed of [
      beaconInbox.refresh(current.log.crypto, current.log.genesis, current.log.authority),
      deckInbox.refresh(current.log.crypto, current.log.genesis, current.log.authority),
      countInbox.refresh(current.log.crypto, current.log.genesis, current.log.authority),
      stealInbox.refresh(current.log.crypto, current.log.genesis, current.log.authority),
    ])
      if (!refreshed.ok) return refreshed;
    return success(undefined);
  };

  const receive = (from: string, bytes: Uint8Array): void => {
    if (disposed) return;
    const parsed = decodeProtocolMessage(bytes);
    if (!parsed.ok) return;
    const current = context;
    if (!current) return;
    const message = parsed.value;
    if (message.t === 'TRADE_PROOF_REQUEST') {
      void answerTradeProofRequest(from, message.request).catch(() => undefined);
      return;
    }
    if (message.t === 'TRADE_PROOF_RESPONSE') {
      const waiting = pendingTrade;
      if (!waiting || disposed || context !== waiting.context) return;
      const response = verifyTradeProofResponse(message.response, waiting.request, current.log);
      if (response.ok && response.value.body.requestId === waiting.requestId)
        waiting.finish(success(response.value.body.proofs));
      return;
    }
    if ('genesisDigest' in message && message.genesisDigest !== current.membership.genesisDigest)
      return;
    if (!refreshInboxes(current).ok) return;
    if (message.t === 'SYS_CONTRIB') beaconInbox.remember(message.contribution);
    else if (message.t === 'DECK_CONTRIB') deckInbox.remember(message.contribution);
    else if (message.t === 'COUNT_CONTRIB') countInbox.remember(message.contribution);
    else if (message.t === 'STEAL_CONTRIB') stealInbox.rememberContribution(message.contribution);
    else if (message.t === 'STEAL_RESPONSE') stealInbox.rememberResponse(message.response);
    void from;
  };

  const answerTradeProofRequest = async (
    from: string,
    request: SignedTradeProofRequest,
  ): Promise<void> => {
    if (disposed || !driver || !signingKey || !context) return;
    const current = context;
    const checked = verifyTradeProofRequest(request, current.log);
    if (!checked.ok) return;
    const requester = resolveArtifactSigner(
      current.log.authority,
      current.log.genesis,
      current.log.crypto?.epoch ?? current.membership.epoch,
      request.body.seat,
    );
    if (!requester.ok || requester.value.publicKey !== from) return;
    const requestId = tradeProofRequestId(request.body);
    const cached = tradeResponses.get(requestId);
    if (cached) {
      transmit(cached, requester.value.publicKey);
      return;
    }
    const host = tradeProofHost(
      current.log.genesis,
      request.body.command.withSeat,
      current.log.authority,
    );
    if (host !== identity.peerId) return;
    const plan = planTradeProof(request.body, current.log);
    if (!plan.ok) return;
    const proofs = driver.produceTradeProofs?.(request, current.log);
    if (!proofs?.ok) return;
    const response = signTradeProofResponse(request, seat, proofs.value, signingKey);
    const message = { t: 'TRADE_PROOF_RESPONSE', response };
    tradeResponses.set(requestId, message);
    if (tradeResponses.size > 64) {
      const oldest = tradeResponses.keys().next().value;
      if (oldest !== undefined) tradeResponses.delete(oldest);
    }
    const outgoing = encodeProtocolMessage(message);
    if (!outgoing.ok || disposed || context !== current) return;
    try {
      const sent = transmit(message, requester.value.publicKey);
      if (!sent.ok) return;
    } catch {
      // Authenticated packets may be lost during reconnect; callers retry requests.
    }
  };

  const requestTradeProofs = (
    request: SignedTradeProofRequest,
    current: ProposalContext,
    recipient: string,
  ): Promise<Result<readonly IndexedHandProof[]>> =>
    new Promise((resolve) => {
      if (pendingTrade) {
        resolve(failure('non-voter-trade-busy', 'Actor already has a pending trade request'));
        return;
      }
      const requestId = tradeProofRequestId(request.body);
      let finished = false;
      const finish = (result: Result<readonly IndexedHandProof[]>) => {
        if (finished) return;
        finished = true;
        const waiting = pendingTrade;
        if (waiting?.requestId === requestId) {
          if (waiting.timer !== null) clock.clearTimeout(waiting.timer);
          pendingTrade = null;
        }
        resolve(result);
      };
      const deadline = clock.now() + TRADE_REQUEST_TIMEOUT_MS;
      const waiting = {
        request,
        requestId,
        context: current,
        finish,
        timer: null as unknown,
        deadline,
      };
      pendingTrade = waiting;
      const retry = () => {
        waiting.timer = null;
        if (disposed || context !== current) {
          finish(
            failure('non-voter-trade-stale', 'Certified head changed during trade proof request'),
          );
          return;
        }
        if (clock.now() >= deadline) {
          finish(failure('non-voter-trade-timeout', 'Trade proof request expired'));
          return;
        }
        const sent = transmit({ t: 'TRADE_PROOF_REQUEST', request }, recipient);
        if (!sent.ok && sent.error.code !== 'non-voter-transport') {
          finish(sent);
          return;
        }
        waiting.timer = clock.setTimeout(
          retry,
          Math.max(0, Math.min(TRADE_REQUEST_RETRY_MS, deadline - clock.now())),
        );
      };
      retry();
    });

  const publishMasterReveal = async (): Promise<Result<void>> => {
    if (!masterReveal || !context || context.log.state.result === null) return success(undefined);
    const prepared = await masterReveal.prepare(seat);
    if (!prepared.ok) return prepared;
    if (disposed || !context || context.log.state.result === null) return success(undefined);
    const sent = transmit({ t: 'MASTER_REVEAL', reveal: prepared.value.packet });
    return sent.ok ? success(undefined) : sent;
  };

  unsubscribe = transport.onMessage(receive);

  const actor: VerifiedNonVoterActor = {
    seat,
    async advance(prefix) {
      if (disposed || !context || !driver)
        return failure('non-voter-disposed', 'Non-voter actor is disposed');
      if (!Array.isArray(prefix) || prefix.length > MAX_PREFIX_ENTRIES)
        return failure(
          'non-voter-prefix-limit',
          'Certified prefix exceeds the actor history bound',
        );
      if (prefix.length < entries.length)
        return failure('non-voter-prefix-shrunk', 'Certified prefix cannot shrink');
      for (let index = 0; index < entries.length; index += 1) {
        const accepted = entries[index];
        const received = prefix[index];
        // A certified entry's identity is its signed entry hash. Honest peers
        // can attach different valid quorum subsets to that same entry.
        if (!accepted || !received || entryHash(accepted.entry) !== entryHash(received.entry))
          return failure('non-voter-prefix-fork', 'Certified prefix changed an accepted entry');
      }
      for (let index = entries.length; index < prefix.length; index += 1) {
        const certified = prefix[index];
        if (!certified) return failure('non-voter-prefix-gap', 'Certified prefix has a gap');
        const before = context;
        const validated = validateCertifiedEntry(certified, before);
        if (!validated.ok) return validated;
        const advanced = advanceContext(before, validated.value);
        if (!advanced.ok) return advanced;
        const committed = driver.committedEntry
          ? driver.committedEntry(validated.value, before.log, advanced.value.log)
          : validated.value.input
            ? driver.committed(before.log, validated.value.input, advanced.value.log.state)
            : failure('non-voter-driver', 'Driver cannot apply protocol-only certified entries');
        if (!committed.ok) return committed;
        entries.push(validated.value);
        context = advanced.value;
        tradeResponses.clear();
        if (
          pendingCommand &&
          (pendingCommand.seq !== context.log.head.seq ||
            pendingCommand.hash !== entryHash(context.log.head))
        )
          pendingCommand = null;
        if (pendingTrade && context !== pendingTrade.context)
          pendingTrade.finish(
            failure('non-voter-trade-stale', 'Certified head changed during trade proof request'),
          );
      }
      return actor.publishContributions();
    },
    async submit(command, expectedHead) {
      if (disposed || !context || !driver || !signingKey)
        return failure('non-voter-disposed', 'Non-voter actor is disposed');
      const current = context;
      const parentHash = entryHash(current.log.head);
      if (expectedHead.seq !== current.log.head.seq || expectedHead.hash !== parentHash)
        return failure('non-voter-stale-head', 'Actor command needs the current certified head');
      let ownedCommand: CommandShape;
      try {
        const detached = v.safeParse(commandShapeSchema, canonicalDecode(canonicalEncode(command)));
        if (!detached.success)
          return failure('non-voter-command', 'Actor command cannot be detached safely');
        ownedCommand = detached.output;
      } catch {
        return failure('non-voter-command', 'Actor command cannot be detached safely');
      }
      if (pendingCommand) {
        if (pendingCommand.seq !== expectedHead.seq || pendingCommand.hash !== expectedHead.hash)
          pendingCommand = null;
        else if (!sameCanonical(pendingCommand.command, ownedCommand))
          return failure(
            'non-voter-command-pending',
            'Another command already uses this certified parent',
          );
        else if (pendingCommand.signed) {
          const detached = detachSignedCommand(pendingCommand.signed);
          if (!detached.ok) return detached;
          return transmit({ t: 'SUBMIT', cmd: pendingCommand.signed }).ok
            ? success(detached.value)
            : failure('non-voter-transport', 'Could not resend the actor command');
        } else
          return failure('non-voter-command-pending', 'The actor command is still being prepared');
      }
      const intent = { seq: expectedHead.seq, hash: expectedHead.hash, command: ownedCommand };
      pendingCommand = intent;
      let retained = false;
      try {
        const controller = current.log.authority?.controllers.find((item) => item.seat === seat);
        if (
          controller &&
          (controller.kind !== 'human' ||
            controller.status !== 'active' ||
            controller.publicKey !== identity.peerId)
        )
          return failure('non-voter-retired', 'Actor no longer controls this seat');
        const privateState = driver.privateState(seat);
        if (!privateState)
          return failure('non-voter-private', 'Actor seat private state is unavailable');
        const automatic = sessionOptions.engine.getAutomaticInput(
          current.log.state,
          new Map([[seat, privateState]]),
        );
        if (
          automatic?.kind === 'command' &&
          automatic.seat === seat &&
          !sameCanonical(automatic.command, ownedCommand)
        )
          return failure(
            'non-voter-automatic',
            'The certified engine requires its automatic action first',
          );
        const input = { kind: 'command' as const, seat, command: ownedCommand };
        const publicCheck = sessionOptions.engine.validate(current.log.state, input);
        if (!publicCheck.ok) return publicCheck;
        const privateCheck = sessionOptions.engine.applyPrivate(
          privateState,
          current.log.state,
          input,
        );
        if (!privateCheck.ok) return privateCheck;
        const body = {
          gameId: current.log.genesis.gameId,
          genesisDigest: current.membership.genesisDigest,
          seat,
          nonce: (current.log.lastNonces.get(seat) ?? 0) + 1,
          headSeq: current.log.head.seq,
          headHash: parentHash,
          command: ownedCommand,
        };
        let external: readonly IndexedHandProof[] | undefined;
        if (ownedCommand.type === 'CONFIRM_TRADE') {
          const planned = planTradeProof(body, current.log);
          if (!planned.ok) return planned;
          if (planned.value.indices.length > 0 && planned.value.owner !== seat) {
            const owner = resolveArtifactSigner(
              current.log.authority,
              current.log.genesis,
              current.log.crypto?.epoch ?? current.log.authority?.epoch ?? 0,
              planned.value.owner,
            );
            if (!owner.ok) return owner;
            const request = signTradeProofRequest(planned.value.body, signingKey);
            const received = await requestTradeProofs(request, current, owner.value.publicKey);
            if (!received.ok) return received;
            if (disposed || context !== current || entryHash(context.log.head) !== parentHash)
              return failure(
                'non-voter-stale-head',
                'Certified head changed while awaiting trade proof',
              );
            external = received.value;
          }
        }
        const evidence = driver.prepareCommand?.(body, current.log, external);
        if (evidence && !evidence.ok) return evidence;
        if (disposed || context !== current || entryHash(context.log.head) !== parentHash)
          return failure(
            'non-voter-stale-head',
            'Certified head changed during command preparation',
          );
        const signed = signCommand(
          evidence?.value ? { ...body, evidence: evidence.value } : body,
          signingKey,
        );
        const detachedSigned = detachSignedCommand(signed);
        if (!detachedSigned.ok) return detachedSigned;
        const returned = detachSignedCommand(detachedSigned.value);
        if (!returned.ok) return returned;
        pendingCommand = { ...intent, signed: detachedSigned.value };
        retained = true;
        const sent = transmit({ t: 'SUBMIT', cmd: detachedSigned.value });
        return sent.ok ? returned : sent;
      } finally {
        if (!retained && pendingCommand === intent) pendingCommand = null;
      }
    },
    legalCommands() {
      if (disposed || !context || !driver) return { commands: [], templates: [] };
      const privateState = driver.privateState(seat);
      if (!privateState) return { commands: [], templates: [] };
      const automatic = sessionOptions.engine.getAutomaticInput(
        context.log.state,
        new Map([[seat, privateState]]),
      );
      if (automatic?.kind === 'command' && automatic.seat === seat)
        return { commands: [copyCanonical(automatic.command)], templates: [] };
      try {
        return {
          commands: enumerateCommands(
            sessionOptions.engine,
            context.log.state,
            seat,
            privateState,
            {
              sampleIndex: () => 0,
            },
          ),
          templates: [],
        };
      } catch {
        return { commands: [], templates: [] };
      }
    },
    async publishContributions() {
      if (disposed || !context || !driver || !signingKey)
        return failure('non-voter-disposed', 'Non-voter actor is disposed');
      const current = context;
      const refreshed = refreshInboxes(current);
      if (!refreshed.ok) return refreshed;
      const crypto = current.log.crypto;
      if (!crypto) return success(undefined);
      const beaconSource = sessionOptions.beaconSource;
      const beaconStore = sessionOptions.beaconContributions;
      if (beaconSource && beaconStore) {
        const signer = resolveArtifactSigner(
          current.log.authority,
          current.log.genesis,
          crypto.epoch,
          seat,
        );
        if (!signer.ok) return signer;
        const beacon = await prepareBeaconContribution(
          crypto,
          seat,
          signingKey,
          beaconSource,
          beaconStore,
          signer.value,
        );
        if (disposed || context !== current) return success(undefined);
        if (!beacon.ok) return beacon;
        if (beacon.value) {
          const sent = transmit({
            t: 'SYS_CONTRIB',
            genesisDigest: current.membership.genesisDigest,
            contribution: beacon.value,
          });
          if (!sent.ok) return sent;
        }
      }
      const counts = crypto.counts;
      if (
        counts &&
        counts.remaining.includes(seat) &&
        sessionOptions.countContributionStore &&
        driver.produceCountProof
      ) {
        const signer = resolveArtifactSigner(
          current.log.authority,
          current.log.genesis,
          crypto.epoch,
          seat,
        );
        if (!signer.ok) return signer;
        const contribution = await prepareCountContribution(
          counts.operation,
          seat,
          signingKey,
          current.log,
          (operation, ownedSeat, contextLog) =>
            driver?.produceCountProof?.(operation, ownedSeat, contextLog) ??
            failure('non-voter-count', 'Count proof source is unavailable'),
          sessionOptions.countContributionStore,
        );
        if (disposed || context !== current) return success(undefined);
        if (!contribution.ok) return contribution;
        const sent = transmit({
          t: 'COUNT_CONTRIB',
          genesisDigest: current.membership.genesisDigest,
          contribution: contribution.value,
        });
        if (!sent.ok) return sent;
      }
      const steal = crypto.steal;
      if (steal && sessionOptions.stealDeliveryStore) {
        const signer = resolveArtifactSigner(
          current.log.authority,
          current.log.genesis,
          crypto.epoch,
          seat,
        );
        if (!signer.ok) return signer;
        if (
          !steal.fixed &&
          steal.operation.victim.seat === seat &&
          driver.produceStealContribution
        ) {
          const contribution = await prepareStealContribution(
            steal.operation,
            seat,
            signingKey,
            current.log,
            (operation, ownedSeat, log, key) =>
              driver?.produceStealContribution?.(operation, ownedSeat, log, key) ??
              failure('non-voter-steal', 'Steal proof source is unavailable'),
            sessionOptions.stealDeliveryStore,
          );
          if (disposed || context !== current) return success(undefined);
          if (!contribution.ok) return contribution;
          const sent = transmit({
            t: 'STEAL_CONTRIB',
            genesisDigest: current.membership.genesisDigest,
            contribution: contribution.value,
          });
          if (!sent.ok) return sent;
        } else if (
          steal.fixed &&
          steal.operation.thief.seat === seat &&
          driver.produceStealResponse
        ) {
          const response = await prepareStealResponse(
            steal.fixed,
            seat,
            signingKey,
            current.log,
            (fixed, ownedSeat, log, key) =>
              driver?.produceStealResponse?.(fixed, ownedSeat, log, key) ??
              failure('non-voter-steal', 'Steal response source is unavailable'),
            sessionOptions.stealDeliveryStore,
          );
          if (disposed || context !== current) return success(undefined);
          if (!response.ok) return response;
          const sent = transmit({
            t: 'STEAL_RESPONSE',
            genesisDigest: current.membership.genesisDigest,
            response: response.value,
          });
          if (!sent.ok) return sent;
        }
      }
      const activeDeck = crypto.decks.active;
      if (activeDeck && sessionOptions.createDeckSource && sessionOptions.deckContributions) {
        const deck = crypto.decks.decks.find(
          (item) => item.commitment.definition.deckId === activeDeck.deckId,
        );
        if (!deck) return failure('non-voter-deck', 'Active deck setup is unavailable');
        const participant = activeDeck.participants.some(
          (item) => item.seat === seat && item.seat !== activeDeck.seat,
        );
        if (participant) {
          const signer = resolveArtifactSigner(
            current.log.authority,
            current.log.genesis,
            crypto.epoch,
            seat,
          );
          if (!signer.ok) return signer;
          const signers = activeDeck.participants
            .filter((item) => item.seat !== activeDeck.seat)
            .map((item) =>
              resolveArtifactSigner(
                current.log.authority,
                current.log.genesis,
                crypto.epoch,
                item.seat,
              ),
            );
          const invalidSigner = signers.find((item) => !item.ok);
          if (invalidSigner && !invalidSigner.ok) return invalidSigner;
          let source: ReturnType<NonNullable<typeof sessionOptions.createDeckSource>> | undefined;
          try {
            source = sessionOptions.createDeckSource(activeDeck.deckId, seat);
            const prefix = [...deckInbox.prefix()];
            const operationId = deckInbox.operationId();
            if (operationId === null) return success(undefined);
            const unlock = await prepareDeckUnlock(
              deck.setup,
              {
                genesisDigest: activeDeck.genesisDigest,
                epoch: activeDeck.epoch,
                anchor: activeDeck.anchor,
                position: activeDeck.position,
                seat: activeDeck.seat,
                slotId: activeDeck.slotId,
              },
              prefix,
              seat,
              signingKey,
              source,
              sessionOptions.deckContributions,
              signers
                .map((item) => (item.ok ? item.value : undefined))
                .filter((item) => item !== undefined),
              signer.value,
            );
            if (disposed || context !== current) return success(undefined);
            if (!unlock.ok) return unlock;
            if (unlock.value) {
              const refreshedDeckInbox = deckInbox.refresh(
                crypto,
                current.log.genesis,
                current.log.authority,
              );
              if (!refreshedDeckInbox.ok) return refreshedDeckInbox;
              const contribution = {
                kind: 'deck-unlock' as const,
                operationId,
                unlocks: [...prefix, unlock.value],
              };
              const sent = transmit({
                t: 'DECK_CONTRIB',
                genesisDigest: current.membership.genesisDigest,
                contribution,
              });
              if (!sent.ok) return sent;
            }
          } finally {
            source?.dispose();
          }
        }
      }
      return publishMasterReveal();
    },
    privateState() {
      const value = disposed ? null : (driver?.privateState(seat) ?? null);
      return value === null ? null : copyCanonical(value);
    },
    head() {
      const current = contextNow();
      return { seq: current.log.head.seq, hash: entryHash(current.log.head) };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      driver?.dispose?.();
      masterReveal?.dispose();
      masterReveal = null;
      pendingTrade?.finish(failure('non-voter-disposed', 'Non-voter actor is disposed'));
      driver = null;
      signingKey?.fill(0);
      signingKey = null;
      context = null;
      entries.length = 0;
      pendingCommand = null;
      sentArtifacts.clear();
      tradeResponses.clear();
    },
  };
  // Public asynchronous operations always report failures through Result.
  let publication: Promise<Result<void>> | null = null;
  const publish = actor.publishContributions.bind(actor);
  actor.publishContributions = () => {
    publication ??= guard(publish).finally(() => {
      publication = null;
    });
    return publication;
  };
  return success({
    ...actor,
    advance: (prefix) => guard(() => actor.advance(prefix)),
    submit: (command, head) => guard(() => actor.submit(command, head)),
  });
}

function sameCanonical(left: unknown, right: unknown): boolean {
  try {
    const a = canonicalEncode(left);
    const b = canonicalEncode(right);
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
  } catch {
    return false;
  }
}

function copyCanonical<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Clone validated local values through the canonical codec.
  return canonicalDecode(canonicalEncode(value)) as T;
}

function guard<T>(run: () => Promise<Result<T>>): Promise<Result<T>> {
  return Promise.resolve()
    .then(run)
    .catch(() => failure('non-voter-operation', 'Actor operation failed'));
}

```


### packages/protocol/src/testing/verified-non-voter-actor.test.ts
```
import { enumerateCommands } from '@cp2p/engine';
import type { Seat } from '@cp2p/engine';
import { canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { describe, expect, test } from 'vitest';
import { entryHash, genesisDigest, signEntry } from '../genesis.js';
import { MemoryProtocolJournal } from '../journal.js';
import { decodeProtocolMessage } from '../messages.js';
import type { ProtocolMessage } from '../messages.js';
import { P2PSession } from '../p2p-session.js';
import { proposerFor } from '../proposal.js';
import type { CertifiedEntry } from '../proposal.js';
import { replayCertifiedPrefix } from '../replay.js';
import { signVote } from '../votes.js';
import { createMemnet } from './memnet.js';
import { VirtualClock } from './virtual-clock.js';
import { createVerifiedNetworkFixture } from './verified-network-fixture.js';
import { createVerifiedNonVoterActor } from './verified-non-voter-actor.js';
import type { VerifiedNonVoterActor } from './verified-non-voter-actor.js';

async function submitAndPump(
  session: P2PSession,
  seat: Seat,
  command: Parameters<P2PSession['submit']>[1],
  sessions: ReadonlyMap<Seat, P2PSession>,
  clock: VirtualClock,
): Promise<void> {
  const outcome: { result: Awaited<ReturnType<P2PSession['submit']>> | null } = { result: null };
  const pending = session.submit(seat, command, {
    expectedRevision: session.getCommittedHead().seq,
  });
  void pending.then((value) => {
    outcome.result = value;
    return value;
  });
  // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- Promise completion updates the captured result asynchronously.
  for (let step = 0; step < 80 && outcome.result === null; step += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Flush replicas between virtual-clock delivery steps.
    await Promise.all([...sessions.values()].map((replica) => replica.flush()));
    clock.advanceBy(0);
  }
  const result = outcome.result;
  if (result === null)
    throw new Error('Signed command did not finish within the virtual delivery bound');
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  await pending;
}

function sameCommand(left: unknown, right: unknown): boolean {
  const a = canonicalEncode(left);
  const b = canonicalEncode(right);
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function copyPrefix(entries: readonly CertifiedEntry[]): CertifiedEntry[] {
  return entries.map(({ entry, certificate }) => ({
    entry: { ...entry },
    certificate: certificate.map((vote) => ({ ...vote, body: { ...vote.body } })),
  }));
}

describe('VerifiedNonVoterActor', () => {
  test('replays a certified exclusion and command with three non-offender signers', async () => {
    const fixture = createVerifiedNetworkFixture({ seed: 731, gameIndex: 2, vpTarget: 3 });
    const clock = new VirtualClock();
    const peers = [...fixture.identities.values()].map(({ peerId }) => peerId);
    const network = createMemnet({ peers, clock });
    const outgoingByPeer = new Map<string, ProtocolMessage[]>();
    const transports = new Map<string, ReturnType<typeof network.transport>>();
    for (const peer of peers) {
      const raw = network.transport(peer);
      const captured: ProtocolMessage[] = [];
      outgoingByPeer.set(peer, captured);
      transports.set(peer, {
        self: raw.self,
        peers: () => raw.peers(),
        onMessage: (listener: Parameters<typeof raw.onMessage>[0]) => raw.onMessage(listener),
        onPeerChange: (listener: Parameters<typeof raw.onPeerChange>[0]) =>
          raw.onPeerChange(listener),
        disconnect: (target: string) => raw.disconnect(target),
        broadcast(bytes: Uint8Array) {
          const decoded = decodeProtocolMessage(bytes);
          if (decoded.ok) captured.push(decoded.value);
          raw.broadcast(bytes);
        },
        send(target: string, bytes: Uint8Array) {
          const decoded = decodeProtocolMessage(bytes);
          if (decoded.ok) captured.push(decoded.value);
          raw.send(target, bytes);
        },
      });
    }

    const sessions = new Map<Seat, P2PSession>();
    let actor: VerifiedNonVoterActor | null = null;
    let actorMessages: ProtocolMessage[] = [];
    let actorSeat: Seat | null = null;
    let actorHistory: CertifiedEntry[] | null = null;
    let publishedOwnedContribution = false;
    try {
      for (const seat of [0, 1, 2, 3] as const) {
        const owner = fixture.identities.get(seat);
        const transport = transports.get(owner?.peerId ?? '');
        if (!owner || !transport) throw new Error(`Fixture seat ${seat} identity is missing`);
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each session binds a distinct identity and journal.
        const opened = await P2PSession.create({
          ...fixture.sessionOptions(seat),
          seat,
          secretKey: owner.secretKey,
          transport,
          clock,
          journal: new MemoryProtocolJournal(),
        });
        if (!opened.ok) throw new Error(`${opened.error.code}: ${opened.error.message}`);
        sessions.set(seat, opened.value);
      }

      for (let pass = 0; pass < 120; pass += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Flush all real replicas before advancing simulated time.
        await Promise.all([...sessions.values()].map((session) => session.flush()));
        clock.advanceBy(0);
        const source = sessions.get(0);
        if (source) {
          const history = source.exportSave();
          const replayed = replayCertifiedPrefix(
            history.genesis,
            history.entries,
            fixture.engine,
            fixture.policy,
          );
          if (!replayed.ok) throw new Error(`${replayed.error.code}: ${replayed.error.message}`);
          if (
            replayed.value.context.log.crypto?.beacon.active &&
            replayed.value.context.log.crypto.decks.decks.every(
              (deck) => deck.nextPass === deck.commitment.passHashes.length,
            )
          ) {
            const seat: Seat = 0;
            const owner = fixture.identities.get(seat);
            const transport = transports.get(owner?.peerId ?? '');
            if (!owner || !transport) throw new Error(`Fixture actor seat ${seat} is unavailable`);
            actorSeat = seat;
            actorHistory = copyPrefix(history.entries);
            const rawActorTransport = network.transport(owner.peerId);
            actorMessages = [];
            const created = createVerifiedNonVoterActor({
              seat,
              identity: owner,
              sessionOptions: fixture.sessionOptions(seat),
              transport: {
                self: rawActorTransport.self,
                peers: () => rawActorTransport.peers(),
                onMessage: (listener) => rawActorTransport.onMessage(listener),
                onPeerChange: (listener) => rawActorTransport.onPeerChange(listener),
                disconnect: (target) => rawActorTransport.disconnect(target),
                broadcast(bytes) {
                  const decoded = decodeProtocolMessage(bytes);
                  if (decoded.ok) actorMessages.push(decoded.value);
                  rawActorTransport.broadcast(bytes);
                },
                send(target, bytes) {
                  const decoded = decodeProtocolMessage(bytes);
                  if (decoded.ok) actorMessages.push(decoded.value);
                  rawActorTransport.send(target, bytes);
                },
              },
              clock,
            });
            if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);
            actor = created.value;
            // oxlint-disable-next-line eslint/no-await-in-loop -- Advance only after the selected live certified head is captured.
            const published = await actor.advance(actorHistory);
            if (!published.ok)
              throw new Error(`${published.error.code}: ${published.error.message}`);
            const contributionCount = actorMessages.length;
            // oxlint-disable-next-line eslint/no-await-in-loop -- Duplicate publication at the same virtual time must not enqueue deliveries.
            await actor.publishContributions();
            if (actorMessages.length !== contributionCount)
              throw new Error('Contribution publication flooded the transport');
            const privateCopy = actor.privateState();
            if (!privateCopy) throw new Error('Actor private state is missing');
            privateCopy.hand['alias-test'] = 42;
            if (actor.privateState()?.hand['alias-test'] !== undefined)
              throw new Error('Actor private snapshot was aliased');
            const acceptedHead = actor.head();
            const originalPrefix = copyPrefix(actorHistory);
            const callerMutatedPrefix = copyPrefix(actorHistory);
            const firstCallerEntry = callerMutatedPrefix[0];
            if (!firstCallerEntry) throw new Error('Accepted prefix unexpectedly empty');
            callerMutatedPrefix[0] = {
              ...firstCallerEntry,
              entry: { ...firstCallerEntry.entry, stateHash: 'e'.repeat(64) },
            };
            // oxlint-disable-next-line eslint/no-await-in-loop -- Reject entry forks after retaining the original accepted prefix.
            const forked = await actor.advance(callerMutatedPrefix);
            if (forked.ok || forked.error.code !== 'non-voter-prefix-fork')
              throw new Error('Actor accepted a changed signed entry in its prefix');
            // Different valid quorum subsets may certify the same signed entry;
            // the actor retains its already-validated wrapper for that entry.
            const alternateCertificatePrefix = copyPrefix(actorHistory);
            const firstAccepted = alternateCertificatePrefix[0];
            if (!firstAccepted) throw new Error('Accepted prefix unexpectedly empty');
            const alternateCertificate = ([0, 1, 3] as const).map((voterSeat) => {
              const signer = fixture.identities.get(voterSeat);
              if (!signer) throw new Error(`Fixture voter ${voterSeat} is missing`);
              return signVote(
                {
                  genesisDigest: genesisDigest(fixture.genesis),
                  epoch: 0,
                  seat: voterSeat,
                  seq: firstAccepted.entry.seq,
                  term: firstAccepted.entry.term,
                  phase: 'precommit',
                  valueHash: entryHash(firstAccepted.entry),
                },
                signer.secretKey,
              );
            });
            alternateCertificatePrefix[0] = {
              ...firstAccepted,
              certificate: alternateCertificate,
            };
            // oxlint-disable-next-line eslint/no-await-in-loop -- Accept the same entry under another valid quorum wrapper.
            const alternate = await actor.advance(alternateCertificatePrefix);
            if (!alternate.ok)
              throw new Error(`Actor rejected an equivalent certificate: ${alternate.error.code}`);
            // Mutating the caller's original object after acceptance must not
            // alter the actor's stored prefix.
            const mutatedEntry = callerMutatedPrefix[0];
            if (!mutatedEntry) throw new Error('Mutated caller prefix unexpectedly empty');
            const callerOwned = actorHistory[0];
            if (!callerOwned) throw new Error('Caller prefix unexpectedly empty');
            callerOwned.entry.stateHash = mutatedEntry.entry.stateHash;
            // oxlint-disable-next-line eslint/no-await-in-loop -- Re-submit the original detached prefix after caller mutation.
            const detached = await actor.advance(originalPrefix);
            if (!detached.ok) throw new Error('Caller mutation changed the actor accepted prefix');
            actorHistory = originalPrefix;
            if (actor.head().seq !== acceptedHead.seq || actor.head().hash !== acceptedHead.hash)
              throw new Error('Mutated caller prefix changed the actor head');
            const lastAccepted = actorHistory.at(-1);
            if (!lastAccepted) throw new Error('Actor prefix unexpectedly lacks an entry');
            const changedPrefix = [
              ...actorHistory.slice(0, -1),
              {
                ...lastAccepted,
                entry: { ...lastAccepted.entry, stateHash: 'f'.repeat(64) },
              },
            ];
            // oxlint-disable-next-line eslint/no-await-in-loop -- Test the invalid fork without racing another prefix update.
            const fork = await actor.advance(changedPrefix);
            if (fork.ok || fork.error.code !== 'non-voter-prefix-fork')
              throw new Error('Actor accepted a changed certified prefix');
            if (actor.head().seq !== acceptedHead.seq || actor.head().hash !== acceptedHead.hash)
              throw new Error('Rejected prefix changed the actor head');
            publishedOwnedContribution = actorMessages.some(
              (message) =>
                message.t === 'SYS_CONTRIB' && message.contribution.signed.body.seat === seat,
            );
            if (!publishedOwnedContribution)
              throw new Error('Actor did not publish its owned beacon contribution');
            break;
          }
        }

        for (const [seat, session] of sessions) {
          const pending = session
            .getPending()
            .some((item) => item.kind === 'player' && item.seat === seat);
          if (!pending) continue;
          const privateState = session.getPrivate(seat);
          if (!privateState) continue;
          const command = enumerateCommands(
            fixture.engine,
            session.getState(),
            seat,
            privateState,
            {
              sampleIndex: () => 0,
            },
          )[0];
          if (command)
            // oxlint-disable-next-line eslint/no-await-in-loop -- Drive an admitted command to certification before polling the next action.
            await submitAndPump(session, seat, command, sessions, clock);
        }
      }
      if (!actor || actorSeat === null || !actorHistory)
        throw new Error('Did not reach a verified player turn');
      const nonVoter = actor;

      let submitted: ReturnType<VerifiedNonVoterActor['submit']> extends Promise<infer T>
        ? T | null
        : never = null;
      for (let pass = 0; pass < 160 && !submitted?.ok; pass += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Flush all real replicas before advancing simulated time.
        await Promise.all([...sessions.values()].map((session) => session.flush()));
        clock.advanceBy(0);
        const latestSource = [...sessions.values()].find(
          (session) => session.getCommittedHead().seq >= nonVoter.head().seq,
        );
        const history = latestSource?.exportSave();
        if (!history) throw new Error('Certified source history is unavailable');
        // oxlint-disable-next-line eslint/no-await-in-loop -- Prefix validation completes before the next virtual-clock step.
        const advanced = await nonVoter.advance(history.entries);
        if (!advanced.ok) throw new Error(`${advanced.error.code}: ${advanced.error.message}`);
        const actorSession = sessions.get(actorSeat);
        const actorHasTurn = actorSession
          ?.getPending()
          .some((item) => item.kind === 'player' && item.seat === actorSeat);
        if (!actorHasTurn) {
          for (const [seat, session] of sessions) {
            const pending = session
              .getPending()
              .some((item) => item.kind === 'player' && item.seat === seat);
            const privateState = session.getPrivate(seat);
            if (!pending || !privateState) continue;
            const command = enumerateCommands(
              fixture.engine,
              session.getState(),
              seat,
              privateState,
              { sampleIndex: () => 0 },
            )[0];
            if (command)
              // oxlint-disable-next-line eslint/no-await-in-loop -- Advance the actual game until the tested actor has a player action.
              await submitAndPump(session, seat, command, sessions, clock);
          }
          continue;
        }
        const command = nonVoter.legalCommands().commands[0];
        if (!command) continue;

        const current = replayCertifiedPrefix(
          history.genesis,
          history.entries,
          fixture.engine,
          fixture.policy,
        );
        if (!current.ok) throw new Error(`${current.error.code}: ${current.error.message}`);
        const parent = current.value.context;
        const offender = actorSeat;
        const offenderIdentity = fixture.identities.get(offender);
        if (!offenderIdentity) throw new Error(`Fixture identity ${offender} is missing`);
        const vote = (valueHash: string) =>
          signVote(
            {
              genesisDigest: parent.membership.genesisDigest,
              epoch: parent.membership.epoch,
              seat: offender,
              seq: parent.log.head.seq + 1,
              term: 1,
              phase: 'prevote',
              valueHash,
            },
            offenderIdentity.secretKey,
          );
        let term = 1;
        while (
          proposerFor(parent.log.head.seq + 1, term, parent.membership, parent.excludedProposers)
            .seat === offender
        )
          term += 1;
        const elected = proposerFor(
          parent.log.head.seq + 1,
          term,
          parent.membership,
          parent.excludedProposers,
        );
        const sequencer = fixture.identities.get(elected.seat);
        if (!sequencer) throw new Error(`Fixture proposer ${elected.seat} is missing`);
        const entry = signEntry(
          {
            seq: parent.log.head.seq + 1,
            term,
            prevHash: entryHash(parent.log.head),
            payload: {
              kind: 'control',
              action: 'exclude-proposer',
              offender,
              evidence: {
                kind: 'vote-equivocation',
                first: vote('a'.repeat(64)),
                second: vote('b'.repeat(64)),
              },
            },
            stateHash: parent.log.head.stateHash,
            sequencer: elected.publicKey,
          },
          sequencer.secretKey,
        );
        const certificate = ([1, 2, 3] as const).map((seat) => {
          const signer = fixture.identities.get(seat);
          if (!signer) throw new Error(`Fixture voter ${seat} is missing`);
          return signVote(
            {
              genesisDigest: parent.membership.genesisDigest,
              epoch: parent.membership.epoch,
              seat,
              seq: entry.seq,
              term: entry.term,
              phase: 'precommit',
              valueHash: entryHash(entry),
            },
            signer.secretKey,
          );
        });
        const exclusion: CertifiedEntry = { entry, certificate };
        // oxlint-disable-next-line eslint/no-await-in-loop -- Apply the synthetic certified control before testing its next command.
        const rejected = await nonVoter.advance([...history.entries, exclusion]);
        if (!rejected.ok) throw new Error(`${rejected.error.code}: ${rejected.error.message}`);
        const postExclusionCommand = nonVoter.legalCommands().commands[0];
        if (!postExclusionCommand)
          throw new Error('Actor lost its legal command after proposer exclusion');

        sessions.get(actorSeat)?.dispose();
        sessions.delete(actorSeat);
        // oxlint-disable-next-line eslint/no-await-in-loop -- Command preparation includes an optional proof round-trip.
        const submission = nonVoter.submit(postExclusionCommand, nonVoter.head());
        void submission.then((result) => {
          submitted = result;
          return result;
        });
        // oxlint-disable-next-line eslint/no-unmodified-loop-condition -- Promise settlement updates submitted asynchronously.
        for (let step = 0; step < 100 && submitted === null; step += 1) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Pump the asynchronous actor proof request with its virtual deadline.
          await Promise.all([...sessions.values()].map((session) => session.flush()));
          clock.advanceBy(250);
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- Actor resolves after the virtual proof request deadline.
        submitted = await submission;
        if (submitted.ok) {
          const legal = nonVoter.legalCommands().commands;
          const different = legal.find(
            (candidate) => !sameCommand(candidate, postExclusionCommand),
          );
          if (legal.length < 2 || !different)
            throw new Error('Fixture did not provide two distinct legal actions for one parent');
          // oxlint-disable-next-line eslint/no-await-in-loop -- Verify competing command is refused while the first is pending.
          const conflict = await nonVoter.submit(different, nonVoter.head());
          if (conflict.ok || conflict.error.code !== 'non-voter-command-pending')
            throw new Error('Actor accepted a second command at the same parent');
          // oxlint-disable-next-line eslint/no-await-in-loop -- Retry the identical signed command at the same parent.
          const retry = await nonVoter.submit(postExclusionCommand, nonVoter.head());
          if (!retry.ok || retry.value.sig !== submitted.value.sig)
            throw new Error('Actor retry did not reuse its retained signed command');
          const excludedPrefix = [...history.entries, exclusion];
          const excluded = replayCertifiedPrefix(
            history.genesis,
            excludedPrefix,
            fixture.engine,
            fixture.policy,
          );
          if (!excluded.ok) throw new Error(excluded.error.code);
          const after = excluded.value.context;
          const applied = fixture.engine.apply(after.log.state, {
            kind: 'command',
            seat: actorSeat,
            command: submitted.value.body.command,
          });
          if (!applied.ok) throw new Error(applied.error.code);
          const commandProposer = proposerFor(
            after.log.head.seq + 1,
            1,
            after.membership,
            after.excludedProposers,
          );
          const proposerIdentity = fixture.identities.get(commandProposer.seat);
          if (!proposerIdentity) throw new Error('Missing post-exclusion proposer');
          if (commandProposer.seat === actorSeat) throw new Error('Excluded proposer elected');
          const committedCommand = signEntry(
            {
              seq: after.log.head.seq + 1,
              term: 1,
              prevHash: entryHash(after.log.head),
              payload: { kind: 'command', signed: submitted.value },
              stateHash: toHex(hashValue(applied.value.state)),
              sequencer: commandProposer.publicKey,
            },
            proposerIdentity.secretKey,
          );
          const commandCertificate = ([1, 2, 3] as const).map((voterSeat) => {
            const signer = fixture.identities.get(voterSeat);
            if (!signer) throw new Error('Missing non-offender voter');
            return signVote(
              {
                genesisDigest: after.membership.genesisDigest,
                epoch: after.membership.epoch,
                seat: voterSeat,
                seq: committedCommand.seq,
                term: committedCommand.term,
                phase: 'precommit',
                valueHash: entryHash(committedCommand),
              },
              signer.secretKey,
            );
          });
          // oxlint-disable-next-line eslint/no-await-in-loop -- Validate the signed actor command through strict certified replay.
          const certified = await nonVoter.advance([
            ...excludedPrefix,
            { entry: committedCommand, certificate: commandCertificate },
          ]);
          if (!certified.ok) throw new Error(`${certified.error.code}: ${certified.error.message}`);
          if (nonVoter.head().seq !== committedCommand.seq)
            throw new Error('Actor command not applied');
        }
      }
      if (!submitted?.ok) throw new Error('Actor could not submit a legal command after exclusion');
      // The focused fixture validates offline certificates. Live network liveness
      // after exclusion belongs to the scenario-6 simulation acceptance run.
      const exclusionMessage = actorMessages.find((message) => message.t === 'SUBMIT');
      if (!exclusionMessage || exclusionMessage.t !== 'SUBMIT')
        throw new Error('Missing actor command');
      expect(submitted.value.body.headSeq + 1).toBe(nonVoter.head().seq);
      const messages = actorMessages;
      expect(actor?.privateState()?.seat).toBe(actorSeat);
      expect(
        messages.some((message) => message.t === 'SUBMIT' && message.cmd.body.seat === actorSeat),
      ).toBe(true);
      expect(messages.some((message) => ['PROPOSAL', 'VOTE', 'COMMIT'].includes(message.t))).toBe(
        false,
      );
      expect(publishedOwnedContribution).toBe(true);
    } finally {
      actor?.dispose();
      for (const session of sessions.values()) session.dispose();
      network.dispose();
      fixture.dispose();
    }
  }, 90_000);
});

```


### packages/protocol/src/testing/verified-network-fixture.ts
```
import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { scalarToBytes } from '@cp2p/crypto';
import type { Seat } from '@cp2p/engine';
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
          return new VerifiedSessionDriver(
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


### packages/protocol/src/testing/memnet.ts
```
import type { PeerId, ProtocolClock, Transport, Unsubscribe } from '../transport.js';
import { VirtualClock } from './virtual-clock.js';

const DEFAULT_SEED = 0x6d2b79f5;

/** Per-direction packet timing and loss controls for a memnet link. */
export interface MemnetLinkOptions {
  readonly latencyMs?: number;
  readonly jitterMs?: number;
  readonly dropProbability?: number;
  readonly duplicateProbability?: number;
  /** Allow packets to overtake earlier packets while this connection stays up. */
  readonly reorder?: boolean;
}

/** Authenticated in-memory peer mesh; defaults to a deterministic virtual clock. */
export interface MemnetOptions<Clock extends ProtocolClock = VirtualClock> {
  readonly peers: readonly PeerId[];
  readonly seed?: number;
  readonly clock?: Clock;
  readonly defaultLink?: MemnetLinkOptions;
}

/** In-memory network controls shared by the transports it creates. */
export interface Memnet<Clock extends ProtocolClock = VirtualClock> {
  readonly clock: Clock;
  peers(): PeerId[];
  /** Number of additional duplicated packets actually delivered since creation. */
  diagnostics(): MemnetDiagnostics;
  transport(peer: PeerId): Transport;
  setLinkOptions(from: PeerId, to: PeerId, options: MemnetLinkOptions): void;
  disconnect(from: PeerId, to: PeerId): void;
  connect(from: PeerId, to: PeerId): void;
  partition(groups: readonly (readonly PeerId[])[]): void;
  heal(): void;
  crash(peer: PeerId): void;
  restart(peer: PeerId): Transport;
  dispose(): void;
}

export interface MemnetDiagnostics {
  readonly duplicateDeliveries: number;
}

interface DirectionOptions {
  latencyMs: number;
  jitterMs: number;
  dropProbability: number;
  duplicateProbability: number;
  reorder: boolean;
}

interface LinkPair {
  enabled: boolean;
  generation: number;
  readonly directions: Map<PeerId, DirectionOptions>;
  readonly nextOrderedDelivery: Map<PeerId, number>;
}

interface PeerRuntime {
  readonly id: PeerId;
  alive: boolean;
  generation: number;
  transport: MemnetTransport | null;
}

interface MessageListener {
  (from: PeerId, message: Uint8Array): void;
}

interface PeerChangeListener {
  (peer: PeerId, online: boolean): void;
}

/**
 * A seeded network simulator for protocol tests. It has no runtime game or
 * cryptographic dependencies; peer IDs are the pre-authenticated test roster.
 */
export function createMemnet<Clock extends ProtocolClock>(
  options: MemnetOptions<Clock> & { readonly clock: Clock },
): Memnet<Clock>;
export function createMemnet(options: MemnetOptions): Memnet;
export function createMemnet(options: MemnetOptions<ProtocolClock>): Memnet<ProtocolClock> {
  return new MemnetNetwork(options, options.clock ?? new VirtualClock());
}

class MemnetNetwork<Clock extends ProtocolClock> implements Memnet<Clock> {
  private readonly random: SeededRandom;
  private readonly runtimes = new Map<PeerId, PeerRuntime>();
  private readonly pairs = new Map<string, LinkPair>();
  private readonly defaultDirection: DirectionOptions;
  private readonly scheduled = new Set<unknown>();
  private duplicateDeliveries = 0;
  private disposed = false;

  constructor(
    options: MemnetOptions<Clock>,
    readonly clock: Clock,
  ) {
    if (options.peers.length === 0) throw new RangeError('memnet requires at least one peer');
    const uniquePeers = new Set<PeerId>();
    for (const peer of options.peers) {
      if (typeof peer !== 'string' || peer.length === 0 || peer.includes('\u0000'))
        throw new TypeError('peer IDs must be non-empty strings without NUL characters');
      if (uniquePeers.has(peer)) throw new Error(`duplicate peer ID: ${peer}`);
      uniquePeers.add(peer);
      this.runtimes.set(peer, { id: peer, alive: true, generation: 0, transport: null });
    }
    this.random = new SeededRandom(options.seed ?? DEFAULT_SEED);
    this.defaultDirection = normalizeDirectionOptions(options.defaultLink ?? {});
    for (let leftIndex = 0; leftIndex < options.peers.length; leftIndex++) {
      const left = options.peers[leftIndex];
      if (!left) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < options.peers.length; rightIndex++) {
        const right = options.peers[rightIndex];
        if (right) this.createPair(left, right);
      }
    }
    for (const peer of options.peers) this.createTransport(peer);
  }

  peers(): PeerId[] {
    return [...this.runtimes.values()]
      .filter((runtime) => runtime.alive)
      .map((runtime) => runtime.id)
      .toSorted();
  }

  diagnostics(): MemnetDiagnostics {
    return { duplicateDeliveries: this.duplicateDeliveries };
  }

  getConnectedPeers(peer: PeerId, generation: number): PeerId[] {
    if (!this.isCurrentTransport(peer, generation)) return [];
    return this.peersFor(peer);
  }

  transport(peer: PeerId): Transport {
    const runtime = this.requireRuntime(peer);
    if (!runtime.alive || !runtime.transport) throw new Error(`peer is offline: ${peer}`);
    return runtime.transport;
  }

  setLinkOptions(from: PeerId, to: PeerId, options: MemnetLinkOptions): void {
    this.assertActive();
    this.assertDistinctPeers(from, to);
    const pair = this.requirePair(from, to);
    const prior = pair.directions.get(from) ?? this.defaultDirection;
    pair.directions.set(from, normalizeDirectionOptions(options, prior));
  }

  disconnect(from: PeerId, to: PeerId): void {
    this.setConnection(from, to, false);
  }

  connect(from: PeerId, to: PeerId): void {
    this.setConnection(from, to, true);
  }

  partition(groups: readonly (readonly PeerId[])[]): void {
    this.assertActive();
    const owner = new Map<PeerId, number>();
    groups.forEach((group, index) => {
      for (const peer of group) {
        this.requireRuntime(peer);
        if (owner.has(peer)) throw new Error(`peer appears in more than one partition: ${peer}`);
        owner.set(peer, index);
      }
    });
    for (const peer of this.runtimes.keys()) if (!owner.has(peer)) owner.set(peer, groups.length);
    for (const [pairKey, pair] of this.pairs) {
      const [left, right] = splitPairKey(pairKey);
      if (owner.get(left) !== owner.get(right)) this.setPairEnabled(left, right, false, pair);
    }
  }

  /** Restore a full mesh among currently live peers. */
  heal(): void {
    this.assertActive();
    for (const [pairKey, pair] of this.pairs) {
      const [left, right] = splitPairKey(pairKey);
      if (this.isAlive(left) && this.isAlive(right)) this.setPairEnabled(left, right, true, pair);
    }
  }

  crash(peer: PeerId): void {
    this.assertActive();
    const runtime = this.requireRuntime(peer);
    if (!runtime.alive) return;
    const connected = this.peersFor(peer);
    runtime.alive = false;
    runtime.generation++;
    runtime.transport?.deactivate();
    runtime.transport = null;
    for (const other of connected) this.notifyPeerChange(other, peer, false);
  }

  restart(peer: PeerId): Transport {
    this.assertActive();
    const runtime = this.requireRuntime(peer);
    if (runtime.alive) throw new Error(`peer is already online: ${peer}`);
    runtime.alive = true;
    runtime.generation++;
    this.createTransport(peer);
    for (const other of this.peersFor(peer)) {
      this.notifyPeerChange(other, peer, true);
      this.notifyPeerChange(peer, other, true);
    }
    if (!runtime.transport) throw new Error('restart failed to create transport');
    return runtime.transport;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const handle of this.scheduled) this.clock.clearTimeout(handle);
    this.scheduled.clear();
    for (const runtime of this.runtimes.values()) {
      runtime.alive = false;
      runtime.generation++;
      runtime.transport?.deactivate();
      runtime.transport = null;
    }
  }

  send(from: PeerId, to: PeerId, message: Uint8Array, generation: number): void {
    if (!this.isCurrentTransport(from, generation)) return;
    this.requireRuntime(to);
    if (!this.isConnected(from, to)) return;
    const pair = this.requirePair(from, to);
    const linkOptions = pair.directions.get(from) ?? this.defaultDirection;
    if (this.random.next() < linkOptions.dropProbability) return;
    const copies = this.random.next() < linkOptions.duplicateProbability ? 2 : 1;
    const bytes = Uint8Array.from(message);
    const senderGeneration = this.requireRuntime(from).generation;
    const receiverGeneration = this.requireRuntime(to).generation;
    const linkGeneration = pair.generation;
    const jitterRange = linkOptions.jitterMs * 2 + 1;
    const sampledJitter = Math.floor(this.random.next() * jitterRange) - linkOptions.jitterMs;
    let deliveryAt = this.clock.now() + linkOptions.latencyMs + sampledJitter;
    deliveryAt = Math.max(this.clock.now(), deliveryAt);
    if (!linkOptions.reorder) {
      deliveryAt = Math.max(deliveryAt, pair.nextOrderedDelivery.get(from) ?? deliveryAt);
      pair.nextOrderedDelivery.set(from, deliveryAt);
    }
    for (let copy = 0; copy < copies; copy++) {
      this.schedule(deliveryAt, () => {
        if (
          this.disposed ||
          !this.isCurrentTransport(from, generation) ||
          this.requireRuntime(from).generation !== senderGeneration ||
          this.requireRuntime(to).generation !== receiverGeneration ||
          pair.generation !== linkGeneration ||
          !this.isConnected(from, to)
        )
          return;
        if (copy > 0) this.duplicateDeliveries++;
        this.requireRuntime(to).transport?.deliver(from, bytes);
      });
    }
  }

  private schedule(at: number, callback: () => void): void {
    const handle = this.clock.setTimeout(() => {
      this.scheduled.delete(handle);
      callback();
    }, at - this.clock.now());
    this.scheduled.add(handle);
  }

  private setConnection(from: PeerId, to: PeerId, enabled: boolean): void {
    this.assertActive();
    this.assertDistinctPeers(from, to);
    const pair = this.requirePair(from, to);
    this.setPairEnabled(from, to, enabled, pair);
  }

  private setPairEnabled(from: PeerId, to: PeerId, enabled: boolean, pair: LinkPair): void {
    if (pair.enabled === enabled) return;
    const wasConnected = this.isAlive(from) && this.isAlive(to) && pair.enabled;
    pair.enabled = enabled;
    pair.generation++;
    pair.nextOrderedDelivery.clear();
    const connected = this.isAlive(from) && this.isAlive(to) && enabled;
    if (wasConnected !== connected) {
      this.notifyPeerChange(from, to, connected);
      this.notifyPeerChange(to, from, connected);
    }
  }

  private createPair(left: PeerId, right: PeerId): void {
    this.pairs.set(makePairKey(left, right), {
      enabled: true,
      generation: 0,
      directions: new Map(),
      nextOrderedDelivery: new Map(),
    });
  }

  private createTransport(peer: PeerId): void {
    const runtime = this.requireRuntime(peer);
    runtime.transport = new MemnetTransport(this, runtime.id, runtime.generation);
  }

  private peersFor(peer: PeerId): PeerId[] {
    return [...this.runtimes.keys()]
      .filter((candidate) => candidate !== peer && this.isConnected(peer, candidate))
      .toSorted();
  }

  private isConnected(left: PeerId, right: PeerId): boolean {
    return (
      left !== right &&
      this.isAlive(left) &&
      this.isAlive(right) &&
      (this.pairs.get(makePairKey(left, right))?.enabled ?? false)
    );
  }

  private isAlive(peer: PeerId): boolean {
    return this.runtimes.get(peer)?.alive ?? false;
  }

  private isCurrentTransport(peer: PeerId, generation: number): boolean {
    const runtime = this.runtimes.get(peer);
    return !this.disposed && Boolean(runtime?.alive && runtime.generation === generation);
  }

  private notifyPeerChange(receiver: PeerId, peer: PeerId, online: boolean): void {
    this.runtimes.get(receiver)?.transport?.deliverPeerChange(peer, online);
  }

  private requireRuntime(peer: PeerId): PeerRuntime {
    const runtime = this.runtimes.get(peer);
    if (!runtime) throw new Error(`unknown peer: ${peer}`);
    return runtime;
  }

  private requirePair(left: PeerId, right: PeerId): LinkPair {
    const pair = this.pairs.get(makePairKey(left, right));
    if (!pair) throw new Error(`unknown link: ${left} ↔ ${right}`);
    return pair;
  }

  private assertDistinctPeers(left: PeerId, right: PeerId): void {
    this.requireRuntime(left);
    this.requireRuntime(right);
    if (left === right) throw new Error('a peer cannot link to itself');
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('memnet is disposed');
  }
}

class MemnetTransport implements Transport {
  private readonly messageListeners = new Set<MessageListener>();
  private readonly peerChangeListeners = new Set<PeerChangeListener>();
  private active = true;

  constructor(
    private readonly network: MemnetNetwork<ProtocolClock>,
    readonly self: PeerId,
    private readonly generation: number,
  ) {}

  peers(): PeerId[] {
    return this.active ? this.network.getConnectedPeers(this.self, this.generation) : [];
  }

  send(to: PeerId, message: Uint8Array): void {
    if (!this.active) return;
    this.network.send(this.self, to, message, this.generation);
  }

  broadcast(message: Uint8Array): void {
    if (!this.active) return;
    for (const peer of this.peers()) this.send(peer, message);
  }

  onMessage(listener: MessageListener): Unsubscribe {
    return subscribe(this.messageListeners, listener, this.active);
  }

  onPeerChange(listener: PeerChangeListener): Unsubscribe {
    return subscribe(this.peerChangeListeners, listener, this.active);
  }

  disconnect(peer: PeerId): void {
    if (this.active) this.network.disconnect(this.self, peer);
  }

  deliver(from: PeerId, message: Uint8Array): void {
    if (!this.active) return;
    for (const listener of Array.from(this.messageListeners))
      listener(from, Uint8Array.from(message));
  }

  deliverPeerChange(peer: PeerId, online: boolean): void {
    if (!this.active) return;
    for (const listener of Array.from(this.peerChangeListeners)) listener(peer, online);
  }

  deactivate(): void {
    this.active = false;
    this.messageListeners.clear();
    this.peerChangeListeners.clear();
  }
}

function subscribe<T>(listeners: Set<T>, listener: T, active: boolean): Unsubscribe {
  if (!active) return () => {};
  listeners.add(listener);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    listeners.delete(listener);
  };
}

function normalizeDirectionOptions(
  options: MemnetLinkOptions,
  base: DirectionOptions = {
    latencyMs: 0,
    jitterMs: 0,
    dropProbability: 0,
    duplicateProbability: 0,
    reorder: false,
  },
): DirectionOptions {
  const normalized = {
    latencyMs: options.latencyMs ?? base.latencyMs,
    jitterMs: options.jitterMs ?? base.jitterMs,
    dropProbability: options.dropProbability ?? base.dropProbability,
    duplicateProbability: options.duplicateProbability ?? base.duplicateProbability,
    reorder: options.reorder ?? base.reorder,
  };
  if (!Number.isSafeInteger(normalized.latencyMs) || normalized.latencyMs < 0)
    throw new RangeError('latencyMs must be a non-negative safe integer');
  if (!Number.isSafeInteger(normalized.jitterMs) || normalized.jitterMs < 0)
    throw new RangeError('jitterMs must be a non-negative safe integer');
  for (const [name, value] of [
    ['dropProbability', normalized.dropProbability],
    ['duplicateProbability', normalized.duplicateProbability],
  ] as const)
    if (!Number.isFinite(value) || value < 0 || value > 1)
      throw new RangeError(`${name} must be between zero and one`);
  return normalized;
}

function makePairKey(left: PeerId, right: PeerId): string {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function splitPairKey(key: string): readonly [PeerId, PeerId] {
  const separator = key.indexOf('\u0000');
  return [key.slice(0, separator), key.slice(separator + 1)];
}

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) throw new RangeError('seed must be a safe integer');
    this.state = seed >>> 0 || DEFAULT_SEED;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }
}

```


### docs/verification/stage07/verified-non-voter-review-disposition.md
```
# Verified non-voter actor review disposition

The review input is `verified-network-review-raw.json`. This disposition covers the actor and focused test. The network runner has separate acceptance checks.

- B1: Actor sideband retransmits reuse a bounded artifact cache and send identical packets at most once per 250 milliseconds of protocol time. Simultaneous publication calls share one promise. SUBMIT and trade proof requests retain explicit caller/request retries. The focused test checks repeated publication at one clock instant adds no outgoing messages.
- M4: Trade proof requests must arrive from the authenticated requester's peer. Responses go to that peer, and a bounded per-head cache reuses signed responses for duplicate requests. Relayed requests receive no proofs.
- M5: Public asynchronous operations catch exceptions and return `non-voter-operation`; inbound fire-and-forget trade handling consumes rejections. Constructor failure disposes initialized private resources. Prefix hashing exceptions follow the same Result boundary.
- M6: Deck unlock preparation captures the operation ID and unlock prefix before awaiting and sends that same prefix. A missing operation ID produces no packet. Every asynchronous contribution preparation checks that its certified context remains current before sending.
- Output aliases: Private state and automatic commands are detached through the canonical codec. The focused test mutates a returned hand snapshot and checks that the next snapshot is unchanged.
- M2: The focused test now mutates the original caller-owned accepted entry in place, then replays an untouched copy. It also checks that changed entry hashes are refused.
- H3: The focused test disposes the original seat-0 session before command submission, retains the complete actor message capture, chooses a non-offender exclusion proposer, signs both the exclusion and following command certificates with seats 1, 2, and 3, and applies both through strict certified replay. It verifies repeated commands reuse the in-memory signature and competing commands at that parent fail.
- M1: Actor submission runs while the test pumps the virtual clock, including the remote-proof deadline. The test no longer waits on a network promise without advancing protocol time.

The exclusion and following command certificates in this focused test are assembled by the fixture. They prove signature, quorum, strict replay, private continuation, and outbound actor constraints. They do not prove that live honest replicas elect, vote, and certify these entries after exclusion. Scenario 6 must supply that evidence. The focused test also does not target delayed deck-prefix races, dropped contribution retry delivery, hostile trade request replay, exception injection, or final master audit completion as independent test cases.

The alternate certificate wrapper check proves that an already-accepted signed entry can be supplied under another wrapper. The actor keeps its first validated certificate and intentionally does not validate replacement wrappers for previously accepted entries. This is not a new certificate-admission test. The retained command is in memory; recreation durability is outside this actor's contract.

```


### .github/workflows/verified-network.yml
```
name: Verified network acceptance

on:
  workflow_dispatch:
    inputs:
      scenario:
        description: Run every fault case or repeat one selected scenario
        type: choice
        required: true
        default: all
        options:
          - all
          - '1'
          - '2'
          - '3'
          - '4'
          - '5'
          - '6'
          - '7'
          - '8'
          - '9'

permissions:
  contents: read

concurrency:
  group: verified-network-${{ github.ref }}
  cancel-in-progress: false

jobs:
  full-game:
    name: Real crypto scenario ${{ matrix.scenario }}
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        scenario: ${{ fromJSON(inputs.scenario == 'all' && '[1,2,3,4,5,6,7,8,9]' || format('[{0}]', inputs.scenario)) }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10.7.1
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec tsc -b tools/sim
      - name: Record source revision
        run: git rev-parse HEAD > verified-source-revision.txt
      - name: Run one complete game with independent peer audits
        run: >-
          node tools/sim/dist/index.js net
          --security verified
          --scenario ${{ matrix.scenario }}
          --seeds 1
          --seed 42
          --start-index 0
          --parallel 1
          --max-elapsed-ms 900000
          > verified-network-${{ matrix.scenario }}.json
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: verified-network-${{ matrix.scenario }}
          path: |
            verified-network-${{ matrix.scenario }}.json
            verified-source-revision.txt
          if-no-files-found: warn
          retention-days: 14

```