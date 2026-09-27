import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import {
  G,
  encodePoint,
  identityFromSecret,
  scalarToBytes,
  scalePoint,
  signObject,
} from '@cp2p/crypto';
import type { Result, Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { entryHash, genesisDigest } from './genesis.js';
import { MemoryProtocolJournal } from './journal.js';
import { persistRecoveryPrivate } from './recovery-private.js';
import { signBeaconReveal } from './beacon.js';
import { completeBeaconState, getBeaconOperation } from './beacon-state.js';
import { BEACON_EVIDENCE_PROTOCOL } from './crypto-context.js';
import {
  advanceRecoveryFixture,
  certifyRecoveryFixtureEntry,
  createRecoveryFixture,
  recoveryFixtureKey,
  recoveryFixtureReadiness,
  signRecoveryFixtureActivation,
  signRecoveryFixtureAuthorization,
  signRecoveryFixtureEntry,
} from './testing/recovery-fixture.js';
import {
  TRANSFER_BOT_CHECK_DOMAIN,
  TRANSFER_BOT_KEY_DOMAIN,
  TRANSFER_DEVICE_DOMAIN,
  TRANSFER_DESTINATION_CHECK_DOMAIN,
  TRANSFER_GAME_KEY_DOMAIN,
  TRANSFER_OWNER_GAME_DOMAIN,
  TRANSFER_RETURN_INTENT_DOMAIN,
  transferEntryRef,
  transferCheckDigest,
} from './transfer-readiness.js';
import { signEntry } from './genesis.js';
import { proposerFor } from './proposal.js';
import { signVote } from './votes.js';
import type { EntryPayload } from './types.js';
import type { ProposalContext } from './proposal.js';
import type { SeatTransferAuthorizationStatement } from './transfer-types.js';
import {
  importTransferPrivate,
  prepareTransferPrivate,
  verifyTransferPrivateEnvelope,
} from './transfer-private.js';
import type { TransferPrivateStore } from './transfer-private.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

class Store implements TransferPrivateStore {
  readonly items = new Map<string, Uint8Array>();
  readonly reads: string[] = [];
  async load(id: string) {
    this.reads.push(id);
    return this.items.get(id)?.slice() ?? null;
  }
  async putIfAbsent(id: string, bytes: Uint8Array) {
    if (this.items.has(id)) return false;
    this.items.set(id, bytes.slice());
    return true;
  }
}

class CountingStore extends Store {
  loadCount = 0;
  writes = 0;

  override async load(id: string) {
    this.loadCount += 1;
    return super.load(id);
  }

  override async putIfAbsent(id: string, bytes: Uint8Array) {
    this.writes += 1;
    return super.putIfAbsent(id, bytes);
  }
}

async function setup() {
  const fixture = createRecoveryFixture({ masterBackedBeacon: true });
  const old = fixture.ready;
  const owner = old.log.authority?.controllers[0];
  if (!owner || !old.log.crypto) throw new Error('Missing certified owner');
  const device = identityFromSecret(new Uint8Array(32).fill(109));
  const game = identityFromSecret(new Uint8Array(32).fill(110));
  const secret = scalarToBytes(111n);
  const statement: SeatTransferAuthorizationStatement = {
    protocol: 'seat-transfer-v1',
    genesisDigest: genesisDigest(fixture.genesis),
    anchor: transferEntryRef(old.log.head),
    validUntilSeq: old.log.head.seq + 1,
    mode: 'live',
    seat: 0,
    currentController: {
      publicKey: owner.publicKey,
      kind: owner.kind,
      activatedAt: owner.activatedAt,
      hostSeat: owner.hostSeat,
    },
    recovery: null,
    nextEpoch: old.log.crypto.epoch + 1,
    destination: {
      devicePeer: device.peerId,
      gamePeer: game.peerId,
      transferEncryptionKey: encodePoint(scalePoint(G, 111n)),
    },
    replacements: [
      { seat: 0, oldPublicKey: owner.publicKey, newPublicKey: game.peerId, newHostSeat: 0 },
    ],
  };
  const change = {
    kind: 'transfer-authorize' as const,
    statement,
    destinationDeviceSig: signObject(TRANSFER_DEVICE_DOMAIN, statement, device.secretKey),
    destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, statement, game.secretKey),
    replacementKeySigs: [],
    ownerIntent: {
      signer: 'current-game' as const,
      sig: signObject(TRANSFER_OWNER_GAME_DOMAIN, statement, recoveryFixtureKey(fixture, 0)),
    },
  };
  const entry = signRecoveryFixtureEntry(
    fixture,
    old,
    { kind: 'membership', change },
    old.log.head.stateHash,
  );
  const certified = certifyRecoveryFixtureEntry(fixture, old, entry, [0, 1, 2, 3]);
  const authorized = advanceRecoveryFixture(old, certified);
  const journal = new MemoryProtocolJournal();
  if (!(await journal.initialize(fixture.genesisEntry, new Uint8Array())))
    throw new Error('Could not initialize fixture journal');
  for (const item of [...fixture.deckEntries, certified]) {
    // Journal compare-and-swap height depends on the preceding certified append.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const record = await journal.load();
    if (
      !record ||
      // oxlint-disable-next-line eslint/no-await-in-loop
      !(await journal.commit(record.height, record.safety.revision, item, new Uint8Array()))
    )
      throw new Error('Could not append fixture certificate');
  }
  return { fixture, entry, authorized, journal, secret, outbox: new Store(), imports: new Store() };
}

