import { toBase64Url } from '@cp2p/codec';
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
  scalePoint,
} from './group.js';

// RFC 9496 Appendix A.1: identity, generator, and its next two multiples.
const GENERATOR_MULTIPLES = [
  '00'.repeat(32),
  'e2f2ae0a6abc4e71a884a961c500515f58e30b6aa582dd8db6a65945e08d2d76',
  '6a493210f7499cd17fecb510ae0cea23a110e8d5b901f8acadd3095c73a3b919',
  '94741f5d5d52755ece4f23f044ee27d5d1ea1e2bd196b462166b16152a9d0259',
] as const;

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
});
