import { DERIVATION_LABELS, deriveBytes } from './derivation.js';

const MIN_BOUND = 1;
const MAX_BOUND = Number.MAX_SAFE_INTEGER;
const TWO_TO_64 = 1n << 64n;
const MAX_LABEL_LENGTH = 128;
// With a safe-integer bound, rejection probability per draw is below 2^-11.
const MAX_ATTEMPTS = 256;

function readBigEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * Derives a deterministic, unbiased integer in `[0, upperExclusive)`.
 * Context must be canonically encodable. The retry counter is domain-bound into
 * each HKDF request, and the eight derived bytes are interpreted big-endian.
 */
export function uniformInt(
  seed: Uint8Array,
  label: string,
  upperExclusive: number,
  context: unknown,
): number {
  if (typeof label !== 'string' || label.trim().length === 0 || label.length > MAX_LABEL_LENGTH)
    throw new TypeError('Uniform integer label must be nonempty and at most 128 characters.');
  if (
    !Number.isSafeInteger(upperExclusive) ||
    upperExclusive < MIN_BOUND ||
    upperExclusive > MAX_BOUND
  )
    throw new RangeError(
      'Uniform integer bound must be an integer from 1 through MAX_SAFE_INTEGER.',
    );

  const bound = BigInt(upperExclusive);
  const limit = TWO_TO_64 - (TWO_TO_64 % bound);
  for (let counter = 0; counter < MAX_ATTEMPTS; counter += 1) {
    const bytes = deriveBytes(seed, DERIVATION_LABELS.uniformInt, { label, context, counter }, 8);
    const candidate = readBigEndian(bytes);
    bytes.fill(0);
    if (candidate < limit) return Number(candidate % bound);
  }
  throw new Error('Uniform integer rejection counter exhausted.');
}