test('certified owner seals exact affected master; destination independently rebuilds and durable retries use identical bytes', async () => {
  const source = await setup();
  const authorization = transferEntryRef(source.entry);
  const master = scalarToBytes(17n);
  const options = {
    journal: source.journal,
    engine: source.fixture.source.engine,
    policy: source.fixture.policy,
    authorization,
    sourceSeat: 0 as const,
    sourceKind: 'current-controller' as const,
    signingKey: recoveryFixtureKey(source.fixture, 0),
    entropy: new Uint8Array(32).fill(6),
    nonce: new Uint8Array(32).fill(7),
    masters: [{ seat: 0 as const, master }],
    outbox: source.outbox,
  };
  const packet = value(await prepareTransferPrivate(options));
  expect(master).toEqual(scalarToBytes(17n));
  const again = value(
    await prepareTransferPrivate({
      ...options,
      entropy: new Uint8Array(32).fill(8),
      nonce: new Uint8Array(32).fill(9),
    }),
  );
  expect(canonicalEncode(again)).toEqual(canonicalEncode(packet));
  expect(value(verifyTransferPrivateEnvelope(packet, source.authorized.log))).toEqual(packet);
  const imported = value(
    await importTransferPrivate({
      genesisEntry: source.fixture.genesisEntry,
      entries: [
        ...source.fixture.deckEntries,
        ...((await source.journal.load())?.entries.slice(-1) ?? []),
      ],
      engine: source.fixture.source.engine,
      policy: source.fixture.policy,
      authorization,
      packet,
      destinationEncryptionSecret: source.secret,
      importStore: source.imports,
    }),
  );
  expect(imported.context.log.head.seq).toBe(source.authorized.log.head.seq);
  expect(imported.masters).toEqual([{ seat: 0, master: scalarToBytes(17n) }]);
  imported.dispose();
  expect(imported.masters[0]?.master.every((byte) => byte === 0)).toBe(true);
  expect(source.imports.items.size).toBe(1);
}, 20_000);

test('tampered bindings, forged source and wrong destination key fail before private import', async () => {
  const source = await setup();
  const authorization = transferEntryRef(source.entry);
  const wrongSource = await prepareTransferPrivate({
    journal: source.journal,
    engine: source.fixture.source.engine,
    policy: source.fixture.policy,
    authorization,
    sourceSeat: 1,
    sourceKind: 'current-controller',
    signingKey: recoveryFixtureKey(source.fixture, 1),
    entropy: new Uint8Array(32).fill(6),
    nonce: new Uint8Array(32).fill(7),
    masters: [{ seat: 0, master: scalarToBytes(17n) }],
    outbox: source.outbox,
  });
  expect(wrongSource).toMatchObject({ ok: false, error: { code: 'transfer-private-source' } });
  expect(source.outbox.items.size).toBe(0);
  const packet = value(
    await prepareTransferPrivate({
      journal: source.journal,
      engine: source.fixture.source.engine,
      policy: source.fixture.policy,
      authorization,
      sourceSeat: 0,
      sourceKind: 'current-controller',
      signingKey: recoveryFixtureKey(source.fixture, 0),
      entropy: new Uint8Array(32).fill(6),
      nonce: new Uint8Array(32).fill(7),
      masters: [{ seat: 0, master: scalarToBytes(17n) }],
      outbox: source.outbox,
    }),
  );
  const forged = {
    ...packet,
    sourceSigner: {
      kind: 'current-controller' as const,
      publicKey: identityFromSecret(new Uint8Array(32).fill(50)).peerId,
    },
  };
  expect(verifyTransferPrivateEnvelope(forged, source.authorized.log).ok).toBe(false);
  expect(
    verifyTransferPrivateEnvelope(
      { ...packet, ciphertextHash: '0'.repeat(64) },
      source.authorized.log,
    ).ok,
  ).toBe(false);
  expect(
    verifyTransferPrivateEnvelope(
      { ...packet, sourceParent: { ...packet.sourceParent, hash: '0'.repeat(64) } },
      source.authorized.log,
    ).ok,
  ).toBe(false);
  const imported = await importTransferPrivate({
    genesisEntry: source.fixture.genesisEntry,
    entries: (await source.journal.load())?.entries ?? [],
    engine: source.fixture.source.engine,
    policy: source.fixture.policy,
    authorization,
    packet,
    destinationEncryptionSecret: scalarToBytes(112n),
    importStore: source.imports,
  });
  expect(imported.ok).toBe(false);
  expect(source.imports.items.size).toBe(0);
});

