import { canonicalEncode, toBase64Url } from '@cp2p/codec';
import { ED25519_TORSION_SUBGROUP } from '@noble/curves/ed25519.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { describe, expect, test } from 'vitest';
import {
  generateIdentity,
  identityFromSecret,
  parsePeerId,
  sign,
  signObject,
  verify,
  verifyObject,
} from './identity.js';

// RFC 8032 §7.1, Ed25519 TEST 1 (empty message).
const SECRET = hexToBytes('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
const PUBLIC = hexToBytes('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
const SIGNATURE = hexToBytes(
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155' +
    '5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
);
const TORSION = ED25519_TORSION_SUBGROUP[1];
if (!TORSION) throw new Error('Noble Ed25519 torsion fixture is missing.');

describe('Ed25519 identity', () => {
  test('matches the RFC 8032 vector and owns the supplied secret bytes', () => {
    const supplied = Uint8Array.from(SECRET);
    const identity = identityFromSecret(supplied);
    supplied.fill(0);

    expect(identity.secretKey).toEqual(SECRET);
    expect(identity.publicKey).toEqual(PUBLIC);
    expect(identity.peerId).toBe(toBase64Url(PUBLIC));
    expect(parsePeerId(identity.peerId)).toEqual(PUBLIC);
    expect(sign(new Uint8Array(), identity.secretKey)).toEqual(SIGNATURE);
    expect(verify(SIGNATURE, new Uint8Array(), identity.publicKey)).toBe(true);
  });

  test('generates a usable CSPRNG-backed identity', () => {
    const identity = generateIdentity();
    const message = utf8ToBytes('identity roundtrip');
    expect(identity.secretKey).toHaveLength(32);
    expect(parsePeerId(identity.peerId)).toEqual(identity.publicKey);
    expect(verify(sign(message, identity.secretKey), message, identity.publicKey)).toBe(true);
  });

  test('rejects malformed, noncanonical, identity, and low-order PeerIds', () => {
    const valid = toBase64Url(PUBLIC);
    const identityPoint = new Uint8Array(32);
    identityPoint[0] = 1;
    const torsionPoint = hexToBytes(TORSION);
    // y = p + 1 encodes the identity noncanonically; strict decoding must reject it.
    const noncanonicalPoint = new Uint8Array(32).fill(0xff);
    noncanonicalPoint[0] = 0xee;
    noncanonicalPoint[31] = 0x7f;
    for (const peerId of [
      `${valid}=`,
      `${valid}!`,
      toBase64Url(PUBLIC.subarray(0, 31)),
      toBase64Url(identityPoint),
      toBase64Url(torsionPoint),
      toBase64Url(noncanonicalPoint),
    ]) {
      expect(() => parsePeerId(peerId)).toThrow(/base64url|PeerId/);
    }
    expect(() => identityFromSecret(SECRET.subarray(0, 31))).toThrow(/32-byte/);
  });
});

describe('signature verification', () => {
  test('rejects tampering, wrong keys, truncated signatures, and weak public keys without throwing', () => {
    const other = generateIdentity();
    const tampered = Uint8Array.from(SIGNATURE);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    const identityPoint = new Uint8Array(32);
    identityPoint[0] = 1;
    const weak = hexToBytes(TORSION);
    const noncanonicalScalar = Uint8Array.from(SIGNATURE);
    noncanonicalScalar.fill(0xff, 32);
    const hostile = new Proxy(new Uint8Array(32), {
      get: () => {
        throw new Error('hostile getter');
      },
    });

    expect(verify(tampered, new Uint8Array(), PUBLIC)).toBe(false);
    expect(verify(SIGNATURE, utf8ToBytes('x'), PUBLIC)).toBe(false);
    expect(verify(SIGNATURE, new Uint8Array(), other.publicKey)).toBe(false);
    expect(verify(SIGNATURE.subarray(0, 63), new Uint8Array(), PUBLIC)).toBe(false);
    expect(verify(noncanonicalScalar, new Uint8Array(), PUBLIC)).toBe(false);
    expect(verify(SIGNATURE, new Uint8Array(), identityPoint)).toBe(false);
    expect(verify(SIGNATURE, new Uint8Array(), weak)).toBe(false);
    expect(verify(SIGNATURE, new Uint8Array(), hostile)).toBe(false);
    expect(Reflect.apply(verify, undefined, [null, new Uint8Array(), PUBLIC])).toBe(false);
    expect(Reflect.apply(verify, undefined, [SIGNATURE, new Uint8Array(), null])).toBe(false);
  });

  test('binds canonical object bytes to a narrow purpose domain', () => {
    const value = { z: [1, true], a: 'move' };
    const reordered = { a: 'move', z: [1, true] };
    const signature = signObject('cmd', value, SECRET);
    const explicit = new Uint8Array([...utf8ToBytes('cp2p/v1/cmd\0'), ...canonicalEncode(value)]);

    expect(signature).toBe(toBase64Url(sign(explicit, SECRET)));
    expect(verifyObject('cmd', reordered, signature, PUBLIC)).toBe(true);
    expect(verifyObject('entry', value, signature, PUBLIC)).toBe(false);
    expect(verifyObject('cmd', { ...value, a: 'other' }, signature, PUBLIC)).toBe(false);
    expect(verifyObject('cmd', value, signature, generateIdentity().publicKey)).toBe(false);
    expect(verifyObject('cmd', value, `${signature}=`, PUBLIC)).toBe(false);
    expect(verifyObject('cmd', value, signature.slice(0, -1), PUBLIC)).toBe(false);

    for (const purpose of ['', 'cmd\0entry', 'cmd/entry', 'CMD', 'cmd\névil']) {
      expect(() => signObject(purpose, value, SECRET)).toThrow(/purpose/);
      expect(verifyObject(purpose, value, signature, PUBLIC)).toBe(false);
    }
    expect(verifyObject('cmd', { bad: Number.NaN }, signature, PUBLIC)).toBe(false);
  });
});
