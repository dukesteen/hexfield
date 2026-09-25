import { canonicalEncode, fromBase64Url, toBase64Url } from '@cp2p/codec';
import { ristretto255 } from '@noble/curves/ed25519.js';
import { hkdfSync } from 'node:crypto';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, test } from 'vitest';
import { openSealed, openSealedWithSharedPoint, seal, MAX_SEALED_BYTES } from './seal.js';
import { G, SCALAR_ORDER, decodePoint, encodePoint, pointToBytes, scalePoint } from './group.js';

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index);
const RECIPIENT_SECRET = 7n;
const RECIPIENT = encodePoint(scalePoint(G, RECIPIENT_SECRET));
const CONTEXT = { game: 'seal-kat', operation: 'steal', seq: 42 };
const SALT = utf8ToBytes('cp2p/v1/seal/hkdf-sha256');

function xor(left: Uint8Array, right: Uint8Array): Uint8Array {
  return Uint8Array.from(left, (value, index) => value ^ (right[index] ?? 0));
}

describe('sealed confidential payloads', () => {
  test('matches a pinned deterministic fixture and independent Node HKDF transcript', () => {
    const plaintext = Uint8Array.of(0, 1, 127, 128, 255);
    const sealed = seal(plaintext, RECIPIENT, SEED, CONTEXT);
    expect(sealed).toEqual({
      ephemeral: 'SoA97KQzhoPO-7wHwadAmGt2kpv-MnD-MWmOdauzLTI',
      ciphertext: '5YUcvhw',
    });

    const shared = pointToBytes(scalePoint(decodePoint(sealed.ephemeral), RECIPIENT_SECRET));
    const info = canonicalEncode([
      'cp2p/v1/seal',
      CONTEXT,
      RECIPIENT,
      sealed.ephemeral,
      plaintext.length,
    ]);
    const keystream = new Uint8Array(hkdfSync('sha256', shared, SALT, info, plaintext.length));
    expect(fromBase64Url(sealed.ciphertext)).toEqual(xor(plaintext, keystream));
  });

  test('roundtrips empty, binary, and maximum-sized inputs without aliasing', () => {
    const inputs = [
      new Uint8Array(),
      Uint8Array.of(0, 1, 127, 128, 255),
      Uint8Array.from({ length: MAX_SEALED_BYTES }, (_, index) => index % 256),
    ];
    for (const original of inputs) {
      const plaintext = original.slice();
      const sealed = seal(plaintext, RECIPIENT, SEED, CONTEXT);
      const expected = plaintext.slice();
      plaintext.fill(0);
      const opened = openSealed(sealed, RECIPIENT_SECRET, CONTEXT);
      expect(opened).toEqual(expected);
      opened.fill(0);
      expect(openSealed(sealed, RECIPIENT_SECRET, CONTEXT)).toEqual(expected);
    }
    expect(() => seal(new Uint8Array(MAX_SEALED_BYTES + 1), RECIPIENT, SEED, CONTEXT)).toThrow(
      /4096/,
    );
  });

  test('binds ciphertext generation to plaintext, recipient, context, and the shared point', () => {
    const plaintext = Uint8Array.of(5, 8, 13, 21);
    const first = seal(plaintext, RECIPIENT, SEED, CONTEXT);
    const differentPlaintext = seal(Uint8Array.of(5, 8, 13, 22), RECIPIENT, SEED, CONTEXT);
    const differentContext = seal(plaintext, RECIPIENT, SEED, { ...CONTEXT, seq: 43 });
    const otherRecipient = encodePoint(scalePoint(G, 11n));
    const differentRecipient = seal(plaintext, otherRecipient, SEED, CONTEXT);

    expect(differentPlaintext.ephemeral).not.toBe(first.ephemeral);
    expect(differentContext.ephemeral).not.toBe(first.ephemeral);
    expect(differentRecipient.ephemeral).not.toBe(first.ephemeral);
    expect(openSealed(first, 11n, CONTEXT)).not.toEqual(plaintext);
    expect(openSealed(first, RECIPIENT_SECRET, { ...CONTEXT, seq: 43 })).not.toEqual(plaintext);

    const shared = encodePoint(scalePoint(decodePoint(first.ephemeral), RECIPIENT_SECRET));
    expect(openSealedWithSharedPoint(first, RECIPIENT, shared, CONTEXT)).toEqual(plaintext);
  });

  test('generic decryption does not claim integrity for modified ciphertext', () => {
    const plaintext = Uint8Array.of(10, 20, 30, 40);
    const sealed = seal(plaintext, RECIPIENT, SEED, CONTEXT);
    const changedCiphertext = fromBase64Url(sealed.ciphertext);
    changedCiphertext[0] = (changedCiphertext[0] ?? 0) ^ 1;
    const modified = { ...sealed, ciphertext: toBase64Url(changedCiphertext) };

    expect(openSealed(modified, RECIPIENT_SECRET, CONTEXT)).not.toEqual(plaintext);
  });

  test('rejects malformed records, accessors, proxies, noncanonical encodings, and oversized ciphertext', () => {
    const valid = seal(Uint8Array.of(1), RECIPIENT, SEED, CONTEXT);
    const accessor = Object.defineProperties(
      {},
      {
        ephemeral: {
          enumerable: true,
          get: () => {
            throw new Error('getter must not run');
          },
        },
        ciphertext: { enumerable: true, value: valid.ciphertext },
      },
    );
    const hostileProxy = new Proxy(valid, {
      ownKeys: () => {
        throw new Error('proxy trap');
      },
    });
    const tooLarge = {
      ...valid,
      ciphertext: 'A'.repeat(Math.ceil((MAX_SEALED_BYTES * 4) / 3) + 1),
    };
    const invalidPoint = {
      ...valid,
      ephemeral: toBase64Url(new Uint8Array(32).fill(0xff)),
    };
    const identityEphemeral = { ...valid, ephemeral: encodePoint(ristretto255.Point.ZERO) };
    const invalidCiphertext = { ...valid, ciphertext: '!' };
    const extraField = { ...valid, extra: 'unexpected' };

    for (const malformed of [
      accessor,
      hostileProxy,
      tooLarge,
      invalidPoint,
      identityEphemeral,
      invalidCiphertext,
      extraField,
    ])
      expect(() => openSealed(malformed, RECIPIENT_SECRET, CONTEXT)).toThrow(/./);
  });

  test('rejects zero/noncanonical recipient scalars and identity or invalid points', () => {
    const valid = seal(Uint8Array.of(1), RECIPIENT, SEED, CONTEXT);
    const identity = encodePoint(ristretto255.Point.ZERO);
    expect(() => seal(new Uint8Array(), identity, SEED, CONTEXT)).toThrow(/Identity/);
    expect(() => openSealed(valid, 0n, CONTEXT)).toThrow(/zero/);
    expect(() => openSealed(valid, SCALAR_ORDER, CONTEXT)).toThrow(/canonical/);
    expect(() => openSealedWithSharedPoint(valid, identity, RECIPIENT, CONTEXT)).toThrow(
      /Identity/,
    );
    expect(() => openSealedWithSharedPoint(valid, RECIPIENT, identity, CONTEXT)).toThrow(
      /Identity/,
    );
    expect(() => openSealedWithSharedPoint(valid, '!', RECIPIENT, CONTEXT)).toThrow(/base64url/);
    expect(() => seal(new Uint8Array(), RECIPIENT, new Uint8Array(31), CONTEXT)).toThrow(
      /32 bytes/,
    );
    expect(() => Reflect.apply(seal, undefined, ['not bytes', RECIPIENT, SEED, CONTEXT])).toThrow(
      /4096/,
    );
    expect(() =>
      openSealed(
        { ephemeral: RECIPIENT, ciphertext: toBase64Url(Uint8Array.of(255)) },
        -1n,
        CONTEXT,
      ),
    ).toThrow(/canonical/);
  });
});
