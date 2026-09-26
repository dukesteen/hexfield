import { canonicalEncode } from '@cp2p/codec';
import { DERIVATION_LABELS, deriveScalar } from './derivation.js';
import {
  G,
  SCALAR_ORDER,
  decodePoint,
  encodePoint,
  invertScalar,
  modScalar,
  scalePoint,
} from './group.js';
import { readProofArray, readProofRecord } from './proof-transcript.js';

/** The online game has at most six original human share holders. */
const MAX_SHARES = 6;
const MAX_INDEX = 65_535;

export interface FeldmanShare {
  index: number;
  value: bigint;
}

export interface FeldmanDistribution {
  shares: FeldmanShare[];
  /** Canonical Ristretto encodings; commitments[0] is secret·G. */
  commitments: string[];
}

/** Public genesis values required to verify one recipient's escrow share. */
export interface FeldmanShareExpectation {
  threshold: number;
  masterPub: string;
  recipientIndex: number;
}

function validIndex(index: unknown): index is number {
  return Number.isSafeInteger(index) && Number(index) > 0 && Number(index) <= MAX_INDEX;
}

function validScalar(value: unknown): value is bigint {
  return typeof value === 'bigint' && value >= 0n && value < SCALAR_ORDER;
}

function checkIndices(indices: readonly number[]): void {
  if (!Array.isArray(indices) || indices.length === 0 || indices.length > MAX_SHARES)
    throw new RangeError('Feldman needs one to six participant indices.');
  if (indices.some((index) => !validIndex(index)) || new Set(indices).size !== indices.length)
    throw new RangeError('Feldman participant indices must be distinct positive bounded integers.');
}

function polynomialAt(coefficients: readonly bigint[], index: number): bigint {
  const x = BigInt(index);
  let value = 0n;
  for (let k = coefficients.length - 1; k >= 0; k -= 1)
    value = modScalar(value * x + (coefficients[k] ?? 0n));
  return value;
}

/**
 * Deterministic given secret, entropy and a canonical public ceremony context.
 * Callers must use fresh entropy and bind the ceremony attempt in `context`.
 */
export function createFeldmanShares(
  secret: bigint,
  participantIndices: readonly number[],
  threshold: number,
  entropy: Uint8Array,
  context: unknown,
): FeldmanDistribution {
  if (!validScalar(secret)) throw new RangeError('Feldman secret must be a canonical scalar.');
  checkIndices(participantIndices);
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > participantIndices.length)
    throw new RangeError('Feldman threshold must be between one and the participant count.');
  if (!(entropy instanceof Uint8Array) || entropy.length !== 32)
    throw new TypeError('Feldman entropy must be exactly 32 bytes.');

  const masterPub = encodePoint(scalePoint(G, secret));
  const statement = {
    domain: 'cp2p/v1/feldman-coefficients',
    context,
    masterPub,
    participantIndices: participantIndices.toSorted((a, b) => a - b),
    threshold,
  };
  // Threshold one has no derived coefficients, but must obey the same context contract.
  canonicalEncode(statement);
  const coefficients = [secret];
  for (let k = 1; k < threshold; k += 1)
    coefficients.push(
      deriveScalar(entropy, DERIVATION_LABELS.escrowCoefficient, {
        ...statement,
        coefficientIndex: k,
      }),
    );
  return {
    shares: participantIndices.map((index) => ({
      index,
      value: polynomialAt(coefficients, index),
    })),
    commitments: coefficients.map((coefficient) => encodePoint(scalePoint(G, coefficient))),
  };
}

/** Hostile input returns false, including degree, master-key or recipient mismatches. */
export function verifyFeldmanShare(
  share: unknown,
  commitments: unknown,
  expected: FeldmanShareExpectation,
): boolean {
  try {
    const { index, value } = readProofRecord(share, ['index', 'value']);
    if (!validIndex(index) || !validScalar(value)) return false;
    const expectation = readProofRecord(expected, ['threshold', 'masterPub', 'recipientIndex']);
    const { threshold, masterPub, recipientIndex } = expectation;
    if (
      typeof threshold !== 'number' ||
      !Number.isSafeInteger(threshold) ||
      threshold < 1 ||
      threshold > MAX_SHARES ||
      typeof masterPub !== 'string' ||
      !validIndex(recipientIndex) ||
      index !== recipientIndex
    )
      return false;
    const encoded = readProofArray(commitments, threshold);
    if (encoded[0] !== masterPub) return false;
    const points = encoded.map((item) => {
      if (typeof item !== 'string') throw new TypeError('Invalid Feldman commitment.');
      return decodePoint(item);
    });
    const x = BigInt(index);
    let power = 1n;
    let expectedPoint = scalePoint(G, 0n);
    for (const point of points) {
      expectedPoint = expectedPoint.add(scalePoint(point, power));
      power = modScalar(power * x);
    }
    return scalePoint(G, value).equals(expectedPoint);
  } catch {
    return false;
  }
}

/**
 * Interpolates authenticated, already Feldman-verified shares at x=0.
 * This function checks shape and uniqueness, but cannot authenticate shares
 * without the original commitments; callers must verify those first.
 */
export function recoverSecret(shares: readonly FeldmanShare[], threshold: number): bigint {
  if (!Array.isArray(shares) || shares.length === 0 || shares.length > MAX_SHARES)
    throw new RangeError('Feldman recovery needs one to six shares.');
  if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > shares.length)
    throw new RangeError('Feldman recovery has insufficient shares for its threshold.');
  const indices = shares.map((share) => share?.index);
  if (
    indices.some((index) => !validIndex(index)) ||
    new Set(indices).size !== indices.length ||
    shares.some((share) => !validScalar(share?.value))
  )
    throw new RangeError(
      'Feldman recovery shares must have distinct indices and canonical scalars.',
    );

  const selected = shares.slice(0, threshold);
  let secret = 0n;
  for (const share of selected) {
    let numerator = 1n;
    let denominator = 1n;
    for (const other of selected) {
      if (other.index === share.index) continue;
      numerator = modScalar(numerator * -BigInt(other.index));
      denominator = modScalar(denominator * BigInt(share.index - other.index));
    }
    secret = modScalar(secret + share.value * numerator * invertScalar(denominator));
  }
  return secret;
}