test('a forged source signature is rejected before replay or import-store access', async () => {
  const source = await setup();
  const packet = value(
    await prepareTransferPrivate({
      journal: source.journal,
      engine: source.fixture.source.engine,
      policy: source.fixture.policy,
      authorization: transferEntryRef(source.entry),
      sourceSeat: 0,
      sourceKind: 'current-controller',
      signingKey: recoveryFixtureKey(source.fixture, 0),
      entropy: new Uint8Array(32).fill(6),
      nonce: new Uint8Array(32).fill(7),
      masters: [{ seat: 0, master: scalarToBytes(17n) }],
      outbox: new Store(),
    }),
  );
  const forged = {
    ...packet,
    sourceSigner: {
      ...packet.sourceSigner,
      publicKey: identityFromSecret(new Uint8Array(32).fill(51)).peerId,
    },
  };
  const engine = new Proxy(source.fixture.source.engine, {
    get() {
      throw new Error('Engine replay must not run before source signature authentication');
    },
  });
  const importStore = new CountingStore();
  const imported = await importTransferPrivate({
    genesisEntry: source.fixture.genesisEntry,
    entries: (await source.journal.load())?.entries ?? [],
    engine,
    policy: source.fixture.policy,
    authorization: transferEntryRef(source.entry),
    packet: forged,
    destinationEncryptionSecret: source.secret,
    importStore,
  });
  expect(imported).toMatchObject({ ok: false, error: { code: 'transfer-private-signature' } });
  expect(importStore.loadCount).toBe(0);
  expect(importStore.writes).toBe(0);
}, 20_000);

test('Buffer inputs remain caller-owned and a malformed later master returns without writing', async () => {
  const source = await setup();
  const signingKey = Buffer.from(recoveryFixtureKey(source.fixture, 0));
  const entropy = Buffer.alloc(32, 31);
  const nonce = Buffer.alloc(32, 32);
  const firstMaster = Buffer.from(scalarToBytes(17n));
  const originals = [signingKey, entropy, nonce, firstMaster].map((item) => Buffer.from(item));
  const outbox = new CountingStore();
  const prepared = await prepareTransferPrivate({
    journal: source.journal,
    engine: source.fixture.source.engine,
    policy: source.fixture.policy,
    authorization: transferEntryRef(source.entry),
    sourceSeat: 0,
    sourceKind: 'current-controller',
    signingKey,
    entropy,
    nonce,
    masters: [
      { seat: 0, master: firstMaster },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise an invalid runtime caller beyond TypeScript's input contract.
      { seat: 1, master: undefined as unknown as Uint8Array },
    ],
    outbox,
  });
  expect(prepared).toMatchObject({ ok: false, error: { code: 'transfer-private-masters' } });
  expect([signingKey, entropy, nonce, firstMaster]).toEqual(originals);
  expect(outbox.writes).toBe(0);
  expect(outbox.items.size).toBe(0);
});

test('certified device can retransmit exact current-controller outbox bytes after key loss', async () => {
  const source = await setup();
  const authorization = transferEntryRef(source.entry);
  const outbox = new Store();
  const packet = value(
    await prepareTransferPrivate({
      journal: source.journal,
      engine: source.fixture.source.engine,
      policy: source.fixture.policy,
      authorization,
      sourceSeat: 0,
      sourceKind: 'current-controller',
      signingKey: recoveryFixtureKey(source.fixture, 0),
      entropy: new Uint8Array(32).fill(6),
      nonce: new Uint8Array(32).fill(7),
      masters: [{ seat: 0, master: scalarToBytes(17n) }],
      outbox,
    }),
  );
  const sourceGamePeer = source.fixture.genesis.seats.find(({ seat }) => seat === 0)?.publicKey;
  if (!sourceGamePeer) throw new Error('Missing original source game key');
  const deviceIdentity = identityFromSecret(
    hashValue({ domain: 'cp2p/test/online-device/v1', gamePeer: sourceGamePeer }),
  );
  expect(source.authorized.log.transfer?.routes.find(({ seat }) => seat === 0)?.devicePeer).toBe(
    deviceIdentity.peerId,
  );
  const retransmitted = value(
    await prepareTransferPrivate({
      journal: source.journal,
      engine: source.fixture.source.engine,
      policy: source.fixture.policy,
      authorization,
      sourceSeat: 0,
      sourceKind: 'certified-device',
      signingKey: deviceIdentity.secretKey,
      entropy: new Uint8Array(32).fill(8),
      nonce: new Uint8Array(32).fill(9),
      masters: [{ seat: 0, master: scalarToBytes(19n) }],
      outbox,
    }),
  );
  expect(canonicalEncode(retransmitted)).toEqual(canonicalEncode(packet));
  deviceIdentity.secretKey.fill(0);
  deviceIdentity.publicKey.fill(0);
});

