import { canonicalEncode, fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { createHashChain, signObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import {
  MemoryBeaconContributionStore,
  type BeaconContributionStore,
  type BeaconSecretSource,
} from './beacon-contributions.js';
import { beaconOperationId, signBeaconReveal } from './beacon.js';
import { resolveArtifactSigner } from './authority.js';
import { getBeaconOperation } from './beacon-state.js';
import { MemoryCheatCandidateStore } from './cheat-candidates.js';
import type { CheatClaim } from './cheat-proof.js';
import { MemoryCountContributionStore } from './count-contributions.js';
import { MemoryStealDeliveryStore } from './steal-contributions.js';
import {
  GENESIS_PREVIOUS_HASH,
  entryHash,
  genesisBody,
  genesisId,
  signEntry,
  signVerifiedGenesis,
} from './genesis.js';
import { MemoryProtocolJournal } from './journal.js';
import { signCommand } from './log.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import type { ProtocolMessage } from './messages.js';
import { ReplicatedLog } from './replicated-log.js';
import { proposerFor } from './proposal.js';
import type { ReplicatedLogOptions, ReplicatedLogStatus } from './replicated-log.js';
import { randomDerivations } from './random-derivations.js';
import { replayCertifiedPrefix, snapshotFromContext } from './replay.js';
import type { ReplayPolicy } from './replay.js';
import { createMemnet } from './testing/memnet.js';
import { createGenesisDeckFixture } from './testing/deck-fixture.js';
import { createSimulationGenesis } from './testing/simulation-genesis.js';
import type { VirtualClock } from './testing/virtual-clock.js';
import type { PeerId, Transport } from './transport.js';
import type { Genesis, GenesisBody } from './types.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | undefined): T {
  if (item === undefined) throw new Error('Missing verified beacon fixture');
  return item;
}

function setupPassCount(fixture: ReturnType<typeof verifiedFixture>): number {
  return fixture.deck.transcripts.reduce(
    (count, transcript) => count + transcript.passes.length,
    0,
  );
}

function policyFor(): ReplayPolicy {
  return {
    // Base deck proofs are checked by signVerifiedGenesis and each certified deck-pass fold.
    genesis: { verifyCommitments: () => success(undefined) },
    entry: {
      // Setup and roll commands are public; the engine still checks their exact legality.
      verifyCommand: (signed) =>
        ['PLACE_SETTLEMENT', 'PLACE_ROAD', 'ROLL_DICE'].includes(signed.body.command.type)
          ? success(undefined)
          : failure('fixture-command', 'This fixture only drives public setup and roll commands'),
    },
  };
}

function verifiedFixture(humanCount = 2, chainLength = 2) {
  const simulation = createSimulationGenesis({ seed: 91, humanCount });
  const humans = simulation.genesis.seats.filter((seat) => seat.kind === 'human');
  const chains = humans.map((_, index) =>
    createHashChain(new Uint8Array(32).fill(index + 29), chainLength),
  );
  const renewals = humans.map((_, index) =>
    createHashChain(new Uint8Array(32).fill(index + 49), chainLength),
  );
  const initialBody: GenesisBody = {
    ...genesisBody(simulation.genesis),
    security: 'verified',
    commitments: {
      beaconChains: humans.map((seat, index) => ({
        seat: seat.seat,
        length: chainLength,
        tip: toBase64Url(required(required(chains[index])[0])),
      })),
    },
  };
  const deck = createGenesisDeckFixture(initialBody, simulation.identities);
  const body = deck.body;
  const signatures = humans.map((seat) => {
    const signed = signVerifiedGenesis(
      body,
      deck.transcripts,
      seat.seat,
      required(simulation.identities.get(seat.seat)).secretKey,
    );
    if (!signed.ok) throw new Error(`Verified genesis signing failed: ${signed.error.message}`);
    return signed.value;
  });
  const genesis: Genesis = { ...body, gameId: genesisId(body), signatures };
  const state = simulation.engine.createGame(body.config, fromBase64Url(body.genesisSeed));
  const first = required(simulation.identities.get(required(humans[0]).seat));
  const entry = signEntry(
    {
      seq: 0,
      term: 1,
      prevHash: GENESIS_PREVIOUS_HASH,
      payload: { kind: 'genesis', genesis },
      stateHash: toHex(hashValue(state)),
      sequencer: first.peerId,
    },
    first.secretKey,
  );
  const sources = humans.map((_, position): BeaconSecretSource => ({
    link(chainEpoch, index) {
      if (index < 1 || index > chainLength) throw new Error('Unexpected local beacon link');
      if (chainEpoch === 0) return required(required(chains[position])[index]);
      if (chainEpoch === 1) return required(required(renewals[position])[index]);
      throw new Error('Unexpected local beacon chain epoch');
    },
    extension(chainEpoch) {
      if (chainEpoch !== 1) throw new Error('Unexpected chain renewal');
      return { length: chainLength, tip: required(required(renewals[position])[0]) };
    },
  }));
  return { simulation, humans, chains, renewals, deck, entry, sources };
}

function observe(
  inner: Transport,
  sent: ProtocolMessage[],
): Transport & { inject(from: PeerId, message: ProtocolMessage): void } {
  const capture = (bytes: Uint8Array) => sent.push(value(decodeProtocolMessage(bytes)));
  let listener: ((from: PeerId, bytes: Uint8Array) => void) | null = null;
  return {
    self: inner.self,
    peers: () => inner.peers(),
    send(to, bytes) {
      capture(bytes);
      inner.send(to, bytes);
    },
    broadcast(bytes) {
      capture(bytes);
      inner.broadcast(bytes);
    },
    onMessage(callback) {
      listener = callback;
      const unsubscribe = inner.onMessage(callback);
      return () => {
        listener = null;
        unsubscribe();
      };
    },
    onPeerChange: (callback) => inner.onPeerChange(callback),
    disconnect: (peer) => inner.disconnect(peer),
    inject(from, message) {
      listener?.(from, value(encodeProtocolMessage(message)));
    },
  };
}

function observeWithoutSystemContributions(
  inner: Transport,
  sent: ProtocolMessage[],
): ReturnType<typeof observe> {
  const observed = observe(inner, sent);
  return {
    ...observed,
    broadcast(bytes) {
      const message = value(decodeProtocolMessage(bytes));
      if (message.t === 'SYS_CONTRIB') return;
      observed.broadcast(bytes);
    },
  };
}

function observeWithheldBeaconVotes(
  inner: Transport,
  sent: ProtocolMessage[],
  seq: number,
  isWithheld: () => boolean,
): ReturnType<typeof observe> {
  const observed = observeWithoutSystemContributions(inner, sent);
  return {
    ...observed,
    broadcast(bytes) {
      const message = value(decodeProtocolMessage(bytes));
      if (message.t === 'VOTE' && message.vote.body.seq === seq && isWithheld()) return;
      observed.broadcast(bytes);
    },
  };
}

function deliverFirstProposal(
  from: PeerId,
  target: ReturnType<typeof observe>,
  sent: ProtocolMessage[],
) {
  const proposal = sent.find((message) => message.t === 'PROPOSAL');
  if (!proposal) throw new Error('Expected the initial deck setup proposal');
  target.inject(from, proposal);
  const prevote = sent.find(
    (message) =>
      message.t === 'VOTE' &&
      message.vote.body.seq === proposal.proposal.body.entry.seq &&
      message.vote.body.phase === 'prevote',
  );
  if (!prevote) throw new Error('Expected the initial deck setup prevote');
  target.inject(from, prevote);
}

function optionsFor(
  fixture: ReturnType<typeof verifiedFixture>,
  position: number,
  transport: Transport,
  clock: VirtualClock,
  journal: MemoryProtocolJournal,
  store: BeaconContributionStore,
  onStatus?: ReplicatedLogOptions['onStatus'],
): ReplicatedLogOptions {
  const seat = required(fixture.humans[position]).seat;
  return {
    genesisEntry: fixture.entry,
    engine: fixture.simulation.engine,
    policy: policyFor(),
    deckSetupPasses: fixture.deck.transcripts.flatMap((transcript) =>
      transcript.passes.map((pass) => ({ deckId: transcript.deckId, pass })),
    ),
    seat,
    secretKey: required(fixture.simulation.identities.get(seat)).secretKey,
    transport,
    clock,
    journal,
    cheatCandidateStore: new MemoryCheatCandidateStore(),
    beaconSource: required(fixture.sources[position]),
    beaconContributions: store,
    // This isolated beacon fixture never enters Monopoly.
    countProof: () => failure('count-not-exercised', 'No count proof in the beacon fixture'),
    countContributionStore: new MemoryCountContributionStore(),
    stealContribution: () => failure('steal-not-exercised', 'No steal in the beacon fixture'),
    stealResponse: () => failure('steal-not-exercised', 'No steal in the beacon fixture'),
    stealDeliveryStore: new MemoryStealDeliveryStore(),
    deckContributions: store,
    createDeckSource: (_deckId, ownerSeat) => fixture.deck.createSource(ownerSeat),
    botKeys: new Map(
      fixture.simulation.genesis.seats
        .filter(
          (item) =>
            item.kind === 'bot' && item.botHost === required(fixture.humans[position]).publicKey,
        )
        .map((item) => [
          item.seat,
          required(fixture.simulation.identities.get(item.seat)).secretKey,
        ]),
    ),
    ...(onStatus ? { onStatus } : {}),
  };
}

async function settle(replicas: readonly ReplicatedLog[], clock: VirtualClock) {
  for (let pass = 0; pass < 64; pass += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Each pass drains packets scheduled by the previous pass.
    await Promise.all(replicas.map((replica) => replica.flush()));
    clock.advanceBy(0);
    // Yield so packets enqueued by this flush are delivered before the next replica flush.
    // oxlint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.all(replicas.map((replica) => replica.flush()));
}

async function playSetupThroughRoll(
  replica: ReplicatedLog,
  clock: VirtualClock,
  fixture: ReturnType<typeof verifiedFixture>,
): Promise<void> {
  for (let step = 0; step < 32; step += 1) {
    const context = replica.getContext();
    const player = context.log.engine
      .getPending(context.log.state)
      .find((item) => item.kind === 'player');
    if (!player || player.kind !== 'player') throw new Error('Expected setup or roll choice');
    const commands = context.log.engine.getLegalCommands(context.log.state, player.seat).commands;
    const command = commands.find((item) => item.type === 'ROLL_DICE') ?? commands[0];
    if (!command) throw new Error('No legal setup or roll command');
    const locallyApplied = context.log.engine.apply(context.log.state, {
      kind: 'command',
      seat: player.seat,
      command,
    });
    if (!locallyApplied.ok) throw new Error(`Legal command failed: ${locallyApplied.error.code}`);
    const signed = signCommand(
      {
        gameId: context.log.genesis.gameId,
        genesisDigest: context.membership.genesisDigest,
        seat: player.seat,
        nonce: (context.log.lastNonces.get(player.seat) ?? 0) + 1,
        headSeq: context.log.head.seq,
        headHash: entryHash(context.log.head),
        command,
      },
      required(fixture.simulation.identities.get(player.seat)).secretKey,
    );
    let resolved: Result<void> | null = null;
    void replica.submit(signed).then((result) => {
      resolved = result;
      return undefined;
    });
    // oxlint-disable-next-line no-await-in-loop -- Each legal command depends on the preceding certified head.
    await settle([replica], clock);
    if (resolved === null)
      throw new Error(`Legal ${command.type} did not commit at setup step ${step}`);
    value(resolved);
    if (command.type === 'ROLL_DICE') return;
  }
  throw new Error('Setup did not reach a dice roll');
}

describe('verified beacon contribution replication', () => {
  test('needs both human tips before START_SEAT can be certified, then converges', async () => {
    const fixture = verifiedFixture();
    const peers = fixture.humans.map(
      (seat) => required(fixture.simulation.identities.get(seat.seat)).peerId,
    );
    const network = createMemnet({ peers });
    const sent: ProtocolMessage[][] = [[], []];
    const transports = peers.map((peer, index) =>
      observe(network.transport(peer), required(sent[index])),
    );
    const journals = [new MemoryProtocolJournal(), new MemoryProtocolJournal()];
    const stores = [new MemoryBeaconContributionStore(), new MemoryBeaconContributionStore()];
    const firstOptions = optionsFor(
      fixture,
      0,
      required(transports[0]),
      network.clock,
      required(journals[0]),
      required(stores[0]),
    );
    expect(await ReplicatedLog.create({ ...firstOptions, deckSetupPasses: [] })).toMatchObject({
      ok: false,
      error: { code: 'replica-deck-transcript' },
    });
    const changedPass = required(firstOptions.deckSetupPasses?.[0]);
    expect(
      await ReplicatedLog.create({
        ...firstOptions,
        deckSetupPasses: [{ ...changedPass, deckId: 'uncommitted-deck' }],
      }),
    ).toMatchObject({ ok: false, error: { code: 'replica-deck-transcript' } });
    expect(await required(journals[0]).load()).toBeNull();
    const first = value(await ReplicatedLog.create(firstOptions));
    await settle([first], network.clock);
    expect(first.getContext().log.head.seq).toBe(0);
    expect(required(sent[0]).some((message) => message.t === 'SYS_CONTRIB')).toBe(false);
    const second = value(
      await ReplicatedLog.create(
        optionsFor(
          fixture,
          1,
          required(transports[1]),
          network.clock,
          required(journals[1]),
          required(stores[1]),
        ),
      ),
    );
    deliverFirstProposal(required(peers[0]), required(transports[1]), required(sent[0]));
    await settle([first, second], network.clock);
    const setupCount = setupPassCount(fixture);
    expect(first.getContext().log.head.seq).toBe(setupCount + 1);
    expect(second.getContext().log.head.seq).toBe(setupCount + 1);
    expect(first.getContext().log.head.stateHash).toBe(second.getContext().log.head.stateHash);
    const duplicate = required(sent[0]).find((message) => message.t === 'SYS_CONTRIB');
    if (!duplicate) throw new Error('Missing first signed beacon contribution');
    const safetyBefore = await required(journals[0]).loadSafety(setupCount + 1);
    const outgoingBefore = required(sent[0]).length;
    for (let repetition = 0; repetition < 3; repetition += 1)
      required(transports[0]).inject(required(peers[0]), duplicate);
    await settle([first, second], network.clock);
    expect((await required(journals[0]).loadSafety(setupCount + 1))?.revision).toBe(
      safetyBefore?.revision,
    );
    expect(required(sent[0])).toHaveLength(outgoingBefore);
    for (const replica of [first, second]) {
      const entries = replica.getEntries();
      expect(entries).toHaveLength(setupCount + 1);
      const start = entries.find(
        ({ entry }) => entry.payload.kind === 'system' && entry.payload.input.type === 'START_SEAT',
      );
      expect(start?.certificate).toHaveLength(2);
      expect(replica.getContext().log.crypto?.beacon.round).toBe(1);
      replica.dispose();
    }
    network.dispose();
  }, 30_000);

  test('repeated complete reveals do not recompute or write while votes are missing', async () => {
    const fixture = verifiedFixture();
    const peers = fixture.humans.map(
      (seat) => required(fixture.simulation.identities.get(seat.seat)).peerId,
    );
    const network = createMemnet({ peers });
    const sent: ProtocolMessage[] = [];
    const transport = observe(network.transport(required(peers[0])), sent);
    const journal = new MemoryProtocolJournal();
    const derive = vi.fn<typeof randomDerivations.derive>((state, pending, seed, context) =>
      randomDerivations.derive(state, pending, seed, context),
    );
    const replica = value(
      await ReplicatedLog.create({
        ...optionsFor(
          fixture,
          0,
          transport,
          network.clock,
          journal,
          new MemoryBeaconContributionStore(),
        ),
        policy: {
          ...policyFor(),
          entry: {
            ...policyFor().entry,
            randomDerivations: { ...randomDerivations, derive },
          },
        },
      }),
    );
    const setupCount = setupPassCount(fixture);
    let withholdStartVotes = true;
    const otherSent: ProtocolMessage[] = [];
    const otherTransport = observeWithheldBeaconVotes(
      network.transport(required(peers[1])),
      otherSent,
      setupCount + 1,
      () => withholdStartVotes,
    );
    const second = value(
      await ReplicatedLog.create(
        optionsFor(
          fixture,
          1,
          otherTransport,
          network.clock,
          new MemoryProtocolJournal(),
          new MemoryBeaconContributionStore(),
        ),
      ),
    );
    deliverFirstProposal(required(peers[0]), otherTransport, sent);
    await settle([replica, second], network.clock);
    expect(replica.getContext().log.head.seq).toBe(setupCount);
    const beacon = replica.getContext().log.crypto?.beacon;
    if (!beacon) throw new Error('Expected a frozen beacon operation');
    const operation = value(getBeaconOperation(beacon));
    const otherSeat = required(fixture.humans[1]).seat;
    const other = required(fixture.simulation.identities.get(otherSeat));
    const contribution: ProtocolMessage = {
      t: 'SYS_CONTRIB',
      genesisDigest: replica.getContext().membership.genesisDigest,
      contribution: {
        kind: 'beacon-reveal',
        signed: signBeaconReveal(
          operation,
          otherSeat,
          required(required(fixture.chains[1])[1]),
          other.secretKey,
        ),
      },
    };
    transport.inject(other.peerId, contribution);
    await settle([replica], network.clock);
    expect(replica.getContext().log.head.seq).toBe(setupCount);
    expect(derive).toHaveBeenCalled();
    const safetyRevision = (await journal.loadSafety(setupCount + 1))?.revision;
    const sentCount = sent.length;
    const derivedCount = derive.mock.calls.length;
    for (let repetition = 0; repetition < 3; repetition += 1)
      transport.inject(other.peerId, contribution);
    transport.inject(other.peerId, {
      ...contribution,
      contribution: {
        kind: 'beacon-reveal',
        signed: signBeaconReveal(
          { ...operation, round: operation.round + 1 },
          otherSeat,
          required(required(fixture.chains[1])[1]),
          other.secretKey,
        ),
      },
    });
    await settle([replica], network.clock);
    expect((await journal.loadSafety(setupCount + 1))?.revision).toBe(safetyRevision);
    expect(sent).toHaveLength(sentCount);
    expect(derive).toHaveBeenCalledTimes(derivedCount);
    withholdStartVotes = false;
    network.clock.advanceBy(2_000);
    await settle([replica, second], network.clock);
    expect(replica.getContext().log.head.seq).toBe(setupCount + 1);
    const committedRevision = (await journal.loadSafety(setupCount + 2))?.revision;
    const committedSent = sent.length;
    const committedDerived = derive.mock.calls.length;
    transport.inject(other.peerId, contribution);
    await settle([replica, second], network.clock);
    expect((await journal.loadSafety(setupCount + 2))?.revision).toBe(committedRevision);
    expect(sent).toHaveLength(committedSent);
    expect(derive).toHaveBeenCalledTimes(committedDerived);
    replica.dispose();
    second.dispose();
    network.dispose();
  }, 30_000);

  test('one human with bots certifies its START_SEAT from one real reveal', async () => {
    const fixture = verifiedFixture(1);
    const peer = required(
      fixture.simulation.identities.get(required(fixture.humans[0]).seat),
    ).peerId;
    const network = createMemnet({ peers: [peer] });
    const transport = network.transport(peer);
    const replica = value(
      await ReplicatedLog.create(
        optionsFor(
          fixture,
          0,
          transport,
          network.clock,
          new MemoryProtocolJournal(),
          new MemoryBeaconContributionStore(),
        ),
      ),
    );
    await settle([replica], network.clock);
    const setupCount = setupPassCount(fixture);
    expect(replica.getContext().log.head.seq).toBe(setupCount + 1);
    const start = replica
      .getEntries()
      .find(
        ({ entry }) => entry.payload.kind === 'system' && entry.payload.input.type === 'START_SEAT',
      );
    expect(start?.certificate).toHaveLength(1);
    expect(replica.getContext().log.crypto?.beacon.chains.map((chain) => chain.index)).toEqual([1]);
    replica.dispose();
    network.dispose();
  }, 30_000);

  test('certifies chain extension before the next reveal and dice result', async () => {
    const fixture = verifiedFixture(1, 1);
    const peer = required(
      fixture.simulation.identities.get(required(fixture.humans[0]).seat),
    ).peerId;
    const network = createMemnet({ peers: [peer] });
    const sent: ProtocolMessage[] = [];
    const transport = observe(network.transport(peer), sent);
    const replica = value(
      await ReplicatedLog.create(
        optionsFor(
          fixture,
          0,
          transport,
          network.clock,
          new MemoryProtocolJournal(),
          new MemoryBeaconContributionStore(),
        ),
      ),
    );
    await settle([replica], network.clock);
    const setupCount = setupPassCount(fixture);
    expect(replica.getContext().log.head.seq).toBe(setupCount + 1);
    expect(replica.getContext().log.crypto?.beacon.chains[0]?.index).toBe(1);
    await playSetupThroughRoll(replica, network.clock, fixture);
    await settle([replica], network.clock);
    const entries = replica.getEntries();
    const extensionIndex = entries.findIndex(
      ({ entry }) => entry.payload.kind === 'crypto' && entry.payload.action === 'beacon-extend',
    );
    const diceIndex = entries.findIndex(
      ({ entry }) => entry.payload.kind === 'system' && entry.payload.input.type === 'DICE_RESULT',
    );
    expect(extensionIndex).toBeGreaterThan(setupCount);
    expect(diceIndex).toBeGreaterThan(extensionIndex);
    const extensionFrameIndex = sent.findIndex(
      (message) => message.t === 'SYS_CONTRIB' && message.contribution.kind === 'beacon-extension',
    );
    const extensionCommitIndex = sent.findIndex(
      (message) =>
        message.t === 'COMMIT' &&
        message.certified.entry.payload.kind === 'crypto' &&
        message.certified.entry.payload.action === 'beacon-extend',
    );
    const renewedRevealIndex = sent.findIndex(
      (message, index) =>
        index > extensionFrameIndex &&
        message.t === 'SYS_CONTRIB' &&
        message.contribution.kind === 'beacon-reveal',
    );
    expect(extensionFrameIndex).toBeGreaterThan(0);
    expect(extensionCommitIndex).toBeGreaterThan(extensionFrameIndex);
    expect(renewedRevealIndex).toBeGreaterThan(extensionCommitIndex);
    const replayed = replayCertifiedPrefix(
      fixture.entry,
      entries,
      fixture.simulation.engine,
      policyFor(),
    );
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error(replayed.error.message);
    expect(snapshotFromContext(replayed.value.context)).toEqual(
      snapshotFromContext(replica.getContext()),
    );
    replica.dispose();
    network.dispose();
  }, 60_000);

  test('storage failure cannot broadcast a reveal or vote', async () => {
    const fixture = verifiedFixture(1);
    const peer = required(
      fixture.simulation.identities.get(required(fixture.humans[0]).seat),
    ).peerId;
    const network = createMemnet({ peers: [peer] });
    const sent: ProtocolMessage[] = [];
    const transport = observe(network.transport(peer), sent);
    const failing: BeaconContributionStore = {
      async load() {
        return null;
      },
      async putIfAbsent() {
        throw new Error('disk failure');
      },
    };
    const statuses: ReplicatedLogStatus[] = [];
    const created = await ReplicatedLog.create(
      optionsFor(
        fixture,
        0,
        transport,
        network.clock,
        new MemoryProtocolJournal(),
        failing,
        (status) => statuses.push(status),
      ),
    );
    const replica = value(created);
    await settle([replica], network.clock);
    const setupCount = setupPassCount(fixture);
    expect(replica.getContext().log.head.seq).toBe(setupCount);
    expect(statuses).toContainEqual({ kind: 'halted', code: 'beacon-contribution-prepare' });
    expect(sent.some((message) => message.t === 'SYS_CONTRIB')).toBe(false);
    expect(sent.some((message) => message.t === 'VOTE' && message.vote.body.seq > setupCount)).toBe(
      false,
    );
    replica.dispose();
    network.dispose();
  }, 30_000);

  test('restore retransmits the exact durable local contribution', async () => {
    const fixture = verifiedFixture();
    const peer = required(
      fixture.simulation.identities.get(required(fixture.humans[0]).seat),
    ).peerId;
    const other = required(
      fixture.simulation.identities.get(required(fixture.humans[1]).seat),
    ).peerId;
    const network = createMemnet({ peers: [peer, other] });
    const journal = new MemoryProtocolJournal();
    const store = new MemoryBeaconContributionStore();
    const secondSent: ProtocolMessage[] = [];
    const before: ProtocolMessage[] = [];
    const firstTransport = observe(network.transport(peer), before);
    const secondObserved = observe(network.transport(other), secondSent);
    const secondTransport = {
      ...secondObserved,
      broadcast(bytes: Uint8Array) {
        const message = value(decodeProtocolMessage(bytes));
        if (message.t === 'SYS_CONTRIB' || message.t === 'CHEAT_CLAIM') {
          secondSent.push(message);
          return;
        }
        secondObserved.broadcast(bytes);
      },
    };
    const original = value(
      await ReplicatedLog.create(
        optionsFor(fixture, 0, firstTransport, network.clock, journal, store),
      ),
    );
    const second = value(
      await ReplicatedLog.create(
        optionsFor(
          fixture,
          1,
          secondTransport,
          network.clock,
          new MemoryProtocolJournal(),
          new MemoryBeaconContributionStore(),
        ),
      ),
    );
    deliverFirstProposal(peer, secondTransport, before);
    await settle([original, second], network.clock);
    const setupCount = setupPassCount(fixture);
    expect(original.getContext().log.head.seq).toBe(setupCount);
    const pending = second.getContext();
    expect(
      proposerFor(setupCount + 1, 1, pending.membership, pending.excludedProposers).seat,
    ).not.toBe(required(fixture.humans[1]).seat);
    if (!pending.log.crypto) throw new Error('Verified beacon context is missing');
    const active = value(getBeaconOperation(pending.log.crypto.beacon));
    const offender = required(fixture.humans[0]);
    const badRevealBody = {
      operationId: beaconOperationId(active),
      seat: offender.seat,
      index: required(active.participants.find((item) => item.seat === offender.seat)).index,
      value: toBase64Url(new Uint8Array(32).fill(200)),
    };
    const cheat: CheatClaim = {
      seat: offender.seat,
      evidence: {
        kind: 'beacon-reveal',
        at: { seq: pending.log.head.seq, hash: entryHash(pending.log.head) },
        artifact: {
          body: badRevealBody,
          sig: signObject(
            'beacon-reveal',
            badRevealBody,
            required(fixture.simulation.identities.get(offender.seat)).secretKey,
          ),
        },
      },
    };
    secondTransport.inject(peer, { t: 'CHEAT_CLAIM', claim: cheat });
    await second.flush();
    expect(secondSent.some((message) => message.t === 'CHEAT_CLAIM')).toBe(true);
    const owedBeforePulse = secondSent.filter((message) => message.t === 'SYS_CONTRIB').length;
    value(await second['pulse']());
    expect(secondSent.filter((message) => message.t === 'SYS_CONTRIB')).toHaveLength(
      owedBeforePulse + 1,
    );
    const firstContribution = before.find((message) => message.t === 'SYS_CONTRIB');
    expect(firstContribution).toBeDefined();
    original.dispose();
    network.crash(peer);
    const after: ProtocolMessage[] = [];
    const restoredTransport = observe(network.restart(peer), after);
    const restored = value(
      await ReplicatedLog.restore(
        optionsFor(fixture, 0, restoredTransport, network.clock, journal, store),
      ),
    );
    await settle([second, restored], network.clock);
    expect(after.find((message) => message.t === 'SYS_CONTRIB')).toEqual(firstContribution);
    expect(restored.getContext().log.head.seq).toBe(setupCount);
    restored.dispose();
    second.dispose();
    network.dispose();
  }, 30_000);

  test('retries persisted contribution after transient contribution and heartbeat send errors', async () => {
    const fixture = verifiedFixture();
    const peer = required(
      fixture.simulation.identities.get(required(fixture.humans[0]).seat),
    ).peerId;
    const other = required(
      fixture.simulation.identities.get(required(fixture.humans[1]).seat),
    ).peerId;
    const network = createMemnet({ peers: [peer, other] });
    const sent: ProtocolMessage[] = [];
    const otherSent: ProtocolMessage[] = [];
    const observed = observe(network.transport(peer), sent);
    let failedContribution = false;
    let failedHeartbeat = false;
    const transport: Transport = {
      ...observed,
      broadcast(bytes) {
        const message = value(decodeProtocolMessage(bytes));
        if (message.t === 'SYS_CONTRIB' && !failedContribution) {
          failedContribution = true;
          throw new Error('transient contribution send error');
        }
        if (message.t === 'HEARTBEAT' && !failedHeartbeat) {
          failedHeartbeat = true;
          throw new Error('transient heartbeat send error');
        }
        observed.broadcast(bytes);
      },
    };
    const store = new MemoryBeaconContributionStore();
    const replica = value(
      await ReplicatedLog.create(
        optionsFor(fixture, 0, transport, network.clock, new MemoryProtocolJournal(), store),
      ),
    );
    const secondTransport = observeWithoutSystemContributions(network.transport(other), otherSent);
    const second = value(
      await ReplicatedLog.create(
        optionsFor(
          fixture,
          1,
          secondTransport,
          network.clock,
          new MemoryProtocolJournal(),
          new MemoryBeaconContributionStore(),
        ),
      ),
    );
    deliverFirstProposal(peer, secondTransport, sent);
    await settle([replica, second], network.clock);
    const setupCount = setupPassCount(fixture);
    expect(replica.getContext().log.head.seq).toBe(setupCount);
    expect(failedContribution).toBe(true);
    expect(sent.some((message) => message.t === 'SYS_CONTRIB')).toBe(false);
    network.clock.advanceBy(2_000);
    await settle([replica], network.clock);
    expect(failedHeartbeat).toBe(true);
    network.clock.advanceBy(2_000);
    await settle([replica], network.clock);
    const delivered = sent.find((message) => message.t === 'SYS_CONTRIB');
    expect(delivered?.t).toBe('SYS_CONTRIB');
    const beacon = replica.getContext().log.crypto?.beacon;
    if (!beacon) throw new Error('Verified beacon context is missing');
    const operation = getBeaconOperation(beacon);
    if (!operation.ok || !delivered || delivered.t !== 'SYS_CONTRIB')
      throw new Error('Persisted contribution was not retried');
    const log = replica.getContext().log;
    const signer = value(
      resolveArtifactSigner(
        log.authority,
        log.genesis,
        log.crypto?.epoch ?? 0,
        required(fixture.humans[0]).seat,
      ),
    );
    expect(
      await store.load(
        `${beaconOperationId(operation.value)}/${signer.generation.seq}/${signer.generation.hash}`,
      ),
    ).toEqual(canonicalEncode(delivered.contribution));
    expect(replica.getContext().log.head.seq).toBe(setupCount);
    replica.dispose();
    second.dispose();
    network.dispose();
  }, 30_000);
});
