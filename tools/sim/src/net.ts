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
  CertifiedEntry,
  ProposalContext,
  ProtocolClock,
  SessionUpdate,
  Transport,
} from '@cp2p/protocol';
import { SimulationDriver, createMemnet, createSimulationGenesis } from '@cp2p/protocol/testing';
import { deriveSeed } from './random-source.js';
import { invalidCommandProposal } from './net-adversary.js';

export interface NetworkGameOptions {
  seed: number;
  gameIndex: number;
  scenario: number;
  maxSteps?: number;
  onProgress?: (progress: {
    revision: number;
    turn: number;
    virtualMilliseconds: number;
    elapsedMilliseconds: number;
  }) => void;
}

export interface NetworkGameResult {
  seed: number;
  gameIndex: number;
  scenario: number;
  turns: number;
  inputs: number;
  virtualMilliseconds: number;
  elapsedMilliseconds: number;
  finalStateHash: string;
  finalLogHash: string;
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
  const game = createSimulationGenesis({ seed: options.seed, gameIndex: options.gameIndex });
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
      return unwrap(
        encodeProtocolMessage({
          t: 'PROPOSAL',
          proposal: invalidCommandProposal(
            decoded.proposal,
            game.genesis,
            seat,
            identity.secretKey,
          ),
        }),
      );
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

  async function open(seat: Seat, restoring: boolean): Promise<void> {
    const identity = game.identities.get(seat);
    const journal = journals.get(seat);
    if (!identity || !journal) throw new Error('Missing simulation identity or journal');
    const sessionOptions = {
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
      const latest = [...updates.values()].toSorted((a, b) => b.revision - a.revision)[0];
      if (!latest) throw new Error('No peer state available');
      // oxlint-disable-next-line no-await-in-loop -- Crash recovery must restore durable journals before the next delivery.
      await advanceFault(latest);
      if (
        [...updates.values()].every(
          (update) => update.state.result && update.revision === latest.revision,
        )
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
          if (maliciousHeight === null) throw new Error('No invalid proposer height was recorded');
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
              control.certificate.length < 3
            )
              throw new Error(`Peer ${seat} lacks the certified offender-0 exclusion`);
            certifiedExclusionPeers++;
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
        return {
          seed: options.seed,
          gameIndex: options.gameIndex,
          scenario: options.scenario,
          turns: latest.state.turn.number,
          inputs: latest.revision,
          virtualMilliseconds: network.clock.now(),
          elapsedMilliseconds: performance.now() - started,
          finalStateHash: toHex(hashValue(latest.state)),
          finalLogHash,
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
          },
        };
      }
      if (submission?.result) {
        const disposedByIntentionalCrash =
          intentionallyInterruptedSubmissions.has(submission) &&
          !submission.result.ok &&
          ['replica-outcome-unknown', 'replica-disposed'].includes(submission.result.error.code);
        if (
          !submission.result.ok &&
          !['renewed-intent', 'command-pending'].includes(submission.result.error.code) &&
          !disposedByIntentionalCrash
        )
          throw new Error(`Submission rejected: ${submission.result.error.code}`);
        submission = null;
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
        byzantineSubmissionRevision = null;
        byzantineSubmissionHash = null;
      }
      if (!submission && !latest.state.result) {
        const pending = choosePending(latest.state, game.engine.getPending(latest.state));
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
          const rebuilt = byzantinePrivate(history);
          if (rebuilt.context.log.head.seq !== latest.revision)
            throw new Error('Byzantine command actor is behind the honest certified head');
          const chosen = actor.bot.decide(
            { state: latest.state, seat: 0, priv: rebuilt.privateState },
            pending,
            actor.rng,
          );
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
    for (const session of sessions.values()) session.dispose();
    network.dispose();
  }
}

function choosePending(state: GameState, pending: readonly Pending[]) {
  const players = pending.filter(
    (item): item is Extract<Pending, { kind: 'player' }> =>
      item.kind === 'player' && item.allowed.some((type) => type !== 'CLAIM_VICTORY'),
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
