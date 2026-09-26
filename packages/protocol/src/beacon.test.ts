import { canonicalEncode, sha256, toBase64Url } from '@cp2p/codec';
import { createHashChain, identityFromSecret, signObject } from '@cp2p/crypto';
import type { Seat } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import {
  beaconOperationId,
  completeBeacon,
  signBeaconReveal,
  validateBeaconOperation,
  verifyBeaconReveal,
  type BeaconOperation,
  type SignedBeaconReveal,
} from './beacon.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing beacon fixture element');
  return value;
}

function fixture() {
  const seats: readonly Seat[] = [0, 1, 2];
  const identities = [1, 2, 3].map((number) => identityFromSecret(new Uint8Array(32).fill(number)));
  const chains = [11, 12, 13].map((number) => createHashChain(new Uint8Array(32).fill(number), 4));
  const operation: BeaconOperation = {
    genesisDigest: toBase64Url(new Uint8Array(32).fill(9)),
    epoch: 0,
    anchor: { seq: 17, hash: 'a'.repeat(64) },
    round: 5,
    pending: { kind: 'random', request: { type: 'dice', dice: 2 }, systemType: 'DICE_RESULT' },
    participants: identities.map((identity, index) => ({
      seat: required(seats[index]),
      publicKey: identity.peerId,
      chainEpoch: 0,
      index: 1,
      length: 4,
      previous: toBase64Url(required(required(chains[index])[0])),
    })),
  };
  const reveals = identities.map((identity, seat) =>
    signBeaconReveal(
      operation,
      required(seats[seat]),
      required(required(chains[seat])[1]),
      identity.secretKey,
    ),
  );
  return { operation, identities, chains, reveals };
}

