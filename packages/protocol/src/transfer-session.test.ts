import {
  canonicalDecode,
  canonicalEncode,
  fromBase64Url,
  hashValue,
  toBase64Url,
  toHex,
} from '@cp2p/codec';
import {
  G,
  encodePoint,
  identityFromSecret,
  parsePeerId,
  scalarToBytes,
  scalePoint,
  signObject,
  verifyObject,
} from '@cp2p/crypto';
import { success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { createBeaconSecretSource } from './beacon-source.js';
import { MemoryBeaconContributionStore } from './beacon-contributions.js';
import { MemoryCheatCandidateStore } from './cheat-candidates.js';
import { MemoryCountContributionStore } from './count-contributions.js';
import { createConsensusState } from './consensus.js';
import { deckCeremonyId } from './deck-genesis.js';
import { createDeckSecretSource } from './deck-source.js';
import {
  entryHash,
  genesisBody,
  genesisDigest,
  genesisId,
  GENESIS_PREVIOUS_HASH,
  signEntry,
  signVerifiedGenesis,
} from './genesis.js';
import { MemoryGenesisConsentStore } from './genesis-outbox.js';
import { createHandSecretSource } from './hand-source.js';
import { MemoryProtocolJournal } from './journal.js';
import { decodeProtocolMessage, encodeProtocolMessage } from './messages.js';
import { P2PSession } from './p2p-session.js';
import type { P2PSessionOptions } from './p2p-session.js';
import { proposerFor } from './proposal.js';
import { initialProposalContext } from './replay.js';
import type { ReplayPolicy } from './replay.js';
import { restoreRetiredSafety } from './retired-safety.js';
import { MemoryStealDeliveryStore } from './steal-contributions.js';
import { createStealSecretSource } from './steal-source.js';
import { createGenesisDeckFixture } from './testing/deck-fixture.js';
import { createMemnet } from './testing/memnet.js';
import {
  advanceRecoveryFixture,
  certifyRecoveryFixtureEntry,
  createRecoveryFixture,
  recoveryFixtureKey,
  recoveryFixtureReadiness,
  recoveryFixtureReplacement,
  signRecoveryFixtureActivation,
  signRecoveryFixtureAuthorization,
  signRecoveryFixtureEntry,
} from './testing/recovery-fixture.js';
import { createSimulationGenesis } from './testing/simulation-genesis.js';
import {
  TRANSFER_BOT_CHECK_DOMAIN,
  TRANSFER_BOT_KEY_DOMAIN,
  TRANSFER_DESTINATION_CHECK_DOMAIN,
  TRANSFER_DEVICE_DOMAIN,
  TRANSFER_GAME_KEY_DOMAIN,
  TRANSFER_OWNER_GAME_DOMAIN,
  transferCheckDigest,
  transferEntryRef,
} from './transfer-readiness.js';
import type { SeatTransferAuthorizationStatement } from './transfer-types.js';
import { VerifiedSessionDriver } from './verified-session-driver.js';
import type { CertifiedEntry, ProposalContext } from './proposal.js';
import type { Genesis } from './types.js';
import { signVote } from './votes.js';

const humans = [0, 1, 2] as const;
const master = (seat: Seat) => scalarToBytes(BigInt(17 + seat));

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing transfer session fixture');
  return item;
}

function verifiedHostedBotFixture() {
  const source = createSimulationGenesis({ seed: 94, humanCount: 3 });
  const base = { ...genesisBody(source.genesis), security: 'verified' as const, commitments: {} };
  const deck = createGenesisDeckFixture(base, source.identities);
  const beaconChains = humans.map((seat) => {
    const provider = createBeaconSecretSource(
      master(seat),
      { ceremonyId: deckCeremonyId(deck.body), seat },
      2,
    );
    try {
      return { seat, length: 2, tip: toBase64Url(provider.initialCommitment.tip) };
    } finally {
      provider.dispose();
    }
  });
  const body = {
    ...deck.body,
    commitments: { ...deck.body.commitments, beaconChains },
  };
  const genesis: Genesis = {
    ...body,
    gameId: genesisId(body),
    signatures: humans.map((seat) =>
      value(
        signVerifiedGenesis(
          body,
          deck.transcripts,
          seat,
          required(source.identities.get(seat)).secretKey,
        ),
      ),
    ),
  };
  const state = source.engine.createGame(genesis.config, fromBase64Url(genesis.genesisSeed));
  const genesisEntry = signEntry(
    {
      seq: 0,
      term: 1,
      prevHash: GENESIS_PREVIOUS_HASH,
      payload: { kind: 'genesis', genesis },
      stateHash: toHex(hashValue(state)),
      sequencer: required(source.identities.get(0)).peerId,
    },
    required(source.identities.get(0)).secretKey,
  );
  const policy: ReplayPolicy = {
    genesis: { verifyCommitments: () => success(undefined) },
    entry: { verifySystem: () => success(undefined), verifyCommand: () => success(undefined) },
  };
  const beforeSetup = value(initialProposalContext(genesisEntry, source.engine, policy));
  const fixture = { source, genesis, genesisEntry, policy, beforeSetup };
  const deckEntries: CertifiedEntry[] = [];
  let context = beforeSetup;
  for (const transcript of deck.transcripts) {
    for (const pass of transcript.passes) {
      const entry = signRecoveryFixtureEntry(
        fixture,
        context,
        { kind: 'crypto', action: 'deck-pass', evidence: { deckId: transcript.deckId, pass } },
        context.log.head.stateHash,
      );
      const certified = certifyRecoveryFixtureEntry(fixture, context, entry, humans);
      context = advanceRecoveryFixture(context, certified);
      deckEntries.push(certified);
    }
  }
  expect(context.log.crypto?.beacon.active).not.toBeNull();
  expect(context.log.crypto?.beacon.chains.map(({ seat }) => seat)).toEqual(humans);
  expect(genesis.seats[3]?.kind).toBe('bot');
  return { ...fixture, deckEntries, ready: context };
}

