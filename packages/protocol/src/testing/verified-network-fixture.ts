import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { scalarToBytes } from '@cp2p/crypto';
import type { Seat } from '@cp2p/engine';
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
import { performVerifiedNetworkAudit } from './verified-network-audit.js';
import type {
  VerifiedNetworkAuditJob,
  VerifiedNetworkAuditRequest,
} from './verified-network-audit.js';

declare const performance: { now(): number };

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
  /** Test-only settings applied before the genuine genesis is signed. */
  readonly discardLimit?: number;
  readonly turnTimer?: {
    readonly preRollSec: number;
    readonly mainSec: number;
    readonly discardSec: number;
    readonly robberSec: number;
  };
  /** Compare session-owned snapshots with terminal reconstruction and the independent audit. */
  readonly verifyLivePrivateStates?: boolean;
  readonly auditExecutor?: (request: VerifiedNetworkAuditRequest) => VerifiedNetworkAuditJob;
}

export interface VerifiedNetworkAuditTiming {
  readonly seat: Seat;
  /** Dispatches, including jobs whose results are still pending. */
  readonly invocations: number;
  /** Settled jobs, including failures and cancellation. */
  readonly completedInvocations: number;
  readonly pendingInvocations: number;
  /** Most recent dispatch time, relative to fixture creation. */
  readonly lastStartedMilliseconds: number;
  /** Sum of elapsed wall time for pending jobs, not worker CPU time. */
  readonly runningMilliseconds: number;
  readonly oldestPendingMilliseconds: number;
  /** Completed-job wall durations retain their previous meaning. */
  readonly totalMilliseconds: number;
  readonly lastMilliseconds: number;
  readonly privateComparisonInvocations: number;
  readonly privateComparisonMilliseconds: number;
}

/**
 * Real four-human verified genesis for network simulations. Sources and durable
 * in-memory outboxes are seat-scoped and remain stable for the fixture lifetime.
 */
