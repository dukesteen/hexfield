import { scalarToBytes, signObject } from '@cp2p/crypto';
import type { Result, Seat } from '@cp2p/engine';
import { beforeAll, describe, expect, test } from 'vitest';
import { genesisDigest } from './genesis.js';
import { MemoryGenesisConsentStore } from './genesis-outbox.js';
import { MemoryProtocolJournal } from './journal.js';
import type { ProposalContext } from './proposal.js';
import { RecoveryInbox } from './recovery-inbox.js';
import { prepareRecoveryRelease } from './recovery-release.js';
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

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing recovery inbox fixture');
  return item;
}

function holderEncryptionSecret(fixture: RecoveryFixture, seat: Seat): bigint {
  const original = required(fixture.genesis.seats.find((item) => item.seat === seat));
  const source = createStealSecretSource(
    scalarToBytes(BigInt(17 + seat)),
    fixture.genesis.ceremonyNonce,
    seat,
    original.publicKey,
  );
  try {
    return source.encryptionSecret();
  } finally {
    source.dispose();
  }
}

describe('public recovery inbox', () => {
  let fixture: RecoveryFixture;
  let authorized: ProposalContext;
  let authorizationEntry: ProposalContext['log']['head'];
  beforeAll(() => {
    fixture = createRecoveryFixture({ masterBackedBeacon: true, chainLength: 1 });
    const replacement = recoveryFixtureReplacement(81);
    const change = signRecoveryFixtureAuthorization(
      fixture,
      recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId),
      replacement.secretKey,
    );
    authorizationEntry = signRecoveryFixtureEntry(
      fixture,
      fixture.ready,
      { kind: 'membership', change },
      fixture.ready.log.head.stateHash,
    );
    const certified = certifyRecoveryFixtureEntry(
      fixture,
      fixture.ready,
      authorizationEntry,
      [1, 2, 3],
    );
    authorized = advanceRecoveryFixture(fixture.ready, certified);
    replacement.secretKey.fill(0);
  }, 30_000);

  test('requires exact active recoverer checks before offering an activation', () => {
    const inbox = new RecoveryInbox();
    value(inbox.refresh(authorized.log));
    const activation = signRecoveryFixtureActivation(fixture, authorized, authorizationEntry);
    const checks = activation.checks.map((check) => ({ statement: activation.statement, check }));
    expect(value(inbox.rememberCheck(required(checks[0])))).toBe(true);
    expect(value(inbox.rememberCheck(required(checks[0])))).toBe(false);
    expect(value(inbox.rememberCheck(required(checks[1])))).toBe(true);
    expect(value(inbox.candidate(authorized.log))).toBeNull();

    expect(
      inbox.rememberCheck({
        ...required(checks[2]),
        statement: { ...activation.statement, genesisDigest: 'a'.repeat(43) },
      }).ok,
    ).toBe(false);
    expect(
      inbox.rememberCheck({
        ...required(checks[2]),
        statement: {
          ...activation.statement,
          authorization: { ...activation.statement.authorization, hash: 'a'.repeat(64) },
        },
      }).ok,
    ).toBe(false);
    const wrongKey = {
      statement: activation.statement,
      check: {
        seat: 3,
        sig: signObject('recovery-check', activation.statement, recoveryFixtureKey(fixture, 0)),
      },
    };
    expect(inbox.rememberCheck(wrongKey).ok).toBe(false);
    expect(
      inbox.rememberCheck({
        statement: activation.statement,
        check: {
          seat: 0,
          sig: signObject('recovery-check', activation.statement, recoveryFixtureKey(fixture, 0)),
        },
      }).ok,
    ).toBe(false);
    expect(inbox.rememberCheck({ ...required(checks[2]), extra: true }).ok).toBe(false);

    expect(value(inbox.rememberCheck(required(checks[2])))).toBe(true);
    const candidate = required(value(inbox.candidate(authorized.log)));
    expect(candidate).toEqual(activation);
    Object.assign(candidate.statement, { checkDigest: 'b'.repeat(64) });
    Object.assign(required(candidate.checks[0]), { sig: 'a'.repeat(86) });
    expect(value(inbox.candidate(authorized.log))).toEqual(activation);
  });

  test('keeps only one valid release per share slot and exposes ciphertext by recipient', async () => {
    const journal = new MemoryProtocolJournal();
    expect(await journal.initialize(fixture.genesisEntry, new Uint8Array())).toBe(true);
    const authorization = certifyRecoveryFixtureEntry(
      fixture,
      fixture.ready,
      authorizationEntry,
      [1, 2, 3],
    );
    for (const certified of [...fixture.deckEntries, authorization]) {
      // Journal commits must follow their certified parents.
      // oxlint-disable-next-line eslint/no-await-in-loop
      expect(await journal.commit(certified.entry.seq, 0, certified, new Uint8Array())).toBe(true);
    }
    const request = (entropy: number) => ({
      journal,
      engine: fixture.source.engine,
      policy: fixture.policy,
      genesisDigest: genesisDigest(fixture.genesis),
      dealerSeat: 0 as const,
      holderSeat: 1 as const,
      recipientSeat: 1 as const,
      holderEncryptionSecret: holderEncryptionSecret(fixture, 1),
      holderSigningKey: recoveryFixtureKey(fixture, 1),
      entropy: new Uint8Array(32).fill(entropy),
      store: new MemoryGenesisConsentStore(),
    });
    const release = value(await prepareRecoveryRelease(request(101)));
    const conflicting = value(await prepareRecoveryRelease(request(102)));
    const inbox = new RecoveryInbox();
    const callerContext = { ...authorized.log, recovery: { ...required(authorized.log.recovery) } };
    value(inbox.refresh(callerContext));
    callerContext.recovery = { ...callerContext.recovery, pending: null };
    expect(value(inbox.rememberRelease(release))).toBe(true);
    expect(value(inbox.rememberRelease(release))).toBe(false);
    expect(inbox.rememberRelease(conflicting)).toMatchObject({
      ok: false,
      error: { code: 'recovery-inbox-conflict' },
    });
    const wrongGameBody = { ...release.body, genesisDigest: 'a'.repeat(43) };
    expect(
      inbox.rememberRelease({
        body: wrongGameBody,
        sig: signObject('recovery-share', wrongGameBody, recoveryFixtureKey(fixture, 1)),
      }).ok,
    ).toBe(false);
    const wrongAuthorization = {
      ...release.body,
      authorization: { ...release.body.authorization, hash: 'b'.repeat(64) },
    };
    expect(
      inbox.rememberRelease({
        body: wrongAuthorization,
        sig: signObject('recovery-share', wrongAuthorization, recoveryFixtureKey(fixture, 1)),
      }).ok,
    ).toBe(false);
    expect(
      inbox.rememberRelease({
        body: release.body,
        sig: signObject('recovery-share', release.body, recoveryFixtureKey(fixture, 2)),
      }).ok,
    ).toBe(false);
    expect(inbox.listReleases(2)).toHaveLength(0);
    expect(inbox.listReleases(1)).toEqual([release]);
    const detached = required(inbox.listReleases(1)[0]);
    detached.sig = 'a'.repeat(86);
    expect(inbox.listReleases(1)).toEqual([release]);
    expect(inbox.takeReleases(1)).toEqual([release]);
    expect(inbox.listReleases(1)).toHaveLength(0);
  });

  test('parent changes clear checks, while releases last until authorization ends', async () => {
    const inbox = new RecoveryInbox();
    value(inbox.refresh(authorized.log));
    const activation = signRecoveryFixtureActivation(fixture, authorized, authorizationEntry);
    value(
      inbox.rememberCheck({
        statement: activation.statement,
        check: required(activation.checks[0]),
      }),
    );
    const journal = new MemoryProtocolJournal();
    expect(await journal.initialize(fixture.genesisEntry, new Uint8Array())).toBe(true);
    const authorization = certifyRecoveryFixtureEntry(
      fixture,
      fixture.ready,
      authorizationEntry,
      [1, 2, 3],
    );
    for (const certified of [...fixture.deckEntries, authorization]) {
      // Journal commits must follow their certified parents.
      // oxlint-disable-next-line eslint/no-await-in-loop
      expect(await journal.commit(certified.entry.seq, 0, certified, new Uint8Array())).toBe(true);
    }
    const release = value(
      await prepareRecoveryRelease({
        journal,
        engine: fixture.source.engine,
        policy: fixture.policy,
        genesisDigest: genesisDigest(fixture.genesis),
        dealerSeat: 0,
        holderSeat: 1,
        recipientSeat: 1,
        holderEncryptionSecret: holderEncryptionSecret(fixture, 1),
        holderSigningKey: recoveryFixtureKey(fixture, 1),
        entropy: new Uint8Array(32).fill(103),
        store: new MemoryGenesisConsentStore(),
      }),
    );
    value(inbox.rememberRelease(release));

    // Refresh receives a certified context in production; only its parent identity changes here.
    const advanced = {
      ...authorized.log,
      head: { ...authorized.log.head, seq: authorized.log.head.seq + 1 },
    };
    value(inbox.refresh(advanced));
    expect(inbox.listReleases(1)).toEqual([release]);
    expect(value(inbox.candidate(advanced))).toBeNull();
    expect(
      inbox.rememberCheck({
        statement: activation.statement,
        check: required(activation.checks[1]),
      }).ok,
    ).toBe(false);
    value(
      inbox.refresh({ ...advanced, recovery: { ...required(advanced.recovery), pending: null } }),
    );
    expect(inbox.listReleases(1)).toHaveLength(0);
  });
});
