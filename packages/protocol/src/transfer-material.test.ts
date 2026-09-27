import { G, encodePoint, identityFromSecret, scalarToBytes, scalePoint } from '@cp2p/crypto';
import type { Result } from '@cp2p/engine';
import { beforeAll, expect, test } from 'vitest';
import { genesisDigest } from './genesis.js';
import type { LogContext } from './log-types.js';
import { createRecoveryFixture, recoveryFixtureKey } from './testing/recovery-fixture.js';
import type { RecoveryFixture } from './testing/recovery-fixture.js';
import {
  validatePendingTransferMaterial,
  validateRetiredTransferBinding,
  validateTransferOwnedMaterial,
} from './transfer-material.js';
import type { TransferOwnedMaterial } from './transfer-material.js';
import { transferEntryRef } from './transfer-readiness.js';

let fixture: RecoveryFixture;
beforeAll(() => {
  fixture = createRecoveryFixture({ masterBackedBeacon: true });
}, 30_000);

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function material(): TransferOwnedMaterial {
  const key = recoveryFixtureKey(fixture, 0);
  const route = fixture.ready.log.transfer?.routes.find((item) => item.seat === 0);
  if (!route?.devicePeer) throw new Error('Missing certified route');
  return {
    protocol: 'online-game-keys-v1',
    genesisDigest: genesisDigest(fixture.genesis),
    humanSeat: 0,
    devicePeer: route.devicePeer,
    seats: [
      {
        seat: 0,
        kind: 'human',
        peerId: identityFromSecret(key).peerId,
        signingKey: key.slice(),
        master: scalarToBytes(17n),
      },
    ],
  };
}

function wipe(binding: TransferOwnedMaterial): void {
  for (const seat of binding.seats) {
    seat.signingKey.fill(0);
    seat.master.fill(0);
  }
}

test('checks active ownership and original commitments, returning detached private buffers', () => {
  const input = material();
  const output = value(validateTransferOwnedMaterial(input, fixture.ready.log));
  const snapshot = input.seats[0]?.master.slice();
  wipe(output);
  expect(input.seats[0]?.master).toEqual(snapshot);
  expect(input.seats[0]?.signingKey).toEqual(recoveryFixtureKey(fixture, 0));
  wipe(input);
});

test('rejects another route, extra seats, wrong signing secret and unrelated master', () => {
  const input = material();
  try {
    expect(
      validateTransferOwnedMaterial(
        { ...input, devicePeer: input.seats[0]?.peerId },
        fixture.ready.log,
      ).ok,
    ).toBe(false);
    expect(
      validateTransferOwnedMaterial(
        { ...input, seats: [...input.seats, ...input.seats] },
        fixture.ready.log,
      ).ok,
    ).toBe(false);
    const original = input.seats[0];
    if (!original) throw new Error('Missing private fixture');
    for (const replacement of [
      { ...original, signingKey: new Uint8Array(32).fill(231) },
      { ...original, master: scalarToBytes(101n) },
    ]) {
      expect(
        validateTransferOwnedMaterial({ ...input, seats: [replacement] }, fixture.ready.log).ok,
      ).toBe(false);
    }
    expect(
      validateTransferOwnedMaterial({ ...input, safety: new Uint8Array() }, fixture.ready.log).ok,
    ).toBe(false);
    expect(input.seats[0]?.signingKey).toEqual(recoveryFixtureKey(fixture, 0));
    expect(input.seats[0]?.master).toEqual(scalarToBytes(17n));
  } finally {
    wipe(input);
  }
});

test('checks an old binding at its installed generation using later completed master evidence', () => {
  const input = material();
  try {
    // The old key was installed at genesis, before its locked-deck setup was complete.
    expect(validateTransferOwnedMaterial(input, fixture.beforeSetup.log).ok).toBe(false);
    wipe(value(validateRetiredTransferBinding(input, fixture.beforeSetup.log, fixture.ready.log)));
    const anotherOwner = { ...input, humanSeat: 1 };
    expect(
      validateRetiredTransferBinding(anotherOwner, fixture.beforeSetup.log, fixture.ready.log).ok,
    ).toBe(false);
    const noHumanKey = { ...input, seats: [] };
    expect(
      validateRetiredTransferBinding(noHumanKey, fixture.beforeSetup.log, fixture.ready.log).ok,
    ).toBe(false);
    expect(input.seats[0]?.master).toEqual(scalarToBytes(17n));
  } finally {
    wipe(input);
  }
});

test('pending material is usable only for the exact pending destination, never as active authority', () => {
  const input = material();
  const destination = identityFromSecret(new Uint8Array(32).fill(233));
  const device = identityFromSecret(new Uint8Array(32).fill(234));
  const context = fixture.ready.log;
  const transfer = context.transfer;
  const controller = context.authority?.controllers[0];
  if (!transfer || !controller) throw new Error('Missing fixture authority');
  const authorization = { seq: context.head.seq + 1, hash: 'a'.repeat(64) };
  // Scope projection unit fixture. Certified signature admission is exercised by transfer-membership tests.
  const pending: LogContext = {
    ...context,
    transfer: {
      ...transfer,
      pending: authorization,
      authorizations: [
        {
          entry: authorization,
          statement: {
            protocol: 'seat-transfer-v1',
            genesisDigest: input.genesisDigest,
            anchor: transferEntryRef(context.head),
            validUntilSeq: context.head.seq + 64,
            mode: 'live',
            seat: 0,
            currentController: controller,
            recovery: null,
            nextEpoch: 1,
            destination: {
              devicePeer: device.peerId,
              gamePeer: destination.peerId,
              transferEncryptionKey: encodePoint(scalePoint(G, 91n)),
            },
            replacements: [
              {
                seat: 0,
                oldPublicKey: controller.publicKey,
                newPublicKey: destination.peerId,
                newHostSeat: 0,
              },
            ],
          },
        },
      ],
    },
  };
  const staged: TransferOwnedMaterial = {
    ...input,
    devicePeer: device.peerId,
    seats: input.seats.map((seat) => ({
      ...seat,
      peerId: destination.peerId,
      signingKey: destination.secretKey,
    })),
  };
  const pendingTransfer = pending.transfer;
  if (!pendingTransfer) throw new Error('Missing pending transfer fixture');
  try {
    wipe(value(validatePendingTransferMaterial(staged, pending, authorization)));
    expect(validateTransferOwnedMaterial(staged, pending).ok).toBe(false);
    expect(validatePendingTransferMaterial(input, pending, authorization).ok).toBe(false);
    expect(
      validatePendingTransferMaterial(staged, pending, { ...authorization, hash: 'b'.repeat(64) })
        .ok,
    ).toBe(false);
    expect(
      validatePendingTransferMaterial(
        staged,
        { ...pending, transfer: { ...pendingTransfer, pending: null } },
        authorization,
      ).ok,
    ).toBe(false);
  } finally {
    wipe(input);
    destination.secretKey.fill(0);
    device.secretKey.fill(0);
  }
});
