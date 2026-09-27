import { canonicalDecode, canonicalEncode, hashValue } from '@cp2p/codec';
import {
  G,
  encodePoint,
  identityFromSecret,
  scalePoint,
  scalarToBytes,
  signObject,
} from '@cp2p/crypto';
import {
  createConsensusState,
  entryHash,
  genesisDigest,
  replayCertifiedPrefix,
} from '@cp2p/protocol';
import type { CertifiedEntry } from '@cp2p/protocol';
import {
  TRANSFER_DESTINATION_CHECK_DOMAIN,
  TRANSFER_DEVICE_DOMAIN,
  TRANSFER_GAME_KEY_DOMAIN,
  TRANSFER_OWNER_GAME_DOMAIN,
  advanceRecoveryFixture,
  certifyRecoveryFixtureEntry,
  createRetiredSafety,
  createRecoveryFixture,
  recoveryFixtureKey,
  signRecoveryFixtureEntry,
  transferCheckDigest,
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
import { openDB } from 'idb';
import { afterEach, expect, test, vi } from 'vitest';
import { acquireActiveGameWriterLease } from './game-writer.js';
import { IndexedDbByteStore } from './indexed-db-byte-store.js';
import { IndexedDbProtocolJournal } from './indexed-db-protocol-journal.js';
import { TransferImportStore, transferImportFinalKey } from './transfer-import-store.js';

class TestLocks implements Pick<LockManager, 'request'> {
  readonly held = new Set<string>();
  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
  request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
  async request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    maybeCallback?: LockGrantedCallback<T>,
  ): Promise<T> {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (!callback) throw new Error('Missing lock callback');
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name, mode: 'exclusive' });
    } finally {
      this.held.delete(name);
    }
  }
}

function installFactory(): void {
  vi.stubGlobal('indexedDB', new IDBFactory());
  for (const [name, value] of Object.entries({
    IDBCursor,
    IDBDatabase,
    IDBIndex,
    IDBKeyRange,
    IDBObjectStore,
    IDBRequest,
    IDBTransaction,
  }))
    vi.stubGlobal(name, value);
}

afterEach(() => vi.unstubAllGlobals());