test('a packet at an earlier certified parent remains importable after an ordinary certified entry and authorization expiry', async () => {
  const source = await setup();
  const authorization = transferEntryRef(source.entry);
  const options = {
    journal: source.journal,
    engine: source.fixture.source.engine,
    policy: source.fixture.policy,
    authorization,
    sourceSeat: 0 as const,
    sourceKind: 'current-controller' as const,
    signingKey: recoveryFixtureKey(source.fixture, 0),
    entropy: new Uint8Array(32).fill(6),
    nonce: new Uint8Array(32).fill(7),
    masters: [{ seat: 0 as const, master: scalarToBytes(17n) }],
    outbox: source.outbox,
  };
  const packet = value(await prepareTransferPrivate(options));
  const beacon = source.authorized.log.crypto?.beacon;
  if (!beacon) throw new Error('Missing certified beacon');
  const operation = value(getBeaconOperation(beacon));
  const reveals = source.fixture.genesis.seats.map(({ seat }) => {
    const chain = source.fixture.chains[seat];
    const link = chain?.[1];
    if (!link) throw new Error('Missing beacon link');
    return signBeaconReveal(operation, seat, link, recoveryFixtureKey(source.fixture, seat));
  });
  const outcome = value(
    completeBeaconState(beacon, reveals, source.authorized.log.state, {
      seq: source.authorized.log.head.seq + 1,
      hash: 'd'.repeat(64),
    }),
  );
  if (outcome.outcome.kind !== 'system') throw new Error('Expected a certified dice result');
  const nextState = value(
    source.fixture.source.engine.apply(source.authorized.log.state, outcome.outcome.input),
  ).state;
  const rollEntry = signRecoveryFixtureEntry(
    source.fixture,
    source.authorized,
    {
      kind: 'system',
      input: outcome.outcome.input,
      evidence: { kind: 'proof', protocol: BEACON_EVIDENCE_PROTOCOL, data: reveals },
    },
    toHex(hashValue(nextState)),
  );
  const certified = certifyRecoveryFixtureEntry(
    source.fixture,
    source.authorized,
    rollEntry,
    [0, 1, 2, 3],
  );
  const afterRoll = advanceRecoveryFixture(source.authorized, certified);
  const record = await source.journal.load();
  if (
    !record ||
    !(await source.journal.commit(
      record.height,
      record.safety.revision,
      certified,
      new Uint8Array(),
    ))
  )
    throw new Error('Could not append ordinary entry');
  expect(source.authorized.log.transfer?.authorizations[0]?.statement.validUntilSeq).toBe(
    authorization.seq,
  );
  expect(afterRoll.log.head.seq).toBeGreaterThan(authorization.seq);
  const retried = value(await prepareTransferPrivate(options));
  expect(canonicalEncode(retried)).toEqual(canonicalEncode(packet));
  const imported = value(
    await importTransferPrivate({
      genesisEntry: source.fixture.genesisEntry,
      entries: (await source.journal.load())?.entries ?? [],
      engine: source.fixture.source.engine,
      policy: source.fixture.policy,
      authorization,
      packet,
      destinationEncryptionSecret: source.secret,
      importStore: source.imports,
    }),
  );
  expect(imported.context.log.head.seq).toBe(afterRoll.log.head.seq);
  imported.dispose();
}, 30_000);

test('saved outbox cannot be reused against another certified parent or a conflicting durable slot', async () => {
  const source = await setup();
  const authorization = transferEntryRef(source.entry);
  const options = {
    journal: source.journal,
    engine: source.fixture.source.engine,
    policy: source.fixture.policy,
    authorization,
    sourceSeat: 0 as const,
    sourceKind: 'current-controller' as const,
    signingKey: recoveryFixtureKey(source.fixture, 0),
    entropy: new Uint8Array(32).fill(6),
    nonce: new Uint8Array(32).fill(7),
    masters: [{ seat: 0 as const, master: scalarToBytes(17n) }],
    outbox: source.outbox,
  };
  value(await prepareTransferPrivate(options));
  const [id, original] = [...source.outbox.items][0] ?? [];
  if (!id || !original) throw new Error('Missing immutable outbox');
  const changed: unknown = canonicalDecode(original);
  if (!changed || typeof changed !== 'object' || Array.isArray(changed))
    throw new Error('Malformed immutable outbox fixture');
  source.outbox.items.set(id, canonicalEncode({ ...changed, ciphertextHash: '0'.repeat(64) }));
  const retry = await prepareTransferPrivate(options);
  expect(retry).toMatchObject({ ok: false, error: { code: 'transfer-private-signature' } });
  expect(entryHash(source.authorized.log.head)).toBe(authorization.hash);
});

