import { G, decodePoint, encodePoint, scalarToBytes } from '@cp2p/crypto';
import { RESOURCES, success } from '@cp2p/engine';
import type { CommandShape, Resource, Result, Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { MemoryBeaconContributionStore } from './beacon-contributions.js';
import { MemoryCheatCandidateStore } from './cheat-candidates.js';
import { MemoryCountContributionStore } from './count-contributions.js';
import { genesisDigest } from './genesis.js';
import type { PublicHandCommitments } from './hand-commitments.js';
import { createHandSecretSource } from './hand-source.js';
import { MemoryProtocolJournal } from './journal.js';
import { decodeProtocolMessage } from './messages.js';
import type { ProtocolMessage } from './messages.js';
import { P2PSession } from './p2p-session.js';
import type { P2PSessionOptions } from './p2p-session.js';
import { replayCertifiedPrefix } from './replay.js';
import { MemoryStealDeliveryStore } from './steal-contributions.js';
import type { DeckContributionStore } from './deck-outbox.js';
import { tradeProofRequestId } from './trade-proof-delivery.js';
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
  if (item === null || item === undefined) throw new Error('Missing live trade fixture value');
  return item;
}

async function settle(sessions: readonly P2PSession[], clock: VirtualClock, passes = 16) {
  for (let pass = 0; pass < passes; pass++) {
    // oxlint-disable-next-line no-await-in-loop -- Each pass drains the preceding network delivery.
    await Promise.all(sessions.map((session) => session.flush()));
    clock.advanceBy(0);
    // oxlint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.all(sessions.map((session) => session.flush()));
}

interface TradeWire {
  requests: { from: PeerId; to: PeerId; bytes: Uint8Array }[];
  responses: { from: PeerId; to: PeerId; bytes: Uint8Array }[];
  broadcasts: number;
  holdResponses: boolean;
  heldResponses: { from: PeerId; to: PeerId; bytes: Uint8Array }[];
}

class MemoryDeckContributionStore implements DeckContributionStore {
  readonly records = new Map<string, Uint8Array>();
  async load(id: string): Promise<Uint8Array | null> {
    return this.records.get(id)?.slice() ?? null;
  }
  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.records.has(id)) return false;
    this.records.set(id, bytes.slice());
    return true;
  }
}

function observed(inner: Transport, wire: TradeWire): Transport {
  return {
    self: inner.self,
    peers: () => inner.peers(),
    send(to, bytes) {
      const message = value(decodeProtocolMessage(bytes));
      if (message.t === 'TRADE_PROOF_REQUEST')
        wire.requests.push({ from: inner.self, to, bytes: bytes.slice() });
      if (message.t === 'TRADE_PROOF_RESPONSE') {
        wire.responses.push({ from: inner.self, to, bytes: bytes.slice() });
        if (wire.holdResponses) {
          wire.heldResponses.push({ from: inner.self, to, bytes: bytes.slice() });
          return;
        }
      }
      inner.send(to, bytes);
    },
    broadcast(bytes) {
      const message = value(decodeProtocolMessage(bytes));
      if (message.t === 'TRADE_PROOF_REQUEST' || message.t === 'TRADE_PROOF_RESPONSE')
        wire.broadcasts += 1;
      inner.broadcast(bytes);
    },
    onMessage: (listener) => inner.onMessage(listener),
    onPeerChange: (listener) => inner.onPeerChange(listener),
    disconnect: (peer) => inner.disconnect(peer),
  };
}

