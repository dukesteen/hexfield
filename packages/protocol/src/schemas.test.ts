import { describe, expect, test } from 'vitest';
import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { createBaseEngine } from '@cp2p/engine';
import type { GameConfig } from '@cp2p/engine';
import * as v from 'valibot';
import { entryHash, genesisDigest, genesisId, signEntry, signGenesis } from './genesis.js';
import { signCommand } from './log.js';
import { genesisSchema, logEntrySchema, signedCommandSchema } from './schemas.js';
import type { Genesis, GenesisBody, LogEntry, SignedCommand } from './types.js';

const seed = new Uint8Array(32);
const seats = [0, 1, 2, 3] as const;
const identities = [
  identityFromSecret(new Uint8Array(32).fill(1)),
  identityFromSecret(new Uint8Array(32).fill(2)),
  identityFromSecret(new Uint8Array(32).fill(3)),
  identityFromSecret(new Uint8Array(32).fill(4)),
] as const;
const config: GameConfig = {
  modules: [{ id: 'base', version: '1.0.0' }],
  seats: [0, 1, 2, 3],
  options: { base: { mapLayout: 'random' } },
};
const state = createBaseEngine().createGame(config, seed);
const body: GenesisBody = {
  protocolVersion: 1,
  engineVersion: state.engineVersion,
  config: { ...config, board: state.board },
  seats: seats.map((seat) => ({
    seat,
    kind: 'human' as const,
    publicKey: identities[seat].peerId,
    name: `Player ${seat + 1}`,
    colour: ['#386b6d', '#b35a39', '#5e7f45', '#885686'][seat] ?? '#386b6d',
  })),
  genesisSeed: toBase64Url(seed),
  ceremonyNonce: toBase64Url(new Uint8Array(32).fill(7)),
  security: 'stub' as const,
  commitments: {},
  createdAt: 1_700_000_000_000,
};
const genesis: Genesis = {
  ...body,
  gameId: genesisId(body),
  signatures: seats.map((seat) => signGenesis(body, seat, identities[seat].secretKey)),
};
const digest = genesisDigest(body);
const entryBody = {
  seq: 0,
  term: 1,
  prevHash: '0'.repeat(64),
  payload: { kind: 'genesis' as const, genesis },
  stateHash: toHex(hashValue(state)),
  sequencer: identities[0].peerId,
};
const entry: LogEntry = signEntry(entryBody, identities[0].secretKey);
const commandBody = {
  gameId: genesis.gameId,
  genesisDigest: digest,
  seat: 0 as const,
  nonce: 1,
  headSeq: 0,
  headHash: entryHash(entry),
  command: { type: 'PLACE_ROAD', edge: 'e:0:1', moduleField: { future: true } },
  evidence: { protocol: 'future-spend', data: { proof: [1, 2, 3] } },
};
const command: SignedCommand = signCommand(commandBody, identities[0].secretKey);

function rejected(schema: Parameters<typeof v.safeParse>[0], value: unknown): void {
  expect(v.safeParse(schema, value).success).toBe(false);
}

