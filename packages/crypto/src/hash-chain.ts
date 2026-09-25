import { sha256 } from '@noble/hashes/sha2.js';

const SEED_BYTES = 32;
const MIN_LENGTH = 1;
const MAX_LENGTH = 65_536;
const DEFAULT_LENGTH = 4_096;

/**
 * Builds a one-way reveal chain. Index zero is the committed tip and index `length`
 * is the supplied seed, with `SHA-256(chain[i + 1]) === chain[i]`.
 * Every returned link is owned by the result and does not alias `seed`.
 */
export function createHashChain(seed: Uint8Array, length = DEFAULT_LENGTH): readonly Uint8Array[] {
  if (!(seed instanceof Uint8Array) || seed.length !== SEED_BYTES)
    throw new TypeError('Hash-chain seed must be exactly 32 bytes.');
  if (!Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH)
    throw new RangeError('Hash-chain length must be an integer from 1 through 65536.');

  let link = seed.slice();
  const chain = [link];
  for (let index = 0; index < length; index += 1) {
    link = sha256(link);
    chain.push(link);
  }
  return chain.toReversed();
}

/** Returns false for malformed inputs; otherwise checks one SHA-256 chain link. */
export function verifyHashChainLink(previous: Uint8Array, reveal: Uint8Array): boolean {
  try {
    if (
      !(previous instanceof Uint8Array) ||
      previous.length !== SEED_BYTES ||
      !(reveal instanceof Uint8Array) ||
      reveal.length !== SEED_BYTES
    )
      return false;
    const actual = sha256(reveal);
    let difference = 0;
    for (let index = 0; index < SEED_BYTES; index += 1)
      difference |= (actual[index] ?? 0) ^ (previous[index] ?? 0);
    return difference === 0;
  } catch {
    return false;
  }
}
