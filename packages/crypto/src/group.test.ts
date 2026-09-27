import { canonicalEncode, toBase64Url } from '@cp2p/codec';
import { ristretto255_hasher } from '@noble/curves/ed25519.js';
import { expand_message_xmd } from '@noble/curves/abstract/hash-to-curve.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, test } from 'vitest';
import {
  G,
  H,
  SCALAR_ORDER,
  decodePoint,
  decodeScalar,
  encodePoint,
  encodeScalar,
  hashToPoint,
  invertScalar,
  modScalar,
  pointFromBytes,
  pointToBytes,
  scalarFromBytes,
  scalarToBytes,
  scalePublicPoint,
  scalePoint,
} from './group.js';

// RFC 9496 Appendix A.1: identity, generator, and its next two multiples.
const GENERATOR_MULTIPLES = [
  '00'.repeat(32),
  'e2f2ae0a6abc4e71a884a961c500515f58e30b6aa582dd8db6a65945e08d2d76',
  '6a493210f7499cd17fecb510ae0cea23a110e8d5b901f8acadd3095c73a3b919',
  '94741f5d5d52755ece4f23f044ee27d5d1ea1e2bd196b462166b16152a9d0259',
] as const;

// RFC 9496 Appendix A.3 inputs are uniform 64-byte strings, not messages
// supplied to RFC 9380 hash_to_ristretto255.
const ELEMENT_DERIVATION_VECTORS = [
  {
    input:
      '5d1be09e3d0c82fc538112490e35701979d99e06ca3e2b5b54bffe8b4dc772c1' +
      '4d98b696a1bbfb5ca32c436cc61c16563790306c79eaca7705668b47dffe5bb6',
    output: '3066f82a1a747d45120d1740f14358531a8f04bbffe6a819f86dfe50f44a0a46',
  },
  {
    input:
      'f116b34b8f17ceb56e8732a60d913dd10cce47a6d53bee9204be8b44f6678b27' +
      '0102a56902e2488c46120e9276cfe54638286b9e4b3cdb470b542d46c2068d38',
    output: 'f26e5b6f7d362d2d2a94c5d0e7602cb4773c95a2e5c31a64f133189fa76ed61b',
  },
] as const;

function deriveToCurve(bytes: Uint8Array) {
  if (!ristretto255_hasher.deriveToCurve)
    throw new Error('Noble Ristretto element derivation is unavailable.');
  return ristretto255_hasher.deriveToCurve(bytes);
}

