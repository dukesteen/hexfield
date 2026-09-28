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
  decksReady,
  genesisDigest,
  entryHash,
  initialProposalContext,
  replayCertifiedPrefix,
  transferChangeSchema,
  validateTransferOwnedMaterial,
  P2PSession,
  prepareOnlineDisclosureGuard,
  validateDeckCeremony,
  validateGenesisOnlineStart,
  VerifiedSessionDriver,
} from '@cp2p/protocol';
import type {
  BeaconSecretProvider,
  BeaconSecretSource,
  DeckSourceFactory,
  EscrowCeremonyStore,
  Genesis,
  LobbyFreezeAgreement,
  LogEntry,
  LogContext,
  CertifiedEntry,
  ProtocolClock,
  ProtocolJournal,
  ReplayPolicy,
  GameSession,
  SessionAuditRunner,
  SignedDeckPass,
  SignedGameSeatBinding,
  Transport,
} from '@cp2p/protocol';
import {
  acquireActiveGameWriterLease,
  IndexedDbProtocolJournal,
  IndexedDbPublicSnapshotStore,
} from '@cp2p/storage';
import type { GameWriterLease } from '@cp2p/storage';
import * as v from 'valibot';
import type { OwnedSeatMaterial } from './online-credentials.js';
import { createOnlineGameTransport } from './online-game-transport.js';
import type { OnlineDeviceRoutes, OnlineGameTransport } from './online-game-transport.js';
import { createOnlineGameCandidateStore } from './online-game-candidates.js';
import { createSessionAuditRunner } from './audit-worker-client.js';
import { createOnlineGameHistoryWriter } from './online-game-history-writer.js';
import { createOnlineGameActivityWriter } from './online-game-activity.js';
import { browserEntropy, randomIndex, randomSeed } from './random.js';

type OnlineJournal = ProtocolJournal & { close(): Promise<void> };

export interface OnlineGameRuntime {
  readonly acquireLease?: typeof acquireActiveGameWriterLease;
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
  /** Immediate fatal fence for an unexpectedly lost exclusive game writer. */
  readonly onFatal?: (error: Error) => void;
  /** Reports local history-metadata persistence failures without affecting gameplay. */
  readonly onHistoryMetadataError?: (error: Error) => void;
  readonly onDeviceRoutes?: (routes: OnlineDeviceRoutes) => void;
  /** Resume preserves history; the built-in journal may initialize only an atomically proven unused slot. */
  readonly journalMode?: 'fresh-or-restore' | 'restore-only';
}

export interface OnlineGame<T extends GameSession = P2PSession> {
  readonly gameId: string;
  readonly genesis: Genesis;
  readonly seat: Seat;
  readonly session: T;
  close(): Promise<void>;
}

