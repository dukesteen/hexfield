import { hashValue, toHex } from '@cp2p/codec';
import { verifyHiddenTransfer } from '@cp2p/crypto';
import type { HiddenTransferStatement } from '@cp2p/crypto';

const LIMIT = 256;
const verified = new Set<string>();

/**
 * Memoize only a successful pure public proof check, never ledger authority.
 * Callers still authenticate the envelope and its current certified operation.
 */
export function verifyStealTransfer(
  statement: HiddenTransferStatement,
  proof: unknown,
  context: unknown,
): boolean {
  try {
    const key = toHex(
      hashValue({ domain: 'cp2p/v1/steal-transfer-proof-cache', statement, proof, context }),
    );
    if (verified.delete(key)) {
      verified.add(key);
      return true;
    }
    if (!verifyHiddenTransfer(statement, proof, context)) return false;
    verified.add(key);
    if (verified.size > LIMIT) {
      const oldest = verified.values().next().value;
      if (oldest !== undefined) verified.delete(oldest);
    }
    return true;
  } catch {
    return false;
  }
}
