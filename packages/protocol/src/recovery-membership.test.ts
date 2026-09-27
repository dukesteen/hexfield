import { hashValue, toHex } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import { beforeAll, describe, expect, test } from 'vitest';
import { artifactSigner, resolveArtifactSigner } from './authority.js';
import { beaconOperationId, signBeaconReveal, verifyBeaconReveal } from './beacon.js';
import { signBeaconExtension } from './beacon-extension.js';
import {
  completeBeaconState,
  extendBeaconState,
  getBeaconExtensionOperation,
  getBeaconOperation,
} from './beacon-state.js';
import { BEACON_EVIDENCE_PROTOCOL } from './crypto-context.js';
import { validateCertifiedEntry } from './proposal.js';
import type { CertifiedEntry, ProposalContext } from './proposal.js';
import { advanceCarriedOperations, validateRecoveryTransition } from './recovery-membership.js';
import type { RecoveryReadiness } from './recovery-types.js';
import {
  advanceRecoveryFixture,
  certifyRecoveryFixtureEntry as certificate,
  createRecoveryFixture,
  recoveryFixtureKey as key,
  recoveryFixtureReadiness as readiness,
  recoveryFixtureRef as entryRef,
  signRecoveryFixtureActivation as activation,
  signRecoveryFixtureAuthorization,
  signRecoveryFixtureEntry as signedEntry,
} from './testing/recovery-fixture.js';
import type { RecoveryFixture } from './testing/recovery-fixture.js';
import type { LogEntry } from './types.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing recovery fixture value');
  return item;
}

function authorization(statement: RecoveryReadiness, data: RecoveryFixture, secret: Uint8Array) {
  return signRecoveryFixtureAuthorization(data, statement, secret);
}

function commit(
  context: ProposalContext,
  entry: LogEntry,
  certified: CertifiedEntry,
): ProposalContext {
  const next = advanceRecoveryFixture(context, certified);
  expect(next.log.head).toEqual(entry);
  return next;
}