describe('strict protocol envelope schemas', () => {
  test('accepts genuine engine board and signed envelope shapes', () => {
    expect(v.safeParse(genesisSchema, genesis).success).toBe(true);
    // Shape parsing accepts a future positive version; semantic validation rejects it.
    expect(v.safeParse(genesisSchema, { ...genesis, protocolVersion: 2 }).success).toBe(true);
    expect(v.safeParse(signedCommandSchema, command).success).toBe(true);
    expect(v.safeParse(logEntrySchema, entry).success).toBe(true);
  });

  test('rejects unknown fields on fixed nested wrappers but leaves registered data opaque', () => {
    rejected(genesisSchema, { ...genesis, extra: true });
    rejected(genesisSchema, { ...genesis, config: { ...genesis.config, extra: true } });
    rejected(genesisSchema, {
      ...genesis,
      config: { ...genesis.config, modules: [{ ...genesis.config.modules[0], extra: true }] },
    });
    rejected(genesisSchema, {
      ...genesis,
      seats: [{ ...genesis.seats[0], extra: true }, ...genesis.seats.slice(1)],
    });
    rejected(genesisSchema, {
      ...genesis,
      config: {
        ...genesis.config,
        board: {
          ...state.board,
          extra: true,
        },
      },
    });
    rejected(genesisSchema, {
      ...genesis,
      config: {
        ...genesis.config,
        board: {
          ...state.board,
          hexes: [{ ...state.board.hexes[0], extra: true }, ...state.board.hexes.slice(1)],
        },
      },
    });
    rejected(signedCommandSchema, { ...command, body: { ...command.body, extra: true } });
    rejected(signedCommandSchema, {
      ...command,
      body: { ...command.body, evidence: { ...commandBody.evidence, extra: true } },
    });
    rejected(logEntrySchema, { ...entry, payload: { ...entry.payload, extra: true } });

    expect(v.safeParse(signedCommandSchema, command).success).toBe(true);
    expect(
      v.safeParse(logEntrySchema, {
        ...entry,
        payload: {
          kind: 'system',
          input: { kind: 'system', type: 'DICE_RESULT', dice: [1, 5] },
          evidence: { kind: 'proof', protocol: 'future-beacon', data: { bytes: [1, 2] } },
        },
      }).success,
    ).toBe(true);
  });

  test('bounds seats, integers, identifiers, arrays, and discriminants', () => {
    expect(
      v.safeParse(genesisSchema, { ...genesis, seats: genesis.seats.slice(0, 1) }).success,
    ).toBe(false);
    rejected(genesisSchema, { ...genesis, seats: [...genesis.seats, ...genesis.seats] });
    rejected(genesisSchema, {
      ...genesis,
      signatures: [...genesis.signatures, ...genesis.signatures],
    });
    rejected(genesisSchema, {
      ...genesis,
      seats: [{ ...genesis.seats[0], seat: 6 }, ...genesis.seats.slice(1)],
    });
    rejected(genesisSchema, {
      ...genesis,
      seats: [{ ...genesis.seats[0], name: '   ' }, ...genesis.seats.slice(1)],
    });
    rejected(genesisSchema, { ...genesis, security: 'unverified' });
    rejected(genesisSchema, { ...genesis, protocolVersion: 0 });
    rejected(genesisSchema, { ...genesis, config: { ...genesis.config, modules: [] } });
    rejected(genesisSchema, {
      ...genesis,
      config: {
        ...genesis.config,
        board: { ...state.board, hexes: Array.from({ length: 513 }, () => state.board.hexes[0]) },
      },
    });
    rejected(genesisSchema, {
      ...genesis,
      config: { ...genesis.config, seats: [0, 1, 2, 3, 4, 5, 0] },
    });
    rejected(signedCommandSchema, { ...command, body: { ...command.body, nonce: 0 } });
    rejected(signedCommandSchema, { ...command, body: { ...command.body, headSeq: 0.5 } });
    rejected(signedCommandSchema, {
      ...command,
      body: { ...command.body, headHash: undefined },
    });
    rejected(logEntrySchema, { ...entry, seq: Number.MAX_SAFE_INTEGER + 1 });
    rejected(logEntrySchema, { ...entry, term: 0 });
    rejected(logEntrySchema, { ...entry, payload: { kind: 'unknown' } });
  });

  test('requires canonical byte encodings and lowercase SHA-256 hashes', () => {
    expect(
      v.safeParse(genesisSchema, { ...genesis, genesisSeed: `${genesis.genesisSeed}=` }).success,
    ).toBe(false);
    rejected(genesisSchema, { ...genesis, genesisSeed: `${genesis.genesisSeed.slice(0, -1)}B` });
    rejected(genesisSchema, { ...genesis, ceremonyNonce: `${genesis.ceremonyNonce}=` });
    rejected(genesisSchema, { ...genesis, gameId: genesis.gameId.slice(1) });
    rejected(genesisSchema, {
      ...genesis,
      seats: [{ ...genesis.seats[0], publicKey: 'A'.repeat(44) }, ...genesis.seats.slice(1)],
    });
    rejected(signedCommandSchema, { ...command, sig: `${command.sig}=` });
    rejected(signedCommandSchema, {
      ...command,
      body: { ...command.body, genesisDigest: `${digest}=` },
    });
    rejected(signedCommandSchema, {
      ...command,
      body: { ...command.body, headHash: command.body.headHash.toUpperCase() },
    });
    rejected(logEntrySchema, { ...entry, stateHash: entry.stateHash.toUpperCase() });
    rejected(logEntrySchema, {
      ...entry,
      payload: {
        kind: 'system',
        input: { kind: 'system', type: 'DICE_RESULT', dice: [1, 5] },
        evidence: { kind: 'stub', context: 'not-a-hash' },
      },
    });
  });

  test('keeps membership change opaque for the later fail-closed business validator', () => {
    expect(
      v.safeParse(logEntrySchema, {
        ...entry,
        payload: { kind: 'membership', change: { future: ['still untrusted'] } },
      }).success,
    ).toBe(true);
    rejected(logEntrySchema, {
      ...entry,
      payload: { kind: 'membership', change: null, extra: true },
    });
  });
});
