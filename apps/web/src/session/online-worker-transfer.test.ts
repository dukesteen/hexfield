import { canonicalDecode, toBase64Url } from '@cp2p/codec';
import { scalarToBytes, signObject } from '@cp2p/crypto';
import { createBaseEngine } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import {
  advanceRecoveryFixture,
  certifyRecoveryFixtureEntry,
  createRecoveryFixture,
  recoveryFixtureKey,
  signRecoveryFixtureEntry,
  TRANSFER_OWNER_GAME_DOMAIN,
  transferEntryRef,
} from '@cp2p/protocol/testing';
import {
  genesisDigest,
  MemoryProtocolJournal,
  prepareTransferPrivate,
  validateGenesisOnlineStart,
  validateDeckCeremony,
  validateGenesisEntry,
  verifyGameSeatBindings,
  verifyLobbyFreezeAgreement,
} from '@cp2p/protocol';
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
import { IndexedDbByteStore } from '@cp2p/storage';
import { loadOrCreateOnlineIdentity } from './online-credentials.js';
import { loadOnlineGameRecord } from './online-game-records.js';
import { encodeOnlineTransferBootstrap } from './online-transfer-bootstrap.js';
import { ONLINE_WORKER_PROTOCOL } from './online-worker-messages.js';
import type { OnlineWorkerRequestBody } from './online-worker-messages.js';
import { OnlineWorkerRuntime } from './online-worker-runtime.js';

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

function request(id: number, generation: string, body: OnlineWorkerRequestBody) {
  return { protocol: ONLINE_WORKER_PROTOCOL, generation, id, body } as const;
}

function lockableStore(): IndexedDbByteStore {
  return new IndexedDbByteStore({ lockProvider: async (_name, task) => task() });
}

afterEach(() => vi.unstubAllGlobals());