export function createVerifiedNetworkFixture(options: VerifiedNetworkFixtureOptions) {
  const fixtureStarted = performance.now();
  const simulation = createSimulationGenesis({
    seed: options.seed,
    gameIndex: options.gameIndex ?? 0,
    humanCount: HUMAN_SEATS.length,
    config: {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [...HUMAN_SEATS],
      options: {
        base: {
          mapLayout: 'random',
          ...(options.vpTarget === undefined ? {} : { vpTarget: options.vpTarget }),
          ...(options.discardLimit === undefined ? {} : { discardLimit: options.discardLimit }),
          ...(options.turnTimer === undefined ? {} : { turnTimer: options.turnTimer }),
        },
      },
    },
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
  const auditJobs = new Set<VerifiedNetworkAuditJob>();
  const auditResults = new Set<Promise<unknown>>();
  let comparisonReserved = false;
  let auditFailure: unknown;
  const dispose = (): void => {
    for (const job of auditJobs) job.cancel();
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

    const livePrivateHashes = new Map<number, Map<Seat, string>>();
    const auditTimings = new Map<
      Seat,
      {
        invocations: number;
        completedInvocations: number;
        lastStartedMilliseconds: number;
        running: Set<{ started: number }>;
        totalMilliseconds: number;
        lastMilliseconds: number;
        privateComparisonInvocations: number;
        privateComparisonMilliseconds: number;
      }
    >();
    let repeatedPrivateSnapshots = 0;
    let checkedPrivateSequences = 0;
    const capturePrivateState = (driver: VerifiedSessionDriver, seat: Seat, seq: number) => {
      if (!options.verifyLivePrivateStates) return;
      const ownedState = driver.privateState(seat);
      if (!ownedState) throw new Error(`Missing owned private state at ${seat}/${seq}`);
      const hash = toHex(hashValue(ownedState));
      const hashes = livePrivateHashes.get(seq) ?? new Map<Seat, string>();
      const prior = hashes.get(seat);
      if (prior !== undefined) {
        if (prior !== hash) throw new Error(`Restored private state differs at ${seat}/${seq}`);
        repeatedPrivateSnapshots += 1;
      }
      hashes.set(seat, hash);
      livePrivateHashes.set(seq, hashes);
    };
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
          const timing = auditTimings.get(seat) ?? {
            invocations: 0,
            completedInvocations: 0,
            lastStartedMilliseconds: 0,
            running: new Set<{ started: number }>(),
            totalMilliseconds: 0,
            lastMilliseconds: 0,
            privateComparisonInvocations: 0,
            privateComparisonMilliseconds: 0,
          };
          auditTimings.set(seat, timing);
          const started = performance.now();
          const running = { started };
          timing.invocations++;
          timing.lastStartedMilliseconds = started - fixtureStarted;
          timing.running.add(running);
          const compare = options.verifyLivePrivateStates && !comparisonReserved;
          if (compare) {
            comparisonReserved = true;
            timing.privateComparisonInvocations++;
          }
          const snapshots = compare
            ? [...livePrivateHashes]
                .map(([seq, hashes]) => ({ seq, seats: [...hashes].toSorted(([a], [b]) => a - b) }))
                .toSorted((a, b) => a.seq - b.seq)
            : undefined;
          const privateStates = snapshots
            ? { snapshots, digest: toHex(hashValue(snapshots)) }
            : undefined;
          const request: VerifiedNetworkAuditRequest = {
            ...input,
            deckTranscripts: deck.transcripts,
            ...(privateStates ? { privateStates } : {}),
          };
          let job: VerifiedNetworkAuditJob;
          try {
            job = options.auditExecutor
              ? options.auditExecutor(request)
              : {
                  result: Promise.resolve(performVerifiedNetworkAudit(request)),
                  cancel() {},
                };
          } catch (error) {
            job = { result: Promise.reject(error), cancel() {} };
          } finally {
            for (const item of input.masters) if (item.master.byteLength) item.master.fill(0);
          }
          auditJobs.add(job);
          const result = job.result.then((value) => {
            if (privateStates) {
              if (
                value.checkedPrivateSequences !== input.entries.length + 1 ||
                value.privateStateDigest !== privateStates.digest
              )
                throw new Error('Live private comparison worker omitted certified evidence');
              checkedPrivateSequences = value.checkedPrivateSequences;
              timing.privateComparisonMilliseconds += value.privateComparisonMilliseconds;
            }
            return value.report;
          });
          auditResults.add(result);
          void result.then(
            () => finish(),
            (error: unknown) => {
              auditFailure = error;
              finish();
            },
          );
          function finish() {
            auditJobs.delete(job);
            auditResults.delete(result);
            const elapsed = performance.now() - started;
            timing.running.delete(running);
            timing.completedInvocations++;
            timing.totalMilliseconds += elapsed;
            timing.lastMilliseconds = elapsed;
          }
          return { result, cancel: () => job.cancel() };
        },
        createDriver: (engine, signedGenesis, _clock, ownedSeats) => {
          if (ownedSeats.length !== 1 || ownedSeats[0] !== seat)
            throw new RangeError(`Seat ${seat} driver may own only its human seat`);
          const driver = new VerifiedSessionDriver(
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
          capturePrivateState(driver, seat, 0);
          if (options.verifyLivePrivateStates) {
            const committed = driver.committedEntry.bind(driver);
            driver.committedEntry = (...args) => {
              const applied = committed(...args);
              if (applied.ok) capturePrivateState(driver, seat, args[0].entry.seq);
              return applied;
            };
          }
          return driver;
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
      waitForAudits: async (): Promise<void> => {
        await Promise.all(auditResults);
        if (auditFailure) throw auditFailure;
      },
      privateStateEvidence: () => ({
        capturedSequences: livePrivateHashes.size,
        capturedSnapshots: [...livePrivateHashes.values()].reduce(
          (sum, hashes) => sum + hashes.size,
          0,
        ),
        checkedSequences: checkedPrivateSequences,
        repeatedSnapshots: repeatedPrivateSnapshots,
        snapshotDigest: toHex(
          hashValue(
            [...livePrivateHashes]
              .map(([seq, hashes]) => ({
                seq,
                seats: [...hashes].toSorted(([a], [b]) => a - b),
              }))
              .toSorted((a, b) => a.seq - b.seq),
          ),
        ),
      }),
      auditTimingEvidence: (): readonly VerifiedNetworkAuditTiming[] => {
        const now = performance.now();
        return [...auditTimings]
          .map(([seat, { running, ...timing }]) => {
            const elapsed = [...running].map(({ started }) => Math.max(0, now - started));
            return {
              seat,
              ...timing,
              pendingInvocations: running.size,
              runningMilliseconds: elapsed.reduce((sum, duration) => sum + duration, 0),
              oldestPendingMilliseconds: Math.max(0, ...elapsed),
            };
          })
          .toSorted((left, right) => left.seat - right.seat);
      },
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