function verifiedTransfer(sameDevice = false) {
  const fixture = createRecoveryFixture({ masterBackedBeacon: true });
  const parent = fixture.ready;
  const controller = parent.log.authority?.controllers.find((item) => item.seat === 0);
  if (!controller || !parent.log.crypto) throw new Error('Missing verified controller');
  const device = identityFromSecret(
    sameDevice
      ? hashValue({ domain: 'cp2p/test/online-device/v1', gamePeer: controller.publicKey })
      : new Uint8Array(32).fill(111),
  );
  const game = identityFromSecret(new Uint8Array(32).fill(112));
  const authorizationStatement = {
    protocol: 'seat-transfer-v1' as const,
    genesisDigest: genesisDigest(fixture.genesis),
    anchor: transferEntryRef(parent.log.head),
    validUntilSeq: parent.log.head.seq + 64,
    mode: 'live' as const,
    seat: 0 as const,
    currentController: {
      publicKey: controller.publicKey,
      kind: controller.kind,
      activatedAt: controller.activatedAt,
      hostSeat: controller.hostSeat,
    },
    recovery: null,
    nextEpoch: parent.membership.epoch + 1,
    destination: {
      devicePeer: device.peerId,
      gamePeer: game.peerId,
      transferEncryptionKey: encodePoint(scalePoint(G, 147n)),
    },
    replacements: [
      {
        seat: 0 as const,
        oldPublicKey: controller.publicKey,
        newPublicKey: game.peerId,
        newHostSeat: 0 as const,
      },
    ],
  };
  const authorization = {
    kind: 'transfer-authorize' as const,
    statement: authorizationStatement,
    destinationDeviceSig: signObject(
      TRANSFER_DEVICE_DOMAIN,
      authorizationStatement,
      device.secretKey,
    ),
    destinationGameSig: signObject(
      TRANSFER_GAME_KEY_DOMAIN,
      authorizationStatement,
      game.secretKey,
    ),
    replacementKeySigs: [],
    ownerIntent: {
      signer: 'current-game' as const,
      sig: signObject(
        TRANSFER_OWNER_GAME_DOMAIN,
        authorizationStatement,
        recoveryFixtureKey(fixture, 0),
      ),
    },
  };
  const authorizedEntry = signRecoveryFixtureEntry(
    fixture,
    parent,
    { kind: 'membership', change: authorization },
    parent.log.head.stateHash,
  );
  const authorizedCertificate = certifyRecoveryFixtureEntry(
    fixture,
    parent,
    authorizedEntry,
    [0, 1, 2, 3],
  );
  const authorized = advanceRecoveryFixture(parent, authorizedCertificate);
  const authorizationRef = transferEntryRef(authorizedEntry);
  const activationStatement = {
    protocol: 'seat-transfer-activation-v1' as const,
    genesisDigest: authorizationStatement.genesisDigest,
    authorization: authorizationRef,
    parent: transferEntryRef(authorized.log.head),
    nextEpoch: authorizationStatement.nextEpoch,
    destinationDevice: device.peerId,
    destinationGame: game.peerId,
    replacements: authorizationStatement.replacements,
    checkDigest: transferCheckDigest(authorized.log, authorizationRef),
  };
  const destinationCheck = signObject(
    TRANSFER_DESTINATION_CHECK_DOMAIN,
    activationStatement,
    game.secretKey,
  );
  const activation = {
    kind: 'transfer-activate' as const,
    statement: activationStatement,
    destinationCheck,
    replacementChecks: [],
  };
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
  const entries: CertifiedEntry[] = [...fixture.deckEntries, authorizedCertificate];
  const bindingBytes = canonicalEncode({
    protocol: 'online-game-keys-v1',
    genesisDigest: authorizationStatement.genesisDigest,
    devicePeer: device.peerId,
    humanSeat: 0,
    seats: [
      {
        seat: 0,
        kind: 'human',
        peerId: game.peerId,
        signingKey: game.secretKey,
        master: scalarToBytes(17n),
      },
    ],
  });
  const oldBindingBytes = canonicalEncode({
    protocol: 'online-game-keys-v1',
    genesisDigest: authorizationStatement.genesisDigest,
    devicePeer: device.peerId,
    humanSeat: 0,
    seats: [
      {
        seat: 0,
        kind: 'human',
        peerId: controller.publicKey,
        signingKey: recoveryFixtureKey(fixture, 0),
        master: scalarToBytes(17n),
      },
    ],
  });
  return {
    fixture,
    entries,
    authorizationRef,
    activationStatement,
    destinationCheck,
    activationCertificate,
    bindingBytes,
    oldBindingBytes,
    device,
    game,
    authorized,
  };
}

