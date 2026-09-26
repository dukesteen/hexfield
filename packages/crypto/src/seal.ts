import { canonicalEncode, fromBase64Url, sha256, toBase64Url } from '@cp2p/codec';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 as sha256Hash } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { DERIVATION_LABELS, deriveBytes, deriveScalar } from './derivation.js';
import { G, decodePoint, encodePoint, pointToBytes, scalarToBytes, scalePoint } from './group.js';
import { proveSchnorr, verifySchnorr } from './sigma.js';
import type { SchnorrProof } from './sigma.js';

export interface SealedPayload {
  readonly ephemeral: string;
  readonly ciphertext: string;
}

export const MAX_SEALED_BYTES = 4096;
const SALT = utf8ToBytes('cp2p/v1/seal/hkdf-sha256');

function ephemeralSecret(
  plaintext: Uint8Array,
  recipient: string,
  seed: Uint8Array,
  context: unknown,
): bigint {
  return deriveScalar(seed, DERIVATION_LABELS.sealEphemeral, {
    context,
    recipient,
    plaintextHash: toBase64Url(sha256(plaintext)),
  });
}

function ephemeralProofContext(
  sealed: SealedPayload,
  recipient: string,
  sealContext: unknown,
  context: unknown,
) {
  return { protocol: 'sealed-ephemeral-v1', recipient, sealed, sealContext, context };
}

function readPayload(value: unknown): SealedPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Sealed payload must be a record.');
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('Sealed payload must be a plain record.');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('ephemeral') || !keys.includes('ciphertext'))
    throw new TypeError('Sealed payload has unexpected fields.');
  const ephemeral = Object.getOwnPropertyDescriptor(value, 'ephemeral');
  const ciphertext = Object.getOwnPropertyDescriptor(value, 'ciphertext');
  if (
    !ephemeral?.enumerable ||
    !('value' in ephemeral) ||
    typeof ephemeral.value !== 'string' ||
    !ciphertext?.enumerable ||
    !('value' in ciphertext) ||
    typeof ciphertext.value !== 'string' ||
    ephemeral.value.length !== 43 ||
    ciphertext.value.length > Math.ceil((MAX_SEALED_BYTES * 4) / 3)
  )
    throw new TypeError('Malformed or oversized sealed payload.');
  decodePoint(ephemeral.value, { nonIdentity: true });
  return { ephemeral: ephemeral.value, ciphertext: ciphertext.value };
}

function applyKeystream(
  bytes: Uint8Array,
  recipient: string,
  ephemeral: string,
  sharedPoint: string,
  context: unknown,
): Uint8Array {
  const shared = decodePoint(sharedPoint, { nonIdentity: true });
  decodePoint(recipient, { nonIdentity: true });
  const info = canonicalEncode(['cp2p/v1/seal', context, recipient, ephemeral, bytes.length]);
  const stream = hkdf(sha256Hash, pointToBytes(shared), SALT, info, bytes.length);
  const result = Uint8Array.from(bytes, (byte, index) => byte ^ (stream[index] ?? 0));
  stream.fill(0);
  return result;
}

/**
 * Confidential delivery only: a signed protocol envelope and a checked opening
 * provide integrity. Never accept decrypted bytes as a valid card/share by themselves.
 * The seed must remain private to the sender; a public or shared seed reveals
 * the ephemeral scalar and plaintext. Context must identify the sender,
 * recipient, certified operation and full statement.
 */
export function seal(
  plaintext: Uint8Array,
  recipient: string,
  seed: Uint8Array,
  context: unknown,
): SealedPayload {
  if (!(plaintext instanceof Uint8Array) || plaintext.length > MAX_SEALED_BYTES)
    throw new TypeError('Plaintext must be at most 4096 bytes.');
  const recipientPoint = decodePoint(recipient, { nonIdentity: true });
  const secret = ephemeralSecret(plaintext, recipient, seed, context);
  const ephemeral = encodePoint(scalePoint(G, secret));
  const shared = encodePoint(scalePoint(recipientPoint, secret));
  return {
    ephemeral,
    ciphertext: toBase64Url(applyKeystream(plaintext, recipient, ephemeral, shared, context)),
  };
}

/**
 * Seals and proves knowledge of the ephemeral scalar without exposing it to callers.
 * Use a sender-private seed. Both contexts must bind the sender, recipient,
 * certified operation and full statement; the verifier must authenticate that
 * binding before any recipient shared point is disclosed in a dispute.
 */
export function sealWithEphemeralProof(
  plaintext: Uint8Array,
  recipient: string,
  seed: Uint8Array,
  sealContext: unknown,
  context: unknown,
): { sealed: SealedPayload; ephemeralProof: SchnorrProof } {
  const sealed = seal(plaintext, recipient, seed, sealContext);
  const secret = ephemeralSecret(plaintext, recipient, seed, sealContext);
  const transcript = ephemeralProofContext(sealed, recipient, sealContext, context);
  const entropy = deriveBytes(seed, DERIVATION_LABELS.proofRandomness, transcript, 32);
  try {
    return {
      sealed,
      ephemeralProof: proveSchnorr(
        { base: encodePoint(G), publicPoint: sealed.ephemeral },
        secret,
        entropy,
        transcript,
      ),
    };
  } finally {
    entropy.fill(0);
  }
}

/** A dispute may reveal xR only after the sender proves it knew r for R = rG. */
export function verifySealedEphemeralProof(
  sealed: unknown,
  recipient: string,
  proof: unknown,
  sealContext: unknown,
  context: unknown,
): boolean {
  try {
    const parsed = readPayload(sealed);
    decodePoint(recipient, { nonIdentity: true });
    return verifySchnorr(
      { base: encodePoint(G), publicPoint: parsed.ephemeral },
      proof,
      ephemeralProofContext(parsed, recipient, sealContext, context),
    );
  } catch {
    return false;
  }
}

/** Returns untrusted plaintext. The caller must validate its claimed opening. */
export function openSealed(
  payload: unknown,
  recipientSecret: bigint,
  context: unknown,
): Uint8Array {
  scalarToBytes(recipientSecret);
  if (recipientSecret === 0n) throw new RangeError('Recipient key must be nonzero.');
  const parsed = readPayload(payload);
  const recipient = encodePoint(scalePoint(G, recipientSecret));
  const shared = encodePoint(scalePoint(decodePoint(parsed.ephemeral), recipientSecret));
  return openSealedWithSharedPoint(parsed, recipient, shared, context);
}

/**
 * For public dispute verification, after a DLEQ authenticates the disclosed
 * shared point and an authenticated sender proof establishes knowledge of the
 * ephemeral scalar for this exact sealed payload and operation.
 */
export function openSealedWithSharedPoint(
  payload: unknown,
  recipient: string,
  sharedPoint: string,
  context: unknown,
): Uint8Array {
  const parsed = readPayload(payload);
  const bytes = fromBase64Url(parsed.ciphertext);
  if (bytes.length > MAX_SEALED_BYTES) throw new RangeError('Sealed payload exceeds byte limit.');
  return applyKeystream(bytes, recipient, parsed.ephemeral, sharedPoint, context);
}
