import { fromBase64Url, toBase64Url } from '@cp2p/codec';
import { DERIVATION_LABELS, deriveBytes, scalarFromBytes } from '@cp2p/crypto';
import type { Seat } from '@cp2p/engine';
import { key32Schema, seatSchema } from './schema-values.js';
import { parseCanonical } from './validation.js';

export interface HandSecretSource {
  proofSeed(context: unknown): Uint8Array;
  dispose(): void;
}

export type HandSourceFactory = (seat: Seat) => HandSecretSource;

/** Deterministic, domain-separated seed source for a single owner's hand proofs. */
export function createHandSecretSource(
  master: Uint8Array,
  genesisDigest: string,
  seat: Seat,
): HandSecretSource {
  if (!(master instanceof Uint8Array) || master.length !== 32)
    throw new TypeError('Hand master must be a canonical nonzero 32-byte scalar');
  try {
    scalarFromBytes(master, { nonzero: true });
  } catch {
    throw new TypeError('Hand master must be a canonical nonzero 32-byte scalar');
  }
  const checkedDigest = parseCanonical(genesisDigest, key32Schema);
  if (!checkedDigest.ok || toBase64Url(fromBase64Url(genesisDigest)) !== genesisDigest)
    throw new TypeError('Hand source genesis digest must be a canonical 32-byte value');
  const checkedSeat = parseCanonical(seat, seatSchema);
  if (!checkedSeat.ok) throw new RangeError('Hand source seat must be from 0 through 5');

  const secret = master.slice();
  const domain = {
    protocol: 'hand-proof-seed-v1',
    genesisDigest: checkedDigest.value,
    seat: checkedSeat.value,
  };
  let disposed = false;
  return {
    proofSeed(context) {
      if (disposed) throw new Error('Hand secret source has been disposed');
      return deriveBytes(secret, DERIVATION_LABELS.proofRandomness, { ...domain, context }, 32);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      secret.fill(0);
    },
  };
}