test('durable pending import remains inert until exact certified activation promotes fresh safety', async () => {
  installFactory();
  const data = verifiedTransfer();
  const locks = new TestLocks();
  const store = new TransferImportStore();
  const stageInput = {
    gameId: data.fixture.genesis.gameId,
    authorization: data.authorizationRef,
    destinationGameKey: data.game.peerId,
    bindingBytes: data.bindingBytes,
    sealedPackage: Uint8Array.of(1),
    privateReplayBytes: Uint8Array.of(2),
    genesis: data.fixture.genesisEntry,
    entries: data.entries,
  };
  const stageKey = await store.stage(stageInput, data.fixture.source.engine, data.fixture.policy);
  const boundedStage = new TransferImportStore(new IndexedDbByteStore({ maxRecordBytes: 1 }));
  await expect(
    boundedStage.stage(stageInput, data.fixture.source.engine, data.fixture.policy),
  ).rejects.toThrow(/oversized/);
  await boundedStage.close();
  const journal = new IndexedDbProtocolJournal(data.fixture.genesis.gameId, {
    keyBinding: {
      recordKey: `online-game/${genesisDigest(data.fixture.genesis)}/keys`,
      bytes: data.bindingBytes,
    },
  });
  expect(await journal.load()).toBeNull();
  await store.saveReadiness(stageKey, {
    protocol: 'seat-transfer-readiness-v1',
    statement: data.activationStatement,
    destinationCheck: data.destinationCheck,
    replacementChecks: [],
  });
  const database = await openDB('cp2p', 2);
  const extraStageKey = `${stageKey}/older-parent`;
  await database.put('bytes', Uint8Array.of(7), extraStageKey);
  database.close();
  const options = {
    stageKey,
    activation: data.activationCertificate,
    engine: data.fixture.source.engine,
    policy: data.fixture.policy,
    expectedActive: null,
    leaseOptions: { lockManager: locks },
  };
  const narrowLimit = Math.max(
    canonicalEncode(data.activationCertificate).byteLength,
    data.bindingBytes.byteLength,
  );
  expect(canonicalEncode(data.fixture.genesisEntry).byteLength).toBeGreaterThan(narrowLimit);
  const narrow = new IndexedDbProtocolJournal(data.fixture.genesis.gameId, {
    maxRecordBytes: narrowLimit,
    keyBinding: {
      recordKey: `online-game/${genesisDigest(data.fixture.genesis)}/keys`,
      bytes: data.bindingBytes,
    },
  });
  await expect(narrow.promoteTransfer(options)).rejects.toThrow(/record/i);
  expect(await narrow.load()).toBeNull();
  await narrow.close();
  const competing = await acquireActiveGameWriterLease(data.fixture.genesis.gameId, {
    lockManager: locks,
  });
  expect(competing).not.toBeNull();
  expect(await journal.promoteTransfer(options)).toBe(false);
  await competing?.close();
  expect(await journal.promoteTransfer(options)).toBe(true);
  expect(await store.readOutcome(data.fixture.genesis.gameId, data.authorizationRef)).toEqual({
    kind: 'promoted',
    activation: {
      seq: data.activationCertificate.entry.seq,
      hash: entryHash(data.activationCertificate.entry),
    },
  });
  expect(await store.load(stageKey)).toBeNull();
  expect(await store.loadReadiness(stageKey)).toBeNull();
  const afterPromotion = await openDB('cp2p', 2);
  expect(await afterPromotion.get('bytes', extraStageKey)).toBeUndefined();
  expect(
    await afterPromotion.get(
      'bytes',
      transferImportFinalKey({
        gameId: data.fixture.genesis.gameId,
        authorization: data.authorizationRef,
      }),
    ),
  ).toBeInstanceOf(Uint8Array);
  afterPromotion.close();
  await expect(
    store.stage(stageInput, data.fixture.source.engine, data.fixture.policy),
  ).rejects.toThrow(/finalized/);
  const loaded = await journal.load();
  if (!loaded) throw new Error('Promoted journal is absent');
  expect(loaded?.entries).toEqual([...data.entries, data.activationCertificate]);
  expect(loaded?.height).toBe(data.activationCertificate.entry.seq + 1);
  expect(loaded?.safety.revision).toBe(0);
  const safety = canonicalDecode(loaded.safety.bytes);
  expect(safety).toMatchObject({
    epoch: 1,
    localSeat: 0,
    localPublicKey: data.game.peerId,
    height: data.activationCertificate.entry.seq + 1,
    parentHash: entryHash(data.activationCertificate.entry),
    round: 1,
    votes: [],
  });
  const replay = replayCertifiedPrefix(
    data.fixture.genesisEntry,
    loaded?.entries ?? [],
    data.fixture.source.engine,
    data.fixture.policy,
  );
  expect(replay.ok).toBe(true);
  const selectiveReset = await openDB('cp2p', 2);
  const removal = selectiveReset.transaction(
    ['games', 'entries', 'consensus', 'bytes'],
    'readwrite',
  );
  await removal.objectStore('games').delete(data.fixture.genesis.gameId);
  await removal.objectStore('consensus').delete(data.fixture.genesis.gameId);
  await removal
    .objectStore('bytes')
    .delete(`online-game/${genesisDigest(data.fixture.genesis)}/keys`);
  for (const key of await removal.objectStore('entries').getAllKeys())
    if (Array.isArray(key) && key[0] === data.fixture.genesis.gameId)
      await removal.objectStore('entries').delete(key);
  await removal.done;
  selectiveReset.close();
  await expect(journal.promoteTransfer(options)).rejects.toThrow(/missing|finalized/);
  await expect(
    store.stage(stageInput, data.fixture.source.engine, data.fixture.policy),
  ).rejects.toThrow(/finalized/);
  await journal.close();
  await store.close();
}, 30_000);

