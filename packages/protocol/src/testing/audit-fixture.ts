import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { scalarToBytes } from '@cp2p/crypto';
import { RESOURCES } from '@cp2p/engine';
import type { CommandShape, GameState, Pending, Result, Seat } from '@cp2p/engine';
import { createBeaconSecretSource } from '../beacon-source.js';
import { MemoryBeaconContributionStore } from '../beacon-contributions.js';
import { MemoryCheatCandidateStore } from '../cheat-candidates.js';
import { MemoryCountContributionStore } from '../count-contributions.js';
import { deckCeremonyId, genesisDeckDefinitions, validateDeckCeremony } from '../deck-genesis.js';
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
import { MemoryProtocolJournal } from '../journal.js';
import { P2PSession } from '../p2p-session.js';
import type { P2PSessionOptions } from '../p2p-session.js';
import type { CertifiedEntry } from '../proposal.js';
import type { ReplayPolicy } from '../replay.js';
import { MemoryStealDeliveryStore } from '../steal-contributions.js';
import { createStealSecretSource } from '../steal-source.js';
import type { Genesis, LogEntry } from '../types.js';
import { VerifiedSessionDriver } from '../verified-session-driver.js';
import { createGenesisDeckFixture } from './deck-fixture.js';
import { createMemnet } from './memnet.js';
import { createSimulationGenesis } from './simulation-genesis.js';
import type { VirtualClock } from './virtual-clock.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing audit fixture value');
  return item;
}

class MemoryDeckStore implements DeckContributionStore {
  private readonly values = new Map<string, Uint8Array>();
  async load(id: string): Promise<Uint8Array | null> {
    return this.values.get(id)?.slice() ?? null;
  }
  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.values.has(id)) return false;
    this.values.set(id, bytes.slice());
    return true;
  }
}

async function settleMessages(sessions: readonly P2PSession[], clock: VirtualClock, passes = 24) {
  for (let pass = 0; pass < passes; pass += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each flush schedules the next packet batch.
    await Promise.all(sessions.map((session) => session.flush()));
    clock.advanceBy(0);
    // oxlint-disable-next-line eslint/no-await-in-loop
    await Promise.resolve();
  }
  await Promise.all(sessions.map((session) => session.flush()));
}

function discard(state: GameState, seat: Seat): CommandShape {
  const holder = required(state.seats.find((item) => item.seat === seat));
  let remaining = Math.floor(holder.resources.total / 2);
  const cards = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
  for (const resource of RESOURCES) {
    cards[resource] = Math.min(holder.resources.min[resource], remaining);
    remaining -= cards[resource];
  }
  if (remaining !== 0) throw new Error('No deterministic public discard');
  return { type: 'DISCARD', cards };
}

function quietRobber(
  state: GameState,
  seat: Seat,
  legal: readonly CommandShape[],
  engine: ReturnType<typeof createSimulationGenesis>['engine'],
): CommandShape | undefined {
  return legal.find((command) => {
    if (command.type !== 'MOVE_ROBBER') return false;
    const applied = engine.apply(state, { kind: 'command', seat, command });
    return (
      applied.ok &&
      !engine
        .getPending(applied.value.state)
        .some((pending) => pending.kind === 'player' && pending.allowed.includes('STEAL'))
    );
  });
}