export class OnlineGameDisclosureError extends Error {
  constructor() {
    super('online-ceremony-disputed');
    this.name = 'OnlineGameDisclosureError';
  }
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
    signingKey: new Uint8Array(item.signingKey),
    master: new Uint8Array(item.master),
  }));
  // Opening cannot publish prepared game output until its final shared-store check.
  const openingOutput: { to: string; bytes: Uint8Array }[] = [];
  let openingBytes = 0;
  let opening = true;
  let outputStopped = false;
  let openingOverflowed = false;
  const device = input.deviceTransport;
  const send = (to: string, bytes: Uint8Array) => {
    if (outputStopped) return;
    if (!opening) {
      device.send(to, bytes);
      return;
    }
    if (openingOutput.length >= 128 || openingBytes + bytes.byteLength > 1024 * 1024) {
      openingOverflowed = true;
      return;
    }
    openingOutput.push({ to, bytes: bytes.slice() });
    openingBytes += bytes.byteLength;
  };
  const openingTransport: Transport = {
    self: device.self,
    peers: () => device.peers(),
    send,
    broadcast: (bytes) => {
      for (const peer of device.peers()) send(peer, bytes);
    },
    onMessage: (listener) => device.onMessage(listener),
    onPeerChange: (listener) => device.onPeerChange(listener),
    disconnect: (peer) => device.disconnect(peer),
  };
  let journal: OnlineJournal | null = null;
  let snapshotStore: IndexedDbPublicSnapshotStore | null = null;
  let lease: GameWriterLease | null = null;
  let transport: OnlineGameTransport | null = null;
  let session: P2PSession | null = null;
  let historyWriter: ReturnType<typeof createOnlineGameHistoryWriter> | null = null;
  let activityWriter: ReturnType<typeof createOnlineGameActivityWriter> | null = null;
  let terminalHead: { seq: number; hash: string } | null = null;
  let leaseLost = false;
  const providers = new Map<Seat, BeaconSecretProvider>();
  const checkCancelled = () => {
    if (input.signal?.aborted || leaseLost || outputStopped)
      throw new DOMException('Online game opening was cancelled', 'AbortError');
  };
  const stopOutput = () => {
    outputStopped = true;
    openingOutput.length = 0;
    openingBytes = 0;
    transport?.dispose();
  };
  input.signal?.addEventListener('abort', stopOutput, { once: true });
  const cleanup = async () => {
    stopOutput();
    input.signal?.removeEventListener('abort', stopOutput);
    historyWriter?.stop();
    activityWriter?.stop();
    try {
      session?.dispose();
      await session?.flush();
    } finally {
      await historyWriter?.flush();
      await activityWriter?.flush();
      transport?.dispose();
      for (const provider of providers.values()) provider.dispose();
      for (const item of material) {
        item.signingKey.fill(0);
        item.master.fill(0);
      }
      try {
        try {
          await snapshotStore?.close();
        } finally {
          await journal?.close();
        }
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
          const decks = validateDeckCeremony(genesis, input.transcripts, { proofs: 'structural' });
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
    if (!crypto) throw new Error('Verified game commitments are missing');
    const disclosure = prepareOnlineDisclosureGuard(genesis);
    if (!disclosure.ok) throw new Error(disclosure.error.message);
    const checkDisclosure = async () => {
      const checkedDisclosure = await disclosure.value.check(input.store);
      if (!checkedDisclosure.ok) throw new Error(checkedDisclosure.error.message);
      if (checkedDisclosure.value) throw new OnlineGameDisclosureError();
      checkCancelled();
    };
    await checkDisclosure();
    const humans = material.filter((seat) => seat.kind === 'human');
    const local = humans[0];
    if (humans.length !== 1 || !local) throw new Error('Stored material needs one human seat');
    lease = await (runtime.acquireLease ?? acquireActiveGameWriterLease)(genesis.gameId, {
      onLost(error) {
        leaseLost = true;
        transport?.dispose();
        session?.dispose();
        try {
          input.onFatal?.(error);
        } catch {
          // Reporting failure cannot restore authority or resume output.
        }
      },
    });
    checkCancelled();
    if (!lease) throw new Error('This game is already active in another tab');
    const digest = genesisDigest(genesis);
    const keyBinding = {
      recordKey: `online-game/${digest}/keys`,
      bytes: canonicalEncode({
        protocol: 'online-game-keys-v1',
        genesisDigest: digest,
        devicePeer: input.deviceTransport.self,
        humanSeat: local.seat,
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
    // Vault-bound journals use an injected factory but still have the same durable public cache.
    if (journal instanceof IndexedDbProtocolJournal)
      snapshotStore = new IndexedDbPublicSnapshotStore(genesis.gameId);
    const saved = await journal.load();
    checkCancelled();
    if (saved && entryHash(saved.genesis) !== entryHash(input.entry))
      throw new Error('Stored game history differs from the certified online start');
    let installed: LogContext | null =
      checked.value.log.authority?.controllers.find((seat) => seat.seat === local.seat)
        ?.publicKey === local.peerId
        ? checked.value.log
        : null;
    let priorKey = checked.value.log.authority?.controllers.find(
      (seat) => seat.seat === local.seat,
    )?.publicKey;
    const replayed = saved
      ? replayCertifiedPrefix(
          saved.genesis,
          saved.entries,
          input.engine,
          policy,
          (_entry, next) => {
            if (!terminalHead && next.log.state.result)
              terminalHead = { seq: next.log.head.seq, hash: entryHash(next.log.head) };
            const key = next.log.authority?.controllers.find(
              (seat) => seat.seat === local.seat,
            )?.publicKey;
            if (key !== priorKey && key === local.peerId) installed = next.log;
            priorKey = key;
            return success(undefined);
          },
        )
      : success({ context: checked.value });
    if (!replayed.ok) throw new Error(replayed.error.message);
    const current = replayed.value.context.log;
    if (!installed) throw new Error('Stored game key has no certified owning generation');
    // The durable binding contains exactly the seats installed with this human
    // key. Later recovery adds separately persisted bots; a return can retire one.
    if (current.crypto && decksReady(current.crypto.decks)) {
      const ownedMaterial = validateTransferOwnedMaterial(
        {
          protocol: 'online-game-keys-v1',
          genesisDigest: digest,
          devicePeer: input.deviceTransport.self,
          humanSeat: local.seat,
          seats: material,
        },
        { ...installed, crypto: current.crypto },
      );
      if (!ownedMaterial.ok) throw new Error(ownedMaterial.error.message);
      for (const seat of ownedMaterial.value.seats) {
        seat.signingKey.fill(0);
        seat.master.fill(0);
      }
    } else {
      // Before certified deck setup only the original frozen owners can open.
      // Driver/source checks below validate the available deck and beacon data.
      const owned = genesis.seats.filter(
        (seat) =>
          seat.seat === local.seat || (seat.kind === 'bot' && seat.botHost === local.peerId),
      );
      if (
        installed.head.seq !== 0 ||
        material.length !== owned.length ||
        material.some(
          (item, index) =>
            item.seat !== owned[index]?.seat ||
            item.kind !== owned[index]?.kind ||
            item.peerId !== owned[index]?.publicKey,
        )
      )
        throw new Error('Stored game keys differ from the frozen device-owned seats');
      for (const item of material) {
        const identity = identityFromSecret(item.signingKey);
        try {
          if (
            identity.peerId !== item.peerId ||
            encodePoint(scalePoint(G, scalarFromBytes(item.master, { nonzero: true }))) !==
              startup.value.bindings.masters.find((entry) => entry.seat === item.seat)?.masterPub
          )
            throw new Error('Stored game secrets do not match the certified identity');
        } finally {
          identity.secretKey.fill(0);
        }
      }
    }
    const projection = createOnlineGameTransport({
      deviceTransport: openingTransport,
      validatedGenesis: { genesis, state },
      agreement: input.agreement,
      bindings: input.bindings,
      certifiedHistory: {
        genesisEntry: input.entry,
        entries: saved?.entries ?? [],
        engine: input.engine,
        policy,
      },
    });
    if (!projection.ok) throw new Error(projection.error.message);
    transport = projection.value;
    const human = current.authority?.controllers.find(
      (seat) => seat.seat === local.seat && seat.kind === 'human' && seat.status === 'active',
    );
    if (!human || human.publicKey !== local.peerId || transport.self !== local.peerId)
      throw new Error('The stored human key no longer controls this seat');
    const activeMaterial = material.filter((item) =>
      current.authority?.controllers.some(
        (seat) =>
          seat.seat === item.seat &&
          seat.kind === item.kind &&
          seat.status === 'active' &&
          seat.hostSeat === human.seat &&
          seat.publicKey === item.peerId,
      ),
    );
    const ownedMaterial = new Map(activeMaterial.map((item) => [item.seat, item]));
    // The journal retains the exact installing-generation binding. Working
    // secrets belong only to the seats still controlled at the restored head.
    for (const item of material) {
      if (ownedMaterial.has(item.seat)) continue;
      item.signingKey.fill(0);
      item.master.fill(0);
    }
    const masterFor = (seat: Seat) => {
      const entry = ownedMaterial.get(seat);
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
      const owner = genesis.seats.find((item) => item.seat === seat);
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
    providers.set(human.seat, beacon);
    if (toBase64Url(beacon.initialCommitment.tip) !== chain.tip)
      throw new Error('Stored master differs from the frozen beacon chain');
    const beaconSources = new Map<Seat, BeaconSecretSource>();
    for (const item of activeMaterial) {
      if (item.kind !== 'bot') continue;
      const originalChain = crypto.beacon.chains.find((candidate) => candidate.seat === item.seat);
      if (!originalChain) {
        if (genesis.seats.find((seat) => seat.seat === item.seat)?.kind === 'bot') continue;
        throw new Error('Missing hosted-seat beacon commitment');
      }
      const provider = createBeaconSecretSource(
        item.master,
        { ceremonyId: deckCeremonyId(genesis), seat: item.seat },
        originalChain.length,
      );
      providers.set(item.seat, provider);
      if (toBase64Url(provider.initialCommitment.tip) !== originalChain.tip)
        throw new Error('Hosted master differs from the frozen beacon chain');
      beaconSources.set(item.seat, provider.source);
    }
    const bot = new RandomBot();
    const botKeys = new Map(
      activeMaterial
        .filter((item) => item.kind === 'bot')
        .map((item) => [item.seat, item.signingKey]),
    );
    const publicSnapshots = snapshotStore;
    const options = {
      genesisEntry: input.entry,
      engine: input.engine,
      policy,
      seat: human.seat,
      secretKey: local.signingKey,
      transport,
      clock: input.clock,
      journal,
      ...(publicSnapshots
        ? { savePublicSnapshot: (snapshot: unknown) => publicSnapshots.saveCommitted(snapshot) }
        : {}),
      onCertifiedNonMembershipCommit(head: { readonly seq: number; readonly hash: string }) {
        const pruned = projection.value.pruneRetired(head);
        if (pruned.ok && pruned.value) {
          const routes = projection.value.deviceRoutes();
          if (routes) input.onDeviceRoutes?.(routes);
        }
        return pruned.ok ? success(undefined) : pruned;
      },
      onMembershipCommitted(entries: readonly CertifiedEntry[]) {
        const routed = projection.value.advanceCertifiedHistory(entries);
        const payload = entries.at(-1)?.entry.payload;
        const transfer =
          payload?.kind === 'membership' ? v.safeParse(transferChangeSchema, payload.change) : null;
        const replacements =
          transfer?.success && transfer.output.kind === 'transfer-activate'
            ? transfer.output.statement.replacements
            : [];
        const retired = !routed.ok && routed.error.code === 'online-transport-retired';
        if (routed.ok) {
          const routes = projection.value.deviceRoutes();
          if (routes) input.onDeviceRoutes?.(routes);
        }
        for (const item of material) {
          if (
            !retired &&
            !replacements.some(
              (replacement) =>
                replacement.seat === item.seat && replacement.oldPublicKey === item.peerId,
            )
          )
            continue;
          item.signingKey.fill(0);
          item.master.fill(0);
          ownedMaterial.delete(item.seat);
          providers.get(item.seat)?.dispose();
          providers.delete(item.seat);
        }
        // The final commit was sent with the old route. Retirement disposes this
        // immutable signer/transport; the destination opens a fresh instance.
        return retired ? success(undefined) : routed;
      },
      botKeys,
      botDelayMs: input.botDelayMs ?? 800,
      decideBot: (
        view: Parameters<RandomBot['decide']>[0],
        pending: Parameters<RandomBot['decide']>[1],
      ) => bot.decide(view, pending, { int: (max) => randomIndex(browserEntropy, max) }),
      beaconSource: beacon.source,
      beaconSources,
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
      transferPrivateOutbox: input.store,
      transferPrivateImportStore: input.store,
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
          const item = ownedMaterial.get(seat);
          return item ? new Uint8Array(item.master) : null;
        },
      },
      auditRunner: runtime.auditRunner ?? createSessionAuditRunner(),
    };
    // The built-in journal returns null only when genesis, entries, safety and
    // its bound voting-key record are all absent in one IndexedDB transaction.
    // Injected journals have no equivalent proof and must remain restore-only.
    if (input.journalMode === 'restore-only' && !saved && runtime.createJournal)
      throw new Error('The certified online game journal is missing');
    await checkDisclosure();
    const opened = await lease.run(() => {
      checkCancelled();
      return saved ? P2PSession.restore(options) : P2PSession.create(options);
    });
    if (!opened.ok) throw new Error(opened.error.message);
    session = opened.value;
    checkCancelled();
    // Evidence insertion uses this attempt lock. This callback only loads and
    // sends synchronously; it does not acquire another ceremony or writer lock.
    await input.store.withCeremonyLock(disclosure.value.attemptId, async () => {
      await checkDisclosure();
      checkCancelled();
      if (openingOverflowed) throw new Error('Online opening output exceeds its bounded queue');
      for (const output of openingOutput) {
        checkCancelled();
        try {
          device.send(output.to, output.bytes);
        } catch {
          // Match GameKeyTransport's lossy-send contract for disconnected peers.
        }
      }
      openingOutput.length = 0;
      openingBytes = 0;
      opening = false;
    });
    historyWriter = createOnlineGameHistoryWriter({
      store: input.store,
      gameId: genesis.gameId,
      genesisDigest: digest,
      session,
      localHumanSeat: human.seat,
      terminalHead,
      ...(input.onHistoryMetadataError ? { onError: input.onHistoryMetadataError } : {}),
    });
    activityWriter = createOnlineGameActivityWriter({
      store: input.store,
      gameId: genesis.gameId,
      genesisDigest: digest,
      session,
      ...(input.onHistoryMetadataError ? { onError: input.onHistoryMetadataError } : {}),
    });
    const routes = projection.value.deviceRoutes();
    if (routes) input.onDeviceRoutes?.(routes);
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
