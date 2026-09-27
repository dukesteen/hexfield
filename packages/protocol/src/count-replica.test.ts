import { canonicalEncode, fromBase64Url, toBase64Url } from '@cp2p/codec';
import { scalarToBytes } from '@cp2p/crypto';
import { RESOURCES } from '@cp2p/engine';
import type { CommandShape, GameState, Result, Seat } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { MemoryBeaconContributionStore } from './beacon-contributions.js';
import { MemoryCheatCandidateStore } from './cheat-candidates.js';
import { MemoryCountContributionStore } from './count-contributions.js';
import { MemoryStealDeliveryStore } from './steal-contributions.js';
import type { SignedCountContribution } from './count-reveal.js';
import type { DeckContributionStore } from './deck-outbox.js';
import { createHandSecretSource } from './hand-source.js';
import { genesisDigest } from './genesis.js';
import { MemoryProtocolJournal } from './journal.js';
import { decodeProtocolMessage } from './messages.js';
import { P2PSession } from './p2p-session.js';
import type { P2PSessionOptions } from './p2p-session.js';
import { createMemnet } from './testing/memnet.js';
import { createSimulationGenesis } from './testing/simulation-genesis.js';
import { createVerifiedDeckSession } from './testing/verified-deck-session.js';
import type { VerifiedDeckSession } from './testing/verified-deck-session.js';
import type { VirtualClock } from './testing/virtual-clock.js';
import type { PeerId, Transport } from './transport.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';
import { initialSeatAuthorities } from './authority.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing live count fixture value');
  return item;
}

class DeckStore implements DeckContributionStore {
  private readonly records = new Map<string, Uint8Array>();
  async load(id: string): Promise<Uint8Array | null> {
    return this.records.get(id)?.slice() ?? null;
  }
  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.records.has(id)) return false;
    this.records.set(id, bytes.slice());
    return true;
  }
}

interface CountGate {
  target: Seat | null;
  active: boolean;
  dropped: SignedCountContribution[];
}

