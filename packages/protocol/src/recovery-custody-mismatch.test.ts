import { canonicalEncode } from '@cp2p/codec';
import { scalarToBytes, signObject } from '@cp2p/crypto';
import type { Result, Seat } from '@cp2p/engine';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { entryHash, genesisDigest } from './genesis.js';
import { MemoryGenesisConsentStore } from './genesis-outbox.js';
import { MemoryProtocolJournal } from './journal.js';
import type { CertifiedEntry } from './proposal.js';
import { validateCertifiedEntry } from './proposal.js';
import { produceRecoveryCheckFromShares } from './recovery-check.js';
import { RecoveryInbox } from './recovery-inbox.js';
import { RecoveryParticipant } from './recovery-participant.js';
import { RECOVERY_VOID_DOMAIN } from './recovery-membership.js';
import { produceRecoveryVoidCheckFromShares } from './recovery-void.js';
import { replayCertifiedPrefix } from './replay.js';
import {
  openRecoveryRelease,
  prepareRecoveryRelease,
  recoverAuthorizedMaster,
  verifyRecoveryRelease,
} from './recovery-release.js';
import { createStealSecretSource } from './steal-source.js';
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
import type { RecoveryFixture } from './testing/recovery-fixture.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function journal(fixture: RecoveryFixture, entries: readonly CertifiedEntry[]) {
  const result = new MemoryProtocolJournal();
  if (!(await result.initialize(fixture.genesisEntry, new Uint8Array([1]))))
    throw new Error('Could not initialize the certified journal');
  for (const certified of entries) {
    // Every durable commit depends on its certified predecessor.
    // oxlint-disable-next-line no-await-in-loop
    if (!(await result.commit(certified.entry.seq, 0, certified, new Uint8Array([1]))))
      throw new Error('Could not commit the certified prefix');
  }
  return result;
}

function holderEncryptionSecret(fixture: RecoveryFixture, seat: Seat): bigint {
  const owner = fixture.genesis.seats.find((item) => item.seat === seat);
  if (!owner) throw new Error('Missing original holder');
  const source = createStealSecretSource(
    scalarToBytes(BigInt(17 + seat)),
    fixture.genesis.ceremonyNonce,
    seat,
    owner.publicKey,
  );
  try {
    return source.encryptionSecret();
  } finally {
    source.dispose();
  }
}

async function createCustodyFixture() {
  // The dealer escrowed the master behind its signed masterPub, but derived its
  // signed beacon tip from another scalar. Feldman verification alone cannot
  // catch this at genesis.
  const fixture = createRecoveryFixture({
    masterBackedBeacon: true,
    misderivedBeaconSeat: 0,
  });
  const replacement = recoveryFixtureReplacement(84);
  const change = signRecoveryFixtureAuthorization(
    fixture,
    recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId),
    replacement.secretKey,
  );
  const entry = signRecoveryFixtureEntry(
    fixture,
    fixture.ready,
    { kind: 'membership', change },
    fixture.ready.log.head.stateHash,
  );
  const authorization = certifyRecoveryFixtureEntry(fixture, fixture.ready, entry, [1, 2, 3]);
  const authorized = advanceRecoveryFixture(fixture.ready, authorization);
  const local = await journal(fixture, [...fixture.deckEntries, authorization]);
  const releaseStore = new MemoryGenesisConsentStore();
  const releases = await Promise.all(
    ([1, 2, 3] as const).map(async (holderSeat) =>
      value(
        await prepareRecoveryRelease({
          journal: local,
          engine: fixture.source.engine,
          policy: fixture.policy,
          genesisDigest: genesisDigest(fixture.genesis),
          dealerSeat: 0,
          holderSeat,
          recipientSeat: 1,
          holderEncryptionSecret: holderEncryptionSecret(fixture, holderSeat),
          holderSigningKey: recoveryFixtureKey(fixture, holderSeat),
          entropy: new Uint8Array(32).fill(104 + holderSeat),
          store: releaseStore,
        }),
      ),
    ),
  );

  return { fixture, replacement, entry, authorization, authorized, local, releaseStore, releases };
}

