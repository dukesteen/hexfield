import { canonicalDecode, fromBase64Url, toBase64Url } from '@cp2p/codec';
import { BASE_DEV_CARD_CATALOGUE, RESOURCES, failure } from '@cp2p/engine';
import { scalarToBytes } from '@cp2p/crypto';
import type { CommandShape, GameState, PrivateState, Result, Seat } from '@cp2p/engine';
import { writeFile } from 'node:fs/promises';
import { Session as InspectorSession } from 'node:inspector';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { MemoryBeaconContributionStore } from './beacon-contributions.js';
import { MemoryCheatCandidateStore } from './cheat-candidates.js';
import { MemoryCountContributionStore } from './count-contributions.js';
import { MemoryStealDeliveryStore } from './steal-contributions.js';
import { createStealSecretSource } from './steal-source.js';
import type { DeckContributionStore } from './deck-outbox.js';
import { decodeDeckCard } from './deck-draw.js';
import { genesisDeckDefinitions } from './deck-genesis.js';
import { COMMAND_PROOFS_PROTOCOL } from './command-proofs.js';
import { entryHash } from './genesis.js';
import { MemoryProtocolJournal } from './journal.js';
import { signCommand } from './log.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import type { ProtocolMessage } from './messages.js';
import { P2PSession } from './p2p-session.js';
import { reconstructPrivateSeats } from './private-replay.js';
import { ReplicatedLog } from './replicated-log.js';
import type { ReplicatedLogOptions } from './replicated-log.js';
import { createMemnet } from './testing/memnet.js';
import { createSimulationGenesis } from './testing/simulation-genesis.js';
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

const BOARD_50_SETTLEMENT_ORDER = [
  'v:-1,-1,N',
  'v:-1,-1,S',
  'v:-1,0,S',
  'v:-1,1,S',
  'v:0,-1,S',
  'v:0,0,S',
  'v:0,2,N',
  'v:1,1,N',
] as const;

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
  dropDeckContribution: (to: PeerId, message: ProtocolMessage) => boolean = () => false,
  trace?: (direction: 'send' | 'receive', message: ProtocolMessage, peer: PeerId) => void,
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
      trace?.('send', message, to);
      if (message.t !== 'DECK_CONTRIB' || !dropDeckContribution(to, message)) inner.send(to, bytes);
    },
    broadcast(bytes) {
      const message = record(bytes);
      for (const to of inner.peers()) {
        trace?.('send', message, to);
        if (message.t !== 'DECK_CONTRIB' || !dropDeckContribution(to, message))
          inner.send(to, bytes);
      }
    },
    onMessage(callback) {
      listener = callback;
      const unsubscribe = inner.onMessage((from, bytes) => {
        if (trace) trace('receive', value(decodeProtocolMessage(bytes)), from);
        callback(from, bytes);
      });
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

function describeTimedMessage(message: ProtocolMessage): string {
  if (message.t === 'DECK_CONTRIB')
    return `DECK_CONTRIB prefix=${message.contribution.unlocks.length}`;
  if (message.t === 'PROPOSAL') return `PROPOSAL seq=${message.proposal.body.entry.seq}`;
  if (message.t === 'VOTE') return `VOTE ${message.vote.body.phase} seq=${message.vote.body.seq}`;
  if (message.t === 'COMMIT') return `COMMIT seq=${message.certified.entry.seq}`;
  if (message.t === 'SUBMIT') return `SUBMIT ${message.cmd.body.command.type}`;
  return message.t;
}

function wallClock(): ProtocolClock & { dispose(): void } {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 0;
  return {
    now: () => performance.now(),
    setTimeout(callback, delayMs) {
      const id = nextId++;
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          callback();
        }, delayMs),
      );
      return id;
    },
    clearTimeout(handle) {
      if (typeof handle !== 'number') return;
      const timer = timers.get(handle);
      if (timer !== undefined) clearTimeout(timer);
      timers.delete(handle);
    },
    dispose() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

