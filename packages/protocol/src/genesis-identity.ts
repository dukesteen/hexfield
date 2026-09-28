import { canonicalDecode, canonicalEncode, hashValue, toBase64Url } from '@cp2p/codec';
import type { Genesis, GenesisBody } from './types.js';

const immutableDigests = new WeakMap<GenesisBody, string>();

/** Internal ownership boundary; callers never supply a trusted digest or cache entry. */
export function ownImmutableGenesis(input: Genesis): Genesis {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Canonical round-trip preserves the validated genesis shape.
  const owned = canonicalDecode(canonicalEncode(input)) as Genesis;
  const objects: object[] = [];
  function collect(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return true;
    // Typed-array storage remains mutable even when its surrounding records are frozen.
    if (value instanceof Uint8Array) return false;
    objects.push(value);
    return Object.values(value).every(collect);
  }
  if (!collect(owned)) return owned;
  const digest = genesisDigest(owned);
  for (const object of objects) Object.freeze(object);
  immutableDigests.set(owned, digest);
  return owned;
}

/** Explicit fields prevent gameId or signatures becoming part of their own hash. */
export function genesisBody(genesis: GenesisBody): GenesisBody {
  return {
    protocolVersion: genesis.protocolVersion,
    engineVersion: genesis.engineVersion,
    config: genesis.config,
    seats: genesis.seats,
    genesisSeed: genesis.genesisSeed,
    ceremonyNonce: genesis.ceremonyNonce,
    security: genesis.security,
    takeover: genesis.takeover,
    commitments: genesis.commitments,
    createdAt: genesis.createdAt,
  };
}

export function genesisId(body: GenesisBody): string {
  return genesisDigest(body).slice(0, 22);
}

/** The full digest binds protocol signatures; gameId is only its routing alias. */
export function genesisDigest(body: GenesisBody): string {
  return (
    immutableDigests.get(body) ??
    toBase64Url(hashValue({ domain: 'cp2p/v1/genesis-body', body: genesisBody(body) }))
  );
}