test('live uncertain-hand trade retries fresh parents, survives restart, and replays both owners', async () => {
  const fixture = createVerifiedDeckSession(317, 2, 128);
  const peers = fixture.humans.map((human) => human.publicKey);
  const network = createMemnet({ peers });
  const wire: TradeWire = {
    requests: [],
    responses: [],
    broadcasts: 0,
    holdResponses: false,
    heldResponses: [],
  };
  const proofSeeds = new Map<PeerId, { count: () => number }>();
  const options: P2PSessionOptions[] = fixture.humans.map((human) => {
    const deckSource = fixture.createDeckSourceFor(human.seat);
    const stealSource = fixture.createStealSourceFor(human.seat);
    const digest = genesisDigest(fixture.genesis);
    let count = 0;
    proofSeeds.set(human.publicKey, { count: () => count });
    return {
      genesisEntry: fixture.entry,
      engine: fixture.simulation.engine,
      policy: fixture.policy,
      seat: human.seat,
      secretKey: required(fixture.simulation.identities.get(human.seat)).secretKey,
      botKeys: fixture.botKeysFor(human.seat),
      transport: observed(network.transport(human.publicKey), wire),
      clock: network.clock,
      journal: new MemoryProtocolJournal(),
      cheatCandidateStore: new MemoryCheatCandidateStore(),
      beaconSource: fixture.beaconSourceFor(human.seat),
      beaconContributions: new MemoryBeaconContributionStore(),
      deckSetupPasses: fixture.deckSetupPasses,
      createDeckSource: deckSource,
      deckContributions: new MemoryDeckContributionStore(),
      countContributionStore: new MemoryCountContributionStore(),
      stealDeliveryStore: new MemoryStealDeliveryStore(),
      createDriver: (engine, genesis, _clock, owned) =>
        new VerifiedSessionDriver(
          engine,
          genesis,
          owned,
          deckSource,
          (seat) => {
            const source = createHandSecretSource(scalarToBytes(BigInt(71 + seat)), digest, seat);
            return {
              proofSeed(context) {
                count += 1;
                return source.proofSeed(context);
              },
              dispose: () => source.dispose(),
            };
          },
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
  async function submit(seat: Seat, command: CommandShape) {
    const host = required(live[ownerIndex(seat)]);
    const completion: { current: Result<void> | null } = { current: null };
    void host.submit(seat, command).then((result) => {
      completion.current = result;
      return undefined;
    });
    await settle(live, network.clock, 24);
    if (!completion.current) {
      network.clock.advanceBy(2_000);
      await settle(live, network.clock, 24);
    }
    value(required(completion.current));
  }
  function discardFor(seat: Seat): CommandShape {
    const state = required(live[0]).getState();
    const hand = required(required(live[ownerIndex(seat)]).getPrivate(seat)).hand;
    let remaining = Math.floor(
      required(state.seats.find((item) => item.seat === seat)).resources.total / 2,
    );
    const cards = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
    for (const resource of RESOURCES) {
      cards[resource] = Math.min(hand[resource] ?? 0, remaining);
      remaining -= cards[resource];
    }
    return { type: 'DISCARD', cards };
  }
  try {
    await settle(live, network.clock, 32);
    let stole = false;
    for (let step = 0; step < 80 && !stole; step++) {
      const session = required(live[0]);
      const state = session.getState();
      const pending = session.getPending().find((item) => item.kind === 'player');
      if (!pending || pending.kind !== 'player')
        throw new Error(
          `No player pending before steal at ${step}: ${JSON.stringify(session.getPending())}`,
        );
      const host = required(live[ownerIndex(pending.seat)]);
      const legal = host.getLegalCommands(pending.seat);
      let command: CommandShape | undefined;
      if (legal.templates.some((item) => item.type === 'DISCARD'))
        command = discardFor(pending.seat);
      command ??= legal.commands.find((item) => item.type === 'STEAL');
      if (command?.type === 'STEAL') stole = true;
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
      if (!command) throw new Error(`No legal command before steal at ${step}`);
      // oxlint-disable-next-line no-await-in-loop -- The next action depends on this certificate.
      await submit(pending.seat, command);
    }
    expect(stole).toBe(true);
    expect(
      required(live[0])
        .exportSave()
        .entries.filter(
          ({ entry }) =>
            entry.payload.kind === 'system' && entry.payload.input.type === 'STEAL_RESULT',
        ),
    ).toHaveLength(1);

    let chosen: { active: Seat; other: Seat; give: Resource; want: Resource } | null = null;
    for (let step = 0; step < 24 && !chosen; step++) {
      const state = required(live[0]).getState();
      const active = state.turn.activeSeat;
      const host = required(live[ownerIndex(active)]);
      const legal = host.getLegalCommands(active);
      if (legal.templates.some((item) => item.type === 'OFFER_TRADE')) {
        const hand = required(host.getPrivate(active)).hand;
        for (const other of fixture.genesis.config.seats) {
          if (ownerIndex(other) === ownerIndex(active)) continue;
          const otherHand = required(required(live[ownerIndex(other)]).getPrivate(other)).hand;
          const publicOther = required(state.seats.find((item) => item.seat === other));
          const want = RESOURCES.find(
            (resource) =>
              (otherHand[resource] ?? 0) > 0 && (publicOther.resources.min[resource] ?? 0) === 0,
          );
          const give = RESOURCES.find((resource) => resource !== want && (hand[resource] ?? 0) > 0);
          if (give && want) {
            chosen = { active, other, give, want };
            break;
          }
        }
      }
      if (chosen) break;
      const pending = required(
        required(live[0])
          .getPending()
          .find((item) => item.kind === 'player'),
      );
      if (pending.kind !== 'player') throw new Error('Unexpected non-player trade pending');
      const nextHost = required(live[ownerIndex(pending.seat)]);
      const nextLegal = nextHost.getLegalCommands(pending.seat);
      const command =
        (nextLegal.templates.some((item) => item.type === 'DISCARD')
          ? discardFor(pending.seat)
          : undefined) ??
        nextLegal.commands.find((item) => item.type === 'ROLL_DICE') ??
        nextLegal.commands.find((item) => item.type === 'END_TURN') ??
        nextLegal.commands[0];
      if (!command)
        throw new Error(
          `Cannot advance to trade at ${step}: ${JSON.stringify({ pending, legal: nextLegal })}`,
        );
      // oxlint-disable-next-line no-await-in-loop -- The next state depends on this certificate.
      await submit(pending.seat, command);
    }
    if (!chosen)
      throw new Error(
        `No remote uncertain trade: ${JSON.stringify(allHands().map((item) => item.hand))}`,
      );
    const { active, other, give, want } = chosen;
    const before = allHands();
    await submit(active, {
      type: 'OFFER_TRADE',
      give: { [give]: 1 },
      want: { [want]: 1 },
      to: [other],
    });
    const cancel = required(live[ownerIndex(active)])
      .getLegalCommands(active)
      .commands.find((item) => item.type === 'CANCEL_TRADE');
    if (cancel?.type !== 'CANCEL_TRADE') throw new Error('Certified offer is missing');
    const offerId = cancel.offerId;
    await submit(other, { type: 'RESPOND_TRADE', offerId, accept: true });
    const parent = required(live[0]).getState();
    const otherHost = required(peers[ownerIndex(other)]);
    const activeHost = required(peers[ownerIndex(active)]);
    const seedsBefore = required(proofSeeds.get(otherHost)).count();
    wire.holdResponses = true;
    const tradeStartedAt = network.clock.now();
    const completion: { current: Result<void> | null } = { current: null };
    void required(live[ownerIndex(active)])
      .submit(active, {
        type: 'CONFIRM_TRADE',
        offerId,
        withSeat: other,
      })
      .then((result) => {
        completion.current = result;
        return undefined;
      });
    await settle(live, network.clock, 24);
    expect(completion.current).toBeNull();
    expect(wire.responses).toHaveLength(1);
    expect(wire.requests.length).toBeGreaterThan(0);
    const firstResponse = required(wire.heldResponses[0]);
    network.clock.advanceBy(300);
    await settle(live, network.clock, 32);
    expect(wire.responses).toHaveLength(2);
    expect(wire.responses[1]?.bytes).toEqual(wire.responses[0]?.bytes);
    expect(required(proofSeeds.get(otherHost)).count()).toBe(seedsBefore + 1);

    for (let replacement = 0; replacement < 3; replacement++) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each new parent follows the prior counter-offer certificate.
      await submit(other, {
        type: 'PROPOSE_TRADE',
        give: { [want]: 1 },
        want: { [give]: 1 },
      });
      expect(
        required(live[ownerIndex(active)])
          .getLegalCommands(active)
          .commands.some(
            (command) =>
              command.type === 'CONFIRM_TRADE' &&
              command.offerId === offerId &&
              command.withSeat === other,
          ),
      ).toBe(true);
      expect(completion.current).toBeNull();
    }
    const uniqueRequests = new Map<
      string,
      Extract<ProtocolMessage, { t: 'TRADE_PROOF_REQUEST' }>
    >();
    for (const request of wire.requests) {
      const decoded = value(decodeProtocolMessage(request.bytes));
      if (decoded.t === 'TRADE_PROOF_REQUEST')
        uniqueRequests.set(tradeProofRequestId(decoded.request.body), decoded);
      expect(request.from).toBe(activeHost);
      expect(request.to).toBe(otherHost);
    }
    const freshRequests = [...uniqueRequests.values()].toSorted(
      (left, right) => left.request.body.headSeq - right.request.body.headSeq,
    );
    expect(freshRequests).toHaveLength(4);
    const firstRequest = required(freshRequests[0]);
    expect(freshRequests.map(({ request }) => request.body.headSeq)).toEqual([
      firstRequest.request.body.headSeq,
      firstRequest.request.body.headSeq + 1,
      firstRequest.request.body.headSeq + 2,
      firstRequest.request.body.headSeq + 3,
    ]);
    expect(new Set(freshRequests.map(({ request }) => request.body.headHash)).size).toBe(4);
    expect(
      freshRequests.every(
        ({ request }) =>
          request.body.command.type === 'CONFIRM_TRADE' &&
          request.body.command.offerId === offerId &&
          request.body.command.withSeat === other,
      ),
    ).toBe(true);
    expect(wire.heldResponses).toHaveLength(5);
    expect(required(proofSeeds.get(otherHost)).count()).toBe(seedsBefore + 4);
    expect(network.clock.now() - tradeStartedAt).toBeLessThan(10_000);
    const fourthRequestId = tradeProofRequestId(required(freshRequests[3]).request.body);
    const fourthBeforeRestart = required(
      wire.responses.find((response) => {
        const decoded = value(decodeProtocolMessage(response.bytes));
        return (
          decoded.t === 'TRADE_PROOF_RESPONSE' &&
          decoded.response.body.requestId === fourthRequestId
        );
      }),
    );

    network.transport(firstResponse.from).send(firstResponse.to, firstResponse.bytes);
    await settle(live, network.clock, 16);
    expect(completion.current).toBeNull();
    expect(required(proofSeeds.get(otherHost)).count()).toBe(seedsBefore + 4);
    expect(wire.broadcasts).toBe(0);

    for (const session of live) session.dispose();
    await settle(live, network.clock, 2);
    expect(completion.current).toMatchObject({
      ok: false,
      error: { code: 'trade-proof-cancelled' },
    });
    live = (await Promise.all(options.map((item) => P2PSession.restore(item)))).map(value);
    await settle(live, network.clock, 16);
    completion.current = null;
    void required(live[ownerIndex(active)])
      .submit(active, { type: 'CONFIRM_TRADE', offerId, withSeat: other })
      .then((result) => {
        completion.current = result;
        return undefined;
      });
    await settle(live, network.clock, 24);
    expect(completion.current).toBeNull();
    const regenerated = required(wire.responses.at(-1));
    expect(regenerated.bytes).toEqual(fourthBeforeRestart.bytes);
    const regeneratedMessage = value(decodeProtocolMessage(regenerated.bytes));
    expect(regeneratedMessage.t).toBe('TRADE_PROOF_RESPONSE');
    expect(wire.broadcasts).toBe(0);

    network.transport(regenerated.from).send(regenerated.to, regenerated.bytes);
    wire.holdResponses = false;
    await settle(live, network.clock, 32);
    const currentCompletion = () => completion.current;
    value(required(currentCompletion()));
    expect(required(proofSeeds.get(otherHost)).count()).toBe(seedsBefore + 5);
    expect(wire.broadcasts).toBe(0);
    const after = allHands();
    const activeBefore = required(before.find((item) => item.seat === active));
    const otherBefore = required(before.find((item) => item.seat === other));
    const activeAfter = required(after.find((item) => item.seat === active));
    const otherAfter = required(after.find((item) => item.seat === other));
    for (const resource of RESOURCES) {
      expect(activeAfter.hand[resource]).toBe(
        (activeBefore.hand[resource] ?? 0) +
          (resource === want ? 1 : 0) -
          (resource === give ? 1 : 0),
      );
      expect(otherAfter.hand[resource]).toBe(
        (otherBefore.hand[resource] ?? 0) +
          (resource === give ? 1 : 0) -
          (resource === want ? 1 : 0),
      );
    }
    const save = required(live[0]).exportSave();
    const confirmations = save.entries.filter(
      ({ entry }) =>
        entry.payload.kind === 'command' &&
        entry.payload.signed.body.command.type === 'CONFIRM_TRADE',
    );
    expect(confirmations).toHaveLength(1);
    expect(required(live[0]).getState()).not.toEqual(parent);
    let priorHands: PublicHandCommitments | null = null;
    let expectedHands: PublicHandCommitments | null = null;
    let actualHands: PublicHandCommitments | null = null;
    value(
      replayCertifiedPrefix(
        save.genesis,
        save.entries,
        fixture.simulation.engine,
        fixture.policy,
        (entry, next) => {
          const hands = required(next.log.crypto).hands;
          if (entry.input?.kind === 'command' && entry.input.command.type === 'CONFIRM_TRADE') {
            if (!priorHands) throw new Error('Missing certified trade parent hands');
            const expected = priorHands.map((row) => {
              const commitments = { ...row.commitments };
              for (const resource of RESOURCES) {
                const delta =
                  row.seat === active
                    ? (resource === want ? 1 : 0) - (resource === give ? 1 : 0)
                    : row.seat === other
                      ? (resource === give ? 1 : 0) - (resource === want ? 1 : 0)
                      : 0;
                const point = decodePoint(row.commitments[resource]);
                commitments[resource] = encodePoint(
                  delta > 0 ? point.add(G) : delta < 0 ? point.subtract(G) : point,
                );
              }
              return { ...row, commitments };
            });
            expectedHands = expected;
            actualHands = hands;
          }
          priorHands = hands;
          return success(undefined);
        },
      ),
    );
    expect(expectedHands).not.toBeNull();
    expect(actualHands).toEqual(expectedHands);
    for (const session of live) session.dispose();
    // Both owners already restarted with the pending trade above. Restore the
    // proof supplier once more after commit to check its durable final hand.
    const restored = value(await P2PSession.restore(required(options[ownerIndex(other)])));
    live = [restored];
    await settle(live, network.clock, 16);
    for (const item of after.filter((holder) => ownerIndex(holder.seat) === ownerIndex(other)))
      expect(restored.getPrivate(item.seat)?.hand).toEqual(item.hand);
    expect(restored.exportSave().entries).toEqual(save.entries);
  } finally {
    for (const session of live) session.dispose();
  }
  // Real setup, steal, four trade-proof parents and restart replay take over a
  // minute on hosted CI. Virtual protocol deadlines above remain unchanged.
}, 90_000);
