import { canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { scalarToBytes, sealWithEphemeralProof, signObject } from '@cp2p/crypto';
import type { Result, Seat } from '@cp2p/engine';
import { beforeAll, expect, test, vi } from 'vitest';
import { genesisDigest } from './genesis.js';
import { MemoryGenesisConsentStore } from './genesis-outbox.js';
import { MemoryProtocolJournal } from './journal.js';
import type { ProtocolJournal } from './journal.js';
import type { CertifiedEntry, ProposalContext } from './proposal.js';
import {
  openRecoveryRelease,
  prepareRecoveryRelease,
  recoverAuthorizedMaster,
  verifyRecoveryRelease,
} from './recovery-release.js';
import type { RecoveryRelease } from './recovery-release.js';
import { createStealSecretSource } from './steal-source.js';
import { produceRecoveryCheckFromShares } from './recovery-check.js';
import {
  advanceRecoveryFixture,
  certifyRecoveryFixtureEntry,
  createRecoveryFixture,
  recoveryFixtureKey,
  recoveryFixtureReadiness,
  recoveryFixtureReplacement,
  signRecoveryFixtureAuthorization,
  signRecoveryFixtureEntry,
} from './testing/recovery-fixture.js';
import type { RecoveryFixture } from './testing/recovery-fixture.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
let data: RecoveryFixture;
let authorization: CertifiedEntry;
let authorized: ProposalContext;

beforeAll(() => {
  data = createRecoveryFixture({ masterBackedBeacon: true });
  const replacement = recoveryFixtureReplacement(84);
  const change = signRecoveryFixtureAuthorization(
    data,
    recoveryFixtureReadiness(data, data.ready, replacement.peerId),
    replacement.secretKey,
  );
  const entry = signRecoveryFixtureEntry(
    data,
    data.ready,
    { kind: 'membership', change },
    data.ready.log.head.stateHash,
  );
  authorization = certifyRecoveryFixtureEntry(data, data.ready, entry, [1, 2, 3]);
  authorized = advanceRecoveryFixture(data.ready, authorization);
  replacement.secretKey.fill(0);
}, 30_000);

async function journal(entries: readonly CertifiedEntry[] = [...data.deckEntries, authorization]) {
  const result = new MemoryProtocolJournal();
  expect(await result.initialize(data.genesisEntry, new Uint8Array([1]))).toBe(true);
  for (const certified of entries)
    // oxlint-disable-next-line no-await-in-loop -- Each journal commit requires its durable predecessor.
    expect(await result.commit(certified.entry.seq, 0, certified, new Uint8Array([1]))).toBe(true);
  return result;
}

function encryptionSecret(seat: Seat): bigint {
  const key = data.genesis.seats.find((item) => item.seat === seat)?.publicKey;
  if (!key) throw new Error('Missing original recipient');
  const source = createStealSecretSource(
    scalarToBytes(BigInt(17 + seat)),
    data.genesis.ceremonyNonce,
    seat,
    key,
  );
  try {
    return source.encryptionSecret();
  } finally {
    source.dispose();
  }
}

function request(
  localJournal: ProtocolJournal,
  holderSeat: Seat = 1,
  store = new MemoryGenesisConsentStore(),
) {
  return {
    journal: localJournal,
    engine: data.source.engine,
    policy: data.policy,
    genesisDigest: genesisDigest(data.genesis),
    dealerSeat: 0 as const,
    holderSeat,
    recipientSeat: 1 as const,
    holderEncryptionSecret: encryptionSecret(holderSeat),
    holderSigningKey: recoveryFixtureKey(data, holderSeat),
    entropy: new Uint8Array(32).fill(104 + holderSeat),
    store,
  };
}

test('certified authorization permits all original holders to release and reconstruct exactly their committed master', async () => {
  const local = await journal();
  const releases: RecoveryRelease[] = await Promise.all(
    ([1, 2, 3] as const).map(async (holder) => {
      const released = value(await prepareRecoveryRelease(request(local, holder)));
      expect(verifyRecoveryRelease(released, authorized.log).ok).toBe(true);
      const opened = value(openRecoveryRelease(released, authorized.log, 1, encryptionSecret(1)));
      expect(opened.dealerSeat).toBe(0);
      expect(opened.index).toBe(holder + 1);
      return released;
    }),
  );
  const secret = value(
    recoverAuthorizedMaster(releases, authorized.log, 0, 1, encryptionSecret(1)),
  );
  expect(secret).toEqual(scalarToBytes(17n));
  secret.fill(0);
  const checked = value(
    await produceRecoveryCheckFromShares({
      journal: local,
      engine: data.source.engine,
      policy: data.policy,
      store: new MemoryGenesisConsentStore(),
      localSeat: 1,
      signingKey: recoveryFixtureKey(data, 1),
      recipientEncryptionSecret: encryptionSecret(1),
      releases,
    }),
  );
  expect(checked.signed.statement.authorization).toEqual(authorized.log.recovery?.pending);
  expect(checked.reconstructed.driver.privateState(0)).not.toBeNull();
  checked.reconstructed.dispose();
  expect(
    recoverAuthorizedMaster(releases.slice(0, 2), authorized.log, 0, 1, encryptionSecret(1)).ok,
  ).toBe(false);
  expect(
    recoverAuthorizedMaster(
      [releases[0], releases[0], releases[2]],
      authorized.log,
      0,
      1,
      encryptionSecret(1),
    ),
  ).toMatchObject({ ok: false, error: { code: 'recovery-release-threshold' } });
  expect(openRecoveryRelease(releases[0], authorized.log, 2, encryptionSecret(2)).ok).toBe(false);
}, 20_000);

test('a proposal, invalid certificate, wrong game and unauthorized recipient never write release bytes', async () => {
  const store = new MemoryGenesisConsentStore();
  const write = vi.spyOn(store, 'putIfAbsent');
  const uncommitted = await journal(data.deckEntries);
  expect(await prepareRecoveryRelease(request(uncommitted, 1, store))).toMatchObject({
    ok: false,
    error: { code: 'recovery-release-unauthorized' },
  });
  const invalid = await journal([
    ...data.deckEntries,
    { ...authorization, certificate: authorization.certificate.slice(0, 2) },
  ]);
  expect(await prepareRecoveryRelease(request(invalid, 1, store))).toMatchObject({
    ok: false,
    error: { code: 'recovery-release-history' },
  });
  const local = await journal();
  expect(
    (await prepareRecoveryRelease({ ...request(local, 1, store), genesisDigest: 'another-game' }))
      .ok,
  ).toBe(false);
  expect((await prepareRecoveryRelease({ ...request(local, 1, store), recipientSeat: 0 })).ok).toBe(
    false,
  );
  expect(write).not.toHaveBeenCalled();
}, 20_000);

test('a lost write reply retains exact encrypted bytes for retry and a corrupt record is never overwritten', async () => {
  const local = await journal();
  const backing = new MemoryGenesisConsentStore();
  let stored: Uint8Array | undefined;
  const store = {
    load: (id: string) => backing.load(id),
    putIfAbsent: async (id: string, bytes: Uint8Array) => {
      await backing.putIfAbsent(id, bytes);
      stored = bytes.slice();
      throw new Error('lost reply');
    },
  };
  expect((await prepareRecoveryRelease({ ...request(local), store })).ok).toBe(false);
  const retried = value(
    await prepareRecoveryRelease({
      ...request(local),
      entropy: new Uint8Array(32).fill(244),
      store,
    }),
  );
  expect(canonicalEncode(retried)).toEqual(stored);
  const write = vi.fn<(id: string, bytes: Uint8Array) => Promise<boolean>>(async () => true);
  expect(
    (
      await prepareRecoveryRelease({
        ...request(local),
        store: { load: async () => new Uint8Array([1]), putIfAbsent: write },
      })
    ).ok,
  ).toBe(false);
  expect(write).not.toHaveBeenCalled();
}, 20_000);

test('a signed encrypted bogus share fails its original opening without blaming the dealer master', async () => {
  const local = await journal();
  const release = value(await prepareRecoveryRelease(request(local)));
  const { sealed: _sealed, ephemeralProof: _proof, ...binding } = release.body;
  const payload = canonicalEncode({ forged: true });
  const encryption = sealWithEphemeralProof(
    payload,
    binding.recipientEncryptionKey,
    new Uint8Array(32).fill(77),
    { domain: 'cp2p/v1/recovery-sealed-share', ...binding },
    { domain: 'cp2p/v1/recovery-share-proof', ...binding },
  );
  const body = { ...binding, ...encryption };
  const malicious = { body, sig: signObject('recovery-share', body, recoveryFixtureKey(data, 1)) };
  expect(verifyRecoveryRelease(malicious, authorized.log).ok).toBe(true);
  expect(openRecoveryRelease(malicious, authorized.log, 1, encryptionSecret(1))).toMatchObject({
    ok: false,
    error: { code: 'escrow-share-hash' },
  });
  expect(toHex(hashValue(payload))).not.toBe(binding.shareHash);
}, 20_000);

test('a changed durable head suppresses a prepared release until it is retried against current authorization', async () => {
  const local = await journal();
  const store = new MemoryGenesisConsentStore();
  const replacement = recoveryFixtureReplacement(85);
  const change = signRecoveryFixtureAuthorization(
    data,
    recoveryFixtureReadiness(
      data,
      authorized,
      replacement.peerId,
      authorized.log.recovery?.pending ?? null,
    ),
    replacement.secretKey,
  );
  const entry = signRecoveryFixtureEntry(
    data,
    authorized,
    { kind: 'membership', change },
    authorized.log.head.stateHash,
  );
  const amendment = certifyRecoveryFixtureEntry(data, authorized, entry, [1, 2, 3]);
  const amended = advanceRecoveryFixture(authorized, amendment);
  const original = store.putIfAbsent.bind(store);
  vi.spyOn(store, 'putIfAbsent').mockImplementationOnce(async (id, bytes) => {
    const won = await original(id, bytes);
    expect(await local.commit(entry.seq, 0, amendment, new Uint8Array([1]))).toBe(true);
    return won;
  });
  expect(await prepareRecoveryRelease(request(local, 1, store))).toMatchObject({
    ok: false,
    error: { code: 'recovery-release-stale' },
  });
  const current = value(await prepareRecoveryRelease(request(local, 1, store)));
  expect(current.body.authorization).toEqual(amended.log.recovery?.pending);
  expect(verifyRecoveryRelease(current, authorized.log).ok).toBe(false);
  replacement.secretKey.fill(0);
}, 20_000);
