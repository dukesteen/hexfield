import { canonicalEncode, sha256 } from '@cp2p/codec';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { DERIVATION_LABELS, deriveScalar } from './derivation.js';
import { modScalar } from './group.js';

const DOMAIN = /^[a-z][a-z0-9-]{0,63}$/;

function checkDomain(domain: string): void {
  if (typeof domain !== 'string' || !DOMAIN.test(domain))
    throw new TypeError('Proof domain must be 1–64 lowercase ASCII letters, digits or hyphens.');
}

/** Fiat–Shamir challenge over the complete canonical statement and first messages. */
export function proofChallenge(
  domain: string,
  context: unknown,
  statement: unknown,
  commitments: unknown,
): bigint {
  checkDomain(domain);
  const transcript = canonicalEncode([
    'cp2p/v1/fiat-shamir',
    domain,
    context,
    statement,
    commitments,
  ]);
  return modScalar(bytesToNumberLE(sha256(transcript)));
}

/** The caller's context must bind the complete certified operation and statement. */
export function proofNonce(
  seed: Uint8Array,
  domain: string,
  context: unknown,
  statement: unknown,
  role: unknown,
): bigint {
  checkDomain(domain);
  return deriveScalar(seed, DERIVATION_LABELS.proofRandomness, {
    domain,
    context,
    statement,
    role,
  });
}

/** Copies only exact own enumerable data properties from a plain record. */
export function readProofRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Proof value must be a plain record.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('Proof value must be a plain record.');
  if (new Set(keys).size !== keys.length || keys.some((key) => typeof key !== 'string'))
    throw new TypeError('Expected proof keys must be unique strings.');
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    throw new TypeError('Proof record has missing or extra keys.');
  const copy: Record<string, unknown> = {};
  Object.setPrototypeOf(copy, null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor))
      throw new TypeError('Proof record must contain enumerable data properties.');
    copy[key] = descriptor.value;
  }
  return copy;
}

/** Copies an exact-length dense array without invoking element getters. */
export function readProofArray(value: unknown, length: number): unknown[] {
  if (!Number.isSafeInteger(length) || length < 0)
    throw new RangeError('Expected proof array length must be a nonnegative safe integer.');
  if (!Array.isArray(value) || value.length !== length)
    throw new TypeError('Proof value must be an array of the expected length.');
  if (Reflect.ownKeys(value).length !== length + 1)
    throw new TypeError('Proof array has holes or extra properties.');
  const copy: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor))
      throw new TypeError('Proof array must contain own enumerable data elements.');
    copy.push(descriptor.value);
  }
  return copy;
}
