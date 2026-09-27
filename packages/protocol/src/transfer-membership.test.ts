import { hashValue, toHex } from '@cp2p/codec';
import { G, encodePoint, identityFromSecret, scalePoint, signObject } from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { genesisDigest, validateGenesis } from './genesis.js';
import { createConsensusState } from './consensus.js';
import type { LogContext } from './log-types.js';
import { proposerFor, validateCertifiedEntry } from './proposal.js';
import { validateRecoveryTransition } from './recovery-membership.js';
import { validateTransferTransition } from './transfer-membership.js';
import { replayCertifiedPrefix, snapshotFromContext } from './replay.js';
import { createRetiredSafety, restoreRetiredSafety } from './retired-safety.js';
import { signVote, validateVote } from './votes.js';
import {
  TRANSFER_DESTINATION_CHECK_DOMAIN,
  TRANSFER_DEVICE_DOMAIN,
  TRANSFER_GAME_KEY_DOMAIN,
  TRANSFER_HUMAN_APPROVAL_DOMAIN,
  TRANSFER_OWNER_GAME_DOMAIN,
  TRANSFER_RETURN_INTENT_DOMAIN,
  advanceTransferHead,
  initialTransferState,
  transferCheckDigest,
  transferEntryRef,
} from './transfer-readiness.js';
import type {
  SeatTransferActivation,
  SeatTransferAuthorization,
  SeatTransferAuthorizationStatement,
  TransferState,
} from './transfer-types.js';
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
import type { ProposalContext } from './proposal.js';
import { PROTOCOL_VERSION } from './types.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing transfer fixture state');
  return item;
}

function initial(fixture: RecoveryFixture): TransferState {
  let state = value(initialTransferState(fixture.genesis, fixture.genesisEntry));
  for (const certified of fixture.deckEntries) state = advanceTransferHead(state, certified.entry);
  return state;
}

function context(fixture: RecoveryFixture, transfer: TransferState): LogContext {
  return { ...fixture.ready.log, transfer };
}

function authorization(
  fixture: RecoveryFixture,
  parent: LogContext,
  mode: 'live' | 'return',
  gameByte: number,
  anchor = transferEntryRef(parent.head),
): { change: SeatTransferAuthorization; gameSecret: Uint8Array } {
  const controller = parent.authority?.controllers[0];
  if (!controller || !parent.crypto) throw new Error('Missing certified controller');
  const device = identityFromSecret(new Uint8Array(32).fill(gameByte - 1));
  const game = identityFromSecret(new Uint8Array(32).fill(gameByte));
  const recovery =
    mode === 'return'
      ? parent.transfer?.returnRoots.find(
          (item) => item.departedSeat === 0 && item.activation !== null,
        )
      : null;
  const statement: SeatTransferAuthorizationStatement = {
    protocol: 'seat-transfer-v1',
    genesisDigest: genesisDigest(fixture.genesis),
    anchor,
    validUntilSeq: anchor.seq + 64,
    mode,
    seat: 0 as const,
    currentController: {
      publicKey: controller.publicKey,
      kind: controller.kind,
      activatedAt: controller.activatedAt,
      hostSeat: controller.hostSeat,
    },
    recovery: recovery?.activation
      ? {
          authorization: recovery.finalAuthorization,
          activation: recovery.activation,
        }
      : null,
    nextEpoch: parent.crypto.epoch + 1,
    destination: {
      devicePeer: device.peerId,
      gamePeer: game.peerId,
      transferEncryptionKey: encodePoint(scalePoint(G, BigInt(gameByte + 30))),
    },
    replacements: [
      {
        seat: 0,
        oldPublicKey: controller.publicKey,
        newPublicKey: game.peerId,
        newHostSeat: 0,
      },
    ],
  };
  const common = {
    kind: 'transfer-authorize' as const,
    statement,
    destinationDeviceSig: signObject(TRANSFER_DEVICE_DOMAIN, statement, device.secretKey),
    destinationGameSig: signObject(TRANSFER_GAME_KEY_DOMAIN, statement, game.secretKey),
    replacementKeySigs: [],
  };
  return {
    change:
      mode === 'live'
        ? {
            ...common,
            ownerIntent: {
              signer: 'current-game',
              sig: signObject(
                TRANSFER_OWNER_GAME_DOMAIN,
                statement,
                recoveryFixtureKey(fixture, 0),
              ),
            },
          }
        : {
            ...common,
            returnIntent: {
              signer: 'last-human-game-key',
              sig: signObject(
                TRANSFER_RETURN_INTENT_DOMAIN,
                statement,
                recoveryFixtureKey(fixture, 0),
              ),
            },
          },
    gameSecret: game.secretKey,
  };
}