async function setupRecovered() {
  const fixture = createRecoveryFixture({ masterBackedBeacon: true });
  const replacement = identityFromSecret(new Uint8Array(32).fill(42));
  const readiness = recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId);
  const recoveryChange = signRecoveryFixtureAuthorization(
    fixture,
    readiness,
    replacement.secretKey,
  );
  const recoveryEntry = signRecoveryFixtureEntry(
    fixture,
    fixture.ready,
    { kind: 'membership', change: recoveryChange },
    fixture.ready.log.head.stateHash,
  );
  const recoveryCertified = certifyRecoveryFixtureEntry(
    fixture,
    fixture.ready,
    recoveryEntry,
    [1, 2, 3],
  );
  const afterAuthorization = advanceRecoveryFixture(fixture.ready, recoveryCertified);
  const activateRecovery = signRecoveryFixtureActivation(
    fixture,
    afterAuthorization,
    recoveryEntry,
  );
  const botState = value(
    fixture.source.engine.apply(afterAuthorization.log.state, {
      kind: 'system',
      type: 'SEAT_STATUS',
      seat: 0,
      status: 'bot',
    }),
  ).state;
  const activateEntry = signRecoveryFixtureEntry(
    fixture,
    afterAuthorization,
    { kind: 'membership', change: activateRecovery },
    toHex(hashValue(botState)),
  );
  const activateCertified = certifyRecoveryFixtureEntry(
    fixture,
    afterAuthorization,
    activateEntry,
    [1, 2, 3],
  );
  const afterRecovery = advanceRecoveryFixture(afterAuthorization, activateCertified);
  const recoveryStore = new Store();
  value(
    await persistRecoveryPrivate(
      afterRecovery.log,
      transferEntryRef(recoveryEntry),
      1,
      [{ seat: 0, master: scalarToBytes(17n) }],
      recoveryStore,
    ),
  );
  const journal = new MemoryProtocolJournal();
  if (!(await journal.initialize(fixture.genesisEntry, new Uint8Array())))
    throw new Error('Journal init failed');
  for (const certified of [...fixture.deckEntries, recoveryCertified, activateCertified]) {
    // Each next journal height depends on the preceding certified append.
    // oxlint-disable-next-line eslint/no-await-in-loop
    const record = await journal.load();
    if (!record) throw new Error('Journal lost its prefix');
    // oxlint-disable-next-line eslint/no-await-in-loop
    if (!(await journal.commit(record.height, record.safety.revision, certified, new Uint8Array())))
      throw new Error('Journal append failed');
  }
  return { fixture, afterRecovery, recoveryEntry, activateEntry, recoveryStore, journal };
}

