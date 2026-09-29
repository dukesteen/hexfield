import { describe, expect, test } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils.js';
import { DERIVATION_LABELS, deriveBotSeed, deriveBytes, deriveScalar } from './derivation.js';
import { SCALAR_ORDER } from './group.js';

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index);

describe('Stage 07 HKDF derivation', () => {
  test('keeps the registered domains unique and immutable at runtime', () => {
    const labels = Object.values(DERIVATION_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
    expect(Object.isFrozen(DERIVATION_LABELS)).toBe(true);
    expect(() =>
      Object.defineProperty(DERIVATION_LABELS, 'uniformInt', { value: 'beacon-seed' }),
    ).toThrow(/Cannot redefine property/);
  });

  test('derives a bot seed from a master secret under the bot label', () => {
    const seed = deriveBotSeed(SEED, { game: 'g', seat: 2 });
    expect(seed).toHaveLength(32);
    expect(seed).toEqual(deriveBytes(SEED, DERIVATION_LABELS.bot, { game: 'g', seat: 2 }, 32));
    expect(deriveBotSeed(SEED, { game: 'g', seat: 3 })).not.toEqual(seed);
    expect(
      deriveBytes(SEED, DERIVATION_LABELS.genesisSeed, { game: 'g', seat: 2 }, 32),
    ).not.toEqual(seed);
  });

  test('derives deterministic, detached bytes bound to label and canonical context', () => {
    const label = DERIVATION_LABELS.beaconSeed;
    const first = deriveBytes(SEED, label, { game: 'g', ordinal: 2 }, 64);
    const reordered = deriveBytes(SEED, label, { ordinal: 2, game: 'g' }, 64);
    expect(first).toHaveLength(64);
    expect(first).toEqual(
      hexToBytes(
        'd250a715c6c31bcc8f45920e6815e45aa8398659d36953e85d746fe72fe28856' +
          '43495cb1eaad0019f282a792c5e65d36c96005a42892f1b638e5e73b4b2e813a',
      ),
    );
    expect(reordered).toEqual(first);
    expect(deriveBytes(SEED, label, { game: 'g', ordinal: 3 }, 64)).not.toEqual(first);
    expect(
      deriveBytes(SEED, DERIVATION_LABELS.beaconExtension, { game: 'g', ordinal: 2 }, 64),
    ).not.toEqual(first);
    expect(deriveBytes(SEED, label, { game: 'g', ordinal: 2 }, 32)).toEqual(first.subarray(0, 32));
    first.fill(0);
    expect(deriveBytes(SEED, label, { game: 'g', ordinal: 2 }, 64)).toEqual(reordered);
  });

  test('keeps escrow distribution retry entropy in its own registered domain', () => {
    const context = {
      protocol: 'escrow-distribution-retry-entropy-v1',
      ceremonyId: 'ceremony',
      seat: 2,
    };
    const entropy = deriveBytes(SEED, DERIVATION_LABELS.escrowDistributionEntropy, context, 32);
    expect(entropy).toHaveLength(32);
    expect(entropy).not.toEqual(
      deriveBytes(SEED, DERIVATION_LABELS.escrowCoefficient, context, 32),
    );
    expect(
      deriveBytes(SEED, DERIVATION_LABELS.escrowDistributionEntropy, { ...context, seat: 3 }, 32),
    ).not.toEqual(entropy);
  });

  test('derives nonzero field scalars with domain and operation separation', () => {
    const context = { deck: 'development', epoch: 2, position: 4 };
    const shuffle = deriveScalar(SEED, DERIVATION_LABELS.deckShuffle, context);
    expect(shuffle).toBeGreaterThan(0n);
    expect(shuffle).toBeLessThan(SCALAR_ORDER);
    expect(shuffle).toBe(
      BigInt('0x5b882e34bcf7d25b476abf340a1fa92a5594ba574b2576ee75a027b3e2e9804'),
    );
    expect(
      deriveScalar(SEED, DERIVATION_LABELS.deckShuffle, {
        position: 4,
        epoch: 2,
        deck: 'development',
      }),
    ).toBe(shuffle);
    expect(deriveScalar(SEED, DERIVATION_LABELS.deckLock, context)).not.toBe(shuffle);
    expect(deriveScalar(SEED, DERIVATION_LABELS.deckShuffle, { ...context, epoch: 3 })).not.toBe(
      shuffle,
    );
    expect(deriveBytes(SEED, DERIVATION_LABELS.deckShuffle, context, 64)).not.toEqual(
      new Uint8Array(64),
    );
  });

  test('enforces the 32-byte seed, registered labels, canonical context and RFC 5869 length', () => {
    expect(() => deriveBytes(SEED.subarray(0, 31), DERIVATION_LABELS.beaconSeed, null, 1)).toThrow(
      /32 bytes/,
    );
    expect(() => deriveScalar(SEED.subarray(0, 31), DERIVATION_LABELS.beaconSeed, null)).toThrow(
      /32 bytes/,
    );
    expect(() => Reflect.apply(deriveBytes, undefined, [SEED, 'ad-hoc', null, 1])).toThrow(/label/);
    expect(() =>
      deriveBytes(SEED, DERIVATION_LABELS.beaconSeed, { missing: undefined }, 1),
    ).toThrow(/./);
    for (const length of [-1, 1.5, 8161, Number.NaN])
      expect(() => deriveBytes(SEED, DERIVATION_LABELS.beaconSeed, null, length)).toThrow(/length/);
    expect(deriveBytes(SEED, DERIVATION_LABELS.beaconSeed, null, 0)).toEqual(new Uint8Array());
    expect(deriveBytes(SEED, DERIVATION_LABELS.beaconSeed, null, 8160)).toHaveLength(8160);
  });
});
