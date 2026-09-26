import { canonicalEncode, fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { createHashChain } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import {
  MemoryBeaconContributionStore,
  type BeaconContributionStore,
  type BeaconSecretSource,
} from './beacon-contributions.js';
import { beaconOperationId, signBeaconReveal } from './beacon.js';
import { getBeaconOperation } from './beacon-state.js';
import {
  GENESIS_PREVIOUS_HASH,
  entryHash,
  genesisBody,
  genesisId,
  signEntry,
  signGenesis,
} from './genesis.js';
import { MemoryProtocolJournal } from './journal.js';
import { signCommand } from './log.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import type { ProtocolMessage } from './messages.js';
import { ReplicatedLog } from './replicated-log.js';
import type { ReplicatedLogOptions } from './replicated-log.js';
import { randomDerivations } from './random-derivations.js';
import { replayCertifiedPrefix, snapshotFromContext } from './replay.js';
import type { ReplayPolicy } from './replay.js';
import { createMemnet } from './testing/memnet.js';
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

const policy: ReplayPolicy = {
  // Later deck/escrow commitments are outside this beacon integration fixture.
  genesis: { verifyCommitments: () => success(undefined) },
  entry: {
    // Setup and roll commands are public; the engine still checks their exact legality.
    verifyCommand: (signed) =>
      ['PLACE_SETTLEMENT', 'PLACE_ROAD', 'ROLL_DICE'].includes(signed.body.command.type)
        ? success(undefined)
        : failure('fixture-command', 'This fixture only drives public setup and roll commands'),
  },
};

function verifiedFixture(humanCount = 2, chainLength = 2) {
  const simulation = createSimulationGenesis({ seed: 91, humanCount });
  const humans = simulation.genesis.seats.filter((seat) => seat.kind === 'human');
  const chains = humans.map((_, index) =>
    createHashChain(new Uint8Array(32).fill(index + 29), chainLength),
  );
  const renewals = humans.map((_, index) =>
    createHashChain(new Uint8Array(32).fill(index + 49), chainLength),
  );
  const body: GenesisBody = {
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
  const genesis: Genesis = {
    ...body,
    gameId: genesisId(body),
    signatures: humans.map((seat) =>
      signGenesis(body, seat.seat, required(simulation.identities.get(seat.seat)).secretKey),
    ),
  };
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
  return { simulation, humans, chains, renewals, entry, sources };
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

function optionsFor(
  fixture: ReturnType<typeof verifiedFixture>,
  position: number,
  transport: Transport,
  clock: VirtualClock,
  journal: MemoryProtocolJournal,
  store: BeaconContributionStore,
): ReplicatedLogOptions {
  const seat = required(fixture.humans[position]).seat;
  return {
    genesisEntry: fixture.entry,
    engine: fixture.simulation.engine,
    policy,
    seat,
    secretKey: required(fixture.simulation.identities.get(seat)).secretKey,
    transport,
    clock,
    journal,
    beaconSource: required(fixture.sources[position]),
    beaconContributions: store,
  };
}

async function settle(replicas: readonly ReplicatedLog[], clock: VirtualClock) {
  for (let pass = 0; pass < 16; pass += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Each pass drains packets scheduled by the previous pass.
    await Promise.all(replicas.map((replica) => replica.flush()));
    clock.advanceBy(0);
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
    const first = value(
      await ReplicatedLog.create(
        optionsFor(
          fixture,
          0,
          required(transports[0]),
          network.clock,
          required(journals[0]),
          required(stores[0]),
        ),
      ),
    );
    await settle([first], network.clock);
    expect(first.getContext().log.head.seq).toBe(0);
    expect(required(sent[0]).some((message) => message.t === 'SYS_CONTRIB')).toBe(true);
    const duplicate = required(sent[0]).find((message) => message.t === 'SYS_CONTRIB');
    if (!duplicate) throw new Error('Missing first signed contribution');
    const safetyBefore = await required(journals[0]).loadSafety(1);
    const outgoingBefore = required(sent[0]).length;
    for (let repetition = 0; repetition < 3; repetition += 1)
      required(transports[0]).inject(required(peers[0]), duplicate);
    await settle([first], network.clock);
    expect((await required(journals[0]).loadSafety(1))?.revision).toBe(safetyBefore?.revision);
    expect(required(sent[0])).toHaveLength(outgoingBefore);
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
    network.clock.advanceBy(2_000);
    await settle([first, second], network.clock);
    expect(first.getContext().log.head.seq).toBe(1);
    expect(second.getContext().log.head.seq).toBe(1);
    expect(first.getContext().log.head.stateHash).toBe(second.getContext().log.head.stateHash);
    for (const replica of [first, second]) {
      expect(replica.getEntries()).toHaveLength(1);
      expect(required(replica.getEntries()[0]).certificate).toHaveLength(2);
      expect(replica.getContext().log.crypto?.beacon.round).toBe(1);
      replica.dispose();
    }
    network.dispose();
  });

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
          ...policy,
          entry: { ...policy.entry, randomDerivations: { ...randomDerivations, derive } },
        },
      }),
    );
    await settle([replica], network.clock);
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
    expect(replica.getContext().log.head.seq).toBe(0);
    expect(derive).toHaveBeenCalled();
    const safetyRevision = (await journal.loadSafety(1))?.revision;
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
    expect((await journal.loadSafety(1))?.revision).toBe(safetyRevision);
    expect(sent).toHaveLength(sentCount);
    expect(derive).toHaveBeenCalledTimes(derivedCount);
    const second = value(
      await ReplicatedLog.create(
        optionsFor(
          fixture,
          1,
          network.transport(other.peerId),
          network.clock,
          new MemoryProtocolJournal(),
          new MemoryBeaconContributionStore(),
        ),
      ),
    );
    network.clock.advanceBy(2_000);
    await settle([replica, second], network.clock);
    expect(replica.getContext().log.head.seq).toBe(1);
    const committedRevision = (await journal.loadSafety(2))?.revision;
    const committedSent = sent.length;
    const committedDerived = derive.mock.calls.length;
    transport.inject(other.peerId, contribution);
    await settle([replica, second], network.clock);
    expect((await journal.loadSafety(2))?.revision).toBe(committedRevision);
    expect(sent).toHaveLength(committedSent);
    expect(derive).toHaveBeenCalledTimes(committedDerived);
    replica.dispose();
    second.dispose();
    network.dispose();
  });

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
    expect(replica.getContext().log.head.seq).toBe(1);
    expect(required(replica.getEntries()[0]).certificate).toHaveLength(1);
    expect(replica.getContext().log.crypto?.beacon.chains.map((chain) => chain.index)).toEqual([1]);
    replica.dispose();
    network.dispose();
  });

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
    expect(extensionIndex).toBeGreaterThan(0);
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
      policy,
    );
    expect(replayed.ok).toBe(true);
    if (!replayed.ok) throw new Error(replayed.error.message);
    expect(snapshotFromContext(replayed.value.context)).toEqual(
      snapshotFromContext(replica.getContext()),
    );
    replica.dispose();
    network.dispose();
  });

  test('storage failure cannot broadcast a reveal or vote', async () => {
    const fixture = verifiedFixture();
    const peer = required(
      fixture.simulation.identities.get(required(fixture.humans[0]).seat),
    ).peerId;
    const network = createMemnet({
      peers: [peer, required(fixture.simulation.identities.get(1)).peerId],
    });
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
    const created = await ReplicatedLog.create(
      optionsFor(fixture, 0, transport, network.clock, new MemoryProtocolJournal(), failing),
    );
    expect(created).toMatchObject({
      ok: false,
      error: { code: 'beacon-contribution-prepare' },
    });
    expect(sent.some((message) => message.t === 'SYS_CONTRIB')).toBe(false);
    expect(sent.some((message) => message.t === 'VOTE')).toBe(false);
    network.dispose();
  });

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
    const before: ProtocolMessage[] = [];
    const firstTransport = observe(network.transport(peer), before);
    const original = value(
      await ReplicatedLog.create(
        optionsFor(fixture, 0, firstTransport, network.clock, journal, store),
      ),
    );
    await settle([original], network.clock);
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
    await settle([restored], network.clock);
    expect(after.find((message) => message.t === 'SYS_CONTRIB')).toEqual(firstContribution);
    expect(restored.getContext().log.head.seq).toBe(0);
    restored.dispose();
    network.dispose();
  });

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
    await settle([replica], network.clock);
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
    expect(await store.load(beaconOperationId(operation.value))).toEqual(
      canonicalEncode(delivered.contribution),
    );
    expect(replica.getContext().log.head.seq).toBe(0);
    replica.dispose();
    network.dispose();
  });
});
