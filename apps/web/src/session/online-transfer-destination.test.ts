import { canonicalDecode, canonicalEncode, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { identityFromSecret, scalarToBytes, signObject } from '@cp2p/crypto';
import { createBaseEngine } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import {
  entryHash,
  createConsensusState,
  genesisDigest,
  MemoryProtocolJournal,
  prepareTransferPrivate,
  restoreConsensusState,
  validateDeckCeremony,
  validateGenesisEntry,
  validateGenesisOnlineStart,
  verifyGameSeatBindings,
  verifyLobbyFreezeAgreement,
} from '@cp2p/protocol';
import {
  advanceRecoveryFixture,
  certifyRecoveryFixtureEntry,
  certifyRecoveryFixtureFirstBeacon,
  createRecoveryFixture,
  createRetiredSafety,
  persistRecoveryPrivate,
  recoveryFixtureKey,
  recoveryFixtureReadiness,
  signRecoveryFixtureAuthorization,
  signRecoveryFixtureActivation,
  signRecoveryFixtureEntry,
  TRANSFER_OWNER_GAME_DOMAIN,
  transferEntryRef,
} from '@cp2p/protocol/testing';
import {
  IDBCursor,
  IDBDatabase,
  IDBFactory,
  IDBIndex,
  IDBKeyRange,
  IDBObjectStore,
  IDBRequest,
  IDBTransaction,
} from 'fake-indexeddb';
import { afterEach, expect, test, vi } from 'vitest';
import { IndexedDbByteStore, IndexedDbProtocolJournal, TransferImportStore } from '@cp2p/storage';
import { loadOnlineGameRecord } from './online-game-records.js';
import { encodeOnlineTransferBootstrap } from './online-transfer-bootstrap.js';
import { OnlineTransferDestination } from './online-transfer-destination.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function installFactory(): void {
  vi.stubGlobal('indexedDB', new IDBFactory());
  for (const [name, item] of Object.entries({
    IDBCursor,
    IDBDatabase,
    IDBIndex,
    IDBKeyRange,
    IDBObjectStore,
    IDBRequest,
    IDBTransaction,
  }))
    vi.stubGlobal(name, item);
  vi.stubGlobal('navigator', {
    locks: {
      async request<T>(
        name: string,
        optionsOrCallback: LockOptions | LockGrantedCallback<T>,
        callbackMaybe?: LockGrantedCallback<T>,
      ) {
        const callback =
          typeof optionsOrCallback === 'function' ? optionsOrCallback : callbackMaybe;
        if (!callback) throw new TypeError('Lock callback is missing');
        return callback({ name, mode: 'exclusive' });
      },
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

function publicRecord(fixture: ReturnType<typeof createRecoveryFixture>) {
  const start = value(validateGenesisOnlineStart(fixture.genesis));
  return {
    gameId: fixture.genesis.gameId,
    genesisDigest: genesisDigest(fixture.genesis),
    invite: {
      roomId: start.bindings.agreement.state.lobbyId,
      hostPeer: start.bindings.agreement.state.hostPeer,
      serverUrl: '',
    },
    agreement: start.bindings.agreement,
    result: {
      entry: fixture.genesisEntry,
      genesis: fixture.genesis,
      transcripts: fixture.deck.transcripts,
      bindings: start.bindings.bindings,
    },
  };
}

test('destination reserves once, imports authenticated private history, resumes and promotes exact certified activation', async () => {
  installFactory();
  const fixture = createRecoveryFixture({ masterBackedBeacon: true, lobbyId: 'transferqa' });
  const record = publicRecord(fixture);
  const entries = [...fixture.deckEntries];
  expect(verifyLobbyFreezeAgreement(record.agreement).ok).toBe(true);
  expect(verifyGameSeatBindings(record.agreement, record.result.bindings).ok).toBe(true);
  const deckCheck = validateDeckCeremony(fixture.genesis, fixture.deck.transcripts);
  const entryCheck = validateGenesisEntry(fixture.genesisEntry, createBaseEngine(), {
    verifyCommitments: () => deckCheck,
  });
  expect(deckCheck.ok).toBe(true);
  expect(entryCheck.ok).toBe(true);
  const bootstrap = value(encodeOnlineTransferBootstrap({ start: record, entries }));
  const device = identityFromSecret(new Uint8Array(32).fill(111));
  const identity = {
    ...device,
    dispose() {
      this.secretKey.fill(0);
    },
  };
  const store = new IndexedDbByteStore({
    lockProvider: async (_name, task) => task(),
  });
  const imports = new TransferImportStore(store);
  const attemptId = toBase64Url(new Uint8Array(32).fill(5));
  const expected = { gameId: record.gameId, genesisDigest: record.genesisDigest };
  const destination = await OnlineTransferDestination.create({
    attemptId,
    mode: 'new',
    expected,
    identity,
    store,
    bootstrapBytes: bootstrap,
    importStore: imports,
  });
  const reopened = await OnlineTransferDestination.create({
    attemptId,
    mode: 'open',
    expected,
    identity,
    store,
    bootstrapBytes: Uint8Array.of(0),
    importStore: imports,
  });
  expect(reopened.snapshot()).toEqual(destination.snapshot());
  await reopened.close();
  const freshOpenAttempt = toBase64Url(new Uint8Array(32).fill(14));
  const freshOpen = await OnlineTransferDestination.create({
    attemptId: freshOpenAttempt,
    mode: 'open',
    expected,
    identity,
    store,
    bootstrapBytes: bootstrap,
  });
  await freshOpen.close();
  const reloadedOpen = await OnlineTransferDestination.create({
    attemptId: freshOpenAttempt,
    mode: 'open',
    expected,
    identity,
    store,
  });
  expect(reloadedOpen.snapshot()).toEqual(freshOpen.snapshot());
  await reloadedOpen.close();
  const corruptAttempt = toBase64Url(new Uint8Array(32).fill(13));
  const corruptKey = `online-transfer/destination/${record.genesisDigest}/${corruptAttempt}`;
  expect(await store.putIfAbsent(corruptKey, Uint8Array.of(0))).toBe(true);
  await expect(
    OnlineTransferDestination.create({
      attemptId: corruptAttempt,
      mode: 'open',
      expected,
      identity,
      store,
      bootstrapBytes: bootstrap,
    }),
  ).rejects.toBeInstanceOf(Error);
  expect(await store.load(corruptKey)).toEqual(Uint8Array.of(0));
  const aborted = new AbortController();
  const originalLock = store.withCeremonyLock.bind(store);
  const interruptedCreate = vi
    .spyOn(store, 'withCeremonyLock')
    .mockImplementationOnce((key, task) => {
      aborted.abort();
      return originalLock(key, task);
    });
  const abandonedAttempt = toBase64Url(new Uint8Array(32).fill(12));
  await expect(
    OnlineTransferDestination.create({
      attemptId: abandonedAttempt,
      mode: 'new',
      expected,
      identity,
      store,
      bootstrapBytes: bootstrap,
      signal: aborted.signal,
    }),
  ).rejects.toThrow(/cancelled/);
  interruptedCreate.mockRestore();
  expect(
    await store.load(`online-transfer/destination/${record.genesisDigest}/${abandonedAttempt}`),
  ).toBeNull();
  await expect(
    OnlineTransferDestination.create({
      attemptId,
      mode: 'new',
      expected,
      identity,
      store,
      bootstrapBytes: bootstrap,
      importStore: imports,
    }),
  ).rejects.toThrow(/already exists/);
  const offer = await destination.prepareOffer({ seat: 0, mode: 'live' });
  const authorization = {
    ...offer,
    ownerIntent: {
      signer: 'current-game' as const,
      sig: signObject(TRANSFER_OWNER_GAME_DOMAIN, offer.statement, recoveryFixtureKey(fixture, 0)),
    },
  };
  const authorizedEntry = signRecoveryFixtureEntry(
    fixture,
    fixture.ready,
    { kind: 'membership', change: authorization },
    fixture.ready.log.head.stateHash,
  );
  const authorizedCertificate = certifyRecoveryFixtureEntry(
    fixture,
    fixture.ready,
    authorizedEntry,
    [0, 1, 2, 3],
  );
  const authorized = advanceRecoveryFixture(fixture.ready, authorizedCertificate);
  entries.push(authorizedCertificate);
  const authorizedBootstrap = value(encodeOnlineTransferBootstrap({ start: record, entries }));
  await destination.refreshBootstrap(authorizedBootstrap);
  await destination.close();

  const resumed = await OnlineTransferDestination.create({
    attemptId,
    mode: 'resume',
    expected,
    identity,
    store,
    importStore: imports,
  });
  expect(await resumed.prepareOffer({ seat: 0, mode: 'live' })).toEqual(offer);
  const journal = new MemoryProtocolJournal();
  expect(await journal.initialize(fixture.genesisEntry, Uint8Array.of(1))).toBe(true);
  for (const certified of entries)
    // oxlint-disable-next-line no-await-in-loop -- Preserve the real certified prefix in the source journal.
    expect(await journal.commit(certified.entry.seq, 0, certified, Uint8Array.of(1))).toBe(true);
  const packet = value(
    await prepareTransferPrivate({
      journal,
      engine: createBaseEngine(),
      policy: fixture.policy,
      authorization: transferEntryRef(authorizedEntry),
      sourceSeat: 0,
      sourceKind: 'current-controller',
      signingKey: recoveryFixtureKey(fixture, 0),
      entropy: new Uint8Array(32).fill(31),
      nonce: new Uint8Array(32).fill(32),
      masters: [{ seat: 0, master: scalarToBytes(17n) }],
      outbox: store,
    }),
  );
  const importSwap = store.compareAndSwap.bind(store);
  const interruptedImport = vi
    .spyOn(store, 'compareAndSwap')
    .mockImplementation((key, before, after) => {
      if (key.startsWith('online-transfer/destination/')) {
        interruptedImport.mockRestore();
        throw new Error('interrupted before import locator update');
      }
      return importSwap(key, before, after);
    });
  await expect(resumed.importPacket(packet)).rejects.toThrow(/interrupted/);
  await resumed.close();
  const importRetry = await OnlineTransferDestination.create({
    attemptId,
    mode: 'resume',
    expected,
    identity,
    store,
    importStore: imports,
  });
  expect(importRetry.snapshot().phase).toBe('offered');
  await importRetry.importPacket(packet);
  await importRetry.close();
  const staged = await OnlineTransferDestination.create({
    attemptId,
    mode: 'resume',
    expected,
    identity,
    store,
    importStore: imports,
  });
  const readiness = await staged.prepareReadiness();
  expect(staged.snapshot().phase).toBe('ready');
  await staged.importPacket(packet);
  expect(staged.snapshot().phase).toBe('ready');
  await expect(
    staged.importPacket({
      ...packet,
      sourceSig: `${packet.sourceSig[0] === 'a' ? 'b' : 'a'}${packet.sourceSig.slice(1)}`,
    }),
  ).rejects.toThrow(/differs/);
  const ordinary = certifyRecoveryFixtureFirstBeacon(fixture, authorized);
  const afterOrdinary = advanceRecoveryFixture(authorized, ordinary);
  entries.push(ordinary);
  const newerBootstrap = value(encodeOnlineTransferBootstrap({ start: record, entries }));
  const originalSwap = store.compareAndSwap.bind(store);
  const interruptedSwap = vi
    .spyOn(store, 'compareAndSwap')
    .mockImplementation((key, before, after) => {
      if (key.startsWith('online-transfer/destination/')) {
        interruptedSwap.mockRestore();
        throw new Error('interrupted before locator compare-and-swap');
      }
      return originalSwap(key, before, after);
    });
  await expect(staged.refreshBootstrap(newerBootstrap)).rejects.toThrow(/interrupted/);
  expect(staged.snapshot().phase).toBe('ready');
  await staged.close();
  const afterInterruption = await OnlineTransferDestination.create({
    attemptId,
    mode: 'resume',
    expected,
    identity,
    store,
    importStore: imports,
  });
  expect(afterInterruption.snapshot().head).toEqual(transferEntryRef(authorizedEntry));
  await afterInterruption.refreshBootstrap(newerBootstrap);
  expect(afterInterruption.snapshot().phase).toBe('imported');
  const refreshedReadiness = await afterInterruption.prepareReadiness();
  expect(refreshedReadiness.statement.parent).toEqual(transferEntryRef(ordinary.entry));
  expect(refreshedReadiness.statement.parent).not.toEqual(readiness.statement.parent);
  const staleActivation = signRecoveryFixtureEntry(
    fixture,
    afterOrdinary,
    { kind: 'membership', change: readiness },
    afterOrdinary.log.head.stateHash,
  );
  expect(() =>
    advanceRecoveryFixture(
      afterOrdinary,
      certifyRecoveryFixtureEntry(fixture, afterOrdinary, staleActivation, [0, 1, 2, 3]),
    ),
  ).toThrow(/transfer|activation|parent/i);
  await afterInterruption.close();
  const stagedResume = await OnlineTransferDestination.create({
    attemptId,
    mode: 'resume',
    expected,
    identity,
    store,
    importStore: imports,
  });
  expect(stagedResume.snapshot().phase).toBe('ready');
  await expect(stagedResume.observeActivation(authorizedBootstrap)).rejects.toThrow(
    /exact certified child/,
  );
  const activationEntry = signRecoveryFixtureEntry(
    fixture,
    afterOrdinary,
    { kind: 'membership', change: refreshedReadiness },
    afterOrdinary.log.head.stateHash,
  );
  const activation = certifyRecoveryFixtureEntry(
    fixture,
    afterOrdinary,
    activationEntry,
    [0, 1, 2, 3],
  );
  advanceRecoveryFixture(afterOrdinary, activation);
  entries.push(activation);
  const activatedBootstrap = value(encodeOnlineTransferBootstrap({ start: record, entries }));
  expect(await stagedResume.observeActivation(activatedBootstrap)).toBe(record.gameId);
  expect(stagedResume.snapshot().phase).toBe('promoted');
  expect(stagedResume.snapshot().head).toEqual(transferEntryRef(activationEntry));
  expect(stagedResume.snapshot().outcome).toEqual({
    authorization: transferEntryRef(authorizedEntry),
    entry: transferEntryRef(activationEntry),
    outcome: 'activated',
  });
  const saved = await loadOnlineGameRecord(store, record.gameId);
  expect(saved?.genesisDigest).toBe(record.genesisDigest);
  expect((await imports.readOutcome(record.gameId, transferEntryRef(authorizedEntry))).kind).toBe(
    'promoted',
  );
  expect(entryHash(activation.entry)).toBeTruthy();
  await stagedResume.close();
  const promotedResume = await OnlineTransferDestination.create({
    attemptId,
    mode: 'resume',
    expected,
    identity,
    store,
    importStore: imports,
  });
  expect(promotedResume.snapshot().phase).toBe('promoted');
  expect(promotedResume.snapshot().outcome).toEqual(stagedResume.snapshot().outcome);
  expect(promotedResume.snapshot().head).toEqual(transferEntryRef(activationEntry));
  expect(await promotedResume.observeActivation(activatedBootstrap)).toBe(record.gameId);
  await promotedResume.close();
  identity.dispose();
  bootstrap.fill(0);
  authorizedBootstrap.fill(0);
  newerBootstrap.fill(0);
  activatedBootstrap.fill(0);
}, 120_000);

test('certified cancellation crosses ordinary children after the local refresh budget is exhausted', async () => {
  installFactory();
  const fixture = createRecoveryFixture({ masterBackedBeacon: true, lobbyId: 'cancelroom' });
  const record = publicRecord(fixture);
  const entries = [...fixture.deckEntries];
  const store = new IndexedDbByteStore({ lockProvider: async (_name, task) => task() });
  const imports = new TransferImportStore(store);
  const device = identityFromSecret(new Uint8Array(32).fill(113));
  const identity = {
    ...device,
    dispose() {
      this.secretKey.fill(0);
    },
  };
  const expected = { gameId: record.gameId, genesisDigest: record.genesisDigest };
  const attemptId = toBase64Url(new Uint8Array(32).fill(6));
  let participant = await OnlineTransferDestination.create({
    attemptId,
    mode: 'new',
    expected,
    identity,
    store,
    importStore: imports,
    bootstrapBytes: value(encodeOnlineTransferBootstrap({ start: record, entries })),
  });
  const offer = await participant.prepareOffer({ seat: 0, mode: 'live' });
  const authorization = {
    ...offer,
    ownerIntent: {
      signer: 'current-game' as const,
      sig: signObject(TRANSFER_OWNER_GAME_DOMAIN, offer.statement, recoveryFixtureKey(fixture, 0)),
    },
  };
  const authorizedEntry = signRecoveryFixtureEntry(
    fixture,
    fixture.ready,
    { kind: 'membership', change: authorization },
    fixture.ready.log.head.stateHash,
  );
  const certifiedAuthorization = certifyRecoveryFixtureEntry(
    fixture,
    fixture.ready,
    authorizedEntry,
    [0, 1, 2, 3],
  );
  const authorized = advanceRecoveryFixture(fixture.ready, certifiedAuthorization);
  entries.push(certifiedAuthorization);
  await participant.refreshBootstrap(
    value(encodeOnlineTransferBootstrap({ start: record, entries })),
  );
  const authorizationRef = transferEntryRef(authorizedEntry);
  await participant.close();
  const locatorKey = `online-transfer/destination/${record.genesisDigest}/${attemptId}`;
  const priorLocator = await store.load(locatorKey);
  if (!priorLocator) throw new Error('Transfer locator was not saved');
  const locator = canonicalDecode(priorLocator);
  if (!locator || typeof locator !== 'object' || Array.isArray(locator))
    throw new Error('Transfer locator is malformed');
  const cappedLocator = canonicalEncode({ ...locator, refreshes: 8 });
  expect(await store.compareAndSwap(locatorKey, priorLocator, cappedLocator)).toBe(true);
  priorLocator.fill(0);
  cappedLocator.fill(0);
  participant = await OnlineTransferDestination.create({
    attemptId,
    mode: 'resume',
    expected,
    identity,
    store,
    importStore: imports,
  });
  const ordinary = certifyRecoveryFixtureFirstBeacon(fixture, authorized);
  const afterOrdinary = advanceRecoveryFixture(authorized, ordinary);
  entries.push(ordinary);
  await expect(
    participant.refreshBootstrap(value(encodeOnlineTransferBootstrap({ start: record, entries }))),
  ).rejects.toThrow(/refresh budget exhausted/);
  const cancellation = {
    kind: 'transfer-cancel' as const,
    genesisDigest: record.genesisDigest,
    authorization: authorizationRef,
    parent: transferEntryRef(afterOrdinary.log.head),
  };
  const cancelEntry = signRecoveryFixtureEntry(
    fixture,
    afterOrdinary,
    { kind: 'membership', change: cancellation },
    afterOrdinary.log.head.stateHash,
  );
  const certifiedCancel = certifyRecoveryFixtureEntry(
    fixture,
    afterOrdinary,
    cancelEntry,
    [0, 1, 2, 3],
  );
  advanceRecoveryFixture(afterOrdinary, certifiedCancel);
  entries.push(certifiedCancel);
  const cancelledBootstrap = value(encodeOnlineTransferBootstrap({ start: record, entries }));
  const originalSwap = store.compareAndSwap.bind(store);
  let locatorWrites = 0;
  const interruptedFinal = vi
    .spyOn(store, 'compareAndSwap')
    .mockImplementation((key, before, after) => {
      if (key.startsWith('online-transfer/destination/') && ++locatorWrites === 2) {
        interruptedFinal.mockRestore();
        throw new Error('interrupted after certified cancellation marker');
      }
      return originalSwap(key, before, after);
    });
  await expect(participant.observeCancellation(cancelledBootstrap)).rejects.toThrow(/interrupted/);
  expect(await imports.readOutcome(record.gameId, authorizationRef)).toEqual({ kind: 'cancelled' });
  expect(await loadOnlineGameRecord(store, record.gameId)).toBeNull();
  await participant.close();
  const resumed = await OnlineTransferDestination.create({
    attemptId,
    mode: 'resume',
    expected,
    identity,
    store,
    importStore: imports,
  });
  expect(resumed.snapshot().phase).toBe('cancelled');
  expect(resumed.snapshot().authorization).toEqual(authorizationRef);
  expect(resumed.snapshot().outcome).toEqual({
    authorization: authorizationRef,
    entry: transferEntryRef(cancelEntry),
    outcome: 'cancelled',
  });
  expect(resumed.snapshot().head).toEqual(transferEntryRef(cancelEntry));
  await expect(resumed.prepareOffer({ seat: 0, mode: 'live' })).rejects.toThrow(/Finalized/);
  await resumed.observeCancellation(cancelledBootstrap);
  await resumed.close();
  identity.dispose();
}, 120_000);

test.each(['pre-removal', 'retired'] as const)(
  'returned human promotes over a valid %s journal on the same device',
  async (oldJournalPhase) => {
    installFactory();
    const fixture = createRecoveryFixture({ masterBackedBeacon: true, lobbyId: 'returnroom' });
    const record = publicRecord(fixture);
    const oldGameKey = recoveryFixtureKey(fixture, 0);
    const oldDevice = identityFromSecret(
      hashValue({
        domain: 'cp2p/test/online-device/v1',
        gamePeer: fixture.genesis.seats[0]?.publicKey,
      }),
    );
    const identity = {
      ...oldDevice,
      dispose() {
        this.secretKey.fill(0);
      },
    };
    const bot = identityFromSecret(new Uint8Array(32).fill(81));
    const recoveryStatement = recoveryFixtureReadiness(fixture, fixture.ready, bot.peerId);
    const recoveryAuthorization = signRecoveryFixtureAuthorization(
      fixture,
      recoveryStatement,
      bot.secretKey,
    );
    const recoveryAuthEntry = signRecoveryFixtureEntry(
      fixture,
      fixture.ready,
      { kind: 'membership', change: recoveryAuthorization },
      fixture.ready.log.head.stateHash,
    );
    const recoveryAuth = certifyRecoveryFixtureEntry(
      fixture,
      fixture.ready,
      recoveryAuthEntry,
      [1, 2, 3],
    );
    const recoveryPending = advanceRecoveryFixture(fixture.ready, recoveryAuth);
    const recoveryActivation = signRecoveryFixtureActivation(
      fixture,
      recoveryPending,
      recoveryAuthEntry,
    );
    const botStatus = value(
      fixture.source.engine.apply(recoveryPending.log.state, {
        kind: 'system',
        type: 'SEAT_STATUS',
        seat: 0,
        status: 'bot',
      }),
    );
    const recoveryActivationEntry = signRecoveryFixtureEntry(
      fixture,
      recoveryPending,
      { kind: 'membership', change: recoveryActivation },
      toHex(hashValue(botStatus.state)),
    );
    const recoveryActivated = certifyRecoveryFixtureEntry(
      fixture,
      recoveryPending,
      recoveryActivationEntry,
      [1, 2, 3],
    );
    const recovered = advanceRecoveryFixture(recoveryPending, recoveryActivated);
    expect(recovered.log.authority?.controllers[0]).toMatchObject({
      kind: 'bot',
      publicKey: bot.peerId,
    });

    // Preserve the real former-human binding and certified removal history. We
    // deliberately delay its retired marker to prove promotion refuses that gap.
    const oldBinding = canonicalEncode({
      protocol: 'online-game-keys-v1',
      genesisDigest: record.genesisDigest,
      devicePeer: oldDevice.peerId,
      humanSeat: 0,
      seats: [
        {
          seat: 0,
          kind: 'human',
          peerId: fixture.genesis.seats[0]?.publicKey,
          signingKey: oldGameKey,
          master: scalarToBytes(17n),
        },
      ],
    });
    const priorSafety = value(createConsensusState(fixture.ready, 0));
    const retired = value(createRetiredSafety(fixture.ready, recoveryAuth, 0, priorSafety));
    const oldEntries =
      oldJournalPhase === 'pre-removal'
        ? [...fixture.deckEntries]
        : [...fixture.deckEntries, recoveryAuth];
    const first = oldEntries[0];
    if (!first || first.certificate.length < 4) throw new Error('Four-voter certificate missing');
    const alternateFirst = { ...first, certificate: first.certificate.slice(0, 3) };
    expect(entryHash(alternateFirst.entry)).toBe(entryHash(first.entry));
    expect(canonicalEncode(alternateFirst)).not.toEqual(canonicalEncode(first));
    const oldJournal = new IndexedDbProtocolJournal(record.gameId, {
      keyBinding: {
        recordKey: `online-game/${record.genesisDigest}/keys`,
        bytes: oldBinding,
      },
    });
    expect(await oldJournal.initialize(fixture.genesisEntry, Uint8Array.of(1))).toBe(true);
    for (const certified of [alternateFirst, ...oldEntries.slice(1)])
      // oxlint-disable-next-line no-await-in-loop -- Build one exact certified retired source journal.
      expect(await oldJournal.commit(certified.entry.seq, 0, certified, Uint8Array.of(1))).toBe(
        true,
      );
    await oldJournal.close();

    if (oldJournalPhase === 'pre-removal') {
      const saved = new IndexedDbProtocolJournal(record.gameId, {
        keyBinding: {
          recordKey: `online-game/${record.genesisDigest}/keys`,
          bytes: oldBinding,
        },
      });
      const current = await saved.load();
      if (!current) throw new Error('Former voter journal is missing');
      if (
        !(await saved.saveSafety(
          current.height,
          current.safety.revision,
          canonicalEncode(priorSafety),
        ))
      )
        throw new Error('Could not persist the former active voter safety');
      await saved.close();
    }

    const store = new IndexedDbByteStore({ lockProvider: async (_name, task) => task() });
    expect(await store.load(`online-game/${record.genesisDigest}/keys`)).toEqual(oldBinding);
    const imports = new TransferImportStore(store);
    const expected = { gameId: record.gameId, genesisDigest: record.genesisDigest };
    const entries = [...fixture.deckEntries, recoveryAuth, recoveryActivated];
    const participant = await OnlineTransferDestination.create({
      attemptId: toBase64Url(new Uint8Array(32).fill(7)),
      mode: 'new',
      expected,
      identity,
      store,
      importStore: imports,
      bootstrapBytes: value(encodeOnlineTransferBootstrap({ start: record, entries })),
    });
    const offer = await participant.prepareOffer({ seat: 0, mode: 'return' });
    expect(offer.returnIntent?.signer).toBe('last-human-game-key');
    const transferAuthEntry = signRecoveryFixtureEntry(
      fixture,
      recovered,
      { kind: 'membership', change: offer },
      recovered.log.head.stateHash,
    );
    const transferAuth = certifyRecoveryFixtureEntry(
      fixture,
      recovered,
      transferAuthEntry,
      [1, 2, 3],
    );
    const transferPending = advanceRecoveryFixture(recovered, transferAuth);
    entries.push(transferAuth);
    await participant.refreshBootstrap(
      value(encodeOnlineTransferBootstrap({ start: record, entries })),
    );
    const sourceJournal = new MemoryProtocolJournal();
    expect(await sourceJournal.initialize(fixture.genesisEntry, Uint8Array.of(1))).toBe(true);
    for (const certified of entries)
      // oxlint-disable-next-line no-await-in-loop -- Preserve the real certified source ancestry.
      expect(await sourceJournal.commit(certified.entry.seq, 0, certified, Uint8Array.of(1))).toBe(
        true,
      );
    const recoveryStore = new IndexedDbByteStore({ lockProvider: async (_name, task) => task() });
    value(
      await persistRecoveryPrivate(
        recovered.log,
        transferEntryRef(recoveryAuthEntry),
        1,
        [{ seat: 0, master: scalarToBytes(17n) }],
        recoveryStore,
      ),
    );
    const packet = value(
      await prepareTransferPrivate({
        journal: sourceJournal,
        engine: createBaseEngine(),
        policy: fixture.policy,
        authorization: transferEntryRef(transferAuthEntry),
        sourceSeat: 1,
        sourceKind: 'current-controller',
        signingKey: recoveryFixtureKey(fixture, 1),
        entropy: new Uint8Array(32).fill(33),
        nonce: new Uint8Array(32).fill(34),
        outbox: store,
        recoveryPrivateStore: recoveryStore,
      }),
    );
    await participant.importPacket(packet);
    const readiness = await participant.prepareReadiness();
    const humanStatus = value(
      fixture.source.engine.apply(transferPending.log.state, {
        kind: 'system',
        type: 'SEAT_STATUS',
        seat: 0,
        status: 'active',
      }),
    );
    const activationEntry = signRecoveryFixtureEntry(
      fixture,
      transferPending,
      { kind: 'membership', change: readiness },
      toHex(hashValue(humanStatus.state)),
    );
    const activation = certifyRecoveryFixtureEntry(
      fixture,
      transferPending,
      activationEntry,
      [1, 2, 3],
    );
    advanceRecoveryFixture(transferPending, activation);
    entries.push(activation);
    const activatedBootstrap = value(encodeOnlineTransferBootstrap({ start: record, entries }));
    if (oldJournalPhase === 'pre-removal') {
      const conflictingEntry = signRecoveryFixtureEntry(
        fixture,
        fixture.ready,
        { kind: 'membership', change: { kind: 'seat-offline', seat: 1 } },
        fixture.ready.log.head.stateHash,
      );
      const conflicting = certifyRecoveryFixtureEntry(
        fixture,
        fixture.ready,
        conflictingEntry,
        [1, 2, 3],
      );
      const checkedDecision = restoreConsensusState(
        { ...priorSafety, decision: conflicting },
        fixture.ready,
        0,
      );
      if (!checkedDecision.ok)
        throw new Error(`Conflicting decision fixture: ${checkedDecision.error.message}`);
      const safetyJournal = new IndexedDbProtocolJournal(record.gameId, {
        keyBinding: {
          recordKey: `online-game/${record.genesisDigest}/keys`,
          bytes: oldBinding,
        },
      });
      const current = await safetyJournal.load();
      if (!current) throw new Error('Former voter journal is missing');
      if (
        !(await safetyJournal.saveSafety(
          current.height,
          current.safety.revision,
          canonicalEncode({ ...priorSafety, decision: conflicting }),
        ))
      )
        throw new Error('Could not persist conflicting decision');
      let rejected = false;
      let rejection = '';
      try {
        await participant.observeActivation(activatedBootstrap);
      } catch (error) {
        rejection = String(error);
        rejected = /conflicting certified decision/.test(rejection);
      }
      if (!rejected) throw new Error(`Conflicting certified decision was discarded: ${rejection}`);
      const persisted = await safetyJournal.load();
      if (!persisted) throw new Error('Former voter journal disappeared');
      if (
        !(await safetyJournal.saveSafety(
          persisted.height,
          persisted.safety.revision,
          canonicalEncode(priorSafety),
        ))
      )
        throw new Error('Could not restore original voter safety');
      await safetyJournal.close();
    }
    if (oldJournalPhase === 'retired') {
      let rejected = false;
      try {
        await participant.observeActivation(activatedBootstrap);
      } catch (error) {
        rejected = /not retired/.test(String(error));
      }
      if (!rejected) throw new Error('Unretired post-removal journal was accepted');
      const retiringJournal = new IndexedDbProtocolJournal(record.gameId, {
        keyBinding: {
          recordKey: `online-game/${record.genesisDigest}/keys`,
          bytes: oldBinding,
        },
      });
      const incomplete = await retiringJournal.load();
      if (!incomplete) throw new Error('Former voter journal is missing');
      if (
        !(await retiringJournal.saveSafety(
          incomplete.height,
          incomplete.safety.revision,
          canonicalEncode(retired),
        ))
      )
        throw new Error('Could not persist the certified retirement marker');
      await retiringJournal.close();
    }
    expect(await participant.observeActivation(activatedBootstrap)).toBe(record.gameId);
    expect(participant.snapshot().phase).toBe('promoted');
    await participant.close();
    identity.dispose();
    oldBinding.fill(0);
  },
  120_000,
);