test('stale activation, conflicting immutable staging and partial destination journal fail closed', async () => {
  installFactory();
  const data = verifiedTransfer();
  const store = new TransferImportStore();
  const stage = {
    gameId: data.fixture.genesis.gameId,
    authorization: data.authorizationRef,
    destinationGameKey: data.game.peerId,
    bindingBytes: data.bindingBytes,
    sealedPackage: Uint8Array.of(1),
    privateReplayBytes: Uint8Array.of(2),
    genesis: data.fixture.genesisEntry,
    entries: data.entries,
  };
  const stageKey = await store.stage(stage, data.fixture.source.engine, data.fixture.policy);
  await expect(
    store.stage(
      { ...stage, privateReplayBytes: Uint8Array.of(9) },
      data.fixture.source.engine,
      data.fixture.policy,
    ),
  ).rejects.toThrow('different bytes');
  await store.saveReadiness(stageKey, {
    protocol: 'seat-transfer-readiness-v1',
    statement: data.activationStatement,
    destinationCheck: data.destinationCheck,
    replacementChecks: [],
  });
  const journal = new IndexedDbProtocolJournal(data.fixture.genesis.gameId, {
    keyBinding: {
      recordKey: `online-game/${genesisDigest(data.fixture.genesis)}/keys`,
      bytes: data.bindingBytes,
    },
  });
  const options = {
    stageKey,
    activation: data.activationCertificate,
    engine: data.fixture.source.engine,
    policy: data.fixture.policy,
    expectedActive: null,
    leaseOptions: { lockManager: new TestLocks() },
  };
  const stale = {
    ...data.activationCertificate,
    entry: { ...data.activationCertificate.entry, prevHash: '0'.repeat(64) },
  };
  await expect(journal.promoteTransfer({ ...options, activation: stale })).rejects.toThrow(
    'Activation is not the exact next entry',
  );
  const database = await openDB('cp2p', 2);
  await database.put('consensus', Uint8Array.of(1), data.fixture.genesis.gameId);
  database.close();
  await expect(journal.promoteTransfer(options)).rejects.toThrow(/partial journal state/);
  await journal.close();
  await store.close();
});

test('certified cancellation erases staged secrets and prevents old-parent restaging', async () => {
  installFactory();
  const data = verifiedTransfer();
  const store = new TransferImportStore();
  const input = {
    gameId: data.fixture.genesis.gameId,
    authorization: data.authorizationRef,
    destinationGameKey: data.game.peerId,
    bindingBytes: data.bindingBytes,
    sealedPackage: Uint8Array.of(1),
    privateReplayBytes: Uint8Array.of(2),
    genesis: data.fixture.genesisEntry,
    entries: data.entries,
  };
  const key = await store.stage(input, data.fixture.source.engine, data.fixture.policy);
  await store.saveReadiness(key, {
    protocol: 'seat-transfer-readiness-v1',
    statement: data.activationStatement,
    destinationCheck: data.destinationCheck,
    replacementChecks: [],
  });
  const change = {
    kind: 'transfer-cancel' as const,
    genesisDigest: genesisDigest(data.fixture.genesis),
    authorization: data.authorizationRef,
    parent: transferEntryRef(data.authorized.log.head),
  };
  const entry = signRecoveryFixtureEntry(
    data.fixture,
    data.authorized,
    { kind: 'membership', change },
    data.authorized.log.head.stateHash,
  );
  const cancellation = certifyRecoveryFixtureEntry(
    data.fixture,
    data.authorized,
    entry,
    [0, 1, 2, 3],
  );
  const closing = {
    gameId: data.fixture.genesis.gameId,
    authorization: data.authorizationRef,
    genesis: data.fixture.genesisEntry,
    entries: [...data.entries, cancellation],
    engine: data.fixture.source.engine,
    policy: data.fixture.policy,
  };
  await expect(store.cancelCertified({ ...closing, entries: data.entries })).rejects.toThrow(
    /certified cancellation/,
  );
  expect(await store.load(key)).not.toBeNull();
  await store.cancelCertified(closing);
  expect(await store.load(key)).toBeNull();
  expect(await store.loadReadiness(key)).toBeNull();
  expect(await store.readOutcome(data.fixture.genesis.gameId, data.authorizationRef)).toEqual({
    kind: 'cancelled',
  });
  await store.cancelCertified(closing);
  await expect(store.stage(input, data.fixture.source.engine, data.fixture.policy)).rejects.toThrow(
    /finalized/,
  );
  await store.close();
}, 30_000);

