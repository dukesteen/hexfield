import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import type { CheatClaim } from './cheat-proof.js';
import { cheatClaimSchema } from './cheat-schema.js';
import { MAX_MESSAGE_BYTES, parseCanonical } from './validation.js';

/** Auxiliary durable outbox. Implementations must copy bytes and keep records across restart. */
export interface CheatCandidateStore {
  loadAll(): Promise<readonly { id: string; bytes: Uint8Array }[]>;
  putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean>;
  delete(id: string): Promise<void>;
}

export class MemoryCheatCandidateStore implements CheatCandidateStore {
  readonly #records = new Map<string, Uint8Array>();

  async loadAll(): Promise<readonly { id: string; bytes: Uint8Array }[]> {
    return [...this.#records].map(([id, bytes]) => ({ id, bytes: bytes.slice() }));
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.#records.has(id)) return false;
    this.#records.set(id, bytes.slice());
    return true;
  }

  async delete(id: string): Promise<void> {
    this.#records.delete(id);
  }
}

export function cheatCandidateId(claim: CheatClaim): string {
  return `cheat/${claim.seat}/${claim.evidence.kind}`;
}

export function cheatClaimHash(claim: CheatClaim): string {
  return toHex(hashValue({ domain: 'cp2p/v1/cheat-claim', claim }));
}

export function encodeCheatCandidate(
  value: unknown,
): Result<{ claim: CheatClaim; bytes: Uint8Array }> {
  const parsed = parseCanonical(value, cheatClaimSchema);
  if (!parsed.ok) return parsed;
  const bytes = canonicalEncode(parsed.value);
  return bytes.byteLength <= MAX_MESSAGE_BYTES
    ? success({ claim: parsed.value, bytes })
    : failure('cheat-candidate-size', 'Cheat candidate exceeds the wire limit');
}

export function decodeCheatCandidate(bytes: Uint8Array): Result<CheatClaim> {
  try {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_MESSAGE_BYTES)
      return failure('cheat-candidate-record', 'Stored cheat candidate exceeds its byte limit');
    return parseCanonical(canonicalDecode(bytes), cheatClaimSchema);
  } catch {
    return failure('cheat-candidate-record', 'Stored cheat candidate is not canonical data');
  }
}