function activation(
  parent: LogContext,
  authorizedEntry: ReturnType<typeof signRecoveryFixtureEntry>,
  authorized: SeatTransferAuthorization,
  gameSecret: Uint8Array,
): SeatTransferActivation {
  const authorizationRef = transferEntryRef(authorizedEntry);
  const statement = {
    protocol: 'seat-transfer-activation-v1' as const,
    genesisDigest: authorized.statement.genesisDigest,
    authorization: authorizationRef,
    parent: transferEntryRef(parent.head),
    nextEpoch: authorized.statement.nextEpoch,
    destinationDevice: authorized.statement.destination.devicePeer,
    destinationGame: authorized.statement.destination.gamePeer,
    replacements: authorized.statement.replacements,
    checkDigest: transferCheckDigest(parent, authorizationRef),
  };
  return {
    kind: 'transfer-activate',
    statement,
    destinationCheck: signObject(TRANSFER_DESTINATION_CHECK_DOMAIN, statement, gameSecret),
    replacementChecks: [],
  };
}

test('live authorization reserves a fresh key; exact-parent readiness activates it and cancellation retains the reservation', () => {
  const fixture = createRecoveryFixture();
  const parent = context(fixture, initial(fixture));
  const prepared = authorization(fixture, parent, 'live', 112);
  const authEntry = signRecoveryFixtureEntry(
    fixture,
    fixture.ready,
    { kind: 'membership', change: prepared.change },
    parent.head.stateHash,
  );
  const authorized = value(
    validateTransferTransition(prepared.change, authEntry, parent, parent.crypto),
  );
  expect(
    validateTransferTransition(
      {
        ...prepared.change,
        ownerIntent: {
          signer: 'current-game',
          sig: signObject(
            TRANSFER_OWNER_GAME_DOMAIN,
            prepared.change.statement,
            recoveryFixtureKey(fixture, 1),
          ),
        },
      },
      authEntry,
      parent,
      parent.crypto,
    ),
  ).toMatchObject({ ok: false, error: { code: 'transfer-owner-intent' } });
  const usedKey = required(parent.authority?.controllers[1]).publicKey;
  expect(
    validateTransferTransition(
      {
        ...prepared.change,
        statement: {
          ...prepared.change.statement,
          destination: { ...prepared.change.statement.destination, gamePeer: usedKey },
          replacements: [
            { ...required(prepared.change.statement.replacements[0]), newPublicKey: usedKey },
          ],
        },
      },
      authEntry,
      parent,
      parent.crypto,
    ),
  ).toMatchObject({ ok: false, error: { code: 'transfer-key-reuse' } });
  expect(authorized.authority.epoch).toBe(parent.authority?.epoch);
  expect(authorized.authority.usedPublicKeys).toContain(
    prepared.change.statement.destination.gamePeer,
  );
  const next: LogContext = {
    ...parent,
    head: authEntry,
    authority: authorized.authority,
    crypto: authorized.crypto,
    transfer: advanceTransferHead(authorized.transfer, authEntry),
  };
  const second = authorization(fixture, next, 'live', 114);
  expect(validateTransferTransition(second.change, authEntry, next, next.crypto)).toMatchObject({
    ok: false,
    error: { code: 'transfer-pending' },
  });
  const activatedChange = activation(next, authEntry, prepared.change, prepared.gameSecret);
  const nextProposal: ProposalContext = { ...fixture.ready, log: next };
  const activatedEntry = signRecoveryFixtureEntry(
    fixture,
    nextProposal,
    { kind: 'membership', change: activatedChange },
    next.head.stateHash,
  );
  const activated = value(
    validateTransferTransition(activatedChange, activatedEntry, next, next.crypto),
  );
  expect(
    validateTransferTransition(
      {
        ...activatedChange,
        destinationCheck: signObject(
          TRANSFER_DESTINATION_CHECK_DOMAIN,
          activatedChange.statement,
          recoveryFixtureKey(fixture, 1),
        ),
      },
      activatedEntry,
      next,
      next.crypto,
    ),
  ).toMatchObject({ ok: false, error: { code: 'transfer-check' } });
  expect(activated.authority.epoch).toBe((parent.authority?.epoch ?? 0) + 1);
  expect(activated.authority.controllers[0]?.publicKey).toBe(
    prepared.change.statement.destination.gamePeer,
  );
  expect(activated.transfer.routes[0]?.devicePeer).toBe(
    prepared.change.statement.destination.devicePeer,
  );
  expect(activated.state).toEqual(parent.state);

  const cancelledChange = {
    kind: 'transfer-cancel' as const,
    genesisDigest: prepared.change.statement.genesisDigest,
    authorization: transferEntryRef(authEntry),
    parent: transferEntryRef(next.head),
  };
  const cancelledEntry = signRecoveryFixtureEntry(
    fixture,
    nextProposal,
    { kind: 'membership', change: cancelledChange },
    next.head.stateHash,
  );
  const cancelled = value(
    validateTransferTransition(cancelledChange, cancelledEntry, next, next.crypto),
  );
  expect(cancelled.transfer.pending).toBeNull();
  expect(cancelled.authority.usedPublicKeys).toContain(
    prepared.change.statement.destination.gamePeer,
  );
  expect(cancelled.transfer.knownDevicePeers).toContain(
    prepared.change.statement.destination.devicePeer,
  );
  const afterCancel: LogContext = {
    ...next,
    head: cancelledEntry,
    transfer: advanceTransferHead(cancelled.transfer, cancelledEntry),
  };
  const stale = authorization(fixture, afterCancel, 'live', 116, transferEntryRef(parent.head));
  const staleEntry = signRecoveryFixtureEntry(
    fixture,
    { ...fixture.ready, log: afterCancel },
    { kind: 'membership', change: stale.change },
    afterCancel.head.stateHash,
  );
  expect(
    validateTransferTransition(stale.change, staleEntry, afterCancel, afterCancel.crypto),
  ).toMatchObject({ ok: false, error: { code: 'transfer-anchor' } });
  const reservedDevice = prepared.change.statement.destination.devicePeer;
  const retry = authorization(fixture, afterCancel, 'live', 118);
  const retryEntry = signRecoveryFixtureEntry(
    fixture,
    { ...fixture.ready, log: afterCancel },
    { kind: 'membership', change: retry.change },
    afterCancel.head.stateHash,
  );
  expect(
    validateTransferTransition(
      {
        ...retry.change,
        statement: {
          ...retry.change.statement,
          destination: {
            ...retry.change.statement.destination,
            gamePeer: reservedDevice,
          },
          replacements: [
            { ...required(retry.change.statement.replacements[0]), newPublicKey: reservedDevice },
          ],
        },
      },
      retryEntry,
      afterCancel,
      afterCancel.crypto,
    ),
  ).toMatchObject({ ok: false, error: { code: 'transfer-key-reuse' } });
  expect(
    validateTransferTransition(
      {
        ...retry.change,
        statement: {
          ...retry.change.statement,
          destination: {
            ...retry.change.statement.destination,
            transferEncryptionKey: prepared.change.statement.destination.transferEncryptionKey,
          },
        },
      },
      retryEntry,
      afterCancel,
      afterCancel.crypto,
    ),
  ).toMatchObject({ ok: false, error: { code: 'transfer-key-reuse' } });
  expect(
    validateTransferTransition(
      {
        ...activatedChange,
        statement: {
          ...activatedChange.statement,
          parent: { ...activatedChange.statement.parent, hash: '0'.repeat(64) },
        },
      },
      activatedEntry,
      next,
      next.crypto,
    ).ok,
  ).toBe(false);
}, 30_000);