test('certified recovered return draws only the named affected master from durable recoverer custody', async () => {
  const { fixture, afterRecovery, recoveryEntry, activateEntry, recoveryStore, journal } =
    await setupRecovered();
  const bot = afterRecovery.log.authority?.controllers[0];
  if (!bot || !afterRecovery.log.crypto) throw new Error('Missing recovered controller');
  const device = identityFromSecret(new Uint8Array(32).fill(119));
  const game = identityFromSecret(new Uint8Array(32).fill(120));
  const destinationSecret = scalarToBytes(121n);
  const statement: SeatTransferAuthorizationStatement = {
    protocol: 'seat-transfer-v1',
    genesisDigest: genesisDigest(fixture.genesis),
    anchor: transferEntryRef(afterRecovery.log.head),
    validUntilSeq: afterRecovery.log.head.seq + 1,
    mode: 'return',
    seat: 0,
    currentController: {
      publicKey: bot.publicKey,
      kind: bot.kind,
      activatedAt: bot.activatedAt,
      hostSeat: bot.hostSeat,
    },
    recovery: {
      authorization: transferEntryRef(recoveryEntry),
      activation: transferEntryRef(activateEntry),
    },
    nextEpoch: afterRecovery.log.crypto.epoch + 1,
    destination: {
      devicePeer: device.peerId,
      gamePeer: game.peerId,
      transferEncryptionKey: encodePoint(scalePoint(G, 121n)),
    },
    replacements: [
      { seat: 0, oldPublicKey: bot.publicKey, newPublicKey: game.peerId, newHostSeat: 0 },
    ],
  };
  const change = {
    kind: 'transfer-authorize' as const,
    statement,
    destinationDeviceSig: signObject(TRANSFER_DEVICE_DOMAIN, statement, device.secretKey),
    destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, statement, game.secretKey),
    replacementKeySigs: [],
    returnIntent: {
      signer: 'last-human-game-key' as const,
      sig: signObject(TRANSFER_RETURN_INTENT_DOMAIN, statement, recoveryFixtureKey(fixture, 0)),
    },
  };
  const transferEntry = signRecoveryFixtureEntry(
    fixture,
    afterRecovery,
    { kind: 'membership', change },
    afterRecovery.log.head.stateHash,
  );
  const transferCertified = certifyRecoveryFixtureEntry(
    fixture,
    afterRecovery,
    transferEntry,
    [1, 2, 3],
  );
  const pending = advanceRecoveryFixture(afterRecovery, transferCertified);
  const record = await journal.load();
  if (
    !record ||
    !(await journal.commit(
      record.height,
      record.safety.revision,
      transferCertified,
      new Uint8Array(),
    ))
  )
    throw new Error('Journal append failed');
  const authorization = transferEntryRef(transferEntry);
  const outbox = new Store();
  const packet = value(
    await prepareTransferPrivate({
      journal,
      engine: fixture.source.engine,
      policy: fixture.policy,
      authorization,
      sourceSeat: 1,
      sourceKind: 'current-controller',
      signingKey: recoveryFixtureKey(fixture, 1),
      entropy: new Uint8Array(32).fill(11),
      nonce: new Uint8Array(32).fill(12),
      outbox,
      recoveryPrivateStore: recoveryStore,
    }),
  );
  expect(recoveryStore.reads).toEqual([
    `recovery-private/${genesisDigest(fixture.genesis)}/${transferEntryRef(recoveryEntry).seq}-${transferEntryRef(recoveryEntry).hash}/1`,
  ]);
  expect(value(verifyTransferPrivateEnvelope(packet, pending.log)).sourceSeat).toBe(1);
  const imports = new Store();
  const imported = value(
    await importTransferPrivate({
      genesisEntry: fixture.genesisEntry,
      entries: (await journal.load())?.entries ?? [],
      engine: fixture.source.engine,
      policy: fixture.policy,
      authorization,
      packet,
      destinationEncryptionSecret: destinationSecret,
      importStore: imports,
    }),
  );
  expect(imported.masters.map(({ seat }) => seat)).toEqual([0]);
  expect(imported.masters[0]?.master).toEqual(scalarToBytes(17n));
  imported.dispose();
}, 30_000);