/** Real certified two-human game ending through a privately dealt victory card. */
export async function createTerminalAuditFixture(
  options: {
    /** Omit the VP override so the base engine uses its default ten-point target. */
    defaultVpTarget?: boolean;
    /** Deterministic test board and deck entropy overrides for focused audit scenarios. */
    boardSeed?: Uint8Array;
    ceremonyNonce?: Uint8Array;
    prioritizeDevBuy?: boolean;
    maxElapsedMs?: number;
    onProgress?: (step: number, state: GameState) => void;
    sessionOptions?: (options: P2PSessionOptions) => P2PSessionOptions;
    onSessionsReady?: (sessions: readonly P2PSession[], clock: VirtualClock) => Promise<void>;
    onTerminal?: (sessions: readonly P2PSession[], clock: VirtualClock) => Promise<void>;
    /** Let the test runner process I/O without advancing the protocol clock. */
    yieldTask?: () => Promise<void>;
    /** Test policy for legal player choices when no development purchase is available. */
    chooseCommand?: (
      host: P2PSession,
      pending: Extract<Pending, { kind: 'player' }>,
    ) => CommandShape;
  } = {},
): Promise<{
  genesisEntry: LogEntry;
  entries: CertifiedEntry[];
  engine: ReturnType<typeof createSimulationGenesis>['engine'];
  policy: ReplayPolicy;
  masters: { seat: Seat; master: Uint8Array }[];
  identities: ReturnType<typeof createSimulationGenesis>['identities'];
}> {
  async function settle(sessions: readonly P2PSession[], clock: VirtualClock, passes = 24) {
    await settleMessages(sessions, clock, passes);
    await options.yieldTask?.();
  }
  const startedAt = Date.now();
  const simulation = createSimulationGenesis({
    seed: 3,
    humanCount: 2,
    config: {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1, 2, 3],
      options: {
        base: options.defaultVpTarget
          ? { mapLayout: 'random' }
          : { mapLayout: 'random', vpTarget: 3 },
      },
    },
  });
  const boardSeed =
    options.boardSeed?.slice() ??
    fromBase64Url(createSimulationGenesis({ seed: 0, humanCount: 2 }).genesis.genesisSeed);
  const humans = simulation.genesis.seats.filter((seat) => seat.kind === 'human');
  const raw = {
    ...genesisBody(simulation.genesis),
    genesisSeed: toBase64Url(boardSeed),
    // This signed nonce gives a reproducible honest deck order.
    ceremonyNonce: toBase64Url(options.ceremonyNonce?.slice() ?? new Uint8Array(32).fill(3)),
    security: 'verified' as const,
    commitments: {},
  };
  const deck = createGenesisDeckFixture(raw, simulation.identities);
  const ceremonyId = deckCeremonyId(deck.body);
  const beaconSources = humans.map(({ seat }) => {
    const master = scalarToBytes(BigInt(17 + seat));
    try {
      return createBeaconSecretSource(master, { ceremonyId, seat }, 128);
    } finally {
      master.fill(0);
    }
  });
  const body = {
    ...deck.body,
    commitments: {
      ...deck.body.commitments,
      beaconChains: humans.map(({ seat }, index) => ({
        seat,
        length: 128,
        tip: toBase64Url(required(beaconSources[index]).initialCommitment.tip),
      })),
    },
  };
  const genesis: Genesis = {
    ...body,
    gameId: genesisId(body),
    signatures: humans.map(({ seat }) =>
      value(
        signVerifiedGenesis(
          body,
          deck.transcripts,
          seat,
          required(simulation.identities.get(seat)).secretKey,
        ),
      ),
    ),
  };
  const deckDefinition = required(value(genesisDeckDefinitions(genesis))[0]);
  const genesisState = simulation.engine.createGame(
    genesis.config,
    fromBase64Url(genesis.genesisSeed),
  );
  const first = required(simulation.identities.get(0));
  const genesisEntry = signEntry(
    {
      seq: 0,
      term: 1,
      prevHash: GENESIS_PREVIOUS_HASH,
      payload: { kind: 'genesis', genesis },
      stateHash: toHex(hashValue(genesisState)),
      sequencer: first.peerId,
    },
    first.secretKey,
  );
  const policy: ReplayPolicy = {
    genesis: {
      verifyCommitments: (candidate) => validateDeckCeremony(candidate, deck.transcripts),
    },
    entry: {},
  };
  const network = createMemnet({ peers: humans.map((seat) => seat.publicKey) });
  const sessions: P2PSession[] = [];
  const localMasters: Uint8Array[] = [];
  try {
    for (const human of humans) {
      const hosted = genesis.seats.filter(
        (seat) =>
          seat.seat === human.seat || (seat.kind === 'bot' && seat.botHost === human.publicKey),
      );
      const masters = new Map(hosted.map(({ seat }) => [seat, scalarToBytes(BigInt(17 + seat))]));
      localMasters.push(...masters.values());
      const sourceFor = (seat: Seat) => required(masters.get(seat));
      const deckSourceFor = (deckId: string, seat: Seat) => {
        if (deckId !== deckDefinition.deckId) throw new Error('Unknown fixture deck');
        return createDeckSecretSource(sourceFor(seat), deckDefinition, seat);
      };
      const sourceIndex = humans.findIndex((seat) => seat.seat === human.seat);
      const beacon = required(beaconSources[sourceIndex]);
      const sessionOptions: P2PSessionOptions = {
        genesisEntry,
        engine: simulation.engine,
        policy,
        seat: human.seat,
        secretKey: required(simulation.identities.get(human.seat)).secretKey,
        transport: network.transport(human.publicKey),
        clock: network.clock,
        journal: new MemoryProtocolJournal(),
        cheatCandidateStore: new MemoryCheatCandidateStore(),
        beaconSource: beacon.source,
        beaconContributions: new MemoryBeaconContributionStore(),
        countContributionStore: new MemoryCountContributionStore(),
        stealDeliveryStore: new MemoryStealDeliveryStore(),
        deckSetupPasses: deck.transcripts.flatMap((transcript) =>
          transcript.passes.map((pass) => ({ deckId: transcript.deckId, pass })),
        ),
        botKeys: new Map(
          hosted
            .filter((seat) => seat.kind === 'bot')
            .map(({ seat }) => [seat, required(simulation.identities.get(seat)).secretKey]),
        ),
        createDeckSource: deckSourceFor,
        deckContributions: new MemoryDeckStore(),
        createDriver: (engine, signedGenesis, _clock, owned) =>
          new VerifiedSessionDriver(
            engine,
            signedGenesis,
            owned,
            deckSourceFor,
            (seat) => createHandSecretSource(sourceFor(seat), genesisDigest(genesis), seat),
            (seat) =>
              createStealSecretSource(
                sourceFor(seat),
                genesis.ceremonyNonce,
                seat,
                required(genesis.seats.find((item) => item.seat === seat)).publicKey,
              ),
          ),
      };
      // oxlint-disable-next-line eslint/no-await-in-loop -- Start each peer after its predecessor joins.
      const opened = await P2PSession.create(
        options.sessionOptions?.(sessionOptions) ?? sessionOptions,
      );
      sessions.push(value(opened));
    }
    await options.onSessionsReady?.(sessions, network.clock);
    await settle(sessions, network.clock, 48);
    for (let step = 0; step < 500; step += 1) {
      if (options.maxElapsedMs !== undefined && Date.now() - startedAt > options.maxElapsedMs)
        throw new Error(`Audit fixture exceeded ${options.maxElapsedMs} ms at command ${step}`);
      const current = required(sessions[0]);
      const state = required(current.getState());
      if (step % 25 === 0) options.onProgress?.(step, state);
      if (state.result) {
        const entries = current.exportSave().entries.slice();
        if (!sessions.every((session) => session.exportSave().entries.length === entries.length)) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for the final certificate on both peers.
          await settle(sessions, network.clock, 24);
        }
        const completedEntries = required(sessions[0]).exportSave().entries.slice();
        if (options.onTerminal) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- The terminal hook observes the live certified sessions.
          await options.onTerminal(sessions, network.clock);
        }
        return {
          genesisEntry,
          entries: completedEntries,
          engine: simulation.engine,
          policy,
          masters: genesis.seats.map(({ seat }) => ({
            seat,
            master: scalarToBytes(BigInt(17 + seat)),
          })),
          identities: simulation.identities,
        };
      }
      const pending = required(current.getPending()).find((item) => item.kind === 'player');
      if (!pending || pending.kind !== 'player') {
        network.clock.advanceBy(2_000);
        // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for the certified system result.
        await settle(sessions, network.clock, 12);
        continue;
      }
      const owner = required(genesis.seats.find((item) => item.seat === pending.seat));
      const hostKey = owner.kind === 'bot' ? owner.botHost : owner.publicKey;
      const host = required(sessions[humans.findIndex((seat) => seat.publicKey === hostKey)]);
      const legalSet = host.getLegalCommands(pending.seat);
      const legal = legalSet.commands;
      const command =
        (options.prioritizeDevBuy === false
          ? undefined
          : legal.find((item) => item.type === 'BUY_DEV_CARD')) ??
        options.chooseCommand?.(host, pending) ??
        legal.find((item) => item.type === 'ROLL_DICE') ??
        legal.find((item) => item.type === 'END_TURN') ??
        (legalSet.templates.some((item) => item.type === 'DISCARD')
          ? discard(state, pending.seat)
          : undefined) ??
        quietRobber(state, pending.seat, legal, simulation.engine) ??
        legal.find((item) => item.type !== 'STEAL');
      if (!command) throw new Error(`No safe command at audit fixture step ${step}`);
      let completion: Result<void> | null = null;
      void host.submit(pending.seat, command).then((result) => {
        completion = result;
        return undefined;
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- The next command requires this certificate.
      await settle(sessions, network.clock);
      if (completion === null) {
        network.clock.advanceBy(2_000);
        // oxlint-disable-next-line eslint/no-await-in-loop
        await settle(sessions, network.clock);
      }
      if (completion === null) throw new Error(`Audit fixture command stalled at step ${step}`);
      value(completion);
    }
    throw new Error('No terminal certified victory within 500 commands');
  } finally {
    for (const session of sessions) session.dispose();
    for (const source of beaconSources) source.dispose();
    for (const master of localMasters) master.fill(0);
    network.dispose();
    boardSeed.fill(0);
  }
}
