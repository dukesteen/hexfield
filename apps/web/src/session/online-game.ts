import { canonicalDecode, canonicalEncode, toBase64Url } from '@cp2p/codec';
import { G, encodePoint, identityFromSecret, scalarFromBytes, scalePoint } from '@cp2p/crypto';
import { RandomBot } from '@cp2p/bots';
import { success } from '@cp2p/engine';
import type { Engine, Seat } from '@cp2p/engine';
import {
  createBeaconSecretSource,
  createDeckSecretSource,
  createHandSecretSource,
  createStealSecretSource,
  deckCeremonyId,
  genesisDigest,
  initialProposalContext,
  P2PSession,
  validateDeckCeremony,
  validateGenesisOnlineStart,
  VerifiedSessionDriver,
} from '@cp2p/protocol';
import type {
  BeaconSecretProvider,
  DeckSourceFactory,
  EscrowCeremonyStore,
  Genesis,
  LobbyFreezeAgreement,
  LogEntry,
  ProtocolClock,
  ProtocolJournal,
  ReplayPolicy,
  SessionAuditRunner,
  SignedDeckPass,
  SignedGameSeatBinding,
  Transport,
} from '@cp2p/protocol';
import { acquireGameWriterLease, IndexedDbProtocolJournal } from '@cp2p/storage';
import type { GameWriterLease } from '@cp2p/storage';
import type { OwnedSeatMaterial } from './online-credentials.js';
import { createOnlineGameTransport } from './online-game-transport.js';
import type { OnlineGameTransport } from './online-game-transport.js';
import { createOnlineGameCandidateStore } from './online-game-candidates.js';
import { createSessionAuditRunner } from './audit-worker-client.js';
import { browserEntropy, randomIndex, randomSeed } from './random.js';

type OnlineJournal = ProtocolJournal & { close(): Promise<void> };

export interface OnlineGameRuntime {
  readonly acquireLease?: typeof acquireGameWriterLease;
  readonly createJournal?: (
    gameId: string,
    keyBinding: { recordKey: string; bytes: Uint8Array },
  ) => OnlineJournal;
  readonly auditRunner?: SessionAuditRunner;
}

export interface OnlineGameInput {
  readonly entry: LogEntry;
  readonly transcripts: readonly { deckId: string; passes: readonly SignedDeckPass[] }[];
  readonly agreement: LobbyFreezeAgreement;
  readonly bindings: readonly SignedGameSeatBinding[];
  readonly material: readonly OwnedSeatMaterial[];
  readonly deviceTransport: Transport;
  readonly store: EscrowCeremonyStore;
  readonly clock: ProtocolClock;
  readonly engine: Engine;
  readonly botDelayMs?: number;
  readonly signal?: AbortSignal;
  /** Resume preserves history; the built-in journal may initialize only an atomically proven unused slot. */
  readonly journalMode?: 'fresh-or-restore' | 'restore-only';
}

export interface OnlineGame {
  readonly gameId: string;
  readonly genesis: Genesis;
  readonly seat: Seat;
  readonly session: P2PSession;
  close(): Promise<void>;
}

