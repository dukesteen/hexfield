import { hashValue, toBase64Url } from '@cp2p/codec';
import type { GenesisBody } from './types.js';

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
  return toBase64Url(hashValue({ domain: 'cp2p/v1/genesis-body', body: genesisBody(body) }));
}
