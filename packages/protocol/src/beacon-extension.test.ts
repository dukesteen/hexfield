import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { createHashChain, identityFromSecret, signObject } from '@cp2p/crypto';
import type { Seat } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import type { BeaconExtensionOperation, SignedBeaconExtension } from './beacon-extension.js';
import {
  beaconExtensionOperationId,
  completeBeaconExtension,
  signBeaconExtension,
  validateBeaconExtensionOperation,
  verifyBeaconExtension,
} from './beacon-extension.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing beacon extension fixture element');
  return value;
}

function fixture() {
  const seats: readonly Seat[] = [0, 1, 2];
  const identities = [1, 2, 3].map((number) => identityFromSecret(new Uint8Array(32).fill(number)));
  const oldChains = [11, 12, 13].map((number) =>
    createHashChain(new Uint8Array(32).fill(number), 4),
  );
  const newChains = [21, 22, 23].map((number) =>
    createHashChain(new Uint8Array(32).fill(number), 5),
  );
  const operation: BeaconExtensionOperation = {
    genesisDigest: toBase64Url(new Uint8Array(32).fill(9)),
    epoch: 0,
    anchor: { seq: 17, hash: 'a'.repeat(64) },
    round: 5,
    pending: { kind: 'random', request: { type: 'dice', dice: 2 }, systemType: 'DICE_RESULT' },
    participants: identities.map((identity, index) => ({
      seat: required(seats[index]),
      publicKey: identity.peerId,
      chainEpoch: 0,
      index: 4,
      length: 4,
      previous: toBase64Url(required(required(oldChains[index])[4])),
    })),
  };
  const extensions = identities.map((identity, index) =>
    signBeaconExtension(
      operation,
      required(seats[index]),
      5,
      required(required(newChains[index])[0]),
      identity.secretKey,
    ),
  );
  return { operation, identities, oldChains, newChains, extensions };
}