test('worker destination resumes exact staged transfer before promotion, then promotes for normal game lookup', async () => {
  installFactory();
  const fixture = createRecoveryFixture({ masterBackedBeacon: true, lobbyId: 'transferqa' });
  const start = value(validateGenesisOnlineStart(fixture.genesis));
  const agreement = start.bindings.agreement;
  const record = {
    gameId: fixture.genesis.gameId,
    genesisDigest: genesisDigest(fixture.genesis),
    invite: {
      roomId: agreement.state.lobbyId,
      hostPeer: agreement.state.hostPeer,
      serverUrl: '',
    },
    agreement,
    result: {
      entry: fixture.genesisEntry,
      genesis: fixture.genesis,
      transcripts: fixture.deck.transcripts,
      bindings: start.bindings.bindings,
    },
  };
  expect(verifyLobbyFreezeAgreement(record.agreement).ok).toBe(true);
  expect(verifyGameSeatBindings(record.agreement, record.result.bindings).ok).toBe(true);
  const deckCheck = validateDeckCeremony(fixture.genesis, fixture.deck.transcripts);
  expect(
    validateGenesisEntry(fixture.genesisEntry, createBaseEngine(), {
      verifyCommitments: () => deckCheck,
    }).ok,
  ).toBe(true);

  const bootstrapEntries = [...fixture.deckEntries];
  const bootstrap = value(
    encodeOnlineTransferBootstrap({ start: record, entries: bootstrapEntries }),
  );
  const attemptId = toBase64Url(new Uint8Array(32).fill(5));
  const expected = { gameId: record.gameId, genesisDigest: record.genesisDigest };
  const credentialStore = lockableStore();
  const identity = await loadOrCreateOnlineIdentity(credentialStore, (length) =>
    new Uint8Array(length).fill(111),
  );
  const self = identity.peerId;
  identity.dispose();
  await credentialStore.close();

  const firstStore = lockableStore();
  const firstEvents: unknown[] = [];
  const firstWorker = new OnlineWorkerRuntime({
    store: firstStore,
    emit: (event) => firstEvents.push(event),
  });
  const firstGeneration = 'transfer-worker-before-restart';
  let firstId = 0;
  const firstRequest = (body: OnlineWorkerRequestBody) =>
    firstWorker.handle(request(++firstId, firstGeneration, body));
  const initialized = await firstRequest({
    kind: 'initializeTransfer',
    self,
    attemptId,
    mode: 'new',
    expected,
    bootstrapBytes: bootstrap,
  });
  if (initialized.kind !== 'initializeTransfer' || !initialized.result.ok)
    throw new Error('Worker did not initialize the transfer destination');
  expect(initialized.result.value.phase).toBe('prepared');
  const offerReply = await firstRequest({
    kind: 'prepareTransferOffer',
    seat: 0,
    mode: 'live',
  });
  if (offerReply.kind !== 'prepareTransferOffer' || !offerReply.result.ok)
    throw new Error('Worker did not prepare transfer credentials');
  const authorization = {
    ...offerReply.result.value,
    ownerIntent: {
      signer: 'current-game' as const,
      sig: signObject(
        TRANSFER_OWNER_GAME_DOMAIN,
        offerReply.result.value.statement,
        recoveryFixtureKey(fixture, 0),
      ),
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
  bootstrapEntries.push(authorizedCertificate);
  const authorizedBootstrap = value(
    encodeOnlineTransferBootstrap({ start: record, entries: bootstrapEntries }),
  );
  const refreshed = await firstRequest({
    kind: 'refreshTransferBootstrap',
    bootstrapBytes: authorizedBootstrap,
  });
  if (refreshed.kind !== 'refreshTransferBootstrap' || !refreshed.result.ok)
    throw new Error('Worker did not accept the certified authorization prefix');

  const sourceJournal = new MemoryProtocolJournal();
  expect(await sourceJournal.initialize(fixture.genesisEntry, Uint8Array.of(1))).toBe(true);
  for (const certified of fixture.deckEntries)
    // oxlint-disable-next-line no-await-in-loop -- Reproduce the exact contiguous source journal.
    expect(await sourceJournal.commit(certified.entry.seq, 0, certified, Uint8Array.of(1))).toBe(
      true,
    );
  expect(
    await sourceJournal.commit(
      authorizedCertificate.entry.seq,
      0,
      authorizedCertificate,
      Uint8Array.of(1),
    ),
  ).toBe(true);
  const packet = value(
    await prepareTransferPrivate({
      journal: sourceJournal,
      engine: fixture.source.engine,
      policy: fixture.policy,
      authorization: transferEntryRef(authorizedEntry),
      sourceSeat: 0,
      sourceKind: 'current-controller',
      signingKey: recoveryFixtureKey(fixture, 0),
      entropy: new Uint8Array(32).fill(31),
      nonce: new Uint8Array(32).fill(32),
      masters: [{ seat: 0, master: scalarToBytes(17n) }],
      outbox: firstStore,
    }),
  );
  const imported = await firstRequest({ kind: 'importTransferPacket', packet });
  if (imported.kind !== 'importTransferPacket' || !imported.result.ok)
    throw new Error('Worker did not import the authenticated transfer packet');
  expect(imported.result.value.phase).toBe('imported');
  const readinessReply = await firstRequest({ kind: 'prepareTransferReadiness' });
  if (readinessReply.kind !== 'prepareTransferReadiness' || !readinessReply.result.ok)
    throw new Error('Worker did not persist transfer readiness');
  expect(readinessReply.result.value).toMatchObject({
    kind: 'transfer-activate',
    statement: { authorization: transferEntryRef(authorizedEntry) },
  });
  const stagedSnapshot = await firstRequest({ kind: 'transferSnapshot' });
  expect(stagedSnapshot).toMatchObject({
    kind: 'transferSnapshot',
    result: { ok: true, value: { phase: 'ready' } },
  });
  expect(
    firstEvents.some(
      (event) =>
        typeof event === 'object' &&
        event !== null &&
        'kind' in event &&
        (event.kind === 'gameReady' || event.kind === 'session'),
    ),
  ).toBe(false);
  await expect(loadOnlineGameRecord(firstStore, record.gameId)).resolves.toBeNull();
  const channel = new MessageChannel();
  const attach = await firstRequest({
    kind: 'attachTransport',
    self,
    peers: [],
    port: channel.port1,
  });
  expect(attach).toMatchObject({
    kind: 'attachTransport',
    result: { ok: false },
  });
  const gameplay = await firstRequest({
    kind: 'validate',
    seat: 0,
    head: transferEntryRef(fixture.ready.log.head),
    command: { type: 'NOOP' },
  });
  expect(gameplay).toMatchObject({ kind: 'validate', result: { ok: false } });
  channel.port1.close();
  channel.port2.close();
  await firstRequest({ kind: 'shutdown' });

  const resumedStore = lockableStore();
  const resumedEvents: unknown[] = [];
  const resumedWorker = new OnlineWorkerRuntime({
    store: resumedStore,
    emit: (event) => resumedEvents.push(event),
  });
  const resumedReply = await resumedWorker.handle(
    request(1, 'transfer-worker-after-restart', {
      kind: 'initializeTransfer',
      self,
      attemptId,
      mode: 'resume',
      expected,
    }),
  );
  if (resumedReply.kind !== 'initializeTransfer' || !resumedReply.result.ok)
    throw new Error('Worker did not resume the staged destination');
  expect(resumedReply.result.value.phase).toBe('ready');
  expect(
    resumedEvents.some(
      (event) =>
        typeof event === 'object' &&
        event !== null &&
        'kind' in event &&
        (event.kind === 'gameReady' || event.kind === 'session'),
    ),
  ).toBe(false);

  const activation = readinessReply.result.value;
  const activationEntry = signRecoveryFixtureEntry(
    fixture,
    authorized,
    { kind: 'membership', change: activation },
    authorized.log.head.stateHash,
  );
  const activationCertificate = certifyRecoveryFixtureEntry(
    fixture,
    authorized,
    activationEntry,
    [0, 1, 2, 3],
  );
  advanceRecoveryFixture(authorized, activationCertificate);
  bootstrapEntries.push(activationCertificate);
  const activatedBootstrap = value(
    encodeOnlineTransferBootstrap({ start: record, entries: bootstrapEntries }),
  );
  const observed = await resumedWorker.handle(
    request(2, 'transfer-worker-after-restart', {
      kind: 'observeTransferActivation',
      bootstrapBytes: activatedBootstrap,
    }),
  );
  if (observed.kind !== 'observeTransferActivation' || !observed.result.ok)
    throw new Error('Worker did not promote the certified activation');
  expect(observed.result.value.gameId).toBe(record.gameId);
  expect(
    resumedEvents.some(
      (event) =>
        typeof event === 'object' &&
        event !== null &&
        'kind' in event &&
        (event.kind === 'gameReady' || event.kind === 'session'),
    ),
  ).toBe(false);
  const publicStore = lockableStore();
  await expect(loadOnlineGameRecord(publicStore, record.gameId)).resolves.toMatchObject({
    gameId: record.gameId,
    genesisDigest: record.genesisDigest,
  });
  await publicStore.close();
  // The transfer caller can send the exact parent before a final certificate,
  // including after source retirement, without parsing history on the UI thread.
  const exportStore = lockableStore();
  const exportWorker = new OnlineWorkerRuntime({ store: exportStore, emit: () => undefined });
  Reflect.set(exportWorker, 'startup', {
    game: () => ({
      gameId: record.gameId,
      session: {
        exportSave: () => ({ genesis: fixture.genesisEntry, entries: bootstrapEntries }),
        dispose: () => undefined,
      },
    }),
    close: async () => undefined,
  });
  try {
    const parent = await exportWorker.handle(
      request(1, 'prefix-export', {
        kind: 'exportTransferBootstrap',
        throughSeq: activationEntry.seq - 1,
      }),
    );
    if (parent.kind !== 'exportTransferBootstrap' || !parent.result.ok)
      throw new Error('Could not export exact certified parent');
    expect(canonicalDecode(parent.result.value)).toMatchObject({
      entries: bootstrapEntries.slice(0, -1),
    });
    const future = await exportWorker.handle(
      request(2, 'prefix-export', {
        kind: 'exportTransferBootstrap',
        throughSeq: activationEntry.seq + 1,
      }),
    );
    expect(future.result.ok).toBe(false);
  } finally {
    await exportWorker.close();
  }
  await resumedWorker.handle(request(3, 'transfer-worker-after-restart', { kind: 'shutdown' }));
  bootstrap.fill(0);
  authorizedBootstrap.fill(0);
  activatedBootstrap.fill(0);
}, 90_000);