async function journalAt(
  fixture: Pick<ReturnType<typeof verifiedHostedBotFixture>, 'beforeSetup' | 'genesisEntry'>,
  seat: Seat,
  entries: readonly CertifiedEntry[],
): Promise<MemoryProtocolJournal> {
  const journal = new MemoryProtocolJournal();
  let context: ProposalContext = fixture.beforeSetup;
  expect(
    await journal.initialize(
      fixture.genesisEntry,
      canonicalEncode(value(createConsensusState(context, seat))),
    ),
  ).toBe(true);
  for (const certified of entries) {
    const next = advanceRecoveryFixture(context, certified);
    expect(
      // oxlint-disable-next-line no-await-in-loop -- Every journal commit depends on the preceding certified head.
      await journal.commit(
        certified.entry.seq,
        0,
        certified,
        canonicalEncode(value(createConsensusState(next, seat))),
      ),
    ).toBe(true);
    context = next;
  }
  return journal;
}

test('fresh destination restores inherited bot without a bot beacon chain and certifies its action', async () => {
  const fixture = verifiedHostedBotFixture();
  const controller = required(fixture.ready.log.authority?.controllers[0]);
  const bot = required(fixture.ready.log.authority?.controllers[3]);
  const device = identityFromSecret(new Uint8Array(32).fill(141));
  const game = identityFromSecret(new Uint8Array(32).fill(142));
  const botGame = identityFromSecret(new Uint8Array(32).fill(143));
  const statement: SeatTransferAuthorizationStatement = {
    protocol: 'seat-transfer-v1',
    genesisDigest: genesisDigest(fixture.genesis),
    anchor: transferEntryRef(fixture.ready.log.head),
    validUntilSeq: fixture.ready.log.head.seq + 64,
    mode: 'live',
    seat: 0,
    currentController: {
      publicKey: controller.publicKey,
      kind: controller.kind,
      activatedAt: controller.activatedAt,
      hostSeat: controller.hostSeat,
    },
    recovery: null,
    nextEpoch: fixture.ready.membership.epoch + 1,
    destination: {
      devicePeer: device.peerId,
      gamePeer: game.peerId,
      transferEncryptionKey: encodePoint(scalePoint(G, 144n)),
    },
    replacements: [
      { seat: 0, oldPublicKey: controller.publicKey, newPublicKey: game.peerId, newHostSeat: 0 },
      { seat: 3, oldPublicKey: bot.publicKey, newPublicKey: botGame.peerId, newHostSeat: 0 },
    ],
  };
  const authorization = {
    kind: 'transfer-authorize' as const,
    statement,
    destinationDeviceSig: signObject(TRANSFER_DEVICE_DOMAIN, statement, device.secretKey),
    destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, statement, game.secretKey),
    replacementKeySigs: [
      { seat: 3, sig: signObject(TRANSFER_BOT_KEY_DOMAIN, statement, botGame.secretKey) },
    ],
    ownerIntent: {
      signer: 'current-game' as const,
      sig: signObject(
        TRANSFER_OWNER_GAME_DOMAIN,
        statement,
        required(fixture.source.identities.get(0)).secretKey,
      ),
    },
  };
  const authEntry = signRecoveryFixtureEntry(
    fixture,
    fixture.ready,
    { kind: 'membership', change: authorization },
    fixture.ready.log.head.stateHash,
  );
  const certifiedAuth = certifyRecoveryFixtureEntry(fixture, fixture.ready, authEntry, humans);
  const authorized = advanceRecoveryFixture(fixture.ready, certifiedAuth);
  const authRef = transferEntryRef(authEntry);
  const activationStatement = {
    protocol: 'seat-transfer-activation-v1' as const,
    genesisDigest: authorized.membership.genesisDigest,
    authorization: authRef,
    parent: authRef,
    nextEpoch: statement.nextEpoch,
    destinationDevice: device.peerId,
    destinationGame: game.peerId,
    replacements: statement.replacements,
    checkDigest: transferCheckDigest(authorized.log, authRef),
  };
  const activation = {
    kind: 'transfer-activate' as const,
    statement: activationStatement,
    destinationCheck: signObject(
      TRANSFER_DESTINATION_CHECK_DOMAIN,
      activationStatement,
      game.secretKey,
    ),
    replacementChecks: [
      {
        seat: 3,
        sig: signObject(TRANSFER_BOT_CHECK_DOMAIN, activationStatement, botGame.secretKey),
      },
    ],
  };
  const activationEntry = signRecoveryFixtureEntry(
    fixture,
    authorized,
    { kind: 'membership', change: activation },
    authorized.log.head.stateHash,
  );
  const certifiedActivation = certifyRecoveryFixtureEntry(
    fixture,
    authorized,
    activationEntry,
    humans,
  );
  const activated = advanceRecoveryFixture(authorized, certifiedActivation);
  const entries = [...fixture.deckEntries, certifiedAuth, certifiedActivation];
  const peers = [
    game.peerId,
    required(fixture.source.identities.get(1)).peerId,
    required(fixture.source.identities.get(2)).peerId,
  ];
  const network = createMemnet({ peers });
  const sessions = new Map<Seat, P2PSession>();
  const providers: ReturnType<typeof createBeaconSecretSource>[] = [];
  let missingHumanBeacon: Result<P2PSession> | null = null;
  try {
    for (const seat of humans) {
      const signer = seat === 0 ? game : required(fixture.source.identities.get(seat));
      // oxlint-disable-next-line no-await-in-loop -- Each journal has its own ordered certified ancestry.
      const journal = await journalAt(fixture, seat, entries);
      const provider = createBeaconSecretSource(
        master(seat),
        { ceremonyId: deckCeremonyId(fixture.genesis), seat },
        2,
      );
      providers.push(provider);
      const deckSource: NonNullable<P2PSessionOptions['createDeckSource']> = (deckId, owner) => {
        const definition = required(
          activated.log.crypto?.decks.decks.find(
            (item) => item.commitment.definition.deckId === deckId,
          ),
        ).commitment.definition;
        return createDeckSecretSource(master(owner), definition, owner);
      };
      const options: P2PSessionOptions = {
        genesisEntry: fixture.genesisEntry,
        engine: fixture.source.engine,
        policy: fixture.policy,
        seat,
        secretKey: signer.secretKey,
        ...(seat === 0 ? { botKeys: new Map([[3, botGame.secretKey]]) } : {}),
        transport: network.transport(signer.peerId),
        clock: network.clock,
        journal,
        cheatCandidateStore: new MemoryCheatCandidateStore(),
        beaconSource: provider.source,
        beaconContributions: new MemoryBeaconContributionStore(),
        createDeckSource: deckSource,
        deckContributions: new MemoryGenesisConsentStore(),
        countContributionStore: new MemoryCountContributionStore(),
        stealDeliveryStore: new MemoryStealDeliveryStore(),
        createDriver: (engine, genesis, _clock, owned) =>
          new VerifiedSessionDriver(
            engine,
            genesis,
            owned,
            deckSource,
            (owner) => createHandSecretSource(master(owner), genesisDigest(genesis), owner),
            (owner) =>
              createStealSecretSource(
                master(owner),
                genesis.ceremonyNonce,
                owner,
                required(genesis.seats[owner]).publicKey,
              ),
          ),
      };
      if (seat === 0) {
        const { beaconSource: _missing, ...withoutHumanBeacon } = options;
        // oxlint-disable-next-line no-await-in-loop -- Probe the same destination journal before its valid restore.
        missingHumanBeacon = await P2PSession.restore(withoutHumanBeacon);
      }
      // oxlint-disable-next-line no-await-in-loop -- Each independent destination journal is restored once.
      sessions.set(seat, value(await P2PSession.restore(options)));
    }
    expect(missingHumanBeacon).toMatchObject({
      ok: false,
      error: { code: 'replica-beacon-store' },
    });
    if (missingHumanBeacon?.ok) missingHumanBeacon.value.dispose();
    const destination = required(sessions.get(0));
    expect(destination.exportSave().entries).toEqual(entries);
    expect(destination.getPrivate(0)).not.toBeNull();
    expect(destination.getPrivate(3)).not.toBeNull();
    expect(required(sessions.get(1)).getPrivate(3)).toBeNull();
    expect(activated.log.crypto?.beacon.chains.some(({ seat }) => seat === 3)).toBe(false);

    async function pumpUntil(condition: () => boolean, limit = 80): Promise<void> {
      for (let tick = 0; tick < limit; tick += 1) {
        // oxlint-disable-next-line no-await-in-loop -- Drain the prior network batch before advancing time.
        await Promise.all([...sessions.values()].map((session) => session.flush()));
        if (condition()) return;
        network.clock.advanceBy(250);
        // oxlint-disable-next-line no-await-in-loop -- Yield to asynchronous proof preparation.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      throw new Error(
        `Destination did not reach bot turn at seq ${destination.getCommittedHead().seq}`,
      );
    }
    await pumpUntil(() =>
      [...sessions.values()].every((session) =>
        session.exportSave().entries.some(({ entry }) => entry.payload.kind === 'system'),
      ),
    );
    for (let step = 0; step < 8 && destination.getState().turn.activeSeat !== 3; step += 1) {
      const active = destination.getState().turn.activeSeat;
      if (active > 2) throw new Error(`Unexpected setup seat ${active}`);
      const actor = required(sessions.get(active));
      const command = required(
        actor
          .getLegalCommands(active)
          .commands.find((item) => ['PLACE_SETTLEMENT', 'PLACE_ROAD'].includes(item.type)),
      );
      const seq = destination.getCommittedHead().seq;
      const submitted = actor.submit(active, command);
      // oxlint-disable-next-line no-await-in-loop -- The next setup choice depends on this certified command.
      await pumpUntil(() =>
        [...sessions.values()].every((session) => session.getCommittedHead().seq > seq),
      );
      // oxlint-disable-next-line no-await-in-loop -- Check the exact command before selecting the next actor.
      expect(await submitted).toEqual({ ok: true, value: undefined });
    }
    expect(destination.getState().turn.activeSeat).toBe(3);
    const botCommand = required(
      destination
        .getLegalCommands(3)
        .commands.find((item) => ['PLACE_SETTLEMENT', 'PLACE_ROAD'].includes(item.type)),
    );
    expect(destination.validate(3, botCommand)).toEqual({ ok: true, value: undefined });
    const seq = destination.getCommittedHead().seq;
    const submitted = destination.submit(3, botCommand);
    await pumpUntil(() =>
      [...sessions.values()].every((session) => session.getCommittedHead().seq > seq),
    );
    expect(await submitted).toEqual({ ok: true, value: undefined });
    const committed = required(destination.exportSave().entries.at(-1)).entry;
    if (committed.payload.kind !== 'command') throw new Error('Expected certified bot command');
    expect(committed.payload.signed.body.seat).toBe(3);
    expect(
      verifyObject(
        'cmd',
        committed.payload.signed.body,
        committed.payload.signed.sig,
        parsePeerId(botGame.peerId),
      ),
    ).toBe(true);
    expect(
      verifyObject(
        'cmd',
        committed.payload.signed.body,
        committed.payload.signed.sig,
        parsePeerId(required(fixture.genesis.seats[3]).publicKey),
      ),
    ).toBe(false);
  } finally {
    for (const session of sessions.values()) session.dispose();
    for (const provider of providers) provider.dispose();
    network.dispose();
    device.secretKey.fill(0);
    game.secretKey.fill(0);
    botGame.secretKey.fill(0);
  }
}, 60_000);