describe('Ristretto255 group encodings', () => {
  test('matches published RFC 9496 generator multiples and accepts identity by default', () => {
    expect(pointToBytes(scalePoint(G, 0n))).toEqual(hexToBytes(GENERATOR_MULTIPLES[0]));
    for (let multiple = 1; multiple < GENERATOR_MULTIPLES.length; multiple += 1) {
      const encoded = hexToBytes(GENERATOR_MULTIPLES[multiple] ?? '');
      expect(pointToBytes(scalePoint(G, BigInt(multiple)))).toEqual(encoded);
      expect(pointToBytes(pointFromBytes(encoded))).toEqual(encoded);
      expect(
        decodePoint(encodePoint(pointFromBytes(encoded))).equals(scalePoint(G, BigInt(multiple))),
      ).toBe(true);
    }
    expect(pointFromBytes(new Uint8Array(32)).is0()).toBe(true);
    expect(() => pointFromBytes(new Uint8Array(32), { nonIdentity: true })).toThrow(/Identity/);
  });

  test('rejects RFC 9496 invalid encodings and malformed base64url', () => {
    const invalid = [
      // Appendix A.2: noncanonical field element, negative field element, nonsquare x².
      '00' + 'ff'.repeat(31),
      '01' + '00'.repeat(31),
      '26948d35ca62e643e26a83177332e6b6afeb9d08e4268b650f1f5bbd8d81d371',
    ];
    for (const hex of invalid) expect(() => pointFromBytes(hexToBytes(hex))).toThrow(/./);
    expect(() => pointFromBytes(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => decodePoint(`${encodePoint(G)}=`)).toThrow(/base64url/);
    expect(() => decodePoint('A'.repeat(100_000))).toThrow(/base64url/);
    expect(() => decodePoint(toBase64Url(new Uint8Array(31)))).toThrow(/32-byte base64url/);
  });

  test('hash-to-group H is stable, separate from G, and binds domain and canonical value', () => {
    expect(H.is0()).toBe(false);
    expect(H.equals(G)).toBe(false);
    expect(pointToBytes(H)).toEqual(pointToBytes(hashToPoint('pedersen-h', 'cp2p/pedersen/H')));
    expect(pointToBytes(H)).toEqual(
      hexToBytes('6e91c18c5b6a7567893b7f5c05d68d6096b85a32fbb34c0568ed88877b351869'),
    );
    expect(hashToPoint('card', { b: 2, a: 1 }).equals(hashToPoint('card', { a: 1, b: 2 }))).toBe(
      true,
    );
    expect(hashToPoint('card', 'x').equals(hashToPoint('deck', 'x'))).toBe(false);
    expect(() => hashToPoint('card\0other', 'x')).toThrow(/domain/);
    expect(() => hashToPoint('card', { invalid: undefined })).toThrow(/./);
  });

  test('matches RFC 9496 A.3 element derivation from uniform bytes', () => {
    for (const vector of ELEMENT_DERIVATION_VECTORS) {
      expect(pointToBytes(deriveToCurve(hexToBytes(vector.input)))).toEqual(
        hexToBytes(vector.output),
      );
    }
  });

  test('matches RFC 9380 K.3 SHA-512 XMD expansion and the actual H derivation path', () => {
    const rfcDst = 'QUUX-V01-CS02-with-expander-SHA512-256';
    expect(expand_message_xmd(new Uint8Array(), rfcDst, 32, sha512)).toEqual(
      hexToBytes('6b9a7312411d92f921c6f68ca0b6380730a1a4d982c507211a90964c394179ba'),
    );
    expect(expand_message_xmd(new TextEncoder().encode('abc'), rfcDst, 32, sha512)).toEqual(
      hexToBytes('0da749f12fbe5483eb066a5f595055679b976e93abe9be6f0f6318bce7aca8dc'),
    );

    // The expected 64 bytes were computed independently with SHA-512's XMD
    // formula over this canonical message and our fixed domain tag.
    const hMessage = canonicalEncode(['cp2p/v1/hash-to-point', 'pedersen-h', 'cp2p/pedersen/H']);
    const uniform = expand_message_xmd(hMessage, 'cp2p-v1-ristretto255-h2c', 64, sha512);
    expect(uniform).toEqual(
      hexToBytes(
        '0a928a2d4088f246b0e7245fbbbf155c065f019da61a4ae0a8cb1550a08d7d99' +
          '74e1def7a38426f5f7e2cff486738dbdc3a2af118f308695ed4baff5c05e5b83',
      ),
    );
    expect(pointToBytes(deriveToCurve(uniform))).toEqual(pointToBytes(H));
    expect(pointToBytes(hashToPoint('pedersen-h', 'cp2p/pedersen/H'))).toEqual(pointToBytes(H));
  });
});

describe('Ristretto255 scalar field', () => {
  test('reads and writes canonical little-endian values including zero', () => {
    expect(scalarFromBytes(new Uint8Array(32))).toBe(0n);
    expect(scalarToBytes(0n)).toEqual(new Uint8Array(32));
    expect(scalarFromBytes(scalarToBytes(SCALAR_ORDER - 1n))).toBe(SCALAR_ORDER - 1n);
    expect(scalarToBytes(258n).subarray(0, 3)).toEqual(Uint8Array.of(2, 1, 0));
    expect(decodeScalar(encodeScalar(258n))).toBe(258n);
    expect(() => scalarFromBytes(new Uint8Array(32), { nonzero: true })).toThrow(/zero/);
    expect(() => decodeScalar(encodeScalar(0n), { nonzero: true })).toThrow(/zero/);
  });

  test('rejects noncanonical or malformed scalars instead of silently reducing them', () => {
    expect(() => scalarFromBytes(scalarToBytes(SCALAR_ORDER - 1n).subarray(0, 31))).toThrow(
      /32 bytes/,
    );
    expect(() => scalarToBytes(SCALAR_ORDER)).toThrow(/canonical/);
    expect(() => scalarToBytes(-1n)).toThrow(/canonical/);
    expect(() => scalarFromBytes(new Uint8Array(32).fill(0xff))).toThrow(/noncanonical/);
    expect(() => decodeScalar(`${encodeScalar(1n)}=`)).toThrow(/base64url/);
    expect(() => decodeScalar('A'.repeat(100_000))).toThrow(/base64url/);
  });

  test('normalizes signed integers and performs secret-safe inversion/multiplication', () => {
    expect(modScalar(-1n)).toBe(SCALAR_ORDER - 1n);
    expect(modScalar(SCALAR_ORDER + 3n)).toBe(3n);
    expect((3n * invertScalar(3n)) % SCALAR_ORDER).toBe(1n);
    expect(scalePoint(G, 3n).equals(scalePoint(G, 9n).multiply(invertScalar(3n)))).toBe(true);
    expect(scalePoint(H, 0n).is0()).toBe(true);
    expect(() => invertScalar(0n)).toThrow(/nonzero/);
    expect(() => scalePoint(G, SCALAR_ORDER)).toThrow(/canonical/);
  });

  test('public proof scalar multiplication matches the secret-safe path', () => {
    const variablePoint = G.add(scalePoint(H, 17n));
    for (const point of [variablePoint, H, scalePoint(G, 0n)])
      for (const scalar of [0n, 1n, 2n, 31n, SCALAR_ORDER - 1n])
        expect(scalePublicPoint(point, scalar).equals(scalePoint(point, scalar))).toBe(true);
    expect(() => scalePublicPoint(variablePoint, SCALAR_ORDER)).toThrow(/canonical/);
    expect(() => scalePublicPoint(variablePoint, -1n)).toThrow(/canonical/);
  });
});