test('transfer outcome lookup distinguishes absence and rejects malformed or misbound markers', async () => {
  installFactory();
  const bytes = new IndexedDbByteStore();
  const store = new TransferImportStore(bytes);
  const authorization = { seq: 7, hash: 'a'.repeat(64) };
  expect(await store.readOutcome('outcome-missing', authorization)).toEqual({ kind: 'missing' });

  const mismatched = {
    outcome: 'cancelled',
    authorization: { seq: 7, hash: 'b'.repeat(64) },
  };
  await bytes.putIfAbsent(
    transferImportFinalKey({ gameId: 'outcome-mismatch', authorization }),
    canonicalEncode(mismatched),
  );
  await expect(store.readOutcome('outcome-mismatch', authorization)).rejects.toThrow(
    /another authorization/,
  );

  const malformed = {
    outcome: 'promoted',
    authorization,
    activation: { seq: 8, hash: 'c'.repeat(64) },
    privateMaterial: 'unexpected',
  };
  await bytes.putIfAbsent(
    transferImportFinalKey({ gameId: 'outcome-malformed', authorization }),
    canonicalEncode(malformed),
  );
  await expect(store.readOutcome('outcome-malformed', authorization)).rejects.toThrow(
    /Invalid key/,
  );
  await bytes.putIfAbsent(
    transferImportFinalKey({ gameId: 'outcome-oversized', authorization }),
    new Uint8Array(1025),
  );
  await expect(store.readOutcome('outcome-oversized', authorization)).rejects.toThrow(
    /record limit/,
  );
  await store.close();
}, 10_000);

test('same-device rekey replaces a retired generation and its safety atomically', async () => {
  installFactory();
  const data = verifiedTransfer(true);
  const recordKey = `online-game/${genesisDigest(data.fixture.genesis)}/keys`;
  const oldSafety = createConsensusState(data.authorized, 0);
  if (!oldSafety.ok) throw new Error(oldSafety.error.message);
  const database = await openDB('cp2p', 2, {
    upgrade(db) {
      db.createObjectStore('bytes');
      db.createObjectStore('games');
      db.createObjectStore('entries');
      db.createObjectStore('consensus');
    },
  });
  const gameId = data.fixture.genesis.gameId;
  await database.put('games', canonicalEncode(data.fixture.genesisEntry), gameId);
  await Promise.all(
    data.entries.map((entry, index) =>
      database.put('entries', canonicalEncode(entry), [gameId, index + 1]),
    ),
  );
  await database.put(
    'consensus',
    canonicalEncode({
      height: data.entries.length + 1,
      revision: 7,
      safety: canonicalEncode(oldSafety.value),
    }),
    gameId,
  );
  await database.put('bytes', data.oldBindingBytes, recordKey);
  database.close();

  const store = new TransferImportStore();
  const stageKey = await store.stage(
    {
      gameId,
      authorization: data.authorizationRef,
      destinationGameKey: data.game.peerId,
      bindingBytes: data.bindingBytes,
      sealedPackage: Uint8Array.of(1),
      privateReplayBytes: Uint8Array.of(2),
      genesis: data.fixture.genesisEntry,
      entries: data.entries,
    },
    data.fixture.source.engine,
    data.fixture.policy,
  );
  await store.saveReadiness(stageKey, {
    protocol: 'seat-transfer-readiness-v1',
    statement: data.activationStatement,
    destinationCheck: data.destinationCheck,
    replacementChecks: [],
  });
  const oldJournal = new IndexedDbProtocolJournal(gameId, {
    keyBinding: { recordKey, bytes: data.oldBindingBytes },
  });
  expect((await oldJournal.load())?.height).toBe(data.entries.length + 1);
  const nextJournal = new IndexedDbProtocolJournal(gameId, {
    keyBinding: { recordKey, bytes: data.bindingBytes },
  });
  const options = {
    stageKey,
    activation: data.activationCertificate,
    engine: data.fixture.source.engine,
    policy: data.fixture.policy,
    expectedActive: {
      head: transferEntryRef(data.entries.at(-1)?.entry ?? data.fixture.genesisEntry),
      bindingBytes: data.oldBindingBytes,
    },
    leaseOptions: { lockManager: new TestLocks() },
  };
  await expect(
    nextJournal.promoteTransfer({
      ...options,
      expectedActive: { ...options.expectedActive, bindingBytes: data.bindingBytes },
    }),
  ).rejects.toThrow(/Retired material|different device|different.*seat/);
  await expect(
    nextJournal.promoteTransfer({
      ...options,
      expectedActive: {
        ...options.expectedActive,
        head: { ...options.expectedActive.head, hash: '0'.repeat(64) },
      },
    }),
  ).rejects.toThrow(/head is stale/);
  expect(await nextJournal.promoteTransfer(options)).toBe(true);
  expect((await nextJournal.load())?.safety.revision).toBe(0);
  await expect(oldJournal.load()).rejects.toThrow(/binding.*mismatched/i);
  await expect(oldJournal.saveSafety(data.entries.length + 1, 7, Uint8Array.of(1))).rejects.toThrow(
    /binding.*mismatched/i,
  );
  const persisted = await openDB('cp2p', 2);
  expect(await persisted.get('bytes', recordKey)).toEqual(data.bindingBytes);
  persisted.close();
  await oldJournal.close();
  await nextJournal.close();
  await store.close();
}, 45_000);

