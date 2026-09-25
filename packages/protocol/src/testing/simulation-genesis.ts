import { canonicalDecode, canonicalEncode, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { createBaseEngine, ENGINE_VERSION } from '@cp2p/engine';
import type { GameConfig, Seat } from '@cp2p/engine';
import { GENESIS_PREVIOUS_HASH, genesisId, signEntry, signGenesis } from '../genesis.js';
import { PROTOCOL_VERSION } from '../types.js';
import type { Genesis, GenesisBody, LogEntry } from '../types.js';

export interface SimulationGenesisOptions {
  seed: number;
  gameIndex?: number;
  config?: GameConfig;
  humanCount?: number;
}

export interface SimulationGenesis {
  engine: ReturnType<typeof createBaseEngine>;
  identities: ReadonlyMap<Seat, ReturnType<typeof identityFromSecret>>;
  genesis: Genesis;
  entry: LogEntry;
}

const DEFAULT_CONFIG: GameConfig = {
  modules: [{ id: 'base', version: '1.0.0' }],
  seats: [0, 1, 2, 3],
  options: { base: { mapLayout: 'random' } },
};

const NAMES = ['Avery', 'Blake', 'Casey', 'Drew', 'Emery', 'Finley'];
const COLOURS = ['#386b6d', '#b35a39', '#5e7f45', '#885686', '#c48b2c', '#4574a8'];

function assertNonnegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a nonnegative safe integer`);
}

function copyConfig(config: GameConfig): GameConfig {
  return {
    modules: config.modules.map((module) => ({ ...module })),
    seats: [...config.seats],
    options: Object.fromEntries(
      Object.entries(config.options).map(([module, options]) => [
        module,
        canonicalDecode(canonicalEncode(options)),
      ]),
    ),
    ...(config.board
      ? {
          board: {
            hexes: config.board.hexes.map((hex) => ({ ...hex })),
            harbors: config.board.harbors.map((harbor) => ({ ...harbor })),
            roads: config.board.roads.map((road) => ({ ...road })),
            buildings: config.board.buildings.map((building) => ({ ...building })),
            robberHex: config.board.robberHex,
          },
        }
      : {}),
  };
}

/**
 * Creates reproducible, explicitly stub-secured genesis data for simulations and dev tools.
 * Every deterministic value is independently domain-separated from the public seed and game index.
 */
export function createSimulationGenesis(options: SimulationGenesisOptions): SimulationGenesis {
  assertNonnegativeSafeInteger(options.seed, 'seed');
  const gameIndex = options.gameIndex ?? 0;
  assertNonnegativeSafeInteger(gameIndex, 'gameIndex');
  if (!Number.isSafeInteger(1_700_000_000_000 + gameIndex))
    throw new RangeError('gameIndex is too large for a deterministic timestamp');

  const config = copyConfig(options.config ?? DEFAULT_CONFIG);
  if (
    config.seats.length < 1 ||
    config.seats.length > NAMES.length ||
    config.seats.some((seat, index) => seat !== index)
  )
    throw new RangeError('config seats must be contiguous and ordered from zero through five');
  const humanCount = options.humanCount ?? config.seats.length;
  if (!Number.isSafeInteger(humanCount) || humanCount < 1 || humanCount > config.seats.length)
    throw new RangeError('humanCount must be between one and the configured seat count');

  const engine = createBaseEngine();
  const identities = new Map<Seat, ReturnType<typeof identityFromSecret>>();
  for (const seat of config.seats) {
    const secret = hashValue({
      domain: 'cp2p/dev/simulation-genesis/identity/v1',
      seed: options.seed,
      gameIndex,
      seat,
    });
    identities.set(seat, identityFromSecret(secret));
  }
  const humans = config.seats.slice(0, humanCount);
  const humanIdentities = humans.map((seat) => {
    const identity = identities.get(seat);
    if (!identity) throw new Error(`Missing generated identity for seat ${seat}`);
    return identity;
  });
  const boardSeed = hashValue({
    domain: 'cp2p/dev/simulation-genesis/board-seed/v1',
    seed: options.seed,
    gameIndex,
  });
  const body: GenesisBody = {
    protocolVersion: PROTOCOL_VERSION,
    engineVersion: ENGINE_VERSION,
    config,
    seats: config.seats.map((seat) => {
      const identity = identities.get(seat);
      if (!identity) throw new Error(`Missing generated identity for seat ${seat}`);
      const name = NAMES[seat];
      const colour = COLOURS[seat];
      if (!name || !colour) throw new Error(`Missing presentation defaults for seat ${seat}`);
      if (seat < humanCount)
        return { seat, kind: 'human', publicKey: identity.peerId, name, colour };
      const host = humanIdentities[(seat - humanCount) % humanIdentities.length];
      if (!host) throw new Error('Missing generated bot host identity');
      return {
        seat,
        kind: 'bot',
        publicKey: identity.peerId,
        botHost: host.peerId,
        name,
        colour,
      };
    }),
    genesisSeed: toBase64Url(boardSeed),
    ceremonyNonce: toBase64Url(
      hashValue({
        domain: 'cp2p/dev/simulation-genesis/ceremony-nonce/v1',
        seed: options.seed,
        gameIndex,
      }),
    ),
    security: 'stub',
    commitments: {},
    createdAt: 1_700_000_000_000 + gameIndex,
  };
  const genesis: Genesis = {
    ...body,
    gameId: genesisId(body),
    signatures: humans.map((seat) => {
      const identity = identities.get(seat);
      if (!identity) throw new Error(`Missing generated identity for seat ${seat}`);
      return signGenesis(body, seat, identity.secretKey);
    }),
  };
  const state = engine.createGame(config, boardSeed);
  const firstHuman = humans[0];
  if (firstHuman === undefined) throw new Error('Missing initial human seat');
  const sequencer = identities.get(firstHuman);
  if (!sequencer) throw new Error('Missing initial sequencer identity');
  const entry = signEntry(
    {
      seq: 0,
      term: 1,
      prevHash: GENESIS_PREVIOUS_HASH,
      payload: { kind: 'genesis', genesis },
      stateHash: toHex(hashValue(state)),
      sequencer: sequencer.peerId,
    },
    sequencer.secretKey,
  );
  return { engine, identities, genesis, entry };
}
