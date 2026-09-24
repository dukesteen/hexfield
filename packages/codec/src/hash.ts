import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { canonicalEncode } from './canonical.js';

/** Computes SHA-256 with the audited @noble/hashes implementation. */
export function sha256(bytes: Uint8Array): Uint8Array {
  return nobleSha256(bytes);
}

/** Hashes a value's canonical representation with SHA-256. */
export function hashValue(value: unknown): Uint8Array {
  return sha256(canonicalEncode(value));
}

/** Converts a byte array to lowercase hexadecimal. */
export function toHex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}
