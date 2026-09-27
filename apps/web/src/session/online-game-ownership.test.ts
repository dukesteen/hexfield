import { canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import {
  G,
  encodePoint,
  identityFromSecret,
  scalarToBytes,
  scalePoint,
  signObject,
} from '@cp2p/crypto';
import type { Result, Seat } from '@cp2p/engine';
import {
  createConsensusState,
  entryHash,
  genesisDigest,
  MemoryProtocolJournal,
  P2PSession,
  proposerFor,
  signEntry,
  signVote,
  TRANSFER_DEVICE_DOMAIN,
  TRANSFER_GAME_KEY_DOMAIN,
  recoveryCheckDigest,
  validateGenesisOnlineStart,
} from '@cp2p/protocol';
import {
  advanceRecoveryFixture,
  certifyRecoveryFixtureEntry,
  createMemnet,
  createRecoveryFixture,
  MemoryEscrowLifecycleStore,
  recoveryFixtureKey,
  signRecoveryFixtureEntry,
  TRANSFER_DESTINATION_CHECK_DOMAIN,
  TRANSFER_OWNER_GAME_DOMAIN,
  transferCheckDigest,
  transferEntryRef,
} from '@cp2p/protocol/testing';
import type { CertifiedEntry, LogEntry, ProposalContext } from '@cp2p/protocol';
import { expect, test, vi } from 'vitest';
import { openOnlineGame } from './online-game.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing ownership fixture value');
  return item;
}

function certifiedByCurrentHumans(
  fixture: ReturnType<typeof createRecoveryFixture>,
  context: ProposalContext,
  payload: LogEntry['payload'],
  stateHash: string,
  keys: ReadonlyMap<Seat, Uint8Array>,
): CertifiedEntry {
  const entrySeq = context.log.head.seq + 1;
  const term = 1;
  const proposer = proposerFor(entrySeq, term, context.membership, context.excludedProposers);
  const signer = keys.get(proposer.seat) ?? recoveryFixtureKey(fixture, proposer.seat);
  const entry = signEntry(
    {
      seq: entrySeq,
      term,
      prevHash: entryHash(context.log.head),
      payload,
      stateHash,
      sequencer: proposer.publicKey,
    },
    signer,
  );
  return {
    entry,
    certificate: ([1, 2, 3] as const).map((seat) => ({
      ...signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: context.membership.epoch,
          seat,
          seq: entry.seq,
          term: entry.term,
          phase: 'precommit',
          valueHash: entryHash(entry),
        },
        keys.get(seat) ?? recoveryFixtureKey(fixture, seat),
      ),
    })),
  };
}