test('certifies transfer with the old quorum, replays new authority, and retires the old key', () => {
  const fixture = createRecoveryFixture();
  const before = fixture.ready;
  expect(fixture.genesis.protocolVersion).toBe(PROTOCOL_VERSION);
  expect(
    validateGenesis(
      { ...fixture.genesis, protocolVersion: PROTOCOL_VERSION - 1 },
      fixture.source.engine,
      fixture.policy.genesis,
    ),
  ).toMatchObject({ ok: false, error: { code: 'version-mismatch' } });
  expect(before.log.transfer).toBeDefined();
  const prepared = authorization(fixture, before.log, 'live', 126);
  const authorizationEntry = signRecoveryFixtureEntry(
    fixture,
    before,
    { kind: 'membership', change: prepared.change },
    before.log.head.stateHash,
  );
  const insufficient = certifyRecoveryFixtureEntry(fixture, before, authorizationEntry, [0, 1]);
  expect(validateCertifiedEntry(insufficient, before).ok).toBe(false);
  const certifiedAuthorization = certifyRecoveryFixtureEntry(
    fixture,
    before,
    authorizationEntry,
    [0, 1, 2],
  );
  const authorized = advanceRecoveryFixture(before, certifiedAuthorization);
  expect(authorized.log.transfer?.pending).toEqual(transferEntryRef(authorizationEntry));
  expect(authorized.membership.epoch).toBe(0);

  const activatedChange = activation(
    authorized.log,
    authorizationEntry,
    prepared.change,
    prepared.gameSecret,
  );
  const wrongParentStatement = {
    ...activatedChange.statement,
    parent: transferEntryRef(before.log.head),
  };
  const wrongParentChange: SeatTransferActivation = {
    ...activatedChange,
    statement: wrongParentStatement,
    destinationCheck: signObject(
      TRANSFER_DESTINATION_CHECK_DOMAIN,
      wrongParentStatement,
      prepared.gameSecret,
    ),
  };
  const wrongParentEntry = signRecoveryFixtureEntry(
    fixture,
    authorized,
    { kind: 'membership', change: wrongParentChange },
    authorized.log.head.stateHash,
  );
  expect(
    validateCertifiedEntry(
      certifyRecoveryFixtureEntry(fixture, authorized, wrongParentEntry, [0, 1, 2]),
      authorized,
    ),
  ).toMatchObject({ ok: false, error: { code: 'transfer-check' } });

  const activationEntry = signRecoveryFixtureEntry(
    fixture,
    authorized,
    { kind: 'membership', change: activatedChange },
    authorized.log.head.stateHash,
  );
  const certifiedActivation = certifyRecoveryFixtureEntry(
    fixture,
    authorized,
    activationEntry,
    [0, 1, 2],
  );
  const active = advanceRecoveryFixture(authorized, certifiedActivation);
  expect(active.membership.epoch).toBe(1);
  expect(active.log.authority?.controllers[0]?.publicKey).toBe(
    prepared.change.statement.destination.gamePeer,
  );
  expect(active.membership.voters[0]?.publicKey).toBe(
    prepared.change.statement.destination.gamePeer,
  );
  const replayed = value(
    replayCertifiedPrefix(
      fixture.genesisEntry,
      [...fixture.deckEntries, certifiedAuthorization, certifiedActivation],
      fixture.source.engine,
      fixture.policy,
    ),
  );
  expect(snapshotFromContext(replayed.context)).toEqual(snapshotFromContext(active));
  const nextVote = {
    genesisDigest: active.membership.genesisDigest,
    epoch: active.membership.epoch,
    seat: 0 as const,
    seq: active.log.head.seq + 1,
    term: 1,
    phase: 'prevote' as const,
    valueHash: null,
  };
  expect(
    validateVote(signVote(nextVote, recoveryFixtureKey(fixture, 0)), active.membership),
  ).toMatchObject({
    ok: false,
    error: { code: 'vote-signature' },
  });
  expect(validateVote(signVote(nextVote, prepared.gameSecret), active.membership).ok).toBe(true);
  const oldSafety = value(createConsensusState(authorized, 0));
  const retired = value(createRetiredSafety(authorized, certifiedActivation, 0, oldSafety));
  expect(
    restoreRetiredSafety(retired, active, 0, required(fixture.genesis.seats[0]).publicKey),
  ).toEqual({ ok: true, value: retired });
}, 30_000);