test('a returned owner can receive custody only through a certified recoverer live transfer and authenticated prior import', async () => {
  const { fixture, afterRecovery, recoveryEntry, activateEntry, recoveryStore, journal } =
    await setupRecovered();
  const human = afterRecovery.log.authority?.controllers.find((item) => item.seat === 1);
  const bot = afterRecovery.log.authority?.controllers.find((item) => item.seat === 0);
  if (!human || !bot || !afterRecovery.log.crypto) throw new Error('Missing recovery controllers');
  const device = identityFromSecret(new Uint8Array(32).fill(128));
  const game = identityFromSecret(new Uint8Array(32).fill(129));
  const nextBot = identityFromSecret(new Uint8Array(32).fill(130));
  const encryptionSecret = scalarToBytes(131n);
  const liveStatement: SeatTransferAuthorizationStatement = {
    protocol: 'seat-transfer-v1',
    genesisDigest: genesisDigest(fixture.genesis),
    anchor: transferEntryRef(afterRecovery.log.head),
    validUntilSeq: afterRecovery.log.head.seq + 1,
    mode: 'live',
    seat: 1,
    currentController: {
      publicKey: human.publicKey,
      kind: human.kind,
      activatedAt: human.activatedAt,
      hostSeat: human.hostSeat,
    },
    recovery: null,
    nextEpoch: afterRecovery.log.crypto.epoch + 1,
    destination: {
      devicePeer: device.peerId,
      gamePeer: game.peerId,
      transferEncryptionKey: encodePoint(scalePoint(G, 131n)),
    },
    replacements: [
      { seat: 1, oldPublicKey: human.publicKey, newPublicKey: game.peerId, newHostSeat: 1 },
      { seat: 0, oldPublicKey: bot.publicKey, newPublicKey: nextBot.peerId, newHostSeat: 1 },
    ],
  };
  const liveChange = {
    kind: 'transfer-authorize' as const,
    statement: liveStatement,
    destinationDeviceSig: signObject(TRANSFER_DEVICE_DOMAIN, liveStatement, device.secretKey),
    destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, liveStatement, game.secretKey),
    replacementKeySigs: [
      {
        seat: 0 as const,
        sig: signObject(TRANSFER_BOT_KEY_DOMAIN, liveStatement, nextBot.secretKey),
      },
    ],
    ownerIntent: {
      signer: 'current-game' as const,
      sig: signObject(TRANSFER_OWNER_GAME_DOMAIN, liveStatement, recoveryFixtureKey(fixture, 1)),
    },
  };
  const liveEntry = signRecoveryFixtureEntry(
    fixture,
    afterRecovery,
    { kind: 'membership', change: liveChange },
    afterRecovery.log.head.stateHash,
  );
  const liveCertified = certifyRecoveryFixtureEntry(fixture, afterRecovery, liveEntry, [1, 2, 3]);
  const pendingLive = advanceRecoveryFixture(afterRecovery, liveCertified);
  let record = await journal.load();
  if (
    !record ||
    !(await journal.commit(record.height, record.safety.revision, liveCertified, new Uint8Array()))
  )
    throw new Error('Could not append live authorization');
  const importedStore = new Store();
  const livePacket = value(
    await prepareTransferPrivate({
      journal,
      engine: fixture.source.engine,
      policy: fixture.policy,
      authorization: transferEntryRef(liveEntry),
      sourceSeat: 1,
      sourceKind: 'current-controller',
      signingKey: recoveryFixtureKey(fixture, 1),
      entropy: new Uint8Array(32).fill(21),
      nonce: new Uint8Array(32).fill(22),
      masters: [
        { seat: 1, master: scalarToBytes(18n) },
        { seat: 0, master: scalarToBytes(17n) },
      ],
      outbox: new Store(),
      recoveryPrivateStore: recoveryStore,
    }),
  );
  const liveImported = value(
    await importTransferPrivate({
      genesisEntry: fixture.genesisEntry,
      entries: (await journal.load())?.entries ?? [],
      engine: fixture.source.engine,
      policy: fixture.policy,
      authorization: transferEntryRef(liveEntry),
      packet: livePacket,
      destinationEncryptionSecret: encryptionSecret,
      importStore: importedStore,
    }),
  );
  expect(liveImported.masters.map(({ seat }) => seat)).toEqual([1, 0]);
  liveImported.dispose();
  const liveActivationStatement = {
    protocol: 'seat-transfer-activation-v1' as const,
    genesisDigest: liveStatement.genesisDigest,
    authorization: transferEntryRef(liveEntry),
    parent: transferEntryRef(pendingLive.log.head),
    nextEpoch: liveStatement.nextEpoch,
    destinationDevice: device.peerId,
    destinationGame: game.peerId,
    replacements: liveStatement.replacements,
    checkDigest: transferCheckDigest(pendingLive.log, transferEntryRef(liveEntry)),
  };
  const liveActivation = {
    kind: 'transfer-activate' as const,
    statement: liveActivationStatement,
    destinationCheck: signObject(
      TRANSFER_DESTINATION_CHECK_DOMAIN,
      liveActivationStatement,
      game.secretKey,
    ),
    replacementChecks: [
      {
        seat: 0 as const,
        sig: signObject(TRANSFER_BOT_CHECK_DOMAIN, liveActivationStatement, nextBot.secretKey),
      },
    ],
  };
  const liveActivationEntry = signRecoveryFixtureEntry(
    fixture,
    pendingLive,
    { kind: 'membership', change: liveActivation },
    pendingLive.log.head.stateHash,
  );
  const liveActivationCertified = certifyRecoveryFixtureEntry(
    fixture,
    pendingLive,
    liveActivationEntry,
    [1, 2, 3],
  );
  const active = advanceRecoveryFixture(pendingLive, liveActivationCertified);
  record = await journal.load();
  if (
    !record ||
    !(await journal.commit(
      record.height,
      record.safety.revision,
      liveActivationCertified,
      new Uint8Array(),
    ))
  )
    throw new Error('Could not append live activation');
  const returnedBot = active.log.authority?.controllers.find((item) => item.seat === 0);
  if (!returnedBot || !active.log.crypto) throw new Error('Missing transferred bot');
  const returnDevice = identityFromSecret(new Uint8Array(32).fill(139));
  const returnGame = identityFromSecret(new Uint8Array(32).fill(140));
  const returnSecret = scalarToBytes(141n);
  const returnStatement: SeatTransferAuthorizationStatement = {
    protocol: 'seat-transfer-v1',
    genesisDigest: genesisDigest(fixture.genesis),
    anchor: transferEntryRef(active.log.head),
    validUntilSeq: active.log.head.seq + 1,
    mode: 'return',
    seat: 0,
    currentController: {
      publicKey: returnedBot.publicKey,
      kind: returnedBot.kind,
      activatedAt: returnedBot.activatedAt,
      hostSeat: returnedBot.hostSeat,
    },
    recovery: {
      authorization: transferEntryRef(recoveryEntry),
      activation: transferEntryRef(activateEntry),
    },
    nextEpoch: active.log.crypto.epoch + 1,
    destination: {
      devicePeer: returnDevice.peerId,
      gamePeer: returnGame.peerId,
      transferEncryptionKey: encodePoint(scalePoint(G, 141n)),
    },
    replacements: [
      {
        seat: 0,
        oldPublicKey: returnedBot.publicKey,
        newPublicKey: returnGame.peerId,
        newHostSeat: 0,
      },
    ],
  };
  const returnChange = {
    kind: 'transfer-authorize' as const,
    statement: returnStatement,
    destinationDeviceSig: signObject(
      TRANSFER_DEVICE_DOMAIN,
      returnStatement,
      returnDevice.secretKey,
    ),
    destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, returnStatement, returnGame.secretKey),
    replacementKeySigs: [],
    returnIntent: {
      signer: 'last-human-game-key' as const,
      sig: signObject(
        TRANSFER_RETURN_INTENT_DOMAIN,
        returnStatement,
        recoveryFixtureKey(fixture, 0),
      ),
    },
  };
  const signingKey = (seat: Seat) =>
    seat === 1 ? game.secretKey : recoveryFixtureKey(fixture, seat);
  const signedEntry = (context: ProposalContext, payload: EntryPayload, stateHash: string) => {
    const seq = context.log.head.seq + 1;
    const term = 1;
    const proposer = proposerFor(seq, term, context.membership, context.excludedProposers);
    return signEntry(
      {
        seq,
        term,
        prevHash: entryHash(context.log.head),
        payload,
        stateHash,
        sequencer: proposer.publicKey,
      },
      signingKey(proposer.seat),
    );
  };
  const certifiedEntry = (context: ProposalContext, entry: ReturnType<typeof signedEntry>) => ({
    entry,
    certificate: ([1, 2, 3] as const).map((seat) =>
      signVote(
        {
          genesisDigest: context.membership.genesisDigest,
          epoch: context.membership.epoch,
          seat,
          seq: entry.seq,
          term: entry.term,
          phase: 'precommit',
          valueHash: entryHash(entry),
        },
        signingKey(seat),
      ),
    ),
  });
  const returnEntry = signedEntry(
    active,
    { kind: 'membership', change: returnChange },
    active.log.head.stateHash,
  );
  const returnCertified = certifiedEntry(active, returnEntry);
  const pendingReturn = advanceRecoveryFixture(active, returnCertified);
  record = await journal.load();
  if (
    !record ||
    !(await journal.commit(
      record.height,
      record.safety.revision,
      returnCertified,
      new Uint8Array(),
    ))
  )
    throw new Error('Could not append return authorization');
  const missingImportOutbox = new Store();
  const missingImport = await prepareTransferPrivate({
    journal,
    engine: fixture.source.engine,
    policy: fixture.policy,
    authorization: transferEntryRef(returnEntry),
    sourceSeat: 1,
    sourceKind: 'current-controller',
    signingKey: game.secretKey,
    entropy: new Uint8Array(32).fill(24),
    nonce: new Uint8Array(32).fill(25),
    outbox: missingImportOutbox,
  });
  expect(missingImport).toMatchObject({ ok: false, error: { code: 'transfer-private-custody' } });
  expect(missingImportOutbox.items.size).toBe(0);
  const retiredSource = await prepareTransferPrivate({
    journal,
    engine: fixture.source.engine,
    policy: fixture.policy,
    authorization: transferEntryRef(returnEntry),
    sourceSeat: 1,
    sourceKind: 'current-controller',
    signingKey: recoveryFixtureKey(fixture, 1),
    entropy: new Uint8Array(32).fill(24),
    nonce: new Uint8Array(32).fill(25),
    outbox: missingImportOutbox,
    importStore: importedStore,
  });
  expect(retiredSource).toMatchObject({ ok: false, error: { code: 'transfer-private-source' } });
  expect(missingImportOutbox.items.size).toBe(0);
  const packet = value(
    await prepareTransferPrivate({
      journal,
      engine: fixture.source.engine,
      policy: fixture.policy,
      authorization: transferEntryRef(returnEntry),
      sourceSeat: 1,
      sourceKind: 'current-controller',
      signingKey: game.secretKey,
      entropy: new Uint8Array(32).fill(24),
      nonce: new Uint8Array(32).fill(25),
      outbox: new Store(),
      importStore: importedStore,
    }),
  );
  expect(
    value(verifyTransferPrivateEnvelope(packet, pendingReturn.log)).sourceSigner.publicKey,
  ).toBe(game.peerId);
  const imported = value(
    await importTransferPrivate({
      genesisEntry: fixture.genesisEntry,
      entries: (await journal.load())?.entries ?? [],
      engine: fixture.source.engine,
      policy: fixture.policy,
      authorization: transferEntryRef(returnEntry),
      packet,
      destinationEncryptionSecret: returnSecret,
      importStore: new Store(),
    }),
  );
  expect(imported.masters.map(({ seat }) => seat)).toEqual([0]);
  imported.dispose();
}, 60_000);