test('an aborted promotion leaves staging inert, and racing tabs yield one active journal', async () => {
  installFactory();
  const data = verifiedTransfer();
  const gameId = data.fixture.genesis.gameId;
  const recordKey = `online-game/${genesisDigest(data.fixture.genesis)}/keys`;
  const store = new TransferImportStore();
  const stageKey = await store.stage(
    {
      gameId,
      authorization: data.authorizationRef,
      destinationGameKey: data.game.peerId,
      bindingBytes: data.bindingBytes,
      sealedPackage: Uint8Array.of(1),
      privateReplayBytes: Uint8Array.of(2),
      genesis: data.fixture.genesisEntry,
      entries: data.entries,
    },
    data.fixture.source.engine,
    data.fixture.policy,
  );
  await store.saveReadiness(stageKey, {
    protocol: 'seat-transfer-readiness-v1',
    statement: data.activationStatement,
    destinationCheck: data.destinationCheck,
    replacementChecks: [],
  });
  const journal = () =>
    new IndexedDbProtocolJournal(gameId, {
      keyBinding: { recordKey, bytes: data.bindingBytes },
    });
  const first = journal();
  const options = {
    stageKey,
    activation: data.activationCertificate,
    engine: data.fixture.source.engine,
    policy: data.fixture.policy,
    expectedActive: null,
    leaseOptions: { lockManager: new TestLocks() },
  };
  // oxlint-disable-next-line typescript/unbound-method -- Preserve the native store receiver.
  const originalPut = IDBObjectStore.prototype.put;
  let injected = false;
  const put = vi.spyOn(IDBObjectStore.prototype, 'put');
  put.mockImplementation(function (this: IDBObjectStore, value, key) {
    const request = originalPut.call(this, value, key);
    if (!injected && this.name === 'consensus') {
      injected = true;
      request.addEventListener('success', () => this.transaction.abort(), { once: true });
    }
    return request;
  });
  try {
    await expect(first.promoteTransfer(options)).rejects.toThrow(
      /transaction.*not active|transaction.*finished|AbortError/,
    );
  } finally {
    put.mockRestore();
  }
  const afterAbort = await openDB('cp2p', 2);
  expect(await afterAbort.get('games', gameId)).toBeUndefined();
  expect(await afterAbort.get('consensus', gameId)).toBeUndefined();
  expect(await afterAbort.get('bytes', recordKey)).toBeUndefined();
  expect(await afterAbort.get('bytes', stageKey)).toBeInstanceOf(Uint8Array);
  expect(await afterAbort.get('bytes', `${stageKey}/readiness`)).toBeInstanceOf(Uint8Array);
  afterAbort.close();
  await first.close();

  const left = journal();
  const right = journal();
  const raced = await Promise.allSettled([
    left.promoteTransfer(options),
    right.promoteTransfer(options),
  ]);
  expect(raced.filter((item) => item.status === 'fulfilled' && item.value)).toHaveLength(1);
  expect((await left.load())?.height).toBe(data.activationCertificate.entry.seq + 1);
  expect(await store.load(stageKey)).toBeNull();
  await left.close();
  await right.close();
  await store.close();
}, 30_000);