describe('certified public recovery membership', () => {
  let data: RecoveryFixture;
  beforeAll(() => {
    data = createRecoveryFixture({ masterBackedBeacon: true });
  }, 60_000);

  test('old three-of-four authorization and new three-of-three activation retain the pending beacon', () => {
    const replacement = identityFromSecret(new Uint8Array(32).fill(81));
    const before = data.ready;
    const frozen = required(before.log.crypto?.beacon.active);
    const auth = authorization(
      readiness(data, before, replacement.peerId),
      data,
      replacement.secretKey,
    );
    const authEntry = signedEntry(
      data,
      before,
      { kind: 'membership', change: auth },
      before.log.head.stateHash,
    );
    const twoVotes = certificate(data, before, authEntry, [1, 2]);
    expect(validateCertifiedEntry(twoVotes, before).ok).toBe(false);
    const authorized = commit(before, authEntry, certificate(data, before, authEntry, [1, 2, 3]));
    expect(authorized.membership.epoch).toBe(1);
    expect(authorized.membership.voters.map(({ seat }) => seat)).toEqual([1, 2, 3]);
    expect(authorized.log.crypto?.beacon.active).toEqual(frozen);
    expect(authorized.log.authority?.controllers[0]?.status).toBe('pending-recovery');
    expect(resolveArtifactSigner(authorized.log.authority, data.genesis, 1, 0).ok).toBe(false);

    const activate = activation(data, authorized, authEntry);
    const statusInput = {
      kind: 'system' as const,
      type: 'SEAT_STATUS' as const,
      seat: 0,
      status: 'bot' as const,
    };
    const applied = value(data.source.engine.apply(authorized.log.state, statusInput));
    const activateEntry = signedEntry(
      data,
      authorized,
      { kind: 'membership', change: activate },
      toHex(hashValue(applied.state)),
    );
    expect(
      validateCertifiedEntry(certificate(data, authorized, activateEntry, [1, 2]), authorized).ok,
    ).toBe(false);
    const active = commit(
      authorized,
      activateEntry,
      certificate(data, authorized, activateEntry, [1, 2, 3]),
    );
    expect(active.membership.epoch).toBe(2);
    expect(active.log.crypto?.beacon.active).toEqual(frozen);
    expect(active.log.recovery?.completed).toHaveLength(1);
    expect(active.log.authority?.controllers[0]?.publicKey).toBe(replacement.peerId);
    const current = value(artifactSigner(required(active.log.authority), 0));
    const operation = value(getBeaconOperation(required(active.log.crypto).beacon));
    const link = required(required(data.chains[0])[1]);
    const oldReveal = signBeaconReveal(operation, 0, link, key(data, 0));
    const newReveal = signBeaconReveal(operation, 0, link, replacement.secretKey, current);
    expect(verifyBeaconReveal(oldReveal, operation, current).ok).toBe(false);
    expect(verifyBeaconReveal(newReveal, operation, current).ok).toBe(true);
    const reveals = data.genesis.seats.map((owner) =>
      owner.seat === 0
        ? newReveal
        : signBeaconReveal(
            operation,
            owner.seat,
            required(required(data.chains[owner.seat])[1]),
            key(data, owner.seat),
          ),
    );
    const result = value(
      completeBeaconState(
        required(active.log.crypto).beacon,
        reveals,
        active.log.state,
        { seq: active.log.head.seq + 1, hash: 'c'.repeat(64) },
        undefined,
        active.log.authority,
        data.genesis,
        active.membership.epoch,
      ),
    );
    if (result.outcome.kind !== 'system') throw new Error('Expected a system beacon outcome');
    const input = result.outcome.input;
    const after = value(data.source.engine.apply(active.log.state, input));
    const payload = (signedReveals: typeof reveals) => ({
      kind: 'system' as const,
      input,
      evidence: { kind: 'proof' as const, protocol: BEACON_EVIDENCE_PROTOCOL, data: signedReveals },
    });
    const badEntry = signedEntry(
      data,
      active,
      payload([oldReveal, ...reveals.slice(1)]),
      toHex(hashValue(after.state)),
    );
    expect(
      validateCertifiedEntry(certificate(data, active, badEntry, [1, 2, 3]), active),
    ).toMatchObject({
      ok: false,
      error: { code: 'beacon-signature' },
    });
    const revealEntry = signedEntry(data, active, payload(reveals), toHex(hashValue(after.state)));
    const completed = commit(
      active,
      revealEntry,
      certificate(data, active, revealEntry, [1, 2, 3]),
    );
    expect(completed.log.crypto?.beacon.active).toBeNull();
    expect(completed.log.crypto?.beacon.round).toBe(1);

    // Isolate the carry update at an exhausted-chain boundary. The synthetic
    // exhausted state tests this pure metadata handoff; the certified reveal
    // above proves live admission with the replacement signer.
    const beacon = required(active.log.crypto).beacon;
    const exhaustedChains = beacon.chains.map((chain) => ({ ...chain, index: chain.length }));
    const exhausted = {
      ...beacon,
      chains: exhaustedChains,
      active: { ...required(beacon.active), participants: exhaustedChains },
    };
    const extensionOperation = value(getBeaconExtensionOperation(exhausted));
    const extensions = extensionOperation.participants.map((participant) => {
      const signer = value(artifactSigner(required(active.log.authority), participant.seat));
      return signBeaconExtension(
        extensionOperation,
        participant.seat,
        2,
        new Uint8Array(32).fill(100 + participant.seat),
        participant.seat === 0 ? replacement.secretKey : key(data, participant.seat),
        signer,
      );
    });
    const extended = value(
      extendBeaconState(
        exhausted,
        extensions,
        active.log.authority,
        data.genesis,
        active.membership.epoch,
      ),
    );
    const carried = value(
      advanceCarriedOperations(required(active.log.authority), {
        ...required(active.log.crypto),
        beacon: extended,
      }),
    );
    const nextOperation = value(getBeaconOperation(extended));
    expect(carried.carriedOperations.find(({ kind }) => kind === 'beacon')).toEqual({
      kind: 'beacon',
      id: beaconOperationId(nextOperation),
      epoch: frozen.epoch,
      anchor: frozen.anchor,
    });
  });

  test('rejects wrong readiness, parent, reused keys, and setup-pending recovery', () => {
    const before = data.ready;
    const replacement = identityFromSecret(new Uint8Array(32).fill(82));
    const good = authorization(
      readiness(data, before, replacement.peerId),
      data,
      replacement.secretKey,
    );
    const prospective = (change: unknown, context = before) => {
      const entry = signedEntry(
        data,
        context,
        { kind: 'membership', change },
        context.log.head.stateHash,
      );
      return validateRecoveryTransition(change, entry, context.log, context.log.crypto);
    };
    expect(prospective(good).ok).toBe(true);
    expect(prospective({ ...good, statement: { ...good.statement, hostSeat: 2 } }).ok).toBe(false);
    expect(
      prospective({
        ...good,
        statement: {
          ...good.statement,
          parent: { ...good.statement.parent, hash: 'f'.repeat(64) },
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'recovery-parent' } });
    const reuse = authorization(
      readiness(data, before, required(data.genesis.seats[0]).publicKey),
      data,
      key(data, 0),
    );
    expect(prospective(reuse)).toMatchObject({ ok: false, error: { code: 'recovery-key-reuse' } });
    expect(prospective(good, data.beforeSetup)).toMatchObject({
      ok: false,
      error: { code: 'recovery-context' },
    });
  });

  test('amendment keeps old authorization, reserves keys, and activates only the latest ref', () => {
    const firstKey = identityFromSecret(new Uint8Array(32).fill(83));
    const secondKey = identityFromSecret(new Uint8Array(32).fill(84));
    const before = data.ready;
    const first = authorization(readiness(data, before, firstKey.peerId), data, firstKey.secretKey);
    const firstEntry = signedEntry(
      data,
      before,
      { kind: 'membership', change: first },
      before.log.head.stateHash,
    );
    const authorized = commit(before, firstEntry, certificate(data, before, firstEntry, [1, 2, 3]));
    const amended = authorization(
      readiness(data, authorized, secondKey.peerId, entryRef(firstEntry)),
      data,
      secondKey.secretKey,
    );
    const amendmentEntry = signedEntry(
      data,
      authorized,
      { kind: 'membership', change: amended },
      authorized.log.head.stateHash,
    );
    const revised = commit(
      authorized,
      amendmentEntry,
      certificate(data, authorized, amendmentEntry, [1, 2, 3]),
    );
    expect(revised.log.recovery?.authorizations).toHaveLength(2);
    expect(revised.log.authority?.usedPublicKeys).toContain(firstKey.peerId);
    expect(revised.log.authority?.usedPublicKeys).toContain(secondKey.peerId);
    const old = activation(data, revised, firstEntry);
    const oldEntry = signedEntry(
      data,
      revised,
      { kind: 'membership', change: old },
      revised.log.head.stateHash,
    );
    expect(
      validateRecoveryTransition(old, oldEntry, revised.log, revised.log.crypto),
    ).toMatchObject({ ok: false, error: { code: 'recovery-authorization' } });
    const badReuse = authorization(
      readiness(data, revised, firstKey.peerId, entryRef(amendmentEntry)),
      data,
      firstKey.secretKey,
    );
    const reuseEntry = signedEntry(
      data,
      revised,
      { kind: 'membership', change: badReuse },
      revised.log.head.stateHash,
    );
    expect(
      validateRecoveryTransition(badReuse, reuseEntry, revised.log, revised.log.crypto),
    ).toMatchObject({ ok: false, error: { code: 'recovery-key-reuse' } });
    const final = activation(data, revised, amendmentEntry);
    const input = {
      kind: 'system' as const,
      type: 'SEAT_STATUS' as const,
      seat: 0,
      status: 'bot' as const,
    };
    const applied = value(data.source.engine.apply(revised.log.state, input));
    const finalEntry = signedEntry(
      data,
      revised,
      { kind: 'membership', change: final },
      toHex(hashValue(applied.state)),
    );
    const active = commit(revised, finalEntry, certificate(data, revised, finalEntry, [1, 2, 3]));
    expect(active.log.authority?.controllers[0]?.publicKey).toBe(secondKey.peerId);
  });
});
