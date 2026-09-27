import { hashValue, toHex } from '@cp2p/codec';
import { signObject } from '@cp2p/crypto';
import { beforeAll, expect, test } from 'vitest';
import { validateCertifiedEntry } from './proposal.js';
import { SEAT_ONLINE_DOMAIN, seatOnlineStatement } from './recovery-presence.js';
import { validateRecoveryTransition } from './recovery-membership.js';
import {
  advanceRecoveryFixture,
  certifyRecoveryFixtureEntry,
  createRecoveryFixture,
  recoveryFixtureKey,
  recoveryFixtureReadiness,
  recoveryFixtureRef,
  recoveryFixtureReplacement,
  signRecoveryFixtureActivation,
  signRecoveryFixtureAuthorization,
  signRecoveryFixtureEntry,
} from './testing/recovery-fixture.js';
import type { RecoveryFixture } from './testing/recovery-fixture.js';

let fixture: RecoveryFixture;
beforeAll(() => {
  fixture = createRecoveryFixture({ offlineSeat: null });
}, 30_000);

function offline(context: RecoveryFixture['ready'], seat: 0 | 1 | 2 | 3) {
  const entry = signRecoveryFixtureEntry(
    fixture,
    context,
    { kind: 'membership', change: { kind: 'seat-offline', seat } },
    context.log.head.stateHash,
  );
  return certifyRecoveryFixtureEntry(fixture, context, entry, [0, 1, 2]);
}

test('certified offline and signed online preserve game and voter state but advance exact markers', () => {
  const start = fixture.ready;
  const first = offline(start, 2);
  const marked = advanceRecoveryFixture(start, first);
  expect(marked.log.recovery?.offline).toEqual([
    { seat: 2, since: recoveryFixtureRef(first.entry) },
  ]);
  expect(marked.log.state).toEqual(start.log.state);
  expect(marked.log.crypto).toEqual(start.log.crypto);
  expect(marked.membership).toEqual(start.membership);
  const duplicate = offline(marked, 2);
  expect(validateCertifiedEntry(duplicate, marked)).toMatchObject({
    ok: false,
    error: { code: 'presence-offline' },
  });

  const statement = seatOnlineStatement(marked.log, 2);
  if (!statement.ok) throw new Error(statement.error.message);
  const proof = {
    statement: statement.value,
    sig: signObject(SEAT_ONLINE_DOMAIN, statement.value, recoveryFixtureKey(fixture, 2)),
  };
  const entry = signRecoveryFixtureEntry(
    fixture,
    marked,
    { kind: 'membership', change: { kind: 'seat-online', proof } },
    marked.log.head.stateHash,
  );
  const returned = advanceRecoveryFixture(
    marked,
    certifyRecoveryFixtureEntry(fixture, marked, entry, [0, 1, 2]),
  );
  expect(returned.log.recovery?.offline).toEqual([]);
  expect(returned.log.state).toEqual(marked.log.state);
  expect(returned.membership).toEqual(marked.membership);
  expect(returned.log.head.seq).toBe(marked.log.head.seq + 1);
  expect(seatOnlineStatement(returned.log, 2)).toMatchObject({
    ok: false,
    error: { code: 'presence-online' },
  });
});

test('online proof rejects stale parent, marker, generation and non-controller signature', () => {
  const first = offline(fixture.ready, 2);
  const marked = advanceRecoveryFixture(fixture.ready, first);
  const statement = seatOnlineStatement(marked.log, 2);
  if (!statement.ok) throw new Error(statement.error.message);
  const changes = [
    { ...statement.value, parent: recoveryFixtureRef(fixture.ready.log.head) },
    { ...statement.value, offline: recoveryFixtureRef(fixture.ready.log.head) },
    { ...statement.value, generation: recoveryFixtureRef(first.entry) },
  ];
  for (const changed of changes) {
    const proof = {
      statement: changed,
      sig: signObject(SEAT_ONLINE_DOMAIN, changed, recoveryFixtureKey(fixture, 2)),
    };
    const entry = signRecoveryFixtureEntry(
      fixture,
      marked,
      { kind: 'membership', change: { kind: 'seat-online', proof } },
      marked.log.head.stateHash,
    );
    expect(
      validateCertifiedEntry(
        certifyRecoveryFixtureEntry(fixture, marked, entry, [0, 1, 2]),
        marked,
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'presence-proof' },
    });
  }
  const badProof = {
    statement: statement.value,
    sig: signObject(SEAT_ONLINE_DOMAIN, statement.value, recoveryFixtureKey(fixture, 1)),
  };
  const badEntry = signRecoveryFixtureEntry(
    fixture,
    marked,
    { kind: 'membership', change: { kind: 'seat-online', proof: badProof } },
    marked.log.head.stateHash,
  );
  expect(
    validateCertifiedEntry(
      certifyRecoveryFixtureEntry(fixture, marked, badEntry, [0, 1, 2]),
      marked,
    ),
  ).toMatchObject({
    ok: false,
    error: { code: 'presence-signature' },
  });
});

test('takeover requires a certified offline marker and activation clears it', () => {
  const replacement = recoveryFixtureReplacement(79);
  const unmarked = signRecoveryFixtureAuthorization(
    fixture,
    recoveryFixtureReadiness(fixture, fixture.ready, replacement.peerId),
    replacement.secretKey,
  );
  const unmarkedEntry = signRecoveryFixtureEntry(
    fixture,
    fixture.ready,
    { kind: 'membership', change: unmarked },
    fixture.ready.log.head.stateHash,
  );
  expect(
    validateRecoveryTransition(
      unmarked,
      unmarkedEntry,
      fixture.ready.log,
      fixture.ready.log.crypto,
    ),
  ).toMatchObject({
    ok: false,
    error: { code: 'recovery-presence' },
  });
  const marked = advanceRecoveryFixture(fixture.ready, offline(fixture.ready, 0));
  const authorize = signRecoveryFixtureAuthorization(
    fixture,
    recoveryFixtureReadiness(fixture, marked, replacement.peerId),
    replacement.secretKey,
  );
  const authEntry = signRecoveryFixtureEntry(
    fixture,
    marked,
    { kind: 'membership', change: authorize },
    marked.log.head.stateHash,
  );
  const authorized = advanceRecoveryFixture(
    marked,
    certifyRecoveryFixtureEntry(fixture, marked, authEntry, [1, 2, 3]),
  );
  expect(authorized.log.recovery?.offline).toEqual(marked.log.recovery?.offline);
  const activate = signRecoveryFixtureActivation(fixture, authorized, authEntry);
  const applied = fixture.source.engine.apply(authorized.log.state, {
    kind: 'system',
    type: 'SEAT_STATUS',
    seat: 0,
    status: 'bot',
  });
  if (!applied.ok) throw new Error(applied.error.message);
  const activationEntry = signRecoveryFixtureEntry(
    fixture,
    authorized,
    { kind: 'membership', change: activate },
    toHex(hashValue(applied.value.state)),
  );
  const activated = advanceRecoveryFixture(
    authorized,
    certifyRecoveryFixtureEntry(fixture, authorized, activationEntry, [1, 2, 3]),
  );
  expect(activated.log.recovery?.offline).toEqual([]);
});