let shared: Awaited<ReturnType<typeof createCustodyFixture>>;
beforeAll(async () => {
  shared = await createCustodyFixture();
}, 30_000);
afterAll(() => {
  shared?.replacement.secretKey.fill(0);
  for (const identity of shared?.fixture.source.identities.values() ?? [])
    identity.secretKey.fill(0);
});

test('requires certified release authority and rejects a mismatched dealer before activation', async () => {
  const { fixture, entry, authorization, authorized, local, releases } = shared;
  const uncertified = certifyRecoveryFixtureEntry(fixture, fixture.ready, entry, [1, 2]);
  expect(validateCertifiedEntry(uncertified, fixture.ready).ok).toBe(false);
  const beforeAuthorization = await journal(fixture, fixture.deckEntries);
  const deniedStore = new MemoryGenesisConsentStore();
  const deniedWrite = vi.spyOn(deniedStore, 'putIfAbsent');
  expect(
    await prepareRecoveryRelease({
      journal: beforeAuthorization,
      engine: fixture.source.engine,
      policy: fixture.policy,
      genesisDigest: genesisDigest(fixture.genesis),
      dealerSeat: 0,
      holderSeat: 1,
      recipientSeat: 1,
      holderEncryptionSecret: holderEncryptionSecret(fixture, 1),
      holderSigningKey: recoveryFixtureKey(fixture, 1),
      entropy: new Uint8Array(32).fill(105),
      store: deniedStore,
    }),
  ).toMatchObject({ ok: false, error: { code: 'recovery-release-unauthorized' } });
  expect(deniedWrite).not.toHaveBeenCalled();

  for (const release of releases) {
    expect(verifyRecoveryRelease(release, authorized.log).ok).toBe(true);
    expect(
      openRecoveryRelease(release, authorized.log, 1, holderEncryptionSecret(fixture, 1)).ok,
    ).toBe(true);
  }
  const master = value(
    recoverAuthorizedMaster(releases, authorized.log, 0, 1, holderEncryptionSecret(fixture, 1)),
  );
  expect(master).toEqual(scalarToBytes(17n));
  master.fill(0);

  const checks = new MemoryGenesisConsentStore();
  const checkWrite = vi.spyOn(checks, 'putIfAbsent');
  expect(
    await produceRecoveryCheckFromShares({
      journal: local,
      engine: fixture.source.engine,
      policy: fixture.policy,
      store: checks,
      localSeat: 1,
      signingKey: recoveryFixtureKey(fixture, 1),
      recipientEncryptionSecret: holderEncryptionSecret(fixture, 1),
      releases,
    }),
  ).toMatchObject({ ok: false, error: { code: 'master-beacon-tip' } });
  expect(checkWrite).not.toHaveBeenCalled();

  // An honest recoverer cannot provide its mandatory check, so this
  // otherwise signed activation lacks the required new-quorum evidence.
  const activation = signRecoveryFixtureActivation(fixture, authorized, authorization.entry);
  const attempted = signRecoveryFixtureEntry(
    fixture,
    authorized,
    { kind: 'membership', change: { ...activation, checks: activation.checks.slice(1) } },
    authorized.log.head.stateHash,
  );
  const certified = certifyRecoveryFixtureEntry(fixture, authorized, attempted, [1, 2, 3]);
  expect(validateCertifiedEntry(certified, authorized)).toMatchObject({
    ok: false,
    error: { code: 'recovery-check' },
  });
  expect(authorized.log.recovery?.pending).not.toBeNull();
}, 30_000);

test('a recoverer persists its private mismatch decision across restart', async () => {
  const { fixture, authorized, local, releaseStore, releases } = shared;
  const participant = new RecoveryParticipant({
    journal: local,
    engine: fixture.source.engine,
    policy: fixture.policy,
    localSeat: 1,
    signingKey: recoveryFixtureKey(fixture, 1),
    encryptionSecret: () => holderEncryptionSecret(fixture, 1),
    privateEntropy: () => new Uint8Array(32).fill(105),
    store: releaseStore,
  });
  try {
    for (const release of releases) value(participant.rememberRelease(authorized.log, release));
    const prepared = value(await participant.prepare(authorized.log));
    expect(prepared.check).toBeNull();
    expect(prepared.voidCheck?.statement.reason).toBe('master-beacon-tip');
  } finally {
    participant.dispose();
  }
  const restarted = new RecoveryParticipant({
    journal: local,
    engine: fixture.source.engine,
    policy: fixture.policy,
    localSeat: 1,
    signingKey: recoveryFixtureKey(fixture, 1),
    encryptionSecret: () => holderEncryptionSecret(fixture, 1),
    privateEntropy: () => new Uint8Array(32).fill(105),
    store: releaseStore,
  });
  try {
    expect(value(await restarted.prepare(authorized.log)).voidCheck?.statement.reason).toBe(
      'master-beacon-tip',
    );
  } finally {
    restarted.dispose();
  }
}, 30_000);