test('return uses the last certified human game key after recovered bot activation', () => {
  const fixture = createRecoveryFixture();
  const seeded: ProposalContext = {
    ...fixture.ready,
    log: context(fixture, initial(fixture)),
  };
  expect(snapshotFromContext(seeded)).toEqual(snapshotFromContext(fixture.ready));
  const replacement = recoveryFixtureReplacement(86);
  const readiness = recoveryFixtureReadiness(fixture, seeded, replacement.peerId);
  const recoveryAuthorize = signRecoveryFixtureAuthorization(
    fixture,
    readiness,
    replacement.secretKey,
  );
  const authorizeEntry = signRecoveryFixtureEntry(
    fixture,
    seeded,
    { kind: 'membership', change: recoveryAuthorize },
    seeded.log.head.stateHash,
  );
  const certifiedAuthorize = certifyRecoveryFixtureEntry(
    fixture,
    seeded,
    authorizeEntry,
    [0, 1, 2, 3],
  );
  const afterAuthorize = advanceRecoveryFixture(seeded, certifiedAuthorize);
  expect(required(afterAuthorize.log.transfer).returnRoots).toHaveLength(1);
  const originalRoot = required(required(afterAuthorize.log.transfer).returnRoots[0]);
  const amendedReplacement = recoveryFixtureReplacement(87);
  const amendedReadiness = recoveryFixtureReadiness(
    fixture,
    afterAuthorize,
    amendedReplacement.peerId,
    transferEntryRef(authorizeEntry),
  );
  const recoveryAmendment = signRecoveryFixtureAuthorization(
    fixture,
    amendedReadiness,
    amendedReplacement.secretKey,
  );
  const amendmentEntry = signRecoveryFixtureEntry(
    fixture,
    afterAuthorize,
    { kind: 'membership', change: recoveryAmendment },
    afterAuthorize.log.head.stateHash,
  );
  const certifiedAmendment = certifyRecoveryFixtureEntry(
    fixture,
    afterAuthorize,
    amendmentEntry,
    [1, 2, 3],
  );
  const afterAmendment = advanceRecoveryFixture(afterAuthorize, certifiedAmendment);
  expect(required(afterAmendment.log.transfer).returnRoots[0]).toEqual({
    ...originalRoot,
    finalAuthorization: transferEntryRef(amendmentEntry),
  });
  const recoveryActivate = signRecoveryFixtureActivation(fixture, afterAmendment, amendmentEntry);
  const activateEntry = signRecoveryFixtureEntry(
    fixture,
    afterAmendment,
    { kind: 'membership', change: recoveryActivate },
    toHex(
      hashValue(
        value(
          afterAmendment.log.engine.apply(afterAmendment.log.state, {
            kind: 'system',
            type: 'SEAT_STATUS',
            seat: 0,
            status: 'bot',
          }),
        ).state,
      ),
    ),
  );
  const certifiedActivate = certifyRecoveryFixtureEntry(
    fixture,
    afterAmendment,
    activateEntry,
    [1, 2, 3],
  );
  const afterRecovery = advanceRecoveryFixture(afterAmendment, certifiedActivate);
  const parent = afterRecovery.log;
  expect(required(parent.transfer).returnRoots[0]?.activation).toEqual(
    transferEntryRef(activateEntry),
  );
  const prepared = authorization(fixture, parent, 'return', 122);
  const staleReturn = authorization(
    fixture,
    parent,
    'return',
    124,
    transferEntryRef(authorizeEntry),
  );
  const staleReturnEntry = signRecoveryFixtureEntry(
    fixture,
    afterRecovery,
    { kind: 'membership', change: staleReturn.change },
    parent.head.stateHash,
  );
  expect(
    validateTransferTransition(staleReturn.change, staleReturnEntry, parent, parent.crypto),
  ).toMatchObject({ ok: false, error: { code: 'transfer-anchor' } });
  const returnEntry = signRecoveryFixtureEntry(
    fixture,
    afterRecovery,
    { kind: 'membership', change: prepared.change },
    parent.head.stateHash,
  );
  const authorized = value(
    validateTransferTransition(prepared.change, returnEntry, parent, parent.crypto),
  );
  expect(
    validateTransferTransition(
      {
        ...prepared.change,
        returnIntent: {
          signer: 'last-human-game-key',
          sig: signObject(
            TRANSFER_RETURN_INTENT_DOMAIN,
            prepared.change.statement,
            replacement.secretKey,
          ),
        },
      },
      returnEntry,
      parent,
      parent.crypto,
    ),
  ).toMatchObject({ ok: false, error: { code: 'transfer-return-intent' } });
  expect(
    validateTransferTransition(
      prepared.change,
      returnEntry,
      { ...parent, transfer: { ...required(parent.transfer), returnRoots: [] } },
      parent.crypto,
    ),
  ).toMatchObject({ ok: false, error: { code: 'transfer-return-history' } });
  const approvals = ([1, 2, 3] as const).map((seat) => ({
    seat,
    sig: signObject(
      TRANSFER_HUMAN_APPROVAL_DOMAIN,
      prepared.change.statement,
      recoveryFixtureKey(fixture, seat),
    ),
  }));
  const approvedReturn: SeatTransferAuthorization = {
    kind: 'transfer-authorize',
    statement: prepared.change.statement,
    destinationDeviceSig: prepared.change.destinationDeviceSig,
    destinationGameSig: prepared.change.destinationGameSig,
    replacementKeySigs: [],
    humanApprovals: approvals,
  };
  const approvalEntry = signRecoveryFixtureEntry(
    fixture,
    afterRecovery,
    { kind: 'membership', change: approvedReturn },
    parent.head.stateHash,
  );
  expect(validateTransferTransition(approvedReturn, approvalEntry, parent, parent.crypto).ok).toBe(
    true,
  );
  expect(
    validateTransferTransition(
      { ...approvedReturn, humanApprovals: approvals.slice(1) },
      approvalEntry,
      parent,
      parent.crypto,
    ),
  ).toMatchObject({ ok: false, error: { code: 'transfer-return-approval' } });
  const certifiedReturn = certifyRecoveryFixtureEntry(
    fixture,
    afterRecovery,
    returnEntry,
    [1, 2, 3],
  );
  const afterReturnAuthorization = advanceRecoveryFixture(afterRecovery, certifiedReturn);
  expect(afterReturnAuthorization.log.authority).toEqual(authorized.authority);
  const next = afterReturnAuthorization.log;
  const activatedChange = activation(next, returnEntry, prepared.change, prepared.gameSecret);
  const expectedState = value(
    next.engine.apply(next.state, {
      kind: 'system',
      type: 'SEAT_STATUS',
      seat: 0,
      status: 'active',
    }),
  ).state;
  const activatedEntry = signRecoveryFixtureEntry(
    fixture,
    afterReturnAuthorization,
    { kind: 'membership', change: activatedChange },
    toHex(hashValue(expectedState)),
  );
  const activated = value(
    validateTransferTransition(activatedChange, activatedEntry, next, next.crypto),
  );
  expect(activated.authority.controllers[0]).toMatchObject({
    kind: 'human',
    publicKey: prepared.change.statement.destination.gamePeer,
    hostSeat: 0,
  });
  expect(activated.state).toEqual(expectedState);
  const certifiedActivation = certifyRecoveryFixtureEntry(
    fixture,
    afterReturnAuthorization,
    activatedEntry,
    [1, 2, 3],
  );
  const returned = advanceRecoveryFixture(afterReturnAuthorization, certifiedActivation);
  expect(returned.membership.epoch).toBe(afterReturnAuthorization.membership.epoch + 1);
  expect(returned.membership.voters[0]?.publicKey).toBe(
    prepared.change.statement.destination.gamePeer,
  );
  expect(returned.log.state).toEqual(expectedState);

  // A later loss creates a new return root. The original human key and R1
  // ancestry must not become valid again after this second recovery.
  const offlineTerm = [1, 2, 3, 4].find(
    (term) =>
      proposerFor(returned.log.head.seq + 1, term, returned.membership, returned.excludedProposers)
        .seat !== 0,
  );
  if (offlineTerm === undefined) throw new Error('No surviving offline-marker proposer');
  const secondOfflineEntry = signRecoveryFixtureEntry(
    fixture,
    returned,
    { kind: 'membership', change: { kind: 'seat-offline', seat: 0 } },
    returned.log.head.stateHash,
    offlineTerm,
  );
  const afterSecondOffline = advanceRecoveryFixture(
    returned,
    certifyRecoveryFixtureEntry(fixture, returned, secondOfflineEntry, [1, 2, 3]),
  );
  const secondReplacement = recoveryFixtureReplacement(88);
  const secondReadiness = recoveryFixtureReadiness(
    fixture,
    afterSecondOffline,
    secondReplacement.peerId,
  );
  const secondAuthorize = signRecoveryFixtureAuthorization(
    fixture,
    secondReadiness,
    secondReplacement.secretKey,
  );
  const secondAuthorizeEntry = signRecoveryFixtureEntry(
    fixture,
    afterSecondOffline,
    { kind: 'membership', change: secondAuthorize },
    afterSecondOffline.log.head.stateHash,
  );
  const secondAuthorized = advanceRecoveryFixture(
    afterSecondOffline,
    certifyRecoveryFixtureEntry(fixture, afterSecondOffline, secondAuthorizeEntry, [1, 2, 3]),
  );
  const secondActivate = signRecoveryFixtureActivation(
    fixture,
    secondAuthorized,
    secondAuthorizeEntry,
  );
  const secondActivateInput = {
    kind: 'system' as const,
    type: 'SEAT_STATUS' as const,
    seat: 0,
    status: 'bot' as const,
  };
  const secondActivatedState = value(
    secondAuthorized.log.engine.apply(secondAuthorized.log.state, secondActivateInput),
  ).state;
  const secondActivateEntry = signRecoveryFixtureEntry(
    fixture,
    secondAuthorized,
    { kind: 'membership', change: secondActivate },
    toHex(hashValue(secondActivatedState)),
  );
  const twiceRecovered = advanceRecoveryFixture(
    secondAuthorized,
    certifyRecoveryFixtureEntry(fixture, secondAuthorized, secondActivateEntry, [1, 2, 3]),
  );
  expect(required(twiceRecovered.log.transfer).returnRoots).toHaveLength(2);
  const staleRootReturn = authorization(fixture, twiceRecovered.log, 'return', 132);
  const staleRootReturnEntry = signRecoveryFixtureEntry(
    fixture,
    twiceRecovered,
    { kind: 'membership', change: staleRootReturn.change },
    twiceRecovered.log.head.stateHash,
  );
  expect(
    validateTransferTransition(
      staleRootReturn.change,
      staleRootReturnEntry,
      twiceRecovered.log,
      twiceRecovered.log.crypto,
    ),
  ).toMatchObject({ ok: false, error: { code: 'transfer-return-history' } });
  const latestRoot = required(twiceRecovered.log.transfer).returnRoots[1];
  if (!latestRoot?.activation) throw new Error('Missing second recovery root activation');
  const currentReturnStatement = {
    ...staleRootReturn.change.statement,
    recovery: {
      authorization: latestRoot.finalAuthorization,
      activation: latestRoot.activation,
    },
  };
  const currentReturnDevice = identityFromSecret(new Uint8Array(32).fill(131));
  const currentReturnGame = identityFromSecret(new Uint8Array(32).fill(132));
  const currentReturn = {
    ...staleRootReturn.change,
    statement: currentReturnStatement,
    destinationDeviceSig: signObject(
      TRANSFER_DEVICE_DOMAIN,
      currentReturnStatement,
      currentReturnDevice.secretKey,
    ),
    destinationGameSig: signObject(
      TRANSFER_GAME_KEY_DOMAIN,
      currentReturnStatement,
      currentReturnGame.secretKey,
    ),
    returnIntent: {
      signer: 'last-human-game-key' as const,
      sig: signObject(TRANSFER_RETURN_INTENT_DOMAIN, currentReturnStatement, prepared.gameSecret),
    },
  };
  const currentReturnEntry = signRecoveryFixtureEntry(
    fixture,
    twiceRecovered,
    { kind: 'membership', change: currentReturn },
    twiceRecovered.log.head.stateHash,
  );
  expect(
    validateTransferTransition(
      currentReturn,
      currentReturnEntry,
      twiceRecovered.log,
      twiceRecovered.log.crypto,
    ).ok,
  ).toBe(true);

  expect(
    validateRecoveryTransition(recoveryAuthorize, authorizeEntry, next, next.crypto),
  ).toMatchObject({
    ok: false,
    error: { code: 'recovery-transfer-pending' },
  });
}, 30_000);
