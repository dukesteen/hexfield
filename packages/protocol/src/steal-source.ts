import { fromBase64Url, toBase64Url } from '@cp2p/codec';
import {
  DERIVATION_LABELS,
  deriveBytes,
  deriveScalar,
  parsePeerId,
  scalarFromBytes,
} from '@cp2p/crypto';
import type { Seat } from '@cp2p/engine';
import { key32Schema, seatSchema } from './schema-values.js';
import { parseCanonical } from './validation.js';

export interface StealSecretSource {
  encryptionSecret(): bigint;
  proofSeed(role: 'transfer' | 'dispute', context: unknown): Uint8Array;
  dispose(): void;
}

/** Fresh source for a locally owned seat; the caller disposes each invocation. */
export type StealSourceFactory = (seat: Seat) => StealSecretSource;

/**
 * Derives the encryption key before deck setup. The pre-ceremony nonce and
 * signing identity avoid a cycle with deckCeremonyId, which includes E_i.
 * Recovery must retain the original genesis signing identity in this domain.
 */
export function createStealSecretSource(
  master: Uint8Array,
  ceremonyNonce: string,
  seat: Seat,
  publicKey: string,
): StealSecretSource {
  if (!(master instanceof Uint8Array) || master.length !== 32)
    throw new TypeError('Steal master must be a canonical nonzero 32-byte scalar');
  try {
    scalarFromBytes(master, { nonzero: true });
  } catch {
    throw new TypeError('Steal master must be a canonical nonzero 32-byte scalar');
  }
  const nonce = parseCanonical(ceremonyNonce, key32Schema);
  if (!nonce.ok || toBase64Url(fromBase64Url(ceremonyNonce)) !== ceremonyNonce)
    throw new TypeError('Steal ceremony nonce must be a canonical 32-byte value');
  const checkedSeat = parseCanonical(seat, seatSchema);
  if (!checkedSeat.ok) throw new RangeError('Steal source seat must be from 0 through 5');
  try {
    parsePeerId(publicKey);
  } catch {
    throw new TypeError('Steal source public key must be a canonical signing peer ID');
  }

  const secret = master.slice();
  const domain = {
    protocol: 'steal-secret-v1',
    ceremonyNonce: nonce.value,
    seat: checkedSeat.value,
    publicKey,
  };
  let disposed = false;
  const check = (): void => {
    if (disposed) throw new Error('Steal secret source has been disposed');
  };
  return {
    encryptionSecret() {
      check();
      return deriveScalar(secret, DERIVATION_LABELS.encryptionKey, domain);
    },
    proofSeed(role, context) {
      check();
      if (role !== 'transfer' && role !== 'dispute')
        throw new TypeError('Unknown steal proof role');
      return deriveBytes(
        secret,
        DERIVATION_LABELS.proofRandomness,
        { ...domain, role, context },
        32,
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      secret.fill(0);
    },
  };
}