test('a stale installing binding cannot restore a bot seat after its human returns', async () => {
  const fixture = createRecoveryFixture({ masterBackedBeacon: true, chainLength: 2 });
  const history: CertifiedEntry[] = [...fixture.deckEntries];
  let context = fixture.ready;

  const recoveredBotKey = identityFromSecret(new Uint8Array(32).fill(201));
  const recoveryStatement = {
    genesisDigest: genesisDigest(fixture.genesis),
    parent: transferEntryRef(context.log.head),
    nextEpoch: context.membership.epoch + 1,
    departedSeat: 0 as const,
    hostSeat: 1 as const,
    botLevel: 'medium' as const,
    replacements: [{ seat: 0 as const, publicKey: recoveredBotKey.peerId }],
    recoverers: ([1, 2, 3] as const).map((seat) => ({
      seat,
      publicKey: required(fixture.genesis.seats[seat]).publicKey,
    })),
    previous: null,
  };
  const recoveryAuth = {
    kind: 'recovery-authorize' as const,
    statement: recoveryStatement,
    hostSig: signObject('recovery-readiness', recoveryStatement, recoveryFixtureKey(fixture, 1)),
    keySigs: [
      {
        seat: 0 as const,
        sig: signObject('recovery-readiness', recoveryStatement, recoveredBotKey.secretKey),
      },
    ],
  };
  const recoveryAuthEntry = signRecoveryFixtureEntry(
    fixture,
    context,
    { kind: 'membership', change: recoveryAuth },
    context.log.head.stateHash,
  );
  const certifiedRecoveryAuth = certifyRecoveryFixtureEntry(
    fixture,
    context,
    recoveryAuthEntry,
    [1, 2, 3],
  );
  history.push(certifiedRecoveryAuth);
  context = advanceRecoveryFixture(context, certifiedRecoveryAuth);

  const recoveryAuthRef = transferEntryRef(recoveryAuthEntry);
  const recoveryActivationStatement = {
    genesisDigest: genesisDigest(fixture.genesis),
    parent: transferEntryRef(context.log.head),
    nextEpoch: context.membership.epoch + 1,
    authorization: recoveryAuthRef,
    checkDigest: recoveryCheckDigest(context.log, recoveryAuthRef),
  };
  const recoveryActivation = {
    kind: 'recovery-activate' as const,
    statement: recoveryActivationStatement,
    checks: ([1, 2, 3] as const).map((seat) => ({
      seat,
      sig: signObject(
        'recovery-check',
        recoveryActivationStatement,
        recoveryFixtureKey(fixture, seat),
      ),
    })),
  };
  const botState = value(
    fixture.source.engine.apply(context.log.state, {
      kind: 'system',
      type: 'SEAT_STATUS',
      seat: 0,
      status: 'bot',
    }),
  ).state;
  const recoveryActivationEntry = signRecoveryFixtureEntry(
    fixture,
    context,
    { kind: 'membership', change: recoveryActivation },
    toHex(hashValue(botState)),
  );
  const certifiedRecoveryActivation = certifyRecoveryFixtureEntry(
    fixture,
    context,
    recoveryActivationEntry,
    [1, 2, 3],
  );
  history.push(certifiedRecoveryActivation);
  context = advanceRecoveryFixture(context, certifiedRecoveryActivation);

  const hostDevice = identityFromSecret(new Uint8Array(32).fill(211));
  const hostGameKey = identityFromSecret(new Uint8Array(32).fill(212));
  const installedBotKey = identityFromSecret(new Uint8Array(32).fill(213));
  const hostController = required(
    context.log.authority?.controllers.find(({ seat }) => seat === 1),
  );
  const botController = required(context.log.authority?.controllers.find(({ seat }) => seat === 0));
  const hostTransfer = {
    protocol: 'seat-transfer-v1' as const,
    genesisDigest: genesisDigest(fixture.genesis),
    anchor: transferEntryRef(context.log.head),
    validUntilSeq: context.log.head.seq + 64,
    mode: 'live' as const,
    seat: 1 as const,
    currentController: {
      publicKey: hostController.publicKey,
      kind: hostController.kind,
      activatedAt: hostController.activatedAt,
      hostSeat: hostController.hostSeat,
    },
    recovery: null,
    nextEpoch: required(context.log.crypto).epoch + 1,
    destination: {
      devicePeer: hostDevice.peerId,
      gamePeer: hostGameKey.peerId,
      transferEncryptionKey: encodePoint(scalePoint(G, 231n)),
    },
    replacements: [
      {
        seat: 1 as const,
        oldPublicKey: hostController.publicKey,
        newPublicKey: hostGameKey.peerId,
        newHostSeat: 1 as const,
      },
      {
        seat: 0 as const,
        oldPublicKey: botController.publicKey,
        newPublicKey: installedBotKey.peerId,
        newHostSeat: 1 as const,
      },
    ],
  };
  const hostTransferAuth = {
    kind: 'transfer-authorize' as const,
    statement: hostTransfer,
    destinationDeviceSig: signObject(TRANSFER_DEVICE_DOMAIN, hostTransfer, hostDevice.secretKey),
    destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, hostTransfer, hostGameKey.secretKey),
    replacementKeySigs: [
      {
        seat: 0 as const,
        sig: signObject('seat-transfer-bot-key-v1', hostTransfer, installedBotKey.secretKey),
      },
    ],
    ownerIntent: {
      signer: 'current-game' as const,
      sig: signObject(TRANSFER_OWNER_GAME_DOMAIN, hostTransfer, recoveryFixtureKey(fixture, 1)),
    },
  };
  const hostAuthEntry = signRecoveryFixtureEntry(
    fixture,
    context,
    { kind: 'membership', change: hostTransferAuth },
    context.log.head.stateHash,
  );
  const certifiedHostAuth = certifyRecoveryFixtureEntry(fixture, context, hostAuthEntry, [1, 2, 3]);
  history.push(certifiedHostAuth);
  context = advanceRecoveryFixture(context, certifiedHostAuth);
  const hostAuthRef = transferEntryRef(hostAuthEntry);
  const hostActivationStatement = {
    protocol: 'seat-transfer-activation-v1' as const,
    genesisDigest: hostTransfer.genesisDigest,
    authorization: hostAuthRef,
    parent: transferEntryRef(context.log.head),
    nextEpoch: hostTransfer.nextEpoch,
    destinationDevice: hostDevice.peerId,
    destinationGame: hostGameKey.peerId,
    replacements: hostTransfer.replacements,
    checkDigest: transferCheckDigest(context.log, hostAuthRef),
  };
  const hostActivation = {
    kind: 'transfer-activate' as const,
    statement: hostActivationStatement,
    destinationCheck: signObject(
      TRANSFER_DESTINATION_CHECK_DOMAIN,
      hostActivationStatement,
      hostGameKey.secretKey,
    ),
    replacementChecks: [
      {
        seat: 0 as const,
        sig: signObject(
          'seat-transfer-bot-check-v1',
          hostActivationStatement,
          installedBotKey.secretKey,
        ),
      },
    ],
  };
  const hostActivationEntry = signRecoveryFixtureEntry(
    fixture,
    context,
    { kind: 'membership', change: hostActivation },
    context.log.head.stateHash,
  );
  const certifiedHostActivation = certifyRecoveryFixtureEntry(
    fixture,
    context,
    hostActivationEntry,
    [1, 2, 3],
  );
  history.push(certifiedHostActivation);
  context = advanceRecoveryFixture(context, certifiedHostActivation);

  const returnedDevice = identityFromSecret(new Uint8Array(32).fill(221));
  const returnedGameKey = identityFromSecret(new Uint8Array(32).fill(222));
  const returnedBot = required(context.log.authority?.controllers.find(({ seat }) => seat === 0));
  const returnStatement = {
    protocol: 'seat-transfer-v1' as const,
    genesisDigest: genesisDigest(fixture.genesis),
    anchor: transferEntryRef(context.log.head),
    validUntilSeq: context.log.head.seq + 1,
    mode: 'return' as const,
    seat: 0 as const,
    currentController: {
      publicKey: returnedBot.publicKey,
      kind: returnedBot.kind,
      activatedAt: returnedBot.activatedAt,
      hostSeat: returnedBot.hostSeat,
    },
    recovery: {
      authorization: transferEntryRef(recoveryAuthEntry),
      activation: transferEntryRef(recoveryActivationEntry),
    },
    nextEpoch: required(context.log.crypto).epoch + 1,
    destination: {
      devicePeer: returnedDevice.peerId,
      gamePeer: returnedGameKey.peerId,
      transferEncryptionKey: encodePoint(scalePoint(G, 241n)),
    },
    replacements: [
      {
        seat: 0 as const,
        oldPublicKey: returnedBot.publicKey,
        newPublicKey: returnedGameKey.peerId,
        newHostSeat: 0 as const,
      },
    ],
  };
  const returnAuthorization = {
    kind: 'transfer-authorize' as const,
    statement: returnStatement,
    destinationDeviceSig: signObject(
      TRANSFER_DEVICE_DOMAIN,
      returnStatement,
      returnedDevice.secretKey,
    ),
    destinationGameSig: signObject(
      TRANSFER_GAME_KEY_DOMAIN,
      returnStatement,
      returnedGameKey.secretKey,
    ),
    replacementKeySigs: [],
    returnIntent: {
      signer: 'last-human-game-key' as const,
      sig: signObject(
        'seat-transfer-return-intent-v1',
        returnStatement,
        recoveryFixtureKey(fixture, 0),
      ),
    },
  };
  const currentHumanKeys = new Map<Seat, Uint8Array>([
    [1, hostGameKey.secretKey],
    [2, recoveryFixtureKey(fixture, 2)],
    [3, recoveryFixtureKey(fixture, 3)],
  ]);
  const certifiedReturnAuth = certifiedByCurrentHumans(
    fixture,
    context,
    { kind: 'membership', change: returnAuthorization },
    context.log.head.stateHash,
    currentHumanKeys,
  );
  history.push(certifiedReturnAuth);
  context = advanceRecoveryFixture(context, certifiedReturnAuth);
  const returnAuthRef = transferEntryRef(certifiedReturnAuth.entry);
  const returnActivationStatement = {
    protocol: 'seat-transfer-activation-v1' as const,
    genesisDigest: returnStatement.genesisDigest,
    authorization: returnAuthRef,
    parent: transferEntryRef(context.log.head),
    nextEpoch: returnStatement.nextEpoch,
    destinationDevice: returnedDevice.peerId,
    destinationGame: returnedGameKey.peerId,
    replacements: returnStatement.replacements,
    checkDigest: transferCheckDigest(context.log, returnAuthRef),
  };
  const returnActivation = {
    kind: 'transfer-activate' as const,
    statement: returnActivationStatement,
    destinationCheck: signObject(
      TRANSFER_DESTINATION_CHECK_DOMAIN,
      returnActivationStatement,
      returnedGameKey.secretKey,
    ),
    replacementChecks: [],
  };
  const returnedState = value(
    fixture.source.engine.apply(context.log.state, {
      kind: 'system',
      type: 'SEAT_STATUS',
      seat: 0,
      status: 'active',
    }),
  ).state;
  const certifiedReturnActivation = certifiedByCurrentHumans(
    fixture,
    context,
    { kind: 'membership', change: returnActivation },
    toHex(hashValue(returnedState)),
    currentHumanKeys,
  );
  history.push(certifiedReturnActivation);
  context = advanceRecoveryFixture(context, certifiedReturnActivation);
  expect(context.log.authority?.controllers.find(({ seat }) => seat === 0)).toMatchObject({
    kind: 'human',
    status: 'active',
    publicKey: returnedGameKey.peerId,
  });

  const journal = Object.assign(new MemoryProtocolJournal(), { close: async () => undefined });
  let persistedContext: ProposalContext = fixture.beforeSetup;
  expect(
    await journal.initialize(
      fixture.genesisEntry,
      canonicalEncode(value(createConsensusState(persistedContext, 1))),
    ),
  ).toBe(true);
  for (const certified of history) {
    persistedContext = advanceRecoveryFixture(persistedContext, certified);
    expect(
      // oxlint-disable-next-line no-await-in-loop -- The journal history is a sequential certified chain.
      await journal.commit(
        certified.entry.seq,
        0,
        certified,
        canonicalEncode(value(createConsensusState(persistedContext, 1))),
      ),
    ).toBe(true);
  }

  const net = createMemnet({
    peers: [
      ...fixture.genesis.seats.map(({ publicKey }) => publicKey),
      hostDevice.peerId,
      returnedDevice.peerId,
    ],
  });
  const restore = vi.spyOn(P2PSession, 'restore');
  const start = value(validateGenesisOnlineStart(fixture.genesis));
  const material = [
    {
      seat: 0 as const,
      kind: 'bot' as const,
      peerId: installedBotKey.peerId,
      signingKey: installedBotKey.secretKey,
      master: scalarToBytes(17n),
    },
    {
      seat: 1 as const,
      kind: 'human' as const,
      peerId: hostGameKey.peerId,
      signingKey: hostGameKey.secretKey,
      master: scalarToBytes(18n),
    },
  ];
  const runtime = {
    acquireLease: async () => ({
      lockName: 'ownership-regression',
      run: async <T>(task: () => T | PromiseLike<T>): Promise<T> => task(),
      close: async () => undefined,
    }),
    createJournal: () => journal,
    auditRunner: () => {
      throw new Error('No terminal audit expected');
    },
  };
  let game: Awaited<ReturnType<typeof openOnlineGame>> | null = null;
  try {
    game = await openOnlineGame(
      {
        entry: fixture.genesisEntry,
        transcripts: fixture.deck.transcripts,
        agreement: start.bindings.agreement,
        bindings: start.bindings.bindings,
        material,
        deviceTransport: net.transport(hostDevice.peerId),
        store: new MemoryEscrowLifecycleStore(),
        clock: net.clock,
        engine: fixture.source.engine,
        journalMode: 'restore-only',
      },
      runtime,
    );
    const options = required(restore.mock.calls[0]?.[0]);
    expect(game.seat).toBe(1);
    expect(game.session.getCommittedHead().seq).toBe(required(history.at(-1)).entry.seq);
    expect(game.session.getPrivate(1)?.seat).toBe(1);
    const masterReveal = required(options.masterReveal);
    expect(await masterReveal.loadOwnedMaster(0)).toBeNull();
    const ownMaster = await masterReveal.loadOwnedMaster(1);
    expect(ownMaster).toEqual(scalarToBytes(18n));
    ownMaster?.fill(0);
    const createDeckSource = required(options.createDeckSource);
    const deckId = required(fixture.deck.transcripts[0]).deckId;
    expect(() => createDeckSource(deckId, 0)).toThrow(/another device/);
    const ownDeck = createDeckSource(deckId, 1);
    expect(ownDeck).toBeDefined();
    ownDeck.dispose();
    const createDriver = required(options.createDriver);
    const retiredDriver = createDriver(options.engine, fixture.genesis, options.clock, [0]);
    expect(retiredDriver.validateSources?.()).toMatchObject({ ok: false });
    retiredDriver.dispose?.();
    const hostDriver = createDriver(options.engine, fixture.genesis, options.clock, [1]);
    expect(hostDriver.validateSources?.()).toEqual({ ok: true, value: undefined });
    hostDriver.dispose?.();
  } finally {
    restore.mockRestore();
    await game?.close();
    for (const item of material) {
      item.signingKey.fill(0);
      item.master.fill(0);
    }
    hostDevice.secretKey.fill(0);
    hostGameKey.secretKey.fill(0);
    installedBotKey.secretKey.fill(0);
    returnedDevice.secretKey.fill(0);
    returnedGameKey.secretKey.fill(0);
    recoveredBotKey.secretKey.fill(0);
    net.dispose();
  }
}, 60_000);
