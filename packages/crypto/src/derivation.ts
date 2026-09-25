import { canonicalEncode } from '@cp2p/codec';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { modScalar } from './group.js';

export const DERIVATION_LABELS = Object.freeze({
  beaconSeed: 'beacon-seed',
  beaconExtension: 'beacon-extension',
  uniformInt: 'uniform-int',
  deckShuffle: 'deck-shuffle',
  deckPermutation: 'deck-permutation',
  deckLock: 'deck-lock',
  encryptionKey: 'encryption-key',
  transferBlind: 'transfer-blind',
  proofRandomness: 'proof-randomness',
  sealEphemeral: 'seal-ephemeral',
  escrowCoefficient: 'escrow-coefficient',
} as const);

export type DerivationLabel = (typeof DERIVATION_LABELS)[keyof typeof DERIVATION_LABELS];

const HKDF_SALT = utf8ToBytes('cp2p/v1/stage07/hkdf-sha256');
const SEED_BYTES = 32;
const MAX_HKDF_BYTES = 255 * 32;
const LABEL_SET = new Set<string>(Object.values(DERIVATION_LABELS));

function checkSeedAndLabel(seed: Uint8Array, label: DerivationLabel): void {
  if (!(seed instanceof Uint8Array) || seed.length !== SEED_BYTES)
    throw new TypeError('Derivation seed must be exactly 32 bytes.');
  if (typeof label !== 'string' || !LABEL_SET.has(label))
    throw new TypeError('Unknown derivation label.');
}

/** Callers must bind the full certified operation and statement in `context`. */
export function deriveBytes(
  seed: Uint8Array,
  label: DerivationLabel,
  context: unknown,
  length: number,
): Uint8Array {
  checkSeedAndLabel(seed, label);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_HKDF_BYTES)
    throw new RangeError('HKDF output length must be between 0 and 8160 bytes.');
  const info = canonicalEncode(['cp2p/v1/derive-bytes', label, context]);
  return hkdf(sha256, seed, HKDF_SALT, info, length);
}

/** Reduces 64 HKDF bytes modulo the group order, retrying zero in a distinct counter domain. */
export function deriveScalar(seed: Uint8Array, label: DerivationLabel, context: unknown): bigint {
  checkSeedAndLabel(seed, label);
  for (let counter = 0; counter < 256; counter += 1) {
    const info = canonicalEncode(['cp2p/v1/derive-scalar', label, context, counter]);
    const bytes = hkdf(sha256, seed, HKDF_SALT, info, 64);
    const wide = bytesToNumberLE(bytes);
    bytes.fill(0);
    const scalar = modScalar(wide);
    if (scalar !== 0n) return scalar;
  }
  throw new Error('Could not derive a nonzero scalar after 256 attempts.');
}