function optionsFor(
  fixture: VerifiedDeckSession,
  position: number,
  transport: Transport,
  clock: ProtocolClock,
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
    cheatCandidateStore: new MemoryCheatCandidateStore(),
    beaconSource: fixture.beaconSourceFor(seat),
    beaconContributions: new MemoryBeaconContributionStore(),
    // These deck-only cases never enter a Monopoly count phase.
    countProof: () => failure('count-not-exercised', 'No count proof in the deck fixture'),
    countContributionStore: new MemoryCountContributionStore(),
    stealContribution: () => failure('steal-not-exercised', 'No steal in the deck fixture'),
    stealResponse: () => failure('steal-not-exercised', 'No steal in the deck fixture'),
    stealDeliveryStore: new MemoryStealDeliveryStore(),
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

function tradeTowardPurchase(
  fixture: VerifiedDeckSession,
  state: GameState,
  seat: Seat,
): CommandShape | undefined {
  const resources = required(state.seats.find((item) => item.seat === seat)).resources.min;
  for (const wanted of ['wool', 'grain', 'ore'] as const) {
    if (resources[wanted] > 0) continue;
    for (const offered of RESOURCES) {
      if (offered === wanted) continue;
      const reserve = offered === 'wool' || offered === 'grain' || offered === 'ore' ? 1 : 0;
      for (const rate of [2, 3, 4]) {
        if (resources[offered] < rate + reserve) continue;
        const give = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
        const get = { ...give };
        give[offered] = rate;
        get[wanted] = 1;
        const command: CommandShape = { type: 'MARITIME_TRADE', give, get };
        if (fixture.simulation.engine.validate(state, { kind: 'command', seat, command }).ok)
          return command;
      }
    }
  }
  return undefined;
}

async function driveToDraw(
  fixture: VerifiedDeckSession,
  replicas: readonly ReplicatedLog[],
  clock: VirtualClock,
  options: {
    stopBeforePurchase?: boolean;
    settlementOrder?: readonly string[];
    minimumBuyerSeat?: number;
    buyerSeat?: Seat;
  } = {},
) {
  const initialPosition = required(replicas[0]).getContext().log.crypto?.decks.decks[0]
    ?.nextPosition;
  for (let step = 0; step < 100; step += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each command needs the prior certified state.
    await settle(replicas, clock, 8);
    const context = required(replicas[0]).getContext();
    const decks = required(context.log.crypto?.decks);
    // A fast draw can finish inside settle, clearing active before we observe it.
    if (decks.active || decks.decks[0]?.nextPosition !== initialPosition) return context;
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
    let setupSettlement: CommandShape | undefined;
    if (options.settlementOrder && legal.some((item) => item.type === 'PLACE_SETTLEMENT')) {
      const vertex = options.settlementOrder[context.log.state.board.buildings.length];
      setupSettlement = required(
        legal.find((item) => item.type === 'PLACE_SETTLEMENT' && item.vertex === vertex),
      );
    }
    const choice =
      (player.seat >= (options.minimumBuyerSeat ?? 0) &&
      (options.buyerSeat === undefined || player.seat === options.buyerSeat)
        ? legal.find((item) => item.type === 'BUY_DEV_CARD')
        : undefined) ??
      legal.find((item) => item.type === 'ROLL_DICE') ??
      legal.find((item) => item.type === 'END_TURN') ??
      (legalSet.templates.some((item) => item.type === 'DISCARD')
        ? discardChoice(fixture, context.log.state, player.seat)
        : undefined) ??
      quietRobberMove(fixture, context.log.state, player.seat, legal) ??
      setupSettlement ??
      legal[0];
    if (!choice)
      throw new Error(`No legal command at step ${step}: ${JSON.stringify(legalSet.templates)}`);
    if (options.stopBeforePurchase && choice.type === 'BUY_DEV_CARD') return context;
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
    `No legal development-card purchase within 100 inputs: head=${context.log.head.seq}, pending=${JSON.stringify(fixture.simulation.engine.getPending(context.log.state))}`,
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

async function driveSessionToFirstPurchase(
  fixture: VerifiedDeckSession,
  sessions: readonly P2PSession[],
  clock: VirtualClock,
  tradeForPurchase = false,
): Promise<Seat> {
  for (let step = 0; step < 500; step += 1) {
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
    const legal = legalSet.commands;
    const choice =
      legal.find((command) => command.type === 'BUY_DEV_CARD') ??
      legal.find((command) => command.type === 'ROLL_DICE') ??
      (tradeForPurchase ? tradeTowardPurchase(fixture, state, player.seat) : undefined) ??
      legal.find((command) => command.type === 'END_TURN') ??
      (legalSet.templates.some((command) => command.type === 'DISCARD')
        ? discardChoice(fixture, state, player.seat)
        : undefined) ??
      quietRobberMove(fixture, state, player.seat, legal) ??
      legal.find((command) => command.type !== 'STEAL');
    if (!choice) throw new Error(`No safe session command at step ${step}`);
    const completion: { current: Result<void> | null } = { current: null };
    void host.submit(player.seat, choice).then((result) => {
      completion.current = result;
      return undefined;
    });
    // oxlint-disable-next-line eslint/no-await-in-loop -- Complete this command before the next choice.
    await settle(sessions, clock);
    if (completion.current === null) {
      clock.advanceBy(2_000);
      // oxlint-disable-next-line eslint/no-await-in-loop
      await settle(sessions, clock);
    }
    value(required(completion.current));
    if (choice.type === 'BUY_DEV_CARD') return player.seat;
  }
  throw new Error('No legal session development-card purchase within 500 inputs');
}

describe('live verified deck replication', () => {
  test('automatically certifies an owned victory card after a transient reveal-source failure', async () => {
    const fixture = createVerifiedDeckSession(7, 2, 128, {
      vpTarget: 3,
      ceremonyNonce: toBase64Url(new Uint8Array(32).fill(7)),
      boardSeed: fromBase64Url(
        createSimulationGenesis({ seed: 0, humanCount: 2 }).genesis.genesisSeed,
      ),
    });
    const peers = fixture.humans.map(
      (seat) => required(fixture.simulation.identities.get(seat.seat)).peerId,
    );
    const network = createMemnet({ peers });
    const journals = [new MemoryProtocolJournal(), new MemoryProtocolJournal()];
    const stores = [new MemoryDeckContributionStore(), new MemoryDeckContributionStore()];
    let failedReveals = 0;
    let preparedReveals = 0;
    const sessions = peers.map((peer, position) => {
      const base = optionsFor(
        fixture,
        position,
        network.transport(peer),
        network.clock,
        required(journals[position]),
        required(stores[position]),
      );
      const original = required(base.createDeckSource);
      return P2PSession.create({
        ...base,
        createDriver: (engine, genesis, _clock, ownedSeats) =>
          new VerifiedSessionDriver(
            engine,
            genesis,
            ownedSeats,
            (deckId, seat) => {
              const source = original(deckId, seat);
              return {
                ...source,
                proofSeed(role, context) {
                  if (role === 'reveal' && failedReveals === 0) {
                    failedReveals += 1;
                    throw new Error('Transient local reveal-source failure');
                  }
                  if (role === 'reveal') preparedReveals += 1;
                  return source.proofSeed(role, context);
                },
              };
            },
            undefined,
            fixture.createStealSourceFor(base.seat),
          ),
      });
    });
    const opened = await Promise.all(sessions);
    const live = opened.map(value);
    await settle(live, network.clock);
    const buyer = await driveSessionToFirstPurchase(fixture, live, network.clock);
    await settle(live, network.clock, 64);
    const beforeRetry = live.map((session) => session.exportSave().entries);
    const deal = required(
      required(beforeRetry[0]).find(
        ({ entry }) => entry.payload.kind === 'system' && entry.payload.input.type === 'CARD_DEALT',
      ),
    );
    if (deal.entry.payload.kind !== 'system' || deal.entry.payload.input.type !== 'CARD_DEALT')
      throw new Error('Missing certified victory card deal');
    const slotId = deal.entry.payload.input.slotId;
    if (typeof slotId !== 'string') throw new Error('Certified deal has no slot ID');
    expect(deal.entry.payload.input.seat).toBe(buyer);
    const owner = required(fixture.genesis.seats.find((seat) => seat.seat === buyer));
    const hostPeer = owner.kind === 'bot' ? owner.botHost : owner.publicKey;
    const ownerIndex = peers.indexOf(hostPeer);
    const ownerSession = required(live[ownerIndex]);
    expect(ownerSession.getPrivate(buyer)?.slots[slotId]).toBe('victoryPoint');
    expect(
      required(ownerSession.getState().seats.find((seat) => seat.seat === buyer)).publicVp,
    ).toBe(2);
    expect(failedReveals).toBe(1);
    expect(preparedReveals).toBe(0);
    expect(beforeRetry.every((entries) => entries.at(-1)?.entry.seq === deal.entry.seq)).toBe(true);
    const parentSeq = deal.entry.seq;
    network.clock.advanceBy(249);
    await settle(live, network.clock);
    expect(
      live.every((session) => session.exportSave().entries.at(-1)?.entry.seq === parentSeq),
    ).toBe(true);
    expect(preparedReveals).toBe(0);
    expect(ownerSession.getLegalCommands(buyer).commands).not.toContainEqual({ type: 'END_TURN' });
    expect(await ownerSession.submit(buyer, { type: 'END_TURN' })).toMatchObject({
      ok: false,
      error: { code: 'automatic-input-pending' },
    });
    expect(
      live.every((session) => session.exportSave().entries.at(-1)?.entry.seq === parentSeq),
    ).toBe(true);
    network.clock.advanceBy(1);
    await settle(live, network.clock, 64);
    const histories = live.map((session) => session.exportSave().entries);
    const claims = histories.map((entries) =>
      entries.find(
        ({ entry }) =>
          entry.payload.kind === 'command' &&
          entry.payload.signed.body.command.type === 'CLAIM_VICTORY',
      ),
    );
    expect(
      histories.every(
        (entries) =>
          entries.filter(
            ({ entry }) =>
              entry.payload.kind === 'command' &&
              entry.payload.signed.body.command.type === 'CLAIM_VICTORY',
          ).length === 1,
      ),
    ).toBe(true);
    for (const claim of claims) {
      expect(claim?.certificate).toHaveLength(2);
      if (claim?.entry.payload.kind !== 'command') throw new Error('Missing certified claim');
      expect(claim.entry.seq).toBe(deal.entry.seq + 1);
      expect(claim.entry.payload.signed.body.headSeq).toBe(deal.entry.seq);
      expect(claim.entry.payload.signed.body.headHash).toBe(entryHash(deal.entry));
      expect(claim.entry.payload.signed.body.command).toEqual({
        type: 'CLAIM_VICTORY',
        slotIds: [slotId],
      });
      expect(claim.entry.payload.signed.body.evidence?.protocol).toBe(COMMAND_PROOFS_PROTOCOL);
    }
    expect(required(claims[0]).entry).toEqual(required(claims[1]).entry);
    expect(preparedReveals).toBe(1);
    expect(
      live.every((session) => {
        const result = session.getState()?.result;
        return result?.winner === buyer && result.reason === 'claimed-vp';
      }),
    ).toBe(true);
    expect(required(live[ownerIndex]).getPrivate(buyer)?.slots[slotId]).toBeUndefined();
    expect(required(live[1 - ownerIndex]).getPrivate(buyer)).toBeNull();
    live.forEach((session) => session.dispose());
    network.dispose();
  }, 120_000);

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
          new VerifiedSessionDriver(
            engine,
            genesis,
            owned,
            required(base.createDeckSource),
            undefined,
            fixture.createStealSourceFor(base.seat),
          ),
      });
      expect(opened).toMatchObject({ ok: false, error: { code: 'session-driver-seats' } });
      // oxlint-disable-next-line no-await-in-loop
      expect(await journal.load()).toBeNull();
    }
    const untrustedRuntimeOption = {
      countProof: () => failure('untrusted-count-proof', 'Raw callback must be ignored'),
    };
    const rawFallback = await P2PSession.create({
      ...base,
      // A raw runtime option cannot supply private count authority in place of the driver.
      ...untrustedRuntimeOption,
      createDriver: (engine, genesis, _clock, ownedSeats) => {
        const driver = new VerifiedSessionDriver(
          engine,
          genesis,
          ownedSeats,
          required(base.createDeckSource),
          undefined,
          fixture.createStealSourceFor(base.seat),
        );
        Object.defineProperty(driver, 'produceCountProof', { value: undefined });
        return driver;
      },
    });
    expect(rawFallback).toMatchObject({ ok: false, error: { code: 'replica-count-store' } });
    expect(await journal.load()).toBeNull();
    const noSecretSource = await P2PSession.create({
      ...base,
      createDriver: (engine, genesis, _clock, ownedSeats) =>
        new VerifiedSessionDriver(engine, genesis, ownedSeats, required(base.createDeckSource)),
    });
    expect(noSecretSource).toMatchObject({ ok: false, error: { code: 'steal-source' } });
    expect(await journal.load()).toBeNull();
    const wrongSecretSource = await P2PSession.create({
      ...base,
      createDriver: (engine, genesis, _clock, ownedSeats) =>
        new VerifiedSessionDriver(
          engine,
          genesis,
          ownedSeats,
          required(base.createDeckSource),
          undefined,
          (seat) =>
            createStealSecretSource(
              scalarToBytes(99n),
              genesis.ceremonyNonce,
              seat,
              required(genesis.seats.find((item) => item.seat === seat)).publicKey,
            ),
        ),
    });
    expect(wrongSecretSource).toMatchObject({ ok: false, error: { code: 'steal-source-key' } });
    expect(await journal.load()).toBeNull();
    for (const method of ['produceStealContribution', 'produceStealResponse'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- Each rejected open must leave the journal untouched.
      const stealFallback = await P2PSession.create({
        ...base,
        createDriver: (engine, genesis, _clock, ownedSeats) => {
          const driver = new VerifiedSessionDriver(
            engine,
            genesis,
            ownedSeats,
            required(base.createDeckSource),
            undefined,
            fixture.createStealSourceFor(base.seat),
          );
          Object.defineProperty(driver, method, { value: undefined });
          return driver;
        },
      });
      expect(stealFallback).toMatchObject({ ok: false, error: { code: 'replica-steal-store' } });
      // oxlint-disable-next-line no-await-in-loop
      expect(await journal.load()).toBeNull();
    }
    network.dispose();
  }, 30_000);

  test('relays a certified draw through a third human without its direct first prefix', async () => {
    const fixture = createVerifiedDeckSession(7, 3, 128, {
      boardSeed: new Uint8Array(32).fill(50),
    });
    const peers = fixture.humans.map(
      (seat) => required(fixture.simulation.identities.get(seat.seat)).peerId,
    );
    const network = createMemnet({ peers });
    const journals = peers.map(() => new MemoryProtocolJournal());
    const stores = peers.map(() => new MemoryDeckContributionStore());
    const sent: ProtocolMessage[][] = peers.map(() => []);
    const received: { from: PeerId; prefix: number }[][] = peers.map(() => []);
    let droppedDirectPrefix = 0;
    const transports = peers.map((peer, position) =>
      observe(
        network.transport(peer),
        required(sent[position]),
        (to, message) => {
          const drop =
            position === 0 &&
            to === peers[2] &&
            message.t === 'DECK_CONTRIB' &&
            message.contribution.unlocks.length === 1;
          if (drop) droppedDirectPrefix += 1;
          return drop;
        },
        (direction, message, from) => {
          if (direction === 'receive' && message.t === 'DECK_CONTRIB')
            required(received[position]).push({
              from,
              prefix: message.contribution.unlocks.length,
            });
        },
      ),
    );
    const opened = await Promise.all(
      peers.map((_, position) =>
        ReplicatedLog.create(
          optionsFor(
            fixture,
            position,
            required(transports[position]),
            network.clock,
            required(journals[position]),
            required(stores[position]),
          ),
        ),
      ),
    );
    const replicas = opened.map(value);
    await settle(replicas, network.clock);
    // Board seed 50 grants a development-card cost during legal second placements.
    const drawContext = await driveToDraw(fixture, replicas, network.clock, {
      settlementOrder: BOARD_50_SETTLEMENT_ORDER,
      minimumBuyerSeat: 2,
    });
    const decks = required(drawContext.log.crypto?.decks);
    const firstRequest = required(decks.active ?? decks.decks[0]?.slots[0]?.receipt.operation);
    expect(firstRequest.position).toBe(0);
    await settle(replicas, network.clock, 64);
    expect(droppedDirectPrefix).toBeGreaterThan(0);
    expect(
      required(received[2]).some(({ from, prefix }) => from === peers[0] && prefix === 1),
    ).toBe(false);
    expect(required(received[2]).some(({ from, prefix }) => from === peers[1] && prefix >= 2)).toBe(
      true,
    );
    const firstDeals = required(replicas[0])
      .getEntries()
      .filter(
        ({ entry }) => entry.payload.kind === 'system' && entry.payload.input.type === 'CARD_DEALT',
      );
    expect(firstDeals).toHaveLength(1);
    expect(
      required(firstDeals[0])
        .certificate.map((vote) => vote.body.seat)
        .toSorted((a, b) => a - b),
    ).toEqual([0, 1, 2]);
    const head = required(replicas[0]).getContext().log.head;
    expect(
      replicas.every((replica) => entryHash(replica.getContext().log.head) === entryHash(head)),
    ).toBe(true);
    for (const replica of replicas) {
      const deals = replica
        .getEntries()
        .filter(
          ({ entry }) =>
            entry.payload.kind === 'system' && entry.payload.input.type === 'CARD_DEALT',
        );
      expect(deals).toHaveLength(1);
      expect(
        required(deals[0])
          .certificate.map((vote) => vote.body.seat)
          .toSorted((a, b) => a - b),
      ).toEqual([0, 1, 2]);
      const deck = required(replica.getContext().log.crypto?.decks.decks[0]);
      expect(deck.nextPosition).toBe(1);
      expect(deck.slots.map((slot) => [slot.seat, slot.slotId])).toEqual([
        [firstRequest.seat, firstRequest.slotId],
      ]);
    }
    replicas.forEach((replica) => replica.dispose());
    const drawer = required(fixture.genesis.seats.find((seat) => seat.seat === firstRequest.seat));
    const ownerPeer = drawer.kind === 'bot' ? drawer.botHost : drawer.publicKey;
    const ownerIndex = peers.indexOf(ownerPeer);
    expect(ownerIndex).toBe(2);
    // One owner and the actual relay cover private visibility; all three live
    // replicas already verified the same draw, certificate and head above.
    const privatePositions = [ownerIndex, 1];
    const sessions = (
      await Promise.all(
        privatePositions.map((position) => {
          const base = optionsFor(
            fixture,
            position,
            required(transports[position]),
            network.clock,
            required(journals[position]),
            required(stores[position]),
          );
          return P2PSession.restore({
            ...base,
            createDriver: (engine, genesis, _clock, ownedSeats) =>
              new VerifiedSessionDriver(
                engine,
                genesis,
                ownedSeats,
                required(base.createDeckSource),
                undefined,
                fixture.createStealSourceFor(base.seat),
              ),
          });
        }),
      )
    ).map(value);
    const card = required(sessions[0]).getPrivate(firstRequest.seat)?.slots[firstRequest.slotId];
    expect(BASE_DEV_CARD_CATALOGUE.some((item) => item.card === card)).toBe(true);
    expect(required(sessions[1]).getPrivate(firstRequest.seat)).toBeNull();
    sessions.forEach((session) => session.dispose());
    network.dispose();
  }, 60_000);

  test.each([
    { humanCount: 1, name: 'one human hosting three consecutive bot unlockers' },
    { humanCount: 4, name: 'four human voters' },
  ])(
    'certifies a legal first draw with $name',
    async ({ humanCount }) => {
      const fixture = createVerifiedDeckSession(7, humanCount, 128, {
        boardSeed: new Uint8Array(32).fill(50),
      });
      const peers = fixture.humans.map(
        (seat) => required(fixture.simulation.identities.get(seat.seat)).peerId,
      );
      const network = createMemnet({ peers });
      const journals = peers.map(() => new MemoryProtocolJournal());
      const stores = peers.map(() => new MemoryDeckContributionStore());
      const transports = peers.map((peer) => network.transport(peer));
      const replicas = (
        await Promise.all(
          peers.map((_, position) =>
            ReplicatedLog.create(
              optionsFor(
                fixture,
                position,
                required(transports[position]),
                network.clock,
                required(journals[position]),
                required(stores[position]),
              ),
            ),
          ),
        )
      ).map(value);
      await settle(replicas, network.clock);
      await driveToDraw(fixture, replicas, network.clock, {
        settlementOrder: BOARD_50_SETTLEMENT_ORDER,
        minimumBuyerSeat: 2,
      });
      await settle(replicas, network.clock, 64);
      const first = required(replicas[0]);
      const deals = first
        .getEntries()
        .filter(
          ({ entry }) =>
            entry.payload.kind === 'system' && entry.payload.input.type === 'CARD_DEALT',
        );
      expect(deals).toHaveLength(1);
      const deal = required(deals[0]);
      const signerSeats = deal.certificate.map((vote) => vote.body.seat);
      expect(new Set(signerSeats).size).toBe(humanCount === 1 ? 1 : 3);
      expect(signerSeats.every((seat) => fixture.humans.some((human) => human.seat === seat))).toBe(
        true,
      );
      const deck = required(first.getContext().log.crypto?.decks.decks[0]);
      expect(deck.nextPosition).toBe(1);
      expect(deck.slots).toHaveLength(1);
      const slot = required(deck.slots[0]);
      const draw = slot.receipt.operation;
      expect(draw.position).toBe(0);
      expect(slot.seat).toBe(draw.seat);
      expect(slot.slotId).toBe(draw.slotId);
      const unlockSeats = slot.receipt.unlocks.map((unlock) => unlock.body.seat);
      expect(unlockSeats).toEqual([0, 1, 2, 3].filter((seat) => seat !== draw.seat));
      const headHash = entryHash(first.getContext().log.head);
      for (const replica of replicas) {
        expect(entryHash(replica.getContext().log.head)).toBe(headHash);
        expect(
          replica
            .getEntries()
            .filter(
              ({ entry }) =>
                entry.payload.kind === 'system' && entry.payload.input.type === 'CARD_DEALT',
            ),
        ).toHaveLength(1);
      }
      const botUnlockSeats = unlockSeats.filter((seat) => seat !== 0);
      const durable = [...required(stores[0]).records.entries()]
        .filter(([key]) => key.startsWith('deck-unlock/'))
        .map(([, bytes]) => canonicalDecode(bytes));
      expect(humanCount !== 1 || botUnlockSeats.length >= 2).toBe(true);
      expect(
        humanCount !== 1 ||
          botUnlockSeats.every((seat) => fixture.genesis.seats[seat]?.kind === 'bot'),
      ).toBe(true);
      expect(humanCount !== 1 || durable.length === 3).toBe(true);
      expect(humanCount === 1 ? durable : [...slot.receipt.unlocks]).toEqual(
        expect.arrayContaining([...slot.receipt.unlocks]),
      );
      replicas.forEach((replica) => replica.dispose());
      const drawer = required(fixture.genesis.seats.find((seat) => seat.seat === draw.seat));
      const ownerPeer = drawer.kind === 'bot' ? drawer.botHost : drawer.publicKey;
      const ownerIndex = peers.indexOf(ownerPeer);
      expect(ownerIndex).toBeGreaterThanOrEqual(0);
      // Restoring all four peers repeats eight full replays. Preserve owner
      // reconstruction and one foreign-seat refusal after the live quorum check.
      const privatePositions =
        humanCount === 1
          ? [ownerIndex]
          : [ownerIndex, peers.findIndex((_, index) => index !== ownerIndex)];
      const sessions = (
        await Promise.all(
          privatePositions.map((position) => {
            const base = optionsFor(
              fixture,
              position,
              required(transports[position]),
              network.clock,
              required(journals[position]),
              required(stores[position]),
            );
            return P2PSession.restore({
              ...base,
              createDriver: (engine, genesis, _clock, ownedSeats) =>
                new VerifiedSessionDriver(
                  engine,
                  genesis,
                  ownedSeats,
                  required(base.createDeckSource),
                  undefined,
                  fixture.createStealSourceFor(base.seat),
                ),
            });
          }),
        )
      ).map(value);
      for (const [index, session] of sessions.entries()) {
        const privateState = session.getPrivate(draw.seat);
        expect(
          index === 0
            ? BASE_DEV_CARD_CATALOGUE.some((card) => card.card === privateState?.slots[draw.slotId])
            : privateState === null,
        ).toBe(true);
      }
      let recoveredHand: PrivateState | null | undefined;
      if (humanCount === 1) {
        const reconstructed = value(
          reconstructPrivateSeats({
            genesisEntry: fixture.entry,
            entries: first.getEntries(),
            engine: fixture.simulation.engine,
            policy: fixture.policy,
            secrets: [{ seat: draw.seat, master: scalarToBytes(BigInt(17 + draw.seat)) }],
          }),
        );
        try {
          recoveredHand = reconstructed.driver.privateState(draw.seat);
        } finally {
          reconstructed.dispose();
        }
      }
      expect(humanCount !== 1 || drawer.kind === 'bot').toBe(true);
      expect(recoveredHand).toEqual(
        humanCount === 1 ? required(sessions[0]).getPrivate(draw.seat) : undefined,
      );
      expect(humanCount !== 1 || Boolean(recoveredHand?.slots[draw.slotId])).toBe(true);
      sessions.forEach((session) => session.dispose());
      network.dispose();
    },
    60_000,
  );

  test('gossips durable unlocks after a legal purchase and restores a dropped unlock', async () => {
    const fixture = createVerifiedDeckSession(3, 2, 128, {
      boardSeed: new Uint8Array(32).fill(50),
      ceremonyNonce: toBase64Url(new Uint8Array(32).fill(4)),
    });
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
    const missingCountProof = { ...firstOptions };
    delete missingCountProof.countProof;
    const missingCountStore = { ...firstOptions };
    delete missingCountStore.countContributionStore;
    const missingStealContribution = { ...firstOptions };
    delete missingStealContribution.stealContribution;
    const missingStealResponse = { ...firstOptions };
    delete missingStealResponse.stealResponse;
    const missingStealStore = { ...firstOptions };
    delete missingStealStore.stealDeliveryStore;
    const invalidOptions: [ReplicatedLogOptions, string][] = [
      [missingSource, 'replica-deck-store'],
      [missingStore, 'replica-deck-store'],
      [missingCountProof, 'replica-count-store'],
      [missingCountStore, 'replica-count-store'],
      [missingStealContribution, 'replica-steal-store'],
      [missingStealResponse, 'replica-steal-store'],
      [missingStealStore, 'replica-steal-store'],
      [{ ...firstOptions, botKeys: new Map() }, 'replica-bot-key'],
      [
        { ...firstOptions, botKeys: new Map([[hostedBot[0], firstOptions.secretKey]]) },
        'replica-bot-key',
      ],
    ];
    for (const [options, code] of invalidOptions) {
      // oxlint-disable-next-line no-await-in-loop -- Every rejected startup must leave the same journal empty.
      const created = await ReplicatedLog.create(options);
      expect(created.ok).toBe(false);
      expect(created).toMatchObject({
        ok: false,
        error: { code },
      });
      // oxlint-disable-next-line no-await-in-loop
      expect(await required(journals[0]).load()).toBeNull();
      expect(required(sent[0])).toHaveLength(0);
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
    const beforeDraw = await driveToDraw(fixture, [first, second], network.clock, {
      settlementOrder: BOARD_50_SETTLEMENT_ORDER,
      buyerSeat: required(fixture.humans[0]).seat,
    });
    const draw = required(beforeDraw.log.crypto?.decks.active);
    expect(draw.position).toBe(0);
    expect(draw.seat).toBe(required(fixture.humans[0]).seat);
    await settle([first, second], network.clock);
    const dropped = required(sent[0]).find((message) => message.t === 'DECK_CONTRIB');
    expect(dropped).toBeDefined();
    if (dropped?.t !== 'DECK_CONTRIB') throw new Error('Missing held deck prefix');
    expect(dropped.contribution.unlocks).toHaveLength(2);
    expect(
      required(sent[1]).some(
        (message) => message.t === 'DECK_CONTRIB' && message.contribution.unlocks.length === 1,
      ),
    ).toBe(true);
    const lastUnlock = required(dropped.contribution.unlocks.at(-1));
    const invalidPrefix: ProtocolMessage = {
      ...dropped,
      contribution: {
        ...dropped.contribution,
        unlocks: [
          ...dropped.contribution.unlocks.slice(0, -1),
          { ...lastUnlock, body: { ...lastUnlock.body, step: lastUnlock.body.step + 1 } },
        ],
      },
    };
    // One bad longer prefix spends one strike; exact retries and future operations do not.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      required(transports[1]).inject(required(peers[0]), invalidPrefix);
      required(transports[1]).inject(required(peers[0]), {
        ...dropped,
        contribution: {
          ...dropped.contribution,
          operationId: `${attempt + 1}`.repeat(64),
        },
      });
    }
    await settle([first, second], network.clock, 8);
    expect(required(transports[1]).peers()).toContain(peers[0]);
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
    for (let attempt = 0; attempt < 8; attempt += 1)
      required(transports[1]).inject(required(peers[0]), dropped);
    await settle([restored, second], network.clock, 8);
    expect(required(transports[1]).peers()).toContain(peers[0]);
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
          new VerifiedSessionDriver(
            engine,
            genesis,
            ownedSeats,
            required(base.createDeckSource),
            undefined,
            fixture.createStealSourceFor(base.seat),
          ),
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
      expect(certified.entry.payload.signed.body.evidence?.protocol).toBe(COMMAND_PROOFS_PROTOCOL);
    }
    expect(required(knightEntries[0]).entry).toEqual(required(knightEntries[1]).entry);
    expect(
      required(sessions[ownerIndex]).getPrivate(draw.seat)?.slots[draw.slotId],
    ).toBeUndefined();
    expect(required(sessions[1 - ownerIndex]).getPrivate(draw.seat)).toBeNull();
    const secondBuyer = await driveSessionToFirstPurchase(fixture, sessions, network.clock, true);
    await settle(sessions, network.clock, 64);
    const secondHistories = sessions.map((session) =>
      session
        .exportSave()
        .entries.filter(
          ({ entry }) =>
            entry.payload.kind === 'system' && entry.payload.input.type === 'CARD_DEALT',
        ),
    );
    expect(secondHistories.every((deals) => deals.length === 2)).toBe(true);
    const secondDeal = required(required(secondHistories[0])[1]);
    if (
      secondDeal.entry.payload.kind !== 'system' ||
      secondDeal.entry.payload.input.type !== 'CARD_DEALT'
    )
      throw new Error('Missing second certified development-card deal');
    expect(secondDeal.entry.payload.input.seat).toBe(secondBuyer);
    const secondSlot = secondDeal.entry.payload.input.slotId;
    if (typeof secondSlot !== 'string') throw new Error('Second deal has no slot ID');
    const secondSeat = required(fixture.genesis.seats.find((seat) => seat.seat === secondBuyer));
    const secondHost = secondSeat.kind === 'bot' ? secondSeat.botHost : secondSeat.publicKey;
    const secondOwnerIndex = peers.indexOf(secondHost);
    const secondCard = required(sessions[secondOwnerIndex]).getPrivate(secondBuyer)?.slots[
      secondSlot
    ];
    expect(BASE_DEV_CARD_CATALOGUE.some((card) => card.card === secondCard)).toBe(true);
    expect(required(sessions[1 - secondOwnerIndex]).getPrivate(secondBuyer)).toBeNull();
    expect(sessions.map((session) => session.getState())).toEqual([
      required(sessions[0]).getState(),
      required(sessions[0]).getState(),
    ]);
    sessions.forEach((session) => session.dispose());
    network.dispose();
  }, 120_000);

  test.skipIf(process.env.CP2P_DRAW_BENCH !== '1')(
    'certifies a full draw within one second across real 50 ms links',
    async () => {
      const fixture = createVerifiedDeckSession();
      const peers = fixture.humans.map(
        (seat) => required(fixture.simulation.identities.get(seat.seat)).peerId,
      );
      const runSample = async (sampleIndex: number): Promise<number> => {
        const journals = [new MemoryProtocolJournal(), new MemoryProtocolJournal()];
        const stores = [new MemoryDeckContributionStore(), new MemoryDeckContributionStore()];
        const prepNetwork = createMemnet({ peers });
        const preparing = await Promise.all(
          peers.map((peer, position) =>
            ReplicatedLog.create(
              optionsFor(
                fixture,
                position,
                prepNetwork.transport(peer),
                prepNetwork.clock,
                required(journals[position]),
                required(stores[position]),
              ),
            ),
          ),
        );
        const prepReplicas = preparing.map(value);
        try {
          await settle(prepReplicas, prepNetwork.clock);
          const beforePurchase = await driveToDraw(fixture, prepReplicas, prepNetwork.clock, {
            stopBeforePurchase: true,
          });
          expect(beforePurchase.log.crypto?.decks.active).toBeNull();
          expect(stores.every((store) => store.records.size === 0)).toBe(true);
        } finally {
          prepReplicas.forEach((replica) => replica.dispose());
          prepNetwork.dispose();
        }

        vi.resetModules();
        const firstModule = await import('./replicated-log.js');
        vi.resetModules();
        const secondModule = await import('./replicated-log.js');
        expect(firstModule.ReplicatedLog).not.toBe(secondModule.ReplicatedLog);
        const constructors = [firstModule.ReplicatedLog, secondModule.ReplicatedLog];

        const clock = wallClock();
        const network = createMemnet({ peers, clock, defaultLink: { latencyMs: 50 } });
        let started = 0;
        const timeline: string[] = [];
        const dealAt = [-1, -1];
        const mark = (position: number, detail: string) => {
          if (started > 0)
            timeline.push(`${(performance.now() - started).toFixed(1)} p${position} ${detail}`);
        };
        const sent: ProtocolMessage[][] = [[], []];
        const transports = peers.map((peer, position) =>
          observe(
            network.transport(peer),
            required(sent[position]),
            () => false,
            (direction, message) => {
              if (['DECK_CONTRIB', 'PROPOSAL', 'VOTE', 'COMMIT', 'SUBMIT'].includes(message.t))
                mark(position, `${direction} ${describeTimedMessage(message)}`);
            },
          ),
        );
        const restored: ReplicatedLog[] = [];
        let profiler: InspectorSession | null = null;
        try {
          const opened = await Promise.all(
            peers.map((peer, position) =>
              required(constructors[position]).restore({
                ...optionsFor(
                  fixture,
                  position,
                  required(transports[position]),
                  clock,
                  required(journals[position]),
                  required(stores[position]),
                ),
                onCommit: (validated) => {
                  mark(
                    position,
                    `certified ${validated.entry.payload.kind} seq=${validated.entry.seq}`,
                  );
                  if (
                    validated.entry.payload.kind === 'system' &&
                    validated.entry.payload.input.type === 'CARD_DEALT'
                  )
                    dealAt[position] = performance.now() - started;
                },
                onStatus: (status) => {
                  if (status.kind === 'rejected' || status.kind === 'halted')
                    mark(position, `status ${status.kind}/${status.code}`);
                },
              }),
            ),
          );
          restored.push(...opened.map(value));
          await Promise.all(restored.map((replica) => replica.flush()));
          const context = required(restored[0]).getContext();
          expect(context.log.crypto?.decks.active).toBeNull();
          expect(required(restored[1]).getContext().log.head.stateHash).toBe(
            context.log.head.stateHash,
          );
          const player = fixture.simulation.engine
            .getPending(context.log.state)
            .find(
              (pending) =>
                pending.kind === 'player' &&
                fixture.simulation.engine
                  .getLegalCommands(context.log.state, pending.seat)
                  .commands.some((command) => command.type === 'BUY_DEV_CARD'),
            );
          if (player?.kind !== 'player') throw new Error('Prepared prefix has no legal purchase');
          const signer = required(fixture.simulation.identities.get(player.seat));
          const holder = required(fixture.genesis.seats.find((seat) => seat.seat === player.seat));
          const hostPeer = holder.kind === 'bot' ? holder.botHost : signer.peerId;
          const hostIndex = peers.indexOf(hostPeer);
          if (hostIndex < 0) throw new Error('No host for purchase seat');
          const signed = signCommand(
            {
              gameId: fixture.genesis.gameId,
              genesisDigest: context.membership.genesisDigest,
              seat: player.seat,
              nonce: (context.log.lastNonces.get(player.seat) ?? 0) + 1,
              headSeq: context.log.head.seq,
              headHash: entryHash(context.log.head),
              command: { type: 'BUY_DEV_CARD' },
            },
            signer.secretKey,
          );
          if (process.env.CP2P_DRAW_PROFILE === '1') {
            const active = new InspectorSession();
            active.connect();
            profiler = active;
            await new Promise<void>((resolve, reject) =>
              active.post('Profiler.enable', (error) => (error ? reject(error) : resolve())),
            );
            await new Promise<void>((resolve, reject) =>
              active.post('Profiler.start', (error) => (error ? reject(error) : resolve())),
            );
          }
          const submission: { current: Result<void> | null } = { current: null };
          started = performance.now();
          void required(restored[hostIndex])
            .submit(signed)
            .then((result) => {
              submission.current = result;
              return undefined;
            });
          const dealt = () => dealAt.every((time) => time >= 0);
          while (!dealt() && performance.now() - started < 10_000) {
            // oxlint-disable-next-line no-await-in-loop -- Real timers deliver the next network packet.
            await Promise.all(restored.map((replica) => replica.flush()));
            // oxlint-disable-next-line no-await-in-loop
            await new Promise<void>((resolve) => setTimeout(resolve, 1));
          }
          const elapsedMs = performance.now() - started;
          if (profiler) {
            const active = profiler;
            const profile = await new Promise<unknown>((resolve, reject) =>
              active.post('Profiler.stop', (error, result) =>
                error ? reject(error) : resolve(result.profile),
              ),
            );
            await writeFile(
              join(tmpdir(), `cp2p-draw-profile-${sampleIndex}.json`),
              JSON.stringify(profile),
            );
            active.disconnect();
            profiler = null;
          }
          expect(dealt()).toBe(true);
          value(required(submission.current));
          expect(
            restored.every((replica) =>
              replica
                .getEntries()
                .some(
                  ({ entry }) =>
                    entry.payload.kind === 'system' && entry.payload.input.type === 'CARD_DEALT',
                ),
            ),
          ).toBe(true);
          expect(required(restored[0]).getContext().log.head.stateHash).toBe(
            required(restored[1]).getContext().log.head.stateHash,
          );
          process.stdout.write(
            `verified draw sample ${sampleIndex + 1} with 50 ms links: ${elapsedMs.toFixed(1)} ms, peers ${dealAt.map((time) => time.toFixed(1)).join('/')} ms\n`,
          );
          process.stdout.write(
            `draw timeline sample ${sampleIndex + 1}:\n${timeline.join('\n')}\n`,
          );
          return elapsedMs;
        } finally {
          profiler?.disconnect();
          restored.forEach((replica) => replica.dispose());
          network.dispose();
          clock.dispose();
        }
      };
      const samples: number[] = [];
      for (let sampleIndex = 0; sampleIndex < 3; sampleIndex++) {
        // oxlint-disable-next-line no-await-in-loop -- Samples must run without overlapping CPU work.
        samples.push(await runSample(sampleIndex));
      }
      const ordered = samples.toSorted((left, right) => left - right);
      process.stdout.write(
        `verified draw median ${required(ordered[1]).toFixed(1)} ms, worst ${required(ordered[2]).toFixed(1)} ms\n`,
      );
      expect(required(ordered[2])).toBeLessThan(1_000);
    },
    180_000,
  );
});