test('only unanimous matching private checks can certify a permanent void', async () => {
  const { fixture, authorization, authorized, local, releases } = shared;
  const voidInbox = new RecoveryInbox();
  expect(voidInbox.refresh(authorized.log).ok).toBe(true);
  const signedVoid = await Promise.all(
    ([1, 2, 3] as const).map(async (recipientSeat) => {
      const recipientReleases =
        recipientSeat === 1
          ? releases
          : await Promise.all(
              ([1, 2, 3] as const).map(async (holderSeat) =>
                value(
                  await prepareRecoveryRelease({
                    journal: local,
                    engine: fixture.source.engine,
                    policy: fixture.policy,
                    genesisDigest: genesisDigest(fixture.genesis),
                    dealerSeat: 0,
                    holderSeat,
                    recipientSeat,
                    holderEncryptionSecret: holderEncryptionSecret(fixture, holderSeat),
                    holderSigningKey: recoveryFixtureKey(fixture, holderSeat),
                    entropy: new Uint8Array(32).fill(120 + recipientSeat * 3 + holderSeat),
                    store: new MemoryGenesisConsentStore(),
                  }),
                ),
              ),
            );
      const durable = new MemoryGenesisConsentStore();
      const write = vi.spyOn(durable, 'putIfAbsent');
      const produced = value(
        await produceRecoveryVoidCheckFromShares({
          journal: local,
          engine: fixture.source.engine,
          policy: fixture.policy,
          store: durable,
          localSeat: recipientSeat,
          signingKey: recoveryFixtureKey(fixture, recipientSeat),
          recipientEncryptionSecret: holderEncryptionSecret(fixture, recipientSeat),
          releases: recipientReleases,
        }),
      );
      const slot = write.mock.calls[0]?.[0];
      expect(slot).toMatch(/^recovery-check\//);
      const stored = slot ? await durable.load(slot) : null;
      expect(stored).toEqual(canonicalEncode(produced));
      expect(JSON.stringify(produced)).not.toContain(
        Buffer.from(scalarToBytes(17n)).toString('base64'),
      );
      return produced;
    }),
  );
  const [first, second, third] = signedVoid;
  if (!first || !second || !third) throw new Error('Missing signed void checks');
  const denied = new MemoryGenesisConsentStore();
  const deniedVoidWrite = vi.spyOn(denied, 'putIfAbsent');
  expect(
    await produceRecoveryVoidCheckFromShares({
      journal: local,
      engine: fixture.source.engine,
      policy: fixture.policy,
      store: denied,
      localSeat: 1,
      signingKey: recoveryFixtureKey(fixture, 1),
      recipientEncryptionSecret: holderEncryptionSecret(fixture, 1) + 1n,
      releases,
    }),
  ).toMatchObject({ ok: false, error: { code: 'recovery-release-recipient' } });
  expect(deniedVoidWrite).not.toHaveBeenCalled();
  const pending = authorized.log.recovery?.pending;
  if (!pending) throw new Error('Missing certified authorization');
  const occupied = new MemoryGenesisConsentStore();
  const occupiedSlot = `recovery-check/${fixture.genesis.gameId}/${pending.seq}-${pending.hash}/${authorized.log.head.seq}-${entryHash(authorized.log.head)}/1`;
  expect(await occupied.putIfAbsent(occupiedSlot, new Uint8Array([1]))).toBe(true);
  expect(
    await produceRecoveryVoidCheckFromShares({
      journal: local,
      engine: fixture.source.engine,
      policy: fixture.policy,
      store: occupied,
      localSeat: 1,
      signingKey: recoveryFixtureKey(fixture, 1),
      recipientEncryptionSecret: holderEncryptionSecret(fixture, 1),
      releases,
    }),
  ).toMatchObject({ ok: false, error: { code: 'recovery-void-conflict' } });
  expect(first.statement).toMatchObject({
    authorization: authorized.log.recovery?.pending,
    dealerSeat: 0,
    reason: 'master-beacon-tip',
  });
  const forged = {
    statement: { ...first.statement, reason: 'master-lock-key' as const },
    check: first.check,
  };
  expect(voidInbox.rememberVoidCheck(forged)).toMatchObject({
    ok: false,
    error: { code: 'recovery-inbox-signature' },
  });
  const staleStatement = {
    ...first.statement,
    parent: { ...first.statement.parent, seq: first.statement.parent.seq + 1 },
  };
  expect(
    voidInbox.rememberVoidCheck({
      statement: staleStatement,
      check: {
        seat: 1,
        sig: signObject(RECOVERY_VOID_DOMAIN, staleStatement, recoveryFixtureKey(fixture, 1)),
      },
    }),
  ).toMatchObject({ ok: false, error: { code: 'recovery-inbox-binding' } });
  const conflicting = {
    statement: { ...first.statement, reason: 'master-lock-key' as const },
    check: {
      seat: second.check.seat,
      sig: signObject(
        RECOVERY_VOID_DOMAIN,
        { ...first.statement, reason: 'master-lock-key' },
        recoveryFixtureKey(fixture, 2),
      ),
    },
  };
  expect(voidInbox.rememberVoidCheck(first).ok).toBe(true);
  expect(voidInbox.rememberVoidCheck(conflicting).ok).toBe(true);
  expect(voidInbox.rememberVoidCheck(third).ok).toBe(true);
  expect(voidInbox.candidate(authorized.log)).toMatchObject({ ok: true, value: null });
  const unanimous = new RecoveryInbox();
  expect(unanimous.refresh(authorized.log).ok).toBe(true);
  for (const check of signedVoid) expect(unanimous.rememberVoidCheck(check).ok).toBe(true);
  const candidate = value(unanimous.candidate(authorized.log));
  if (!candidate || candidate.kind !== 'recovery-void') throw new Error('Missing void candidate');
  const incomplete = { ...candidate, checks: candidate.checks.slice(1) };
  const invalid = signRecoveryFixtureEntry(
    fixture,
    authorized,
    { kind: 'membership', change: incomplete },
    authorized.log.head.stateHash,
  );
  expect(
    validateCertifiedEntry(
      certifyRecoveryFixtureEntry(fixture, authorized, invalid, [1, 2, 3]),
      authorized,
    ),
  ).toMatchObject({ ok: false, error: { code: 'recovery-void-check' } });
  const voidEntry = signRecoveryFixtureEntry(
    fixture,
    authorized,
    { kind: 'membership', change: candidate },
    authorized.log.head.stateHash,
  );
  const certifiedVoid = certifyRecoveryFixtureEntry(fixture, authorized, voidEntry, [1, 2, 3]);
  expect(validateCertifiedEntry(certifiedVoid, authorized).ok).toBe(true);
  const terminal = advanceRecoveryFixture(authorized, certifiedVoid);
  expect(unanimous.candidate(terminal.log)).toMatchObject({ ok: true, value: null });
  expect(terminal.log.recovery?.void).toMatchObject({
    entry: { seq: voidEntry.seq, hash: entryHash(voidEntry) },
    dealerSeat: 0,
    reason: 'master-beacon-tip',
  });
  expect(terminal.log.state.result).toBeNull();
  const replayed = value(
    replayCertifiedPrefix(
      fixture.genesisEntry,
      [...fixture.deckEntries, authorization, certifiedVoid],
      fixture.source.engine,
      fixture.policy,
    ),
  );
  expect(replayed.context.log.recovery?.void).toEqual(terminal.log.recovery?.void);
  const later = signRecoveryFixtureEntry(
    fixture,
    terminal,
    { kind: 'membership', change: candidate },
    terminal.log.head.stateHash,
  );
  expect(
    validateCertifiedEntry(
      certifyRecoveryFixtureEntry(fixture, terminal, later, [1, 2, 3]),
      terminal,
    ),
  ).toMatchObject({ ok: false, error: { code: 'game-void' } });
}, 30_000);