test('fresh host takes a recovered bot only with its current key and original beacon source', async () => {
  const fixture = createRecoveryFixture({ masterBackedBeacon: true, chainLength: 2 });
  const recoveredKey = recoveryFixtureReplacement(121);
  const recoveryReadiness = recoveryFixtureReadiness(fixture, fixture.ready, recoveredKey.peerId);
  const recoveryAuthorization = signRecoveryFixtureAuthorization(
    fixture,
    recoveryReadiness,
    recoveredKey.secretKey,
  );
  const recoveryEntry = signRecoveryFixtureEntry(
    fixture,
    fixture.ready,
    { kind: 'membership', change: recoveryAuthorization },
    fixture.ready.log.head.stateHash,
  );
  const certifiedRecovery = certifyRecoveryFixtureEntry(
    fixture,
    fixture.ready,
    recoveryEntry,
    [1, 2, 3],
  );
  const recovering = advanceRecoveryFixture(fixture.ready, certifiedRecovery);
  const recoveryActivation = signRecoveryFixtureActivation(fixture, recovering, recoveryEntry);
  const takeover = value(
    fixture.source.engine.apply(recovering.log.state, {
      kind: 'system',
      type: 'SEAT_STATUS',
      seat: 0,
      status: 'bot',
    }),
  );
  const recoveryActivationEntry = signRecoveryFixtureEntry(
    fixture,
    recovering,
    { kind: 'membership', change: recoveryActivation },
    toHex(hashValue(takeover.state)),
  );
  const certifiedRecoveryActivation = certifyRecoveryFixtureEntry(
    fixture,
    recovering,
    recoveryActivationEntry,
    [1, 2, 3],
  );
  const hosted = advanceRecoveryFixture(recovering, certifiedRecoveryActivation);
  const host = required(hosted.log.authority?.controllers.find((item) => item.seat === 1));
  const bot = required(hosted.log.authority?.controllers.find((item) => item.seat === 0));
  const device = identityFromSecret(new Uint8Array(32).fill(151));
  const game = identityFromSecret(new Uint8Array(32).fill(152));
  const botGame = identityFromSecret(new Uint8Array(32).fill(153));
  const statement: SeatTransferAuthorizationStatement = {
    protocol: 'seat-transfer-v1',
    genesisDigest: genesisDigest(fixture.genesis),
    anchor: transferEntryRef(hosted.log.head),
    validUntilSeq: hosted.log.head.seq + 64,
    mode: 'live',
    seat: 1,
    currentController: {
      publicKey: host.publicKey,
      kind: host.kind,
      activatedAt: host.activatedAt,
      hostSeat: host.hostSeat,
    },
    recovery: null,
    nextEpoch: hosted.membership.epoch + 1,
    destination: {
      devicePeer: device.peerId,
      gamePeer: game.peerId,
      transferEncryptionKey: encodePoint(scalePoint(G, 154n)),
    },
    replacements: [
      { seat: 1, oldPublicKey: host.publicKey, newPublicKey: game.peerId, newHostSeat: 1 },
      { seat: 0, oldPublicKey: bot.publicKey, newPublicKey: botGame.peerId, newHostSeat: 1 },
    ],
  };
  const authorization = {
    kind: 'transfer-authorize' as const,
    statement,
    destinationDeviceSig: signObject(TRANSFER_DEVICE_DOMAIN, statement, device.secretKey),
    destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, statement, game.secretKey),
    replacementKeySigs: [
      { seat: 0, sig: signObject(TRANSFER_BOT_KEY_DOMAIN, statement, botGame.secretKey) },
    ],
    ownerIntent: {
      signer: 'current-game' as const,
      sig: signObject(TRANSFER_OWNER_GAME_DOMAIN, statement, recoveryFixtureKey(fixture, 1)),
    },
  };
  const authorizationEntry = signRecoveryFixtureEntry(
    fixture,
    hosted,
    { kind: 'membership', change: authorization },
    hosted.log.head.stateHash,
  );
  const certifiedAuthorization = certifyRecoveryFixtureEntry(
    fixture,
    hosted,
    authorizationEntry,
    [1, 2, 3],
  );
  const authorized = advanceRecoveryFixture(hosted, certifiedAuthorization);
  const authorizationRef = transferEntryRef(authorizationEntry);
  const activationStatement = {
    protocol: 'seat-transfer-activation-v1' as const,
    genesisDigest: authorized.membership.genesisDigest,
    authorization: authorizationRef,
    parent: authorizationRef,
    nextEpoch: statement.nextEpoch,
    destinationDevice: device.peerId,
    destinationGame: game.peerId,
    replacements: statement.replacements,
    checkDigest: transferCheckDigest(authorized.log, authorizationRef),
  };
  const activation = {
    kind: 'transfer-activate' as const,
    statement: activationStatement,
    destinationCheck: signObject(
      TRANSFER_DESTINATION_CHECK_DOMAIN,
      activationStatement,
      game.secretKey,
    ),
    replacementChecks: [
      {
        seat: 0,
        sig: signObject(TRANSFER_BOT_CHECK_DOMAIN, activationStatement, botGame.secretKey),
      },
    ],
  };
  const activationEntry = signRecoveryFixtureEntry(
    fixture,
    authorized,
    { kind: 'membership', change: activation },
    authorized.log.head.stateHash,
  );
  const certifiedActivation = certifyRecoveryFixtureEntry(
    fixture,
    authorized,
    activationEntry,
    [1, 2, 3],
  );
  const active = advanceRecoveryFixture(authorized, certifiedActivation);
  const entries = [
    ...fixture.deckEntries,
    certifiedRecovery,
    certifiedRecoveryActivation,
    certifiedAuthorization,
    certifiedActivation,
  ];
  const journal = await journalAt(fixture, 1, entries);
  const network = createMemnet({
    peers: [
      game.peerId,
      required(fixture.source.identities.get(2)).peerId,
      required(fixture.source.identities.get(3)).peerId,
    ],
  });
  const humanBeacon = createBeaconSecretSource(
    master(1),
    { ceremonyId: deckCeremonyId(fixture.genesis), seat: 1 },
    2,
  );
  const botBeacon = createBeaconSecretSource(
    master(0),
    { ceremonyId: deckCeremonyId(fixture.genesis), seat: 0 },
    2,
  );
  let destination: P2PSession | undefined;
  try {
    expect(active.log.crypto?.beacon.chains.some(({ seat }) => seat === 0)).toBe(true);
    expect(toBase64Url(botBeacon.initialCommitment.tip)).toBe(
      toBase64Url(required(required(fixture.chains[0])[0])),
    );
    const deckSource: NonNullable<P2PSessionOptions['createDeckSource']> = (deckId, seat) => {
      const definition = required(
        active.log.crypto?.decks.decks.find((item) => item.commitment.definition.deckId === deckId),
      ).commitment.definition;
      return createDeckSecretSource(master(seat), definition, seat);
    };
    const options: P2PSessionOptions = {
      genesisEntry: fixture.genesisEntry,
      engine: fixture.source.engine,
      policy: fixture.policy,
      seat: 1,
      secretKey: game.secretKey,
      botKeys: new Map([[0, botGame.secretKey]]),
      transport: network.transport(game.peerId),
      clock: network.clock,
      journal,
      cheatCandidateStore: new MemoryCheatCandidateStore(),
      beaconSource: humanBeacon.source,
      beaconSources: new Map([[0, botBeacon.source]]),
      beaconContributions: new MemoryBeaconContributionStore(),
      createDeckSource: deckSource,
      deckContributions: new MemoryGenesisConsentStore(),
      countContributionStore: new MemoryCountContributionStore(),
      stealDeliveryStore: new MemoryStealDeliveryStore(),
      createDriver: (engine, genesis, _clock, owned) =>
        new VerifiedSessionDriver(
          engine,
          genesis,
          owned,
          deckSource,
          (seat) => createHandSecretSource(master(seat), genesisDigest(genesis), seat),
          (seat) =>
            createStealSecretSource(
              master(seat),
              genesis.ceremonyNonce,
              seat,
              required(genesis.seats[seat]).publicKey,
            ),
        ),
    };
    expect(
      await P2PSession.restore({ ...options, botKeys: new Map([[0, recoveredKey.secretKey]]) }),
    ).toMatchObject({
      ok: false,
      error: { code: 'session-bot-key' },
    });
    expect(await P2PSession.restore({ ...options, beaconSources: new Map() })).toMatchObject({
      ok: false,
      error: { code: 'replica-recovery-keys' },
    });
    destination = value(await P2PSession.restore(options));
    expect(destination.getPrivate(1)).not.toBeNull();
    expect(destination.getPrivate(0)).not.toBeNull();
    expect(destination.exportSave().entries).toEqual(entries);
  } finally {
    destination?.dispose();
    botBeacon.dispose();
    humanBeacon.dispose();
    network.dispose();
    device.secretKey.fill(0);
    game.secretKey.fill(0);
    botGame.secretKey.fill(0);
    recoveredKey.secretKey.fill(0);
  }
}, 60_000);