test('promotes after the old journal has certified activation and persisted its retirement marker', async () => {
  installFactory();
  const data = verifiedTransfer(true);
  const gameId = data.fixture.genesis.gameId;
  const recordKey = `online-game/${genesisDigest(data.fixture.genesis)}/keys`;
  const oldSafety = createConsensusState(data.authorized, 0);
  if (!oldSafety.ok) throw new Error(oldSafety.error.message);
  const retired = createRetiredSafety(
    data.authorized,
    data.activationCertificate,
    0,
    oldSafety.value,
  );
  if (!retired.ok) throw new Error(retired.error.message);
  const database = await openDB('cp2p', 2, {
    upgrade(db) {
      db.createObjectStore('bytes');
      db.createObjectStore('games');
      db.createObjectStore('entries');
      db.createObjectStore('consensus');
    },
  });
  await database.put('games', canonicalEncode(data.fixture.genesisEntry), gameId);
  const full = [...data.entries, data.activationCertificate];
  await Promise.all(
    full.map((entry, index) =>
      database.put('entries', canonicalEncode(entry), [gameId, index + 1]),
    ),
  );
  await database.put(
    'consensus',
    canonicalEncode({
      height: full.length + 1,
      revision: 0,
      safety: canonicalEncode({ ...retired.value, parentHash: '0'.repeat(64) }),
    }),
    gameId,
  );
  await database.put('bytes', data.oldBindingBytes, recordKey);
  database.close();

  const stage = new TransferImportStore();
  const stageKey = await stage.stage(
    {
      gameId,
      authorization: data.authorizationRef,
      destinationGameKey: data.game.peerId,
      bindingBytes: data.bindingBytes,
      sealedPackage: Uint8Array.of(1),
      privateReplayBytes: Uint8Array.of(2),
      genesis: data.fixture.genesisEntry,
      entries: data.entries,
    },
    data.fixture.source.engine,
    data.fixture.policy,
  );
  await stage.saveReadiness(stageKey, {
    protocol: 'seat-transfer-readiness-v1',
    statement: data.activationStatement,
    destinationCheck: data.destinationCheck,
    replacementChecks: [],
  });
  const journal = new IndexedDbProtocolJournal(gameId, {
    keyBinding: { recordKey, bytes: data.bindingBytes },
  });
  const options = {
    stageKey,
    activation: data.activationCertificate,
    engine: data.fixture.source.engine,
    policy: data.fixture.policy,
    expectedActive: {
      head: transferEntryRef(data.activationCertificate.entry),
      bindingBytes: data.oldBindingBytes,
    },
    leaseOptions: { lockManager: new TestLocks() },
  };
  await expect(journal.promoteTransfer(options)).rejects.toThrow(
    'Existing controller was not retired',
  );
  const corrected = await openDB('cp2p', 2);
  await corrected.put(
    'consensus',
    canonicalEncode({
      height: full.length + 1,
      revision: 0,
      safety: canonicalEncode(retired.value),
    }),
    gameId,
  );
  corrected.close();
  expect(await journal.promoteTransfer(options)).toBe(true);
  expect((await journal.load())?.safety).toMatchObject({ revision: 0 });
  expect(await stage.load(stageKey)).toBeNull();
  await journal.close();
  await stage.close();
}, 30_000);
