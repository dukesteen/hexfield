import { BASE_DEV_CARD_CATALOGUE, RESOURCES } from '@cp2p/engine';
import type { CommandShape, GameState, Result, Seat } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { MemoryBeaconContributionStore } from './beacon-contributions.js';
import type { DeckContributionStore } from './deck-outbox.js';
import { decodeDeckCard } from './deck-draw.js';
import { genesisDeckDefinitions } from './deck-genesis.js';
import { DECK_REVEAL_PROTOCOL } from './deck-ledger.js';
import { entryHash } from './genesis.js';
import { MemoryProtocolJournal } from './journal.js';
import { signCommand } from './log.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import type { ProtocolMessage } from './messages.js';
import { P2PSession } from './p2p-session.js';
import { ReplicatedLog } from './replicated-log.js';
import type { ReplicatedLogOptions } from './replicated-log.js';
import { createMemnet } from './testing/memnet.js';
import { createVerifiedDeckSession } from './testing/verified-deck-session.js';
import type { VerifiedDeckSession } from './testing/verified-deck-session.js';
import type { VirtualClock } from './testing/virtual-clock.js';
import type { PeerId, ProtocolClock, Transport } from './transport.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing deck replica fixture value');
  return item;
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

function observe(
  inner: Transport,
  sent: ProtocolMessage[],
  dropDeckContribution: () => boolean = () => false,
): Transport & { inject(from: PeerId, message: ProtocolMessage): void } {
  let listener: ((from: PeerId, bytes: Uint8Array) => void) | null = null;
  const record = (bytes: Uint8Array) => {
    const message = value(decodeProtocolMessage(bytes));
    sent.push(message);
    return message;
  };
  return {
    self: inner.self,
    peers: () => inner.peers(),
    send(to, bytes) {
      const message = record(bytes);
      if (message.t !== 'DECK_CONTRIB' || !dropDeckContribution()) inner.send(to, bytes);
    },
    broadcast(bytes) {
      const message = record(bytes);
      if (message.t !== 'DECK_CONTRIB' || !dropDeckContribution()) inner.broadcast(bytes);
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
  fixture: VerifiedDeckSession,
  position: number,
  transport: Transport,
  clock: VirtualClock,
  journal: MemoryProtocolJournal,
  deckContributions: DeckContributionStore,
): ReplicatedLogOptions {
  const seat = required(fixture.humans[position]).seat;
  return {
    genesisEntry: fixture.entry,
    engine: fixture.simulation.engine,
    policy: fixture.policy,
    seat,
    secretKey: required(fixture.simulation.identities.get(seat)).secretKey,
    transport,
    clock,
    journal,
    beaconSource: fixture.beaconSourceFor(seat),
    beaconContributions: new MemoryBeaconContributionStore(),
    deckSetupPasses: fixture.deckSetupPasses,
    botKeys: fixture.botKeysFor(seat),
    createDeckSource: fixture.createDeckSourceFor(seat),
    deckContributions,
  };
}

async function settle(
  replicas: readonly { flush(): Promise<void> }[],
  clock: VirtualClock,
  passes = 32,
) {
  for (let pass = 0; pass < passes; pass += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Each pass drains packets scheduled by the previous pass.
    await Promise.all(replicas.map((replica) => replica.flush()));
    clock.advanceBy(0);
    // oxlint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await Promise.all(replicas.map((replica) => replica.flush()));
}

function discardChoice(fixture: VerifiedDeckSession, state: GameState, seat: Seat): CommandShape {
  const holder = required(state.seats.find((item) => item.seat === seat));
  let remaining = Math.floor(holder.resources.total / 2);
  const cards = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
  for (const resource of RESOURCES) {
    const count = Math.min(holder.resources.min[resource], remaining);
    cards[resource] = count;
    remaining -= count;
  }
  const command: CommandShape = { type: 'DISCARD', cards };
  if (
    remaining !== 0 ||
    !fixture.simulation.engine.validate(state, { kind: 'command', seat, command }).ok
  )
    throw new Error('No legal deterministic discard from the public hand');
  return command;
}

function quietRobberMove(
  fixture: VerifiedDeckSession,
  state: GameState,
  seat: Seat,
  legal: readonly CommandShape[],
): CommandShape | undefined {
  for (const command of legal) {
    if (command.type !== 'MOVE_ROBBER') continue;
    const applied = fixture.simulation.engine.apply(state, {
      kind: 'command',
      seat,
      command,
    });
    if (
      applied.ok &&
      !fixture.simulation.engine
        .getPending(applied.value.state)
        .some((pending) => pending.kind === 'player' && pending.allowed.includes('STEAL'))
    )
      return command;
  }
  return undefined;
}

async function driveToDraw(
  fixture: VerifiedDeckSession,
  replicas: readonly ReplicatedLog[],
  clock: VirtualClock,
) {
  for (let step = 0; step < 500; step += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each command needs the prior certified state.
    await settle(replicas, clock, 8);
    const context = required(replicas[0]).getContext();
    if (context.log.crypto?.decks.active) return context;
    const player = fixture.simulation.engine.getPending(context.log.state).find((item) => {
      if (item.kind !== 'player') return false;
      const available = fixture.simulation.engine.getLegalCommands(context.log.state, item.seat);
      return (
        available.commands.length > 0 ||
        available.templates.some((template) => template.type === 'DISCARD')
      );
    });
    if (!player || player.kind !== 'player') {
      clock.advanceBy(2_000);
      continue;
    }
    const legalSet = fixture.simulation.engine.getLegalCommands(context.log.state, player.seat);
    const legal = legalSet.commands;
    const choice =
      legal.find((item) => item.type === 'BUY_DEV_CARD') ??
      legal.find((item) => item.type === 'ROLL_DICE') ??
      legal.find((item) => item.type === 'END_TURN') ??
      (legalSet.templates.some((item) => item.type === 'DISCARD')
        ? discardChoice(fixture, context.log.state, player.seat)
        : undefined) ??
      quietRobberMove(fixture, context.log.state, player.seat, legal) ??
      legal[0];
    if (!choice)
      throw new Error(`No legal command at step ${step}: ${JSON.stringify(legalSet.templates)}`);
    const signer = required(fixture.simulation.identities.get(player.seat));
    const host = fixture.genesis.seats.find((seat) => seat.seat === player.seat);
    const hostPeer = host?.kind === 'bot' ? host.botHost : signer.peerId;
    const hostIndex = fixture.humans.findIndex(
      (seat) => fixture.simulation.identities.get(seat.seat)?.peerId === hostPeer,
    );
    if (hostIndex < 0) throw new Error('No host for pending player');
    const signed = signCommand(
      {
        gameId: fixture.genesis.gameId,
        genesisDigest: context.membership.genesisDigest,
        seat: player.seat,
        nonce: (context.log.lastNonces.get(player.seat) ?? 0) + 1,
        headSeq: context.log.head.seq,
        headHash: entryHash(context.log.head),
        command: choice,
      },
      signer.secretKey,
    );
    let result: Result<void> | null = null;
    void required(replicas[hostIndex])
      .submit(signed)
      .then((settled) => {
        result = settled;
        return undefined;
      });
    // oxlint-disable-next-line eslint/no-await-in-loop -- Complete this command before the next choice.
    await settle(replicas, clock);
    if (result === null) {
      clock.advanceBy(2_000);
      // oxlint-disable-next-line eslint/no-await-in-loop -- The timeout may release the current proposal.
      await settle(replicas, clock);
    }
    if (result === null) throw new Error(`${choice.type} did not commit at step ${step}`);
    value(result);
  }
  const context = required(replicas[0]).getContext();
  throw new Error(
    `No legal development-card purchase within 500 inputs: head=${context.log.head.seq}, pending=${JSON.stringify(fixture.simulation.engine.getPending(context.log.state))}`,
  );
}

async function driveSessionToPlayableKnight(
  fixture: VerifiedDeckSession,
  sessions: readonly P2PSession[],
  clock: VirtualClock,
  seat: Seat,
  slotId: string,
) {
  const play: CommandShape = { type: 'PLAY_DEV_CARD', slotId, card: 'knight' };
  for (let step = 0; step < 100; step += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each command needs the preceding certificate.
    await settle(sessions, clock, 8);
    const state = required(sessions[0]).getState();
    const pending = required(sessions[0]).getPending();
    const player = pending.find((item) => item.kind === 'player');
    if (player?.kind !== 'player') {
      clock.advanceBy(2_000);
      continue;
    }
    const owner = fixture.genesis.seats.find((item) => item.seat === player.seat);
    const hostPeer = owner?.kind === 'bot' ? owner.botHost : owner?.publicKey;
    const hostIndex = fixture.humans.findIndex(
      (item) => fixture.simulation.identities.get(item.seat)?.peerId === hostPeer,
    );
    if (hostIndex < 0) throw new Error('No session host for pending player');
    const host = required(sessions[hostIndex]);
    const legalSet = host.getLegalCommands(player.seat);
    if (
      player.seat === seat &&
      legalSet.commands.some(
        (command) =>
          command.type === 'PLAY_DEV_CARD' &&
          command.slotId === slotId &&
          command.card === 'knight',
      )
    )
      return play;
    const legal = legalSet.commands;
    const choice =
      legal.find((command) => command.type === 'ROLL_DICE') ??
      legal.find((command) => command.type === 'END_TURN') ??
      (legalSet.templates.some((command) => command.type === 'DISCARD')
        ? discardChoice(fixture, state, player.seat)
        : undefined) ??
      quietRobberMove(fixture, state, player.seat, legal) ??
      legal.find((command) => command.type !== 'STEAL' && command.type !== 'BUY_DEV_CARD');
    if (!choice) throw new Error(`No safe session command at step ${step}`);
    const completion: { current: Result<void> | null } = { current: null };
    void host.submit(player.seat, choice).then((settled) => {
      completion.current = settled;
      return undefined;
    });
    // oxlint-disable-next-line eslint/no-await-in-loop -- The network must certify this choice before the next one.
    await settle(sessions, clock);
    if (completion.current === null) {
      clock.advanceBy(2_000);
      // oxlint-disable-next-line eslint/no-await-in-loop -- A timeout can release this proposal.
      await settle(sessions, clock);
    }
    const result = completion.current;
    if (result === null) throw new Error(`${choice.type} did not commit at step ${step}`);
    if (!result.ok && result.error.code !== 'command-pending') value(result);
  }
  throw new Error('Knight did not become playable within 100 session inputs');
}

describe('live verified deck replication', () => {
  test('rejects a verified driver with missing hosted or extra foreign private seats before opening a journal', async () => {
    const fixture = createVerifiedDeckSession();
    const host = required(fixture.humans[0]);
    const peer = required(fixture.simulation.identities.get(host.seat)).peerId;
    const network = createMemnet({ peers: [peer] });
    const bot = required([...fixture.botKeysFor(host.seat).keys()][0]);
    const foreign = required(fixture.humans[1]).seat;
    const journal = new MemoryProtocolJournal();
    const base = optionsFor(
      fixture,
      0,
      network.transport(peer),
      network.clock,
      journal,
      new MemoryDeckContributionStore(),
    );
    for (const owned of [[host.seat], [host.seat, bot, foreign]]) {
      // oxlint-disable-next-line no-await-in-loop -- Each rejected open must leave this journal empty.
      const opened = await P2PSession.create({
        ...base,
        createDriver: (engine, genesis) =>
          new VerifiedSessionDriver(engine, genesis, owned, required(base.createDeckSource)),
      });
      expect(opened).toMatchObject({ ok: false, error: { code: 'session-driver-seats' } });
      // oxlint-disable-next-line no-await-in-loop
      expect(await journal.load()).toBeNull();
    }
    network.dispose();
  }, 30_000);

  test('gossips durable unlocks after a legal purchase and restores a dropped unlock', async () => {
    const fixture = createVerifiedDeckSession();
    expect(value(genesisDeckDefinitions(fixture.deck.body))[0]?.cards).toHaveLength(25);
    const peers = fixture.humans.map(
      (seat) => required(fixture.simulation.identities.get(seat.seat)).peerId,
    );
    const network = createMemnet({ peers });
    const journals = [new MemoryProtocolJournal(), new MemoryProtocolJournal()];
    const stores = [new MemoryDeckContributionStore(), new MemoryDeckContributionStore()];
    const sent: ProtocolMessage[][] = [[], []];
    let dropUnlocks = true;
    const transports = peers.map((peer, index) =>
      observe(network.transport(peer), required(sent[index]), () => index === 0 && dropUnlocks),
    );
    const firstOptions = optionsFor(
      fixture,
      0,
      required(transports[0]),
      network.clock,
      required(journals[0]),
      required(stores[0]),
    );
    expect(() =>
      required(firstOptions.createDeckSource)('dev', required(fixture.humans[1]).seat),
    ).toThrow(/not hosted/);
    const hostedBot = required([...required(firstOptions.botKeys).entries()][0]);
    const missingSource = { ...firstOptions };
    delete missingSource.createDeckSource;
    const missingStore = { ...firstOptions };
    delete missingStore.deckContributions;
    const invalidOptions: ReplicatedLogOptions[] = [
      missingSource,
      missingStore,
      { ...firstOptions, botKeys: new Map() },
      { ...firstOptions, botKeys: new Map([[hostedBot[0], firstOptions.secretKey]]) },
    ];
    for (const [index, options] of invalidOptions.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- Every rejected startup must leave the same journal empty.
      const created = await ReplicatedLog.create(options);
      expect(created.ok).toBe(false);
      expect(created).toMatchObject({
        ok: false,
        error: { code: index < 2 ? 'replica-deck-store' : 'replica-bot-key' },
      });
      // oxlint-disable-next-line no-await-in-loop
      expect(await required(journals[0]).load()).toBeNull();
    }
    const first = value(await ReplicatedLog.create(firstOptions));
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
    const firstProposal = required(sent[0]).find((message) => message.t === 'PROPOSAL');
    if (firstProposal) {
      required(transports[1]).inject(required(peers[0]), firstProposal);
      const firstPrevote = required(sent[0]).find(
        (message) =>
          message.t === 'VOTE' &&
          message.vote.body.seq === firstProposal.proposal.body.entry.seq &&
          message.vote.body.phase === 'prevote',
      );
      if (firstPrevote) required(transports[1]).inject(required(peers[0]), firstPrevote);
    }
    await settle([first, second], network.clock);
    const beforeDraw = await driveToDraw(fixture, [first, second], network.clock);
    const draw = required(beforeDraw.log.crypto?.decks.active);
    expect(draw.position).toBe(0);
    await settle([first, second], network.clock);
    const dropped = required(sent[0]).find((message) => message.t === 'DECK_CONTRIB');
    expect(dropped).toBeDefined();
    const headBeforeRestart = first.getContext().log.head.seq;
    expect(
      first
        .getEntries()
        .some(
          ({ entry }) =>
            entry.payload.kind === 'system' && entry.payload.input.type === 'CARD_DEALT',
        ),
    ).toBe(false);
    first.dispose();
    network.crash(required(peers[0]));
    dropUnlocks = false;
    const failedMessages: ProtocolMessage[] = [];
    const failedTransport = observe(network.restart(required(peers[0])), failedMessages);
    const failedStore: DeckContributionStore = {
      load: async () => null,
      putIfAbsent: async () => {
        throw new Error('Simulated durable deck write failure');
      },
    };
    const failedRestore = await ReplicatedLog.restore(
      optionsFor(fixture, 0, failedTransport, network.clock, required(journals[0]), failedStore),
    );
    expect(failedRestore.ok).toBe(false);
    expect(failedRestore).toMatchObject({ ok: false, error: { code: 'deck-outbox-write' } });
    expect(failedMessages.filter((message) => message.t === 'DECK_CONTRIB')).toHaveLength(0);
    expect(failedMessages.filter((message) => message.t === 'VOTE')).toHaveLength(0);
    expect((await required(journals[0]).load())?.height).toBe(headBeforeRestart + 1);
    network.crash(required(peers[0]));
    const retransmitted: ProtocolMessage[] = [];
    const restartedTransport = observe(network.restart(required(peers[0])), retransmitted);
    const restored = value(
      await ReplicatedLog.restore(
        optionsFor(
          fixture,
          0,
          restartedTransport,
          network.clock,
          required(journals[0]),
          required(stores[0]),
        ),
      ),
    );
    await settle([restored, second], network.clock);
    expect(retransmitted.find((message) => message.t === 'DECK_CONTRIB')).toEqual(dropped);
    expect(restored.getContext().log.head.seq).toBeGreaterThan(headBeforeRestart);
    expect(restored.getContext().log.head.stateHash).toBe(second.getContext().log.head.stateHash);
    const deal = required(
      restored
        .getEntries()
        .find(
          ({ entry }) =>
            entry.payload.kind === 'system' && entry.payload.input.type === 'CARD_DEALT',
        ),
    );
    expect(deal.certificate).toHaveLength(2);
    const deck = required(restored.getContext().log.crypto?.decks.decks[0]);
    const slot = required(deck.slots[0]);
    expect(deck.nextPosition).toBe(1);
    expect(slot.seat).toBe(draw.seat);
    expect(slot.slotId).toBe(draw.slotId);
    expect(JSON.stringify(restored.getContext().log.state)).not.toContain(slot.receipt.point);
    const host = required(fixture.genesis.seats.find((seat) => seat.seat === draw.seat));
    const ownerHost = host.kind === 'bot' ? host.botHost : host.publicKey;
    const ownerHuman = required(
      fixture.humans.find(
        (seat) => fixture.simulation.identities.get(seat.seat)?.peerId === ownerHost,
      ),
    );
    const owner = fixture.createDeckSourceFor(ownerHuman.seat)('dev', draw.seat);
    let dealtCard: string;
    try {
      const decoded = value(decodeDeckCard(deck.setup, slot.receipt, owner.lock(draw.position)));
      expect(BASE_DEV_CARD_CATALOGUE).toContainEqual(decoded);
      dealtCard = decoded.card;
    } finally {
      owner.dispose();
    }
    expect(required(stores[0]).records.size).toBeGreaterThan(0);
    restored.dispose();
    second.dispose();
    const sessionOptions = (position: number, transport: Transport) => {
      const base = optionsFor(
        fixture,
        position,
        transport,
        network.clock,
        required(journals[position]),
        required(stores[position]),
      );
      return {
        ...base,
        createDriver: (
          engine: typeof fixture.simulation.engine,
          genesis: typeof fixture.genesis,
          _clock: ProtocolClock,
          ownedSeats: readonly Seat[],
        ) =>
          new VerifiedSessionDriver(engine, genesis, ownedSeats, required(base.createDeckSource)),
      };
    };
    const sessions = [
      value(await P2PSession.restore(sessionOptions(0, restartedTransport))),
      value(await P2PSession.restore(sessionOptions(1, required(transports[1])))),
    ];
    const holder = required(fixture.genesis.seats.find((seat) => seat.seat === draw.seat));
    const ownerPeer = holder.kind === 'bot' ? holder.botHost : holder.publicKey;
    const ownerIndex = peers.indexOf(ownerPeer);
    expect(ownerIndex).toBeGreaterThanOrEqual(0);
    expect(required(sessions[ownerIndex]).getPrivate(draw.seat)?.slots[draw.slotId]).toBe(
      dealtCard,
    );
    expect(required(sessions[1 - ownerIndex]).getPrivate(draw.seat)).toBeNull();
    expect(draw.seat).toBe(required(fixture.humans[0]).seat);
    expect(dealtCard).toBe('knight');
    const play = await driveSessionToPlayableKnight(
      fixture,
      sessions,
      network.clock,
      draw.seat,
      draw.slotId,
    );
    const completion: { current: Result<void> | null } = { current: null };
    void required(sessions[ownerIndex])
      .submit(draw.seat, play)
      .then((result) => {
        completion.current = result;
        return undefined;
      });
    await settle(sessions, network.clock);
    if (completion.current === null) {
      network.clock.advanceBy(2_000);
      await settle(sessions, network.clock);
    }
    value(required(completion.current));
    const histories = sessions.map((session) => session.exportSave().entries);
    const knightEntries = histories.map((entries) =>
      entries.find(
        ({ entry }) =>
          entry.payload.kind === 'command' &&
          entry.payload.signed.body.command.type === 'PLAY_DEV_CARD' &&
          entry.payload.signed.body.command.slotId === draw.slotId,
      ),
    );
    for (const certified of knightEntries) {
      expect(certified?.certificate).toHaveLength(2);
      if (certified?.entry.payload.kind !== 'command') throw new Error('Missing certified Knight');
      expect(certified.entry.payload.signed.body.evidence?.protocol).toBe(DECK_REVEAL_PROTOCOL);
    }
    expect(required(knightEntries[0]).entry).toEqual(required(knightEntries[1]).entry);
    expect(
      required(sessions[ownerIndex]).getPrivate(draw.seat)?.slots[draw.slotId],
    ).toBeUndefined();
    expect(required(sessions[1 - ownerIndex]).getPrivate(draw.seat)).toBeNull();
    sessions.forEach((session) => session.dispose());
    network.dispose();
  }, 120_000);
});