test('a second-generation retired human can request only certified history', async () => {
  const fixture = createRecoveryFixture({ masterBackedBeacon: true, chainLength: 2 });
  const firstDevice = identityFromSecret(new Uint8Array(32).fill(161));
  const firstGame = identityFromSecret(new Uint8Array(32).fill(162));
  const secondDevice = identityFromSecret(new Uint8Array(32).fill(165));
  const secondGame = identityFromSecret(new Uint8Array(32).fill(166));
  const pendingDevice = identityFromSecret(new Uint8Array(32).fill(168));
  const pendingGame = identityFromSecret(new Uint8Array(32).fill(169));
  const keys = new Map<Seat, Uint8Array>(
    fixture.genesis.seats.map(({ seat }) => [seat, recoveryFixtureKey(fixture, seat)]),
  );
  const entries = [...fixture.deckEntries];
  let context = fixture.ready;
  const certify = (change: unknown, excludedSeat: Seat = 2) => {
    const nextSeq = context.log.head.seq + 1;
    const elected = proposerFor(nextSeq, 1, context.membership, context.excludedProposers);
    const entry = signEntry(
      {
        seq: nextSeq,
        term: 1,
        prevHash: entryHash(context.log.head),
        payload: { kind: 'membership', change },
        stateHash: context.log.head.stateHash,
        sequencer: elected.publicKey,
      },
      required(keys.get(elected.seat)),
    );
    const certified: CertifiedEntry = {
      entry,
      certificate: context.membership.voters
        .filter(({ seat }) => seat !== excludedSeat)
        .map(({ seat }) =>
          signVote(
            {
              genesisDigest: context.membership.genesisDigest,
              epoch: context.membership.epoch,
              seat,
              seq: nextSeq,
              term: 1,
              phase: 'precommit',
              valueHash: entryHash(entry),
            },
            required(keys.get(seat)),
          ),
        ),
    };
    context = advanceRecoveryFixture(context, certified);
    entries.push(certified);
    return entry;
  };
  const transfer = (
    device: ReturnType<typeof identityFromSecret>,
    game: ReturnType<typeof identityFromSecret>,
    ownerKey: Uint8Array,
    encryptionScalar: bigint,
    retiringOwnerOffline = false,
  ) => {
    const controller = required(context.log.authority?.controllers.find((item) => item.seat === 0));
    const statement: SeatTransferAuthorizationStatement = {
      protocol: 'seat-transfer-v1',
      genesisDigest: genesisDigest(fixture.genesis),
      anchor: transferEntryRef(context.log.head),
      validUntilSeq: context.log.head.seq + 64,
      mode: 'live',
      seat: 0,
      currentController: {
        publicKey: controller.publicKey,
        kind: controller.kind,
        activatedAt: controller.activatedAt,
        hostSeat: controller.hostSeat,
      },
      recovery: null,
      nextEpoch: context.membership.epoch + 1,
      destination: {
        devicePeer: device.peerId,
        gamePeer: game.peerId,
        transferEncryptionKey: encodePoint(scalePoint(G, encryptionScalar)),
      },
      replacements: [
        { seat: 0, oldPublicKey: controller.publicKey, newPublicKey: game.peerId, newHostSeat: 0 },
      ],
    };
    const authorization = certify({
      kind: 'transfer-authorize',
      statement,
      destinationDeviceSig: signObject(TRANSFER_DEVICE_DOMAIN, statement, device.secretKey),
      destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, statement, game.secretKey),
      replacementKeySigs: [],
      ownerIntent: {
        signer: 'current-game',
        sig: signObject(TRANSFER_OWNER_GAME_DOMAIN, statement, ownerKey),
      },
    });
    const authorizationRef = transferEntryRef(authorization);
    const activationStatement = {
      protocol: 'seat-transfer-activation-v1' as const,
      genesisDigest: context.membership.genesisDigest,
      authorization: authorizationRef,
      parent: authorizationRef,
      nextEpoch: statement.nextEpoch,
      destinationDevice: device.peerId,
      destinationGame: game.peerId,
      replacements: statement.replacements,
      checkDigest: transferCheckDigest(context.log, authorizationRef),
    };
    certify(
      {
        kind: 'transfer-activate',
        statement: activationStatement,
        destinationCheck: signObject(
          TRANSFER_DESTINATION_CHECK_DOMAIN,
          activationStatement,
          game.secretKey,
        ),
        replacementChecks: [],
      },
      retiringOwnerOffline ? 0 : 2,
    );
    keys.set(0, game.secretKey);
  };
  transfer(firstDevice, firstGame, recoveryFixtureKey(fixture, 0), 163n);
  transfer(secondDevice, secondGame, firstGame.secretKey, 167n, true);
  const secondActivated = context;
  const secondActivationSeq = required(entries.at(-1)).entry.seq;
  const pendingController = required(
    context.log.authority?.controllers.find((item) => item.seat === 0),
  );
  const pendingStatement: SeatTransferAuthorizationStatement = {
    protocol: 'seat-transfer-v1',
    genesisDigest: genesisDigest(fixture.genesis),
    anchor: transferEntryRef(context.log.head),
    validUntilSeq: context.log.head.seq + 64,
    mode: 'live',
    seat: 0,
    currentController: {
      publicKey: pendingController.publicKey,
      kind: pendingController.kind,
      activatedAt: pendingController.activatedAt,
      hostSeat: pendingController.hostSeat,
    },
    recovery: null,
    nextEpoch: context.membership.epoch + 1,
    destination: {
      devicePeer: pendingDevice.peerId,
      gamePeer: pendingGame.peerId,
      transferEncryptionKey: encodePoint(scalePoint(G, 170n)),
    },
    replacements: [
      {
        seat: 0,
        oldPublicKey: pendingController.publicKey,
        newPublicKey: pendingGame.peerId,
        newHostSeat: 0,
      },
    ],
  };
  certify({
    kind: 'transfer-authorize',
    statement: pendingStatement,
    destinationDeviceSig: signObject(
      TRANSFER_DEVICE_DOMAIN,
      pendingStatement,
      pendingDevice.secretKey,
    ),
    destinationGameSig: signObject(
      TRANSFER_GAME_KEY_DOMAIN,
      pendingStatement,
      pendingGame.secretKey,
    ),
    replacementKeySigs: [],
    ownerIntent: {
      signer: 'current-game',
      sig: signObject(TRANSFER_OWNER_GAME_DOMAIN, pendingStatement, secondGame.secretKey),
    },
  });

  const journal = await journalAt(fixture, 1, entries);
  const human = required(fixture.source.identities.get(1));
  const network = createMemnet({
    peers: [
      human.peerId,
      firstGame.peerId,
      secondGame.peerId,
      pendingGame.peerId,
      required(fixture.source.identities.get(2)).peerId,
      required(fixture.source.identities.get(3)).peerId,
    ],
  });
  const oldRoute = network.transport(firstGame.peerId);
  const pendingRoute = network.transport(pendingGame.peerId);
  const staleRoute = oldRoute;
  const responses: ReturnType<typeof decodeProtocolMessage>[] = [];
  const pendingResponses: ReturnType<typeof decodeProtocolMessage>[] = [];
  const unsubscribe = oldRoute.onMessage((_from, bytes) => {
    responses.push(decodeProtocolMessage(bytes));
  });
  const unsubscribePending = pendingRoute.onMessage((_from, bytes) => {
    pendingResponses.push(decodeProtocolMessage(bytes));
  });
  const beacon = createBeaconSecretSource(
    master(1),
    { ceremonyId: deckCeremonyId(fixture.genesis), seat: 1 },
    2,
  );
  const staleBeacon = createBeaconSecretSource(
    master(0),
    { ceremonyId: deckCeremonyId(fixture.genesis), seat: 0 },
    2,
  );
  let session: P2PSession | undefined;
  let stale: P2PSession | undefined;
  try {
    const deckSource: NonNullable<P2PSessionOptions['createDeckSource']> = (deckId, seat) => {
      const definition = required(
        context.log.crypto?.decks.decks.find(
          (item) => item.commitment.definition.deckId === deckId,
        ),
      ).commitment.definition;
      return createDeckSecretSource(master(seat), definition, seat);
    };
    session = value(
      await P2PSession.restore({
        genesisEntry: fixture.genesisEntry,
        engine: fixture.source.engine,
        policy: fixture.policy,
        seat: 1,
        secretKey: human.secretKey,
        transport: network.transport(human.peerId),
        clock: network.clock,
        journal,
        cheatCandidateStore: new MemoryCheatCandidateStore(),
        beaconSource: beacon.source,
        beaconContributions: new MemoryBeaconContributionStore(),
        createDeckSource: deckSource,
        deckContributions: new MemoryGenesisConsentStore(),
        countContributionStore: new MemoryCountContributionStore(),
        stealDeliveryStore: new MemoryStealDeliveryStore(),
        createDriver: (engine, genesis, _clock, owned) =>
          new VerifiedSessionDriver(
            engine,
            genesis,
            owned,
            deckSource,
            (seat) => createHandSecretSource(master(seat), genesisDigest(genesis), seat),
            (seat) =>
              createStealSecretSource(
                master(seat),
                genesis.ceremonyNonce,
                seat,
                required(genesis.seats[seat]).publicKey,
              ),
          ),
      }),
    );
    const sync = value(
      encodeProtocolMessage({
        t: 'SYNC_REQ',
        genesisDigest: context.membership.genesisDigest,
        fromSeq: secondActivationSeq - 1,
      }),
    );
    oldRoute.send(human.peerId, sync);
    network.clock.advanceBy(0);
    await session.flush();
    network.clock.advanceBy(0);
    const batches = responses.flatMap((response) =>
      response.ok && response.value.t === 'SYNC_RES' ? [response.value] : [],
    );
    expect(batches).toHaveLength(1);
    expect(required(batches[0]).entries.map(({ entry }) => entry.seq)).toEqual([
      secondActivationSeq - 1,
      secondActivationSeq,
      secondActivationSeq + 1,
    ]);
    pendingRoute.send(human.peerId, sync);
    network.clock.advanceBy(0);
    await session.flush();
    network.clock.advanceBy(0);
    expect(
      pendingResponses.flatMap((response) =>
        response.ok && response.value.t === 'SYNC_RES' ? [response.value] : [],
      ),
    ).toHaveLength(0);
    // The first destination was offline before its retirement certificate. Restore
    // against an existing survivor link with no new commit hint or peer-change.
    const staleJournal = await journalAt(fixture, 0, entries.slice(0, -2));
    const staleOptions: P2PSessionOptions = {
      genesisEntry: fixture.genesisEntry,
      engine: fixture.source.engine,
      policy: fixture.policy,
      seat: 0,
      secretKey: firstGame.secretKey,
      transport: staleRoute,
      clock: network.clock,
      journal: staleJournal,
      cheatCandidateStore: new MemoryCheatCandidateStore(),
      beaconSource: staleBeacon.source,
      beaconContributions: new MemoryBeaconContributionStore(),
      createDeckSource: deckSource,
      deckContributions: new MemoryGenesisConsentStore(),
      countContributionStore: new MemoryCountContributionStore(),
      stealDeliveryStore: new MemoryStealDeliveryStore(),
      createDriver: (engine, genesis, _clock, owned) =>
        new VerifiedSessionDriver(
          engine,
          genesis,
          owned,
          deckSource,
          (seat) => createHandSecretSource(master(seat), genesisDigest(genesis), seat),
          (seat) =>
            createStealSecretSource(
              master(seat),
              genesis.ceremonyNonce,
              seat,
              required(genesis.seats[seat]).publicKey,
            ),
        ),
    };
    stale = value(await P2PSession.restore(staleOptions));
    for (let tick = 0; tick < 20 && stale.getCommittedHead().seq < secondActivationSeq; tick += 1) {
      network.clock.advanceBy(0);
      // oxlint-disable-next-line no-await-in-loop -- Each replay batch depends on the prior certified response.
      await Promise.all([session.flush(), stale.flush()]);
      // oxlint-disable-next-line no-await-in-loop -- Let queued transport and replay promises settle.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(stale.getCommittedHead().seq).toBe(secondActivationSeq);
    expect(stale.getProtocolStatus()).toMatchObject({ kind: 'retired', seat: 0 });
    expect(stale.getPrivate(0)).toBeNull();
    const retiredRecord = required(await staleJournal.load());
    expect(retiredRecord.height).toBe(secondActivationSeq + 1);
    expect(
      restoreRetiredSafety(
        canonicalDecode(required(retiredRecord.safety).bytes),
        secondActivated,
        0,
        firstGame.peerId,
      ).ok,
    ).toBe(true);
    expect(await P2PSession.restore(staleOptions)).toMatchObject({
      ok: false,
      error: { code: 'session-key' },
    });
    const before = responses.filter(
      (response) => response.ok && response.value.t === 'SNAPSHOT_RES',
    ).length;
    oldRoute.send(
      human.peerId,
      value(
        encodeProtocolMessage({
          t: 'SNAPSHOT_REQ',
          genesisDigest: context.membership.genesisDigest,
          atSeq: context.log.head.seq,
        }),
      ),
    );
    network.clock.advanceBy(0);
    await session.flush();
    network.clock.advanceBy(0);
    expect(
      responses.filter((response) => response.ok && response.value.t === 'SNAPSHOT_RES'),
    ).toHaveLength(before);
  } finally {
    session?.dispose();
    stale?.dispose();
    unsubscribe();
    unsubscribePending();
    beacon.dispose();
    staleBeacon.dispose();
    network.dispose();
    firstDevice.secretKey.fill(0);
    firstGame.secretKey.fill(0);
    secondDevice.secretKey.fill(0);
    secondGame.secretKey.fill(0);
    pendingDevice.secretKey.fill(0);
    pendingGame.secretKey.fill(0);
  }
}, 60_000);
