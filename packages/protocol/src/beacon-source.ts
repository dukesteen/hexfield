import { fromBase64Url } from '@cp2p/codec';
import { createHashChain, deriveBytes, DERIVATION_LABELS, scalarFromBytes } from '@cp2p/crypto';
import type { Seat } from '@cp2p/engine';
import type { BeaconSecretSource } from './beacon-contributions.js';

const DEFAULT_LENGTH = 4_096;
const MAX_LENGTH = 65_536;
const CACHE_EPOCHS = 2;

export interface BeaconSecretSourceContext {
  ceremonyId: string;
  seat: Seat;
}

export interface BeaconSecretProvider {
  source: BeaconSecretSource;
  readonly initialCommitment: { length: number; tip: Uint8Array };
  dispose(): void;
}

function checkedContext(value: BeaconSecretSourceContext): BeaconSecretSourceContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Beacon context must contain a ceremony ID and seat.');
  const keys = Reflect.ownKeys(value);
  const ceremony = Object.getOwnPropertyDescriptor(value, 'ceremonyId');
  const seat = Object.getOwnPropertyDescriptor(value, 'seat');
  if (
    keys.length !== 2 ||
    !ceremony?.enumerable ||
    !('value' in ceremony) ||
    !seat?.enumerable ||
    !('value' in seat) ||
    typeof ceremony.value !== 'string' ||
    ceremony.value.length !== 43 ||
    !Number.isSafeInteger(seat.value) ||
    seat.value < 0 ||
    seat.value > 5
  )
    throw new TypeError('Beacon context must contain a canonical ceremony ID and seat.');
  if (fromBase64Url(ceremony.value).length !== 32)
    throw new TypeError('Beacon ceremony ID must encode exactly 32 bytes.');
  return { ceremonyId: ceremony.value, seat: seat.value };
}

/** Chain secrets are deterministic across restarts, including a crash before contribution storage. */
export function createBeaconSecretSource(
  master: Uint8Array,
  context: BeaconSecretSourceContext,
  length = DEFAULT_LENGTH,
): BeaconSecretProvider {
  if (!(master instanceof Uint8Array) || master.length !== 32)
    throw new TypeError('Beacon master must be a canonical nonzero 32-byte scalar.');
  scalarFromBytes(master, { nonzero: true });
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_LENGTH)
    throw new RangeError('Beacon chain length must be from 1 through 65536.');
  const bound = checkedContext(context);
  const secret = master.slice();
  const cache = new Map<number, readonly Uint8Array[]>();
  let disposed = false;

  const chain = (chainEpoch: number): readonly Uint8Array[] => {
    if (disposed) throw new Error('Beacon secret source has been disposed.');
    if (!Number.isSafeInteger(chainEpoch) || chainEpoch < 0)
      throw new RangeError('Beacon chain epoch must be a nonnegative safe integer.');
    const known = cache.get(chainEpoch);
    if (known) return known;
    const seed = deriveBytes(
      secret,
      chainEpoch === 0 ? DERIVATION_LABELS.beaconSeed : DERIVATION_LABELS.beaconExtension,
      { ...bound, chainEpoch, length },
      32,
    );
    let generated: readonly Uint8Array[];
    try {
      generated = createHashChain(seed, length);
    } finally {
      seed.fill(0);
    }
    cache.set(chainEpoch, generated);
    if (cache.size > CACHE_EPOCHS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        for (const link of cache.get(oldest) ?? []) link.fill(0);
        cache.delete(oldest);
      }
    }
    return generated;
  };

  const source: BeaconSecretSource = {
    link(chainEpoch, index) {
      if (!Number.isSafeInteger(index) || index < 1 || index > length)
        throw new RangeError('Beacon link index is outside the chain.');
      const value = chain(chainEpoch)[index];
      if (!value) throw new Error('Beacon link is missing.');
      return value.slice();
    },
    extension(chainEpoch) {
      if (!Number.isSafeInteger(chainEpoch) || chainEpoch < 1)
        throw new RangeError('Beacon extension epoch must be positive.');
      const tip = chain(chainEpoch)[0];
      if (!tip) throw new Error('Beacon extension tip is missing.');
      return { length, tip: tip.slice() };
    },
  };
  return {
    source,
    get initialCommitment() {
      const tip = chain(0)[0];
      if (!tip) throw new Error('Initial beacon tip is missing.');
      return { length, tip: tip.slice() };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      secret.fill(0);
      for (const links of cache.values()) for (const link of links) link.fill(0);
      cache.clear();
    },
  };
}
