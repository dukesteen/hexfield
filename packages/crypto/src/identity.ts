import { canonicalEncode, fromBase64Url, sha256, toBase64Url } from '@cp2p/codec';
import { ed25519 } from '@noble/curves/ed25519.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

/** A local Ed25519 seed and its public identity. Keep the secretKey private. */
export interface Identity {
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly peerId: string;
}

const SECRET_KEY_BYTES = 32;
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const PURPOSE = /^[a-z][a-z0-9-]{0,31}$/;
// Only successful checks are memoized, by byte content rather than mutable object
// identity. Fixed limits keep hostile input from growing process memory indefinitely.
const validKeys = new Set<string>();
const validSignatures = new Set<string>();

function remember(cache: Set<string>, key: string, limit: number): void {
  if (cache.size >= limit) {
    const oldest = cache.values().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.add(key);
}

function requireBytes(value: unknown, length: number | undefined, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || (length !== undefined && value.length !== length)) {
    throw new TypeError(
      `${name} must be ${length === undefined ? 'a' : `a ${length}-byte`} Uint8Array.`,
    );
  }
  return value;
}

function validPublicKey(value: unknown): value is Uint8Array {
  try {
    if (!(value instanceof Uint8Array) || value.length !== PUBLIC_KEY_BYTES) return false;
    const encoded = toBase64Url(value);
    if (validKeys.has(encoded)) return true;
    const point = ed25519.Point.fromBytes(value, false);
    point.assertValidity();
    if (!point.isTorsionFree()) return false;
    remember(validKeys, encoded, 256);
    return true;
  } catch {
    return false;
  }
}

function objectMessage(purpose: string, value: unknown): Uint8Array {
  if (!PURPOSE.test(purpose)) {
    throw new TypeError(
      'Signature purpose must be 1–32 lowercase ASCII letters, digits, or hyphens, beginning with a letter.',
    );
  }
  const prefix = utf8ToBytes(`cp2p/v1/${purpose}\0`);
  const body = canonicalEncode(value);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  return message;
}

/** Generates a fresh identity using noble's platform CSPRNG. */
export function generateIdentity(): Identity {
  return identityFromSecret(ed25519.keygen().secretKey);
}

/** Derives an identity from a 32-byte Ed25519 seed without retaining the caller's buffer. */
export function identityFromSecret(secretKey: Uint8Array): Identity {
  const secret = Uint8Array.from(requireBytes(secretKey, SECRET_KEY_BYTES, 'Secret key'));
  const publicKey = ed25519.getPublicKey(secret);
  return { secretKey: secret, publicKey, peerId: toBase64Url(publicKey) };
}

/** Decodes a canonical PeerId and rejects identity, torsion, and malformed public keys. */
export function parsePeerId(peerId: string): Uint8Array {
  if (typeof peerId !== 'string') throw new TypeError('PeerId must be a string.');
  const publicKey = fromBase64Url(peerId);
  if (!validPublicKey(publicKey))
    throw new TypeError('PeerId must contain a valid prime-order Ed25519 public key.');
  return publicKey;
}

/** Signs bytes with plain Ed25519. Protocol objects should use signObject. */
export function sign(bytes: Uint8Array, secretKey: Uint8Array): Uint8Array {
  requireBytes(bytes, undefined, 'Message');
  requireBytes(secretKey, SECRET_KEY_BYTES, 'Secret key');
  return ed25519.sign(bytes, secretKey);
}

/** Strict RFC 8032 verification. Malformed or hostile inputs return false. */
export function verify(signature: Uint8Array, bytes: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    if (!(signature instanceof Uint8Array) || signature.length !== SIGNATURE_BYTES) return false;
    if (!(bytes instanceof Uint8Array) || !validPublicKey(publicKey)) return false;
    // Hash the full message, including the object-purpose prefix where present.
    // Recompute from current buffers on every call, even after a successful check.
    const cacheKey = `${toBase64Url(publicKey)}/${toBase64Url(signature)}/${toBase64Url(sha256(bytes))}`;
    if (validSignatures.has(cacheKey)) return true;
    if (!ed25519.verify(signature, bytes, publicKey, { zip215: false })) return false;
    remember(validSignatures, cacheKey, 4096);
    return true;
  } catch {
    return false;
  }
}

/** Signs canonical object bytes in the cp2p/v1 purpose domain, returning base64url. */
export function signObject(purpose: string, value: unknown, secretKey: Uint8Array): string {
  return toBase64Url(sign(objectMessage(purpose, value), secretKey));
}

/** Verifies a canonical, purpose-bound object signature without throwing on peer input. */
export function verifyObject(
  purpose: string,
  value: unknown,
  signature: string,
  publicKey: Uint8Array,
): boolean {
  try {
    if (typeof signature !== 'string') return false;
    return verify(fromBase64Url(signature), objectMessage(purpose, value), publicKey);
  } catch {
    return false;
  }
}
