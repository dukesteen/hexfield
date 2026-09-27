import { scalarToBytes } from '@cp2p/crypto';
import { RESOURCES } from '@cp2p/engine';
import type { CommandShape, Result, Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { MemoryBeaconContributionStore } from './beacon-contributions.js';
import { MemoryCheatCandidateStore } from './cheat-candidates.js';
import { MemoryCountContributionStore } from './count-contributions.js';
import { genesisDigest } from './genesis.js';
import { createHandSecretSource } from './hand-source.js';
import { MemoryProtocolJournal } from './journal.js';
import { decodeProtocolMessage } from './messages.js';
import { P2PSession } from './p2p-session.js';
import { reconstructPrivateSeats } from './private-replay.js';
import type { P2PSessionOptions } from './p2p-session.js';
import { MemoryStealDeliveryStore } from './steal-contributions.js';
import type { StealDeliveryStore } from './steal-contributions.js';
import type { StealSourceFactory } from './steal-source.js';
import { createMemnet } from './testing/memnet.js';
import { createVerifiedDeckSession } from './testing/verified-deck-session.js';
import type { VirtualClock } from './testing/virtual-clock.js';
import type { PeerId, Transport } from './transport.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing live steal fixture value');
  return item;
}

async function settle(sessions: readonly P2PSession[], clock: VirtualClock, passes = 16) {
  for (let pass = 0; pass < passes; pass++) {
    // oxlint-disable-next-line no-await-in-loop -- Drain deliveries before the next network pass.
    await Promise.all(sessions.map((session) => session.flush()));
    clock.advanceBy(0);
    // oxlint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.all(sessions.map((session) => session.flush()));
}

interface Gate {
  held: boolean;
  sent: Uint8Array[];
}

function gated(inner: Transport, gate: Gate): Transport {
  const drop = (bytes: Uint8Array) => {
    const message = value(decodeProtocolMessage(bytes));
    if (message.t === 'STEAL_CONTRIB') {
      gate.sent.push(bytes.slice());
      return gate.held;
    }
    return (
      gate.held &&
      message.t === 'PROPOSAL' &&
      message.proposal.body.entry.payload.kind === 'crypto' &&
      message.proposal.body.entry.payload.action === 'steal-fixed'
    );
  };
  return {
    self: inner.self,
    peers: () => inner.peers(),
    send(to: PeerId, bytes: Uint8Array) {
      if (!drop(bytes)) inner.send(to, bytes);
    },
    broadcast(bytes: Uint8Array) {
      if (!drop(bytes)) inner.broadcast(bytes);
    },
    onMessage: (listener) => inner.onMessage(listener),
    onPeerChange: (listener) => inner.onPeerChange(listener),
    disconnect: (peer) => inner.disconnect(peer),
  };
}

test('a live hidden steal survives a dropped delivery and restart with one private transfer', async () => {
  const fixture = createVerifiedDeckSession(317, 2, 128);
  const peers = fixture.humans.map((human) => human.publicKey);
  const network = createMemnet({ peers });
  const gate: Gate = { held: true, sent: [] };
  const stealStoreLoads = new Map<PeerId, { count: () => number; proofSeeds: () => number }>();
  const options: P2PSessionOptions[] = fixture.humans.map((human) => {
    const deckSource = fixture.createDeckSourceFor(human.seat);
    const createSource = fixture.createStealSourceFor(human.seat);
    const digest = genesisDigest(fixture.genesis);
    const backingStore = new MemoryStealDeliveryStore();
    let loadCount = 0;
    let transferProofSeeds = 0;
    const stealSource: StealSourceFactory = (seat) => {
      const source = createSource(seat);
      return {
        encryptionSecret: () => source.encryptionSecret(),
        proofSeed(role, context) {
          if (role === 'transfer') transferProofSeeds += 1;
          return source.proofSeed(role, context);
        },
        dispose: () => source.dispose(),
      };
    };
    const stealDeliveryStore: StealDeliveryStore = {
      async load(id) {
        loadCount += 1;
        return backingStore.load(id);
      },
      putIfAbsent: (id, bytes) => backingStore.putIfAbsent(id, bytes),
    };
    stealStoreLoads.set(human.publicKey, {
      count: () => loadCount,
      proofSeeds: () => transferProofSeeds,
    });
    return {
      genesisEntry: fixture.entry,
      engine: fixture.simulation.engine,
      policy: fixture.policy,
      seat: human.seat,
      secretKey: required(fixture.simulation.identities.get(human.seat)).secretKey,
      botKeys: fixture.botKeysFor(human.seat),
      transport: gated(network.transport(human.publicKey), gate),
      clock: network.clock,
      journal: new MemoryProtocolJournal(),
      cheatCandidateStore: new MemoryCheatCandidateStore(),
      beaconSource: fixture.beaconSourceFor(human.seat),
      beaconContributions: new MemoryBeaconContributionStore(),
      deckSetupPasses: fixture.deckSetupPasses,
      createDeckSource: deckSource,
      deckContributions: new MemoryStealDeliveryStore(),
      countContributionStore: new MemoryCountContributionStore(),
      stealDeliveryStore,
      createDriver: (engine, genesis, _clock, owned) =>
        new VerifiedSessionDriver(
          engine,
          genesis,
          owned,
          deckSource,
          (seat) => createHandSecretSource(scalarToBytes(BigInt(71 + seat)), digest, seat),
          stealSource,
        ),
    };
  });
  let live = (await Promise.all(options.map((item) => P2PSession.create(item)))).map(value);
  const ownerIndex = (seat: Seat): number => {
    const owner = required(fixture.genesis.seats.find((item) => item.seat === seat));
    const peer = owner.kind === 'bot' ? owner.botHost : owner.publicKey;
    const index = peers.indexOf(peer);
    if (index < 0) throw new Error('Missing private owner');
    return index;
  };
  const allHands = () =>
    fixture.genesis.config.seats.map((seat) =>
      required(required(live[ownerIndex(seat)]).getPrivate(seat)),
    );
  try {
    await settle(live, network.clock, 32);
    let thief: Seat | null = null;
    let victim: Seat | null = null;
    for (let step = 0; step < 100 && victim === null; step++) {
      const session = required(live[0]);
      const state = session.getState();
      const pending = session.getPending().find((item) => item.kind === 'player');
      if (!pending || pending.kind !== 'player')
        throw new Error(
          `Unexpected pending at step ${step}: ${JSON.stringify(session.getPending())}`,
        );
      const host = required(live[ownerIndex(pending.seat)]);
      const legal = host.getLegalCommands(pending.seat);
      let command: CommandShape | undefined;
      if (legal.templates.some((item) => item.type === 'DISCARD')) {
        const hand = required(host.getPrivate(pending.seat)).hand;
        let remaining = Math.floor(
          required(state.seats.find((item) => item.seat === pending.seat)).resources.total / 2,
        );
        const cards = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
        for (const resource of RESOURCES) {
          cards[resource] = Math.min(hand[resource] ?? 0, remaining);
          remaining -= cards[resource];
        }
        command = { type: 'DISCARD', cards };
      }
      command ??= legal.commands.find((item) => item.type === 'STEAL');
      if (command?.type === 'STEAL') {
        thief = pending.seat;
        victim = fixture.genesis.config.seats.find((seat) => seat === command?.victim) ?? null;
      }
      command ??= legal.commands.find((item) => {
        if (item.type !== 'MOVE_ROBBER') return false;
        const moved = fixture.simulation.engine.apply(state, {
          kind: 'command',
          seat: pending.seat,
          command: item,
        });
        return (
          moved.ok &&
          fixture.simulation.engine
            .getPending(moved.value.state)
            .some((next) => next.kind === 'player' && next.allowed.includes('STEAL'))
        );
      });
      command ??=
        legal.commands.find((item) => item.type === 'ROLL_DICE') ??
        legal.commands.find((item) => item.type === 'END_TURN') ??
        legal.commands[0];
      if (!command) throw new Error(`No legal command at step ${step}`);
      const completion: { current: Result<void> | null } = { current: null };
      void host.submit(pending.seat, command).then((result) => {
        completion.current = result;
        return undefined;
      });
      // oxlint-disable-next-line no-await-in-loop -- Each command needs the preceding certificate.
      await settle(live, network.clock, 32);
      if (!completion.current) {
        network.clock.advanceBy(2_000);
        // oxlint-disable-next-line no-await-in-loop
        await settle(live, network.clock, 32);
      }
      value(required(completion.current));
    }
    const thiefSeat = required(thief);
    const victimSeat = required(victim);
    expect(gate.sent.length).toBeGreaterThan(0);
    const firstDelivery = required(gate.sent[0]);
    const victimOwner = peers[ownerIndex(victimSeat)];
    const victimStore = required(stealStoreLoads.get(required(victimOwner)));
    const loadsBeforePulse = victimStore.count();
    const proofSeedsBeforePulse = victimStore.proofSeeds();
    expect(loadsBeforePulse).toBeGreaterThan(0);
    expect(proofSeedsBeforePulse).toBeGreaterThan(0);
    const sendsBeforePulse = gate.sent.length;
    network.clock.advanceBy(2_000);
    await settle(live, network.clock, 32);
    expect(gate.sent.length).toBeGreaterThan(sendsBeforePulse);
    expect(victimStore.count()).toBe(loadsBeforePulse);
    expect(victimStore.proofSeeds()).toBe(proofSeedsBeforePulse);
    for (const bytes of gate.sent) expect(bytes).toEqual(firstDelivery);
    const before = allHands();
    const publicBefore = required(live[0]).getState();
    for (const session of live) session.dispose();
    const sentBeforeRestore = gate.sent.length;
    live = (await Promise.all(options.map((item) => P2PSession.restore(item)))).map(value);
    await settle(live, network.clock, 32);
    expect(allHands()).toEqual(before);
    expect(required(live[0]).getState()).toEqual(publicBefore);
    expect(gate.sent.length).toBeGreaterThan(sentBeforeRestore);
    for (const bytes of gate.sent) expect(bytes).toEqual(firstDelivery);
    gate.held = false;
    const stealResults = () =>
      required(live[0])
        .exportSave()
        .entries.filter(
          ({ entry }) =>
            entry.payload.kind === 'system' && entry.payload.input.type === 'STEAL_RESULT',
        );
    for (let attempt = 0; attempt < 8 && stealResults().length === 0; attempt++) {
      network.clock.advanceBy(1_000);
      // oxlint-disable-next-line no-await-in-loop -- Each virtual tick can schedule the next consensus phase.
      await settle(live, network.clock, 16);
    }
    const results = stealResults();
    expect(results).toHaveLength(1);
    const after = allHands();
    const botSeats = fixture.genesis.seats
      .filter((seat) => seat.kind === 'bot')
      .map((seat) => seat.seat);
    expect(botSeats.some((seat) => seat === thiefSeat || seat === victimSeat)).toBe(true);
    const reconstructed = value(
      reconstructPrivateSeats({
        genesisEntry: fixture.entry,
        entries: required(live[0]).exportSave().entries,
        engine: fixture.simulation.engine,
        policy: fixture.policy,
        secrets: botSeats.map((seat) => ({ seat, master: scalarToBytes(BigInt(17 + seat)) })),
      }),
    );
    try {
      for (const seat of botSeats)
        expect(reconstructed.driver.privateState(seat)).toEqual(
          required(after.find((hand) => hand.seat === seat)),
        );
    } finally {
      reconstructed.dispose();
    }
    const thiefBefore = required(before.find((item) => item.seat === thiefSeat));
    const thiefAfter = required(after.find((item) => item.seat === thiefSeat));
    const victimBefore = required(before.find((item) => item.seat === victimSeat));
    const victimAfter = required(after.find((item) => item.seat === victimSeat));
    const gained = RESOURCES.filter(
      (resource) => (thiefAfter.hand[resource] ?? 0) === (thiefBefore.hand[resource] ?? 0) + 1,
    );
    expect(gained).toHaveLength(1);
    for (const resource of RESOURCES) {
      const delta = resource === gained[0] ? 1 : 0;
      expect(thiefAfter.hand[resource]).toBe((thiefBefore.hand[resource] ?? 0) + delta);
      expect(victimAfter.hand[resource]).toBe((victimBefore.hand[resource] ?? 0) - delta);
    }
    for (const peer of live) expect(peer.getState()).toEqual(required(live[0]).getState());
    for (const session of live) session.dispose();
    live = (await Promise.all(options.map((item) => P2PSession.restore(item)))).map(value);
    await settle(live, network.clock, 16);
    expect(allHands()).toEqual(after);
    expect(
      required(live[0])
        .exportSave()
        .entries.filter(
          ({ entry }) =>
            entry.payload.kind === 'system' && entry.payload.input.type === 'STEAL_RESULT',
        ),
    ).toHaveLength(1);
  } finally {
    for (const session of live) session.dispose();
  }
}, 60_000);