describe('frozen beacon contribution and completion', () => {
  test('validates signed multi-human links and pins the seed to values, not signatures', () => {
    const { operation, reveals } = fixture();
    const checked = validateBeaconOperation(operation);
    expect(checked.ok).toBe(true);
    expect(beaconOperationId(operation)).toMatch(/^[0-9a-f]{64}$/);
    for (const reveal of reveals) expect(verifyBeaconReveal(reveal, operation).ok).toBe(true);
    const completed = completeBeacon(operation, reveals);
    expect(completed.ok).toBe(true);
    if (!completed.ok) throw new Error(completed.error.message);
    const values = reveals.map(({ body }) => ({ seat: body.seat, value: body.value }));
    expect(completed.value.seed).toBe(
      toBase64Url(sha256(canonicalEncode(['cp2p/v1/beacon', operation, operation.round, values]))),
    );
    expect(completed.value.seed).toBe('2VOJW3v8tvPHz5vfSJhlkf5DDQGT1TAQaeGDxLe7bYk');
    expect(completed.value.reveals).toEqual(reveals);
    expect(completed.value.reveals[0]).not.toBe(reveals[0]);
  });

  test('rejects forged keys, other operations and replayed chain links', () => {
    const { operation, identities, chains, reveals } = fixture();
    const first = required(reveals[0]);
    const firstKey = required(identities[0]).secretKey;
    const secondKey = required(identities[1]).secretKey;
    const variants: BeaconOperation[] = [
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
            ? { ...item, index: 2, previous: toBase64Url(required(required(chains[0])[1])) }
            : item,
        ),
      },
    ];
    for (const other of variants) expect(verifyBeaconReveal(first, other).ok).toBe(false);
    const forged: SignedBeaconReveal = {
      body: first.body,
      sig: signObject('beacon-reveal', first.body, secondKey),
    };
    expect(verifyBeaconReveal(forged, operation).ok).toBe(false);
    const wrongIndex = { ...first.body, index: 2 };
    expect(
      verifyBeaconReveal(
        { body: wrongIndex, sig: signObject('beacon-reveal', wrongIndex, firstKey) },
        operation,
      ).ok,
    ).toBe(false);
    const staleValue = { ...first.body, value: toBase64Url(required(required(chains[0])[2])) };
    expect(
      verifyBeaconReveal(
        { body: staleValue, sig: signObject('beacon-reveal', staleValue, firstKey) },
        operation,
      ).ok,
    ).toBe(false);
    expect(() =>
      signBeaconReveal(operation, 0, required(required(chains[0])[2]), firstKey),
    ).toThrow(/chain/);
    expect(() =>
      signBeaconReveal(operation, 0, required(required(chains[0])[1]), secondKey),
    ).toThrow(/key/);
  });

  test('requires the exact sorted participant and reveal set', () => {
    const { operation, reveals } = fixture();
    expect(completeBeacon(operation, reveals.slice(0, 2)).ok).toBe(false);
    expect(completeBeacon(operation, [...reveals, required(reveals[0])]).ok).toBe(false);
    const sparse = reveals.slice(0, 2);
    sparse.length = 3;
    expect(completeBeacon(operation, sparse).ok).toBe(false);
    const extra = reveals.slice();
    Object.defineProperty(extra, 'seed', { value: 'fake' });
    expect(completeBeacon(operation, extra).ok).toBe(false);
    const hostile = new Proxy(reveals, {
      ownKeys() {
        throw new Error('hostile array');
      },
    });
    expect(completeBeacon(operation, hostile).ok).toBe(false);
    expect(
      completeBeacon(operation, [required(reveals[0]), required(reveals[0]), required(reveals[2])])
        .ok,
    ).toBe(false);
    expect(completeBeacon(operation, reveals.toReversed()).ok).toBe(false);
    expect(
      completeBeacon(operation, [required(reveals[0]), required(reveals[2]), required(reveals[1])])
        .ok,
    ).toBe(false);
    expect(
      completeBeacon(operation, [{ ...required(reveals[0]), seed: 'fake' }, ...reveals.slice(1)])
        .ok,
    ).toBe(false);
    expect(
      validateBeaconOperation({ ...operation, participants: operation.participants.toReversed() })
        .ok,
    ).toBe(false);
    expect(
      validateBeaconOperation({
        ...operation,
        participants: [operation.participants[0], operation.participants[0]],
      }).ok,
    ).toBe(false);
  });

  test('rejects malformed operation fields, keys and oversized canonical messages', () => {
    const { operation, reveals } = fixture();
    expect(validateBeaconOperation({ ...operation, extra: 1 }).ok).toBe(false);
    expect(
      validateBeaconOperation({ ...operation, pending: { ...operation.pending, extra: 1 } }).ok,
    ).toBe(false);
    expect(
      validateBeaconOperation({ ...operation, anchor: { ...operation.anchor, extra: 1 } }).ok,
    ).toBe(false);
    expect(validateBeaconOperation({ ...operation, round: 0 }).ok).toBe(false);
    expect(validateBeaconOperation({ ...operation, epoch: -1 }).ok).toBe(false);
    expect(
      validateBeaconOperation({
        ...operation,
        pending: { ...operation.pending, request: { type: '' } },
      }).ok,
    ).toBe(false);
    expect(
      validateBeaconOperation({
        ...operation,
        pending: { ...operation.pending, request: { type: 'x', huge: 'x'.repeat(300_000) } },
      }).ok,
    ).toBe(false);
    const invalidParticipants = [
      { ...required(operation.participants[0]), index: 0 },
      { ...required(operation.participants[0]), index: 5 },
      { ...required(operation.participants[0]), length: 65_537 },
      {
        ...required(operation.participants[0]),
        previous: `${required(operation.participants[0]).previous}=`,
      },
      { ...required(operation.participants[0]), publicKey: toBase64Url(new Uint8Array(32)) },
      { ...required(operation.participants[0]), extra: 1 },
    ];
    for (const first of invalidParticipants)
      expect(
        validateBeaconOperation({
          ...operation,
          participants: [first, ...operation.participants.slice(1)],
        }).ok,
      ).toBe(false);
    expect(verifyBeaconReveal({ ...required(reveals[0]), extra: 1 }, operation).ok).toBe(false);
    expect(
      verifyBeaconReveal(
        { ...required(reveals[0]), body: { ...required(reveals[0]).body, value: 'x' } },
        operation,
      ).ok,
    ).toBe(false);
    expect(
      completeBeacon(operation, [
        { ...required(reveals[0]), body: { ...required(reveals[0]).body, extra: 1 } },
        ...reveals.slice(1),
      ]).ok,
    ).toBe(false);
  });
});