function gatedTransport(inner: Transport, gate: CountGate): Transport {
  const drop = (bytes: Uint8Array): boolean => {
    if (!gate.active || gate.target === null) return false;
    const message = value(decodeProtocolMessage(bytes));
    if (message.t === 'COUNT_CONTRIB' && message.contribution.body.seat === gate.target) {
      gate.dropped.push(message.contribution);
      return true;
    }
    if (message.t !== 'PROPOSAL') return false;
    const payload = message.proposal.body.entry.payload;
    return (
      payload.kind === 'system' &&
      payload.input.type === 'REVEAL_COUNT' &&
      payload.input.seat === gate.target
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

async function settle(sessions: readonly P2PSession[], clock: VirtualClock, passes = 8) {
  for (let pass = 0; pass < passes; pass += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Each pass drains the preceding network deliveries.
    await Promise.all(sessions.map((session) => session.flush()));
    clock.advanceBy(0);
    // oxlint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.all(sessions.map((session) => session.flush()));
}

function hostIndex(fixture: VerifiedDeckSession, seat: Seat): number {
  const owner = required(fixture.genesis.seats.find((item) => item.seat === seat));
  const peer = owner.kind === 'bot' ? owner.botHost : owner.publicKey;
  const index = fixture.humans.findIndex(
    (human) => fixture.simulation.identities.get(human.seat)?.peerId === peer,
  );
  if (index < 0) throw new Error('Missing live count host');
  return index;
}

function discard(state: GameState, seat: Seat): CommandShape {
  const holder = required(state.seats.find((item) => item.seat === seat));
  let remaining = Math.floor(holder.resources.total / 2);
  const cards = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
  for (const resource of RESOURCES) {
    const count = Math.min(holder.resources.min[resource], remaining);
    cards[resource] = count;
    remaining -= count;
  }
  if (remaining !== 0) throw new Error('No public deterministic discard');
  return { type: 'DISCARD', cards };
}

function quietRobber(
  fixture: VerifiedDeckSession,
  state: GameState,
  seat: Seat,
  legal: readonly CommandShape[],
): CommandShape | undefined {
  for (const command of legal) {
    if (command.type !== 'MOVE_ROBBER') continue;
    const moved = fixture.simulation.engine.apply(state, { kind: 'command', seat, command });
    if (
      moved.ok &&
      !fixture.simulation.engine
        .getPending(moved.value.state)
        .some((pending) => pending.kind === 'player' && pending.allowed.includes('STEAL'))
    )
      return command;
  }
  return undefined;
}

describe('live verified Monopoly count replication', () => {
  test('certifies owner count contributions and folds private hands after a legal Monopoly', async () => {
    // Keep the original board/game seed; nonce 14 selects the current protocol's Monopoly-first permutation.
    const fixture = createVerifiedDeckSession(16, 2, 128, {
      ceremonyNonce: toBase64Url(new Uint8Array(32).fill(14)),
      boardSeed: fromBase64Url(
        createSimulationGenesis({ seed: 14, humanCount: 2 }).genesis.genesisSeed,
      ),
    });
    const peers = fixture.humans.map(
      (human) => required(fixture.simulation.identities.get(human.seat)).peerId,
    );
    const network = createMemnet({ peers });
    const gate: CountGate = { target: null, active: false, dropped: [] };
    const journals = peers.map(() => new MemoryProtocolJournal());
    const deckStores = peers.map(() => new DeckStore());
    const countStores = peers.map(() => new MemoryCountContributionStore());
    const sessionOptions: P2PSessionOptions[] = peers.map((peer, index) => {
      const human = required(fixture.humans[index]);
      const seat = human.seat;
      const deckSource = fixture.createDeckSourceFor(seat);
      const digest = genesisDigest(fixture.genesis);
      return {
        genesisEntry: fixture.entry,
        engine: fixture.simulation.engine,
        policy: fixture.policy,
        seat,
        secretKey: required(fixture.simulation.identities.get(seat)).secretKey,
        botKeys: fixture.botKeysFor(seat),
        transport: gatedTransport(network.transport(peer), gate),
        clock: network.clock,
        journal: required(journals[index]),
        cheatCandidateStore: new MemoryCheatCandidateStore(),
        beaconSource: fixture.beaconSourceFor(seat),
        beaconContributions: new MemoryBeaconContributionStore(),
        deckSetupPasses: fixture.deckSetupPasses,
        createDeckSource: deckSource,
        deckContributions: required(deckStores[index]),
        countContributionStore: required(countStores[index]),
        stealDeliveryStore: new MemoryStealDeliveryStore(),
        createDriver: (engine, genesis, _clock, ownedSeats) =>
          new VerifiedSessionDriver(
            engine,
            genesis,
            ownedSeats,
            deckSource,
            (owner) => createHandSecretSource(scalarToBytes(BigInt(71 + owner)), digest, owner),
            fixture.createStealSourceFor(seat),
          ),
      };
    });
    const sessions = await Promise.all(sessionOptions.map((options) => P2PSession.create(options)));
    const live = sessions.map(value);
    let restored: P2PSession[] = [];
    try {
      await settle(live, network.clock, 32);
      let buyer: Seat | null = null;
      let slotId: string | null = null;
      let played = false;
      let beforeCounts: Map<Seat, number> | null = null;
      let chosenResource: (typeof RESOURCES)[number] | null = null;
      let expectedVictims: Seat[] | null = null;
      for (let step = 0; step < 120 && !played; step += 1) {
        // oxlint-disable-next-line no-await-in-loop -- Each legal choice needs the preceding certificate.
        await settle(live, network.clock);
        const state = required(live[0]).getState();
        const pending = required(live[0])
          .getPending()
          .find((item) => item.kind === 'player');
        if (!pending || pending.kind !== 'player') {
          network.clock.advanceBy(2_000);
          continue;
        }
        const host = required(live[hostIndex(fixture, pending.seat)]);
        const legalSet = host.getLegalCommands(pending.seat);
        const legal = legalSet.commands;
        let choice: CommandShape | undefined;
        if (buyer === null) {
          choice = legal.find((command) => command.type === 'BUY_DEV_CARD');
          if (choice) buyer = pending.seat;
        } else if (slotId === null) {
          const slots = required(live[hostIndex(fixture, buyer)]).getPrivate(buyer)?.slots;
          if (Object.values(slots ?? {}).some((card) => card !== 'monopoly'))
            throw new Error('The nonce-7 first card was not Monopoly');
          const ownedSlot = Object.entries(slots ?? {}).find(([, card]) => card === 'monopoly');
          if (ownedSlot) slotId = ownedSlot[0];
        }
        if (buyer !== null && slotId !== null && pending.seat === buyer) {
          const playable = legal.find(
            (command) =>
              command.type === 'PLAY_DEV_CARD' &&
              command.slotId === slotId &&
              command.card === 'monopoly',
          );
          if (playable) {
            chosenResource =
              RESOURCES.map((resource) => ({
                resource,
                possibleVictims: state.seats.filter(
                  (seat) => seat.seat !== buyer && seat.resources.max[resource] > 0,
                ).length,
              })).toSorted((left, right) => right.possibleVictims - left.possibleVictims)[0]
                ?.resource ?? 'brick';
            expectedVictims = state.seats
              .filter(
                (seat) => seat.seat !== buyer && seat.resources.max[required(chosenResource)] > 0,
              )
              .map((seat) => seat.seat);
            gate.target = expectedVictims.at(-1) ?? null;
            gate.active = true;
            beforeCounts = new Map(
              fixture.genesis.config.seats.map((seat) => [
                seat,
                required(
                  required(required(live[hostIndex(fixture, seat)]).getPrivate(seat)).hand[
                    required(chosenResource)
                  ],
                ),
              ]),
            );
            choice = {
              ...playable,
              params: { resource: chosenResource },
            };
            played = true;
          }
        }
        choice ??=
          legal.find((command) => command.type === 'ROLL_DICE') ??
          legal.find((command) => command.type === 'END_TURN') ??
          (legalSet.templates.some((command) => command.type === 'DISCARD')
            ? discard(state, pending.seat)
            : undefined) ??
          quietRobber(fixture, state, pending.seat, legal) ??
          legal.find((command) => command.type !== 'STEAL' && command.type !== 'BUY_DEV_CARD');
        if (!choice) throw new Error(`No safe legal choice at step ${step}`);
        const completion: { current: Result<void> | null } = { current: null };
        void host.submit(pending.seat, choice).then((result) => {
          completion.current = result;
          return undefined;
        });
        // oxlint-disable-next-line no-await-in-loop -- Wait for this certificate before choosing again.
        await settle(live, network.clock, 32);
        if (completion.current === null) {
          network.clock.advanceBy(2_000);
          // oxlint-disable-next-line no-await-in-loop
          await settle(live, network.clock, 32);
        }
        value(required(completion.current));
      }
      if (
        !played ||
        buyer === null ||
        slotId === null ||
        !chosenResource ||
        !beforeCounts ||
        !expectedVictims
      )
        throw new Error('First Monopoly was not legally played within 120 choices');
      expect(expectedVictims.length).toBeGreaterThan(1);
      const target = required(gate.target);
      const revealSeats = (peersNow: readonly P2PSession[]): Seat[] =>
        required(peersNow[0])
          .exportSave()
          .entries.flatMap(({ entry }) => {
            const payload = entry.payload;
            if (payload.kind !== 'system' || payload.input.type !== 'REVEAL_COUNT') return [];
            const seat = fixture.genesis.config.seats.find((item) => item === payload.input.seat);
            return seat === undefined ? [] : [seat];
          });
      await settle(live, network.clock, 32);
      for (
        let retry = 0;
        retry < 4 && revealSeats(live).length < expectedVictims.length - 1;
        retry += 1
      ) {
        network.clock.advanceBy(2_000);
        // oxlint-disable-next-line no-await-in-loop -- Await the prior victim before freezing the pending final reveal.
        await settle(live, network.clock, 16);
      }
      expect(revealSeats(live)).toEqual(expectedVictims.slice(0, -1));
      expect(gate.dropped.length).toBeGreaterThan(0);
      const original = required(gate.dropped[0]);
      const generation = required(
        value(initialSeatAuthorities(fixture.genesis)).controllers.find(
          (owner) => owner.seat === target,
        ),
      ).activatedAt;
      const recordId = `count-contribution/${original.body.operationId}/${target}/${generation.seq}/${generation.hash}`;
      const stored = await required(countStores[hostIndex(fixture, target)]).load(recordId);
      expect(stored).toEqual(canonicalEncode(original));
      const midHeads = live.map((session) => session.getCommittedHead());
      const midHands = new Map(
        fixture.genesis.config.seats.map((seat) => [
          seat,
          required(required(live[hostIndex(fixture, seat)]).getPrivate(seat)).hand,
        ]),
      );
      const droppedBeforeRestore = gate.dropped.length;
      for (const session of live) session.dispose();
      restored = (
        await Promise.all(sessionOptions.map((options) => P2PSession.restore(options)))
      ).map(value);
      expect(restored.map((session) => session.getCommittedHead())).toEqual(midHeads);
      for (const seat of fixture.genesis.config.seats)
        expect(required(restored[hostIndex(fixture, seat)]).getPrivate(seat)?.hand).toEqual(
          midHands.get(seat),
        );
      await settle(restored, network.clock, 16);
      for (let retry = 0; retry < 2 && gate.dropped.length === droppedBeforeRestore; retry += 1) {
        network.clock.advanceBy(2_000);
        // oxlint-disable-next-line no-await-in-loop -- The restored outbox may rebroadcast on the next round.
        await settle(restored, network.clock, 16);
      }
      expect(gate.dropped.length).toBeGreaterThan(droppedBeforeRestore);
      expect(canonicalEncode(required(gate.dropped.at(-1)))).toEqual(canonicalEncode(original));
      expect(await required(countStores[hostIndex(fixture, target)]).load(recordId)).toEqual(
        stored,
      );
      gate.active = false;
      await settle(restored, network.clock, 32);
      for (
        let retry = 0;
        retry < 4 && revealSeats(restored).length < expectedVictims.length;
        retry += 1
      ) {
        network.clock.advanceBy(2_000);
        // oxlint-disable-next-line no-await-in-loop -- Advance a stalled proposal round after releasing the gate.
        await settle(restored, network.clock, 16);
      }
      expect(revealSeats(restored)).toEqual(expectedVictims);
      let paid = 0;
      for (const seat of fixture.genesis.config.seats) {
        const privateState = required(
          required(restored[hostIndex(fixture, seat)]).getPrivate(seat),
        );
        const previous = required(beforeCounts.get(seat));
        if (seat === buyer) continue;
        paid += previous;
        expect(privateState.hand[chosenResource]).toBe(0);
      }
      expect(
        required(restored[hostIndex(fixture, buyer)]).getPrivate(buyer)?.hand[chosenResource],
      ).toBe(required(beforeCounts.get(buyer)) + paid);
      expect(restored[0]?.getCommittedHead()).toEqual(restored[1]?.getCommittedHead());
    } finally {
      for (const session of live) session.dispose();
      for (const session of restored) session.dispose();
    }
    // This fixed ceremony/play/restore trace takes about 42 s in isolation;
    // keep suite concurrency bounded so crypto-heavy replicas can finish.
  }, 60_000);
});
