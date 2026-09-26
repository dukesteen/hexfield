import { decodePoint, encodePoint } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import type { GenesisBody } from './types.js';

/** Call after genesis shape validation, before signing or accepting verified genesis. */
export function validateGenesisEncryption(genesis: GenesisBody): Result<void> {
  if (genesis.security === 'stub')
    return genesis.seats.some((seat) => seat.encryptionKey !== undefined)
      ? failure('stub-encryption', 'Stub games cannot claim verified encryption keys')
      : success(undefined);
  const keys = new Set<string>();
  for (const seat of genesis.seats) {
    const key = seat.encryptionKey;
    if (!key || keys.has(key))
      return failure('genesis-encryption-key', 'Every seat needs a distinct encryption key');
    try {
      if (encodePoint(decodePoint(key, { nonIdentity: true })) !== key)
        return failure('genesis-encryption-key', 'Encryption key is not canonical');
    } catch {
      return failure('genesis-encryption-key', 'Encryption key is malformed or identity');
    }
    keys.add(key);
  }
  return success(undefined);
}