describe('signed exhausted-chain extension', () => {
  test('binds the same frozen request and completes ordered new commitments without randomness', () => {
    const { operation, identities, newChains, extensions } = fixture();
    expect(validateBeaconExtensionOperation(operation).ok).toBe(true);
    expect(beaconExtensionOperationId(operation)).toBe(
      toHex(hashValue({ domain: 'cp2p/v1/beacon-extension', operation })),
    );
    for (const extension of extensions)
      expect(verifyBeaconExtension(extension, operation).ok).toBe(true);
    const completed = completeBeaconExtension(operation, extensions);
    expect(completed.ok).toBe(true);
    if (!completed.ok) throw new Error(completed.error.message);
    expect(completed.value.commitments).toEqual(
      identities.map((identity, index) => ({
        seat: index,
        publicKey: identity.peerId,
        chainEpoch: 1,
        length: 5,
        tip: toBase64Url(required(required(newChains[index])[0])),
      })),
    );
    expect(completed.value.extensions).toEqual(extensions);
    expect(completed.value.extensions[0]).not.toBe(extensions[0]);
    expect(Object.keys(completed.value).toSorted()).toEqual(['commitments', 'extensions']);
  });

  test('rejects unfinished chains and changed frozen operation fields', () => {
    const { operation, oldChains, extensions } = fixture();
    const first = required(extensions[0]);
    const variants: BeaconExtensionOperation[] = [
      { ...operation, genesisDigest: toBase64Url(new Uint8Array(32).fill(8)) },
      { ...operation, epoch: 1 },
      { ...operation, anchor: { ...operation.anchor, seq: 18 } },
      { ...operation, anchor: { ...operation.anchor, hash: 'b'.repeat(64) } },
      { ...operation, pending: { ...operation.pending, request: { type: 'stealIndex' } } },
      { ...operation, round: 6 },
      {
        ...operation,
        participants: operation.participants.map((item, index) =>
          index === 0
            ? { ...item, previous: toBase64Url(required(required(oldChains[0])[3])) }
            : item,
        ),
      },
      {
        ...operation,
        participants: operation.participants.map((item, index) =>
          index === 0 ? { ...item, chainEpoch: 1 } : item,
        ),
      },
    ];
    for (const other of variants) expect(verifyBeaconExtension(first, other).ok).toBe(false);
    const unfinished = {
      ...operation,
      participants: operation.participants.map((item, index) =>
        index === 0 ? { ...item, index: item.length - 1 } : item,
      ),
    };
    expect(validateBeaconExtensionOperation(unfinished).ok).toBe(false);
    expect(verifyBeaconExtension(first, unfinished).ok).toBe(false);
    expect(completeBeaconExtension(unfinished, extensions).ok).toBe(false);
    expect(() =>
      signBeaconExtension(unfinished, 0, 5, new Uint8Array(32).fill(1), new Uint8Array(32).fill(1)),
    ).toThrow(/exhausted/);
  });

  test('requires the next signed epoch, new canonical tip, frozen signer and bounded length', () => {
    const { operation, identities, extensions } = fixture();
    const first = required(extensions[0]);
    const firstKey = required(identities[0]).secretKey;
    const secondKey = required(identities[1]).secretKey;
    const oldTip = required(operation.participants[0]).previous;
    const changedEpoch = { ...first.body, chainEpoch: 2 };
    expect(
      verifyBeaconExtension(
        { body: changedEpoch, sig: signObject('beacon-extension', changedEpoch, firstKey) },
        operation,
      ).ok,
    ).toBe(false);
    const repeatedTip = { ...first.body, tip: oldTip };
    expect(
      verifyBeaconExtension(
        { body: repeatedTip, sig: signObject('beacon-extension', repeatedTip, firstKey) },
        operation,
      ).ok,
    ).toBe(false);
    const forged: SignedBeaconExtension = {
      body: first.body,
      sig: signObject('beacon-extension', first.body, secondKey),
    };
    expect(verifyBeaconExtension(forged, operation).ok).toBe(false);
    expect(
      verifyBeaconExtension(
        { body: first.body, sig: signObject('beacon-reveal', first.body, firstKey) },
        operation,
      ).ok,
    ).toBe(false);
    expect(() => signBeaconExtension(operation, 0, 5, new Uint8Array(31), firstKey)).toThrow(/32/);
    expect(() => signBeaconExtension(operation, 0, 0, new Uint8Array(32), firstKey)).toThrow(
      /length/,
    );
    expect(() => signBeaconExtension(operation, 0, 65_537, new Uint8Array(32), firstKey)).toThrow(
      /length/,
    );
    expect(() => signBeaconExtension(operation, 0, 5, new Uint8Array(32), secondKey)).toThrow(
      /key/,
    );
    expect(() => signBeaconExtension(operation, 3, 5, new Uint8Array(32), firstKey)).toThrow(
      /Seat/,
    );
  });

  test('requires exactly one extension per frozen seat in order', () => {
    const { operation, extensions } = fixture();
    expect(completeBeaconExtension(operation, extensions.slice(0, 2)).ok).toBe(false);
    expect(completeBeaconExtension(operation, [...extensions, required(extensions[0])]).ok).toBe(
      false,
    );
    expect(completeBeaconExtension(operation, extensions.toReversed()).ok).toBe(false);
    expect(
      completeBeaconExtension(operation, [
        required(extensions[0]),
        required(extensions[0]),
        required(extensions[2]),
      ]).ok,
    ).toBe(false);
    const sparse = extensions.slice(0, 2);
    sparse.length = 3;
    expect(completeBeaconExtension(operation, sparse).ok).toBe(false);
    const hostile = new Proxy(extensions.slice(), {
      ownKeys() {
        throw new Error('hostile extension array');
      },
    });
    expect(completeBeaconExtension(operation, hostile).ok).toBe(false);
    const extra = extensions.slice();
    Object.defineProperty(extra, 'randomness', { value: 'fake' });
    expect(completeBeaconExtension(operation, extra).ok).toBe(false);
  });

  test('rejects hostile operation and signed-envelope shapes without throwing', () => {
    const { operation, extensions } = fixture();
    const first = required(extensions[0]);
    expect(validateBeaconExtensionOperation({ ...operation, extra: 1 }).ok).toBe(false);
    expect(validateBeaconExtensionOperation({ ...operation, round: 0 }).ok).toBe(false);
    expect(validateBeaconExtensionOperation({ ...operation, participants: [] }).ok).toBe(false);
    expect(
      validateBeaconExtensionOperation({
        ...operation,
        participants: operation.participants.toReversed(),
      }).ok,
    ).toBe(false);
    expect(
      validateBeaconExtensionOperation({
        ...operation,
        participants: operation.participants.map((item, index) =>
          index === 0 ? { ...item, chainEpoch: Number.MAX_SAFE_INTEGER } : item,
        ),
      }).ok,
    ).toBe(false);
    expect(verifyBeaconExtension(null, operation).ok).toBe(false);
    expect(verifyBeaconExtension({ ...first, extra: 1 }, operation).ok).toBe(false);
    expect(
      verifyBeaconExtension({ ...first, body: { ...first.body, extra: 1 } }, operation).ok,
    ).toBe(false);
    expect(
      verifyBeaconExtension({ ...first, body: { ...first.body, tip: 'x' } }, operation).ok,
    ).toBe(false);
    expect(
      verifyBeaconExtension({ ...first, body: { ...first.body, length: 65_537 } }, operation).ok,
    ).toBe(false);
    expect(verifyBeaconExtension({ ...first, sig: 'x' }, operation).ok).toBe(false);
    expect(
      verifyBeaconExtension(first, {
        ...operation,
        pending: { ...operation.pending, request: { type: 'x', huge: 'x'.repeat(300_000) } },
      }).ok,
    ).toBe(false);
  });
});
