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
