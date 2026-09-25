import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { createBaseEngine, ENGINE_VERSION } from '@cp2p/engine';
import type { GameConfig } from '@cp2p/engine';
import { GENESIS_PREVIOUS_HASH, genesisId, signEntry, signGenesis } from '../genesis.js';
import { PROTOCOL_VERSION } from '../types.js';
import type { Genesis, GenesisBody, LogEntry } from '../types.js';

export function fixtureAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Missing protocol test fixture at ${index}`);
  return item;
}

/** Fixed keys and board seed keep protocol tests reproducible without test-time randomness. */
export function protocolFixture(): {
  engine: ReturnType<typeof createBaseEngine>;
  identities: readonly ReturnType<typeof identityFromSecret>[];
  body: GenesisBody;
  genesis: Genesis;
  state: ReturnType<ReturnType<typeof createBaseEngine>['createGame']>;
  entry: LogEntry;
} {
  const engine = createBaseEngine();
  const identities = [1, 2, 3, 4].map((byte) => identityFromSecret(new Uint8Array(32).fill(byte)));
  const config: GameConfig = {
    modules: [{ id: 'base', version: '1.0.0' }],
    seats: [0, 1, 2, 3],
    options: { base: { mapLayout: 'random' } },
  };
  const seed = new Uint8Array(32);
  const state = engine.createGame(config, seed);
  const first = identities[0];
  const second = identities[1];
  const third = identities[2];
  const fourth = identities[3];
  if (!first || !second || !third || !fourth) throw new Error('Missing protocol test identity');
  const body: GenesisBody = {
    protocolVersion: PROTOCOL_VERSION,
    engineVersion: ENGINE_VERSION,
    config,
    seats: [
      { seat: 0, kind: 'human', publicKey: first.peerId, name: 'Alice', colour: '#386b6d' },
      { seat: 1, kind: 'human', publicKey: second.peerId, name: 'Bob', colour: '#b35a39' },
      {
        seat: 2,
        kind: 'bot',
        publicKey: third.peerId,
        botHost: first.peerId,
        name: 'Bot C',
        colour: '#5e7f45',
      },
      {
        seat: 3,
        kind: 'bot',
        publicKey: fourth.peerId,
        botHost: second.peerId,
        name: 'Bot D',
        colour: '#885686',
      },
    ],
    genesisSeed: toBase64Url(seed),
    ceremonyNonce: toBase64Url(new Uint8Array(32).fill(7)),
    security: 'stub',
    commitments: {},
    createdAt: 1_700_000_000_000,
  };
  const genesis: Genesis = {
    ...body,
    gameId: genesisId(body),
    signatures: [signGenesis(body, 0, first.secretKey), signGenesis(body, 1, second.secretKey)],
  };
  const entry = signEntry(
    {
      seq: 0,
      term: 1,
      prevHash: GENESIS_PREVIOUS_HASH,
      payload: { kind: 'genesis', genesis },
      stateHash: toHex(hashValue(state)),
      sequencer: first.peerId,
    },
    first.secretKey,
  );
  return { engine, identities, body, genesis, state, entry };
}