/** Opens only an authenticated, fully verified ceremony result under an exclusive game writer. */
export async function openOnlineGame(
  supplied: OnlineGameInput,
  runtime: OnlineGameRuntime = {},
): Promise<OnlineGame> {
  // Retain detached public evidence across asynchronous lease and storage work.
  const input = {
    ...supplied,
    entry: copyEvidence(supplied.entry),
    transcripts: copyEvidence(supplied.transcripts),
    agreement: copyEvidence(supplied.agreement),
    bindings: copyEvidence(supplied.bindings),
  };
  const material = input.material.map((item) => ({
    ...item,
    signingKey: item.signingKey.slice(),
    master: item.master.slice(),
  }));
  let journal: OnlineJournal | null = null;
  let lease: GameWriterLease | null = null;
  let transport: OnlineGameTransport | null = null;
  let session: P2PSession | null = null;
  const providers: BeaconSecretProvider[] = [];
  const checkCancelled = () => {
    if (input.signal?.aborted)
      throw new DOMException('Online game opening was cancelled', 'AbortError');
  };
  const stopOutput = () => transport?.dispose();
  input.signal?.addEventListener('abort', stopOutput, { once: true });
  const cleanup = async () => {
    input.signal?.removeEventListener('abort', stopOutput);
    try {
      session?.dispose();
      await session?.flush();
    } finally {
      transport?.dispose();
      for (const provider of providers) provider.dispose();
      for (const item of material) {
        item.signingKey.fill(0);
        item.master.fill(0);
      }
      try {
        await journal?.close();
      } finally {
        await lease?.close();
      }
    }
  };
  try {
    checkCancelled();
    const policy: ReplayPolicy = {
      genesis: {
        verifyCommitments(genesis) {
          const decks = validateDeckCeremony(genesis, input.transcripts);
          return decks.ok ? success(undefined) : decks;
        },
      },
      entry: {},
    };
    const checked = initialProposalContext(input.entry, input.engine, policy);
    if (!checked.ok) throw new Error(checked.error.message);
    const { genesis, state, crypto } = checked.value.log;
    const startup = validateGenesisOnlineStart(genesis);
    if (!startup.ok) throw new Error(startup.error.message);
    const projection = createOnlineGameTransport({
      deviceTransport: input.deviceTransport,
      validatedGenesis: { genesis, state },
      agreement: input.agreement,
      bindings: input.bindings,
    });
    if (!projection.ok) throw new Error(projection.error.message);
    transport = projection.value;
    checkCancelled();
    const human = genesis.seats.find(
      (seat) => seat.kind === 'human' && seat.publicKey === transport?.self,
    );
    if (!human || human.kind !== 'human' || !crypto)
      throw new Error('The device does not own a verified human game seat');
    const owned = genesis.seats.filter(
      (seat) =>
        seat.seat === human.seat || (seat.kind === 'bot' && seat.botHost === human.publicKey),
    );
    if (
      material.length !== owned.length ||
      material.some(
        (item, index) => item.seat !== owned[index]?.seat || item.kind !== owned[index]?.kind,
      )
    )
      throw new Error('Stored game keys differ from the frozen device-owned seats');
    for (const item of material) {
      const owner = owned.find((seat) => seat.seat === item.seat);
      const master = startup.value.bindings.masters.find((entry) => entry.seat === item.seat);
      const identity = identityFromSecret(item.signingKey);
      try {
        if (
          identity.peerId !== item.peerId ||
          identity.peerId !== owner?.publicKey ||
          encodePoint(scalePoint(G, scalarFromBytes(item.master, { nonzero: true }))) !==
            master?.masterPub
        )
          throw new Error('Stored game secrets do not match the certified identity');
      } finally {
        identity.secretKey.fill(0);
      }
    }
    const local = material.find((item) => item.seat === human.seat);
    if (!local) throw new Error('The local game key is missing');
    lease = await (runtime.acquireLease ?? acquireGameWriterLease)(genesis.gameId, human.publicKey);
    checkCancelled();
    if (!lease) throw new Error('This game is already active in another tab');
    const digest = genesisDigest(genesis);
    const keyBinding = {
      recordKey: `online-game/${digest}/keys`,
      bytes: canonicalEncode({
        protocol: 'online-game-keys-v1',
        genesisDigest: digest,
        devicePeer: input.deviceTransport.self,
        humanSeat: human.seat,
        seats: material,
      }),
    };
    try {
      journal = runtime.createJournal
        ? runtime.createJournal(genesis.gameId, keyBinding)
        : new IndexedDbProtocolJournal(genesis.gameId, { keyBinding });
    } finally {
      keyBinding.bytes.fill(0);
    }
    const masterFor = (seat: Seat) => {
      const entry = material.find((item) => item.seat === seat);
      if (!entry) throw new Error('Cannot derive secrets for another device');
      return entry.master;
    };
    const deckSource: DeckSourceFactory = (deckId, seat) => {
      const definition = crypto.decks.decks.find(
        (deck) => deck.commitment.definition.deckId === deckId,
      )?.commitment.definition;
      if (!definition) throw new Error('Unknown verified deck');
      return createDeckSecretSource(masterFor(seat), definition, seat);
    };
    const stealSource = (seat: Seat) => {
      const owner = owned.find((item) => item.seat === seat);
      if (!owner) throw new Error("Cannot derive another device's encryption key");
      return createStealSecretSource(masterFor(seat), genesis.ceremonyNonce, seat, owner.publicKey);
    };
    const chain = crypto.beacon.chains.find((item) => item.seat === human.seat);
    if (!chain) throw new Error('Missing human beacon commitment');
    const beacon = createBeaconSecretSource(
      local.master,
      { ceremonyId: deckCeremonyId(genesis), seat: human.seat },
      chain.length,
    );
    providers.push(beacon);
    if (toBase64Url(beacon.initialCommitment.tip) !== chain.tip)
      throw new Error('Stored master differs from the frozen beacon chain');
    const bot = new RandomBot();
    const botKeys = new Map(
      material.filter((item) => item.kind === 'bot').map((item) => [item.seat, item.signingKey]),
    );
    const options = {
      genesisEntry: input.entry,
      engine: input.engine,
      policy,
      seat: human.seat,
      secretKey: local.signingKey,
      transport,
      clock: input.clock,
      journal,
      botKeys,
      botDelayMs: input.botDelayMs ?? 800,
      decideBot: (
        view: Parameters<RandomBot['decide']>[0],
        pending: Parameters<RandomBot['decide']>[1],
      ) => bot.decide(view, pending, { int: (max) => randomIndex(browserEntropy, max) }),
      beaconSource: beacon.source,
      beaconContributions: input.store,
      deckSetupPasses: input.transcripts.flatMap(({ deckId, passes }) =>
        passes.map((pass) => ({ deckId, pass })),
      ),
      createDeckSource: deckSource,
      deckContributions: input.store,
      countContributionStore: input.store,
      stealDeliveryStore: input.store,
      cheatCandidateStore: createOnlineGameCandidateStore(input.store, digest),
      recoveryStore: input.store,
      recoveryParticipant: {
        store: input.store,
        privateEntropy: () => randomSeed(browserEntropy),
        encryptionSecret: () => {
          const source = stealSource(human.seat);
          try {
            return source.encryptionSecret();
          } finally {
            source.dispose();
          }
        },
      },
      createDriver: (
        engine: Engine,
        approved: Genesis,
        _clock: ProtocolClock,
        seats: readonly Seat[],
      ) =>
        new VerifiedSessionDriver(
          engine,
          approved,
          seats,
          deckSource,
          (seat) => createHandSecretSource(masterFor(seat), digest, seat),
          stealSource,
        ),
      masterReveal: {
        store: input.store,
        async loadOwnedMaster(seat: Seat) {
          return material.find((item) => item.seat === seat)?.master.slice() ?? null;
        },
      },
      auditRunner: runtime.auditRunner ?? createSessionAuditRunner(),
    };
    const saved = await journal.load();
    checkCancelled();
    // The built-in journal returns null only when genesis, entries, safety and
    // its bound voting-key record are all absent in one IndexedDB transaction.
    // Injected journals have no equivalent proof and must remain restore-only.
    if (input.journalMode === 'restore-only' && !saved && runtime.createJournal)
      throw new Error('The certified online game journal is missing');
    const opened = await lease.run(() => {
      checkCancelled();
      return saved ? P2PSession.restore(options) : P2PSession.create(options);
    });
    if (!opened.ok) throw new Error(opened.error.message);
    session = opened.value;
    checkCancelled();
    let closing: Promise<void> | null = null;
    return {
      gameId: genesis.gameId,
      genesis,
      seat: human.seat,
      session,
      close() {
        closing ??= Promise.resolve().then(cleanup);
        return closing;
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function copyEvidence<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The same canonical value is detached here and validated before use.
  return canonicalDecode(canonicalEncode(value)) as T;
}
