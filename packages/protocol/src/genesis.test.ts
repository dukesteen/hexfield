import { toBase64Url } from '@cp2p/codec';
import { signObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import {
  entryHash,
  genesisDigest,
  genesisId,
  signEntry,
  signGenesis,
  validateGenesis,
  validateGenesisEntry,
} from './genesis.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';
import type { Genesis, GenesisBody } from './types.js';

function errorCode(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

describe('genesis validation', () => {
  test('derives one deterministic game and verifies every human plus the initial entry', () => {
    const { engine, body, genesis, state, entry } = protocolFixture();
    expect(genesisId(body)).toBe(genesis.gameId);
    expect(genesisDigest(body)).toHaveLength(43);
    expect(validateGenesis(genesis, engine, { allowStub: true })).toMatchObject({
      ok: true,
      value: { state },
    });
    expect(validateGenesisEntry(entry, engine, { allowStub: true })).toMatchObject({
      ok: true,
      value: { state, hash: entryHash(entry) },
    });
    expect(validateGenesis(genesis, engine)).toMatchObject({
      ok: false,
      error: { code: 'stub-forbidden' },
    });
  });

  test('binds the full genesis digest, including informational fields, to human signatures', () => {
    const { engine, body, genesis, entry, identities } = protocolFixture();
    const changedBody: GenesisBody = { ...body, createdAt: body.createdAt + 1 };
    const changed: Genesis = {
      ...genesis,
      ...changedBody,
      gameId: genesisId(changedBody),
    };
    expect(genesisDigest(changedBody)).not.toBe(genesisDigest(body));
    expect(errorCode(validateGenesis(changed, engine, { allowStub: true }))).toBe(
      'genesis-signatures',
    );

    // The log's genesis hash commits to the full digest but excludes signature encodings.
    const changedEntry = { ...entry, payload: { kind: 'genesis' as const, genesis: changed } };
    expect(entryHash(changedEntry)).not.toBe(entryHash(entry));
    const otherSignature = signObject(
      'other',
      { genesisDigest: genesisDigest(body) },
      fixtureAt(identities, 0).secretKey,
    );
    const sameBodyDifferentSignatures = {
      ...entry,
      payload: {
        kind: 'genesis' as const,
        genesis: {
          ...genesis,
          signatures: [
            { ...fixtureAt(genesis.signatures, 0), sig: otherSignature },
            fixtureAt(genesis.signatures, 1),
          ],
        },
      },
    };
    expect(entryHash(sameBodyDifferentSignatures)).toBe(entryHash(entry));
    expect(
      errorCode(validateGenesisEntry(sameBodyDifferentSignatures, engine, { allowStub: true })),
    ).toBe('genesis-signatures');
  });

  test('rejects version, seat, bot host, key, and signature substitution', () => {
    const { engine, body, genesis, identities } = protocolFixture();
    const policy = { allowStub: true };
    expect(errorCode(validateGenesis({ ...genesis, protocolVersion: 99 }, engine, policy))).toBe(
      'version-mismatch',
    );
    expect(errorCode(validateGenesis({ ...genesis, gameId: 'A'.repeat(22) }, engine, policy))).toBe(
      'genesis-id',
    );

    const swappedSeats = [
      fixtureAt(genesis.seats, 1),
      fixtureAt(genesis.seats, 0),
      ...genesis.seats.slice(2),
    ];
    const changedSeats: GenesisBody = { ...body, seats: swappedSeats };
    expect(
      errorCode(
        validateGenesis(
          { ...genesis, ...changedSeats, gameId: genesisId(changedSeats) },
          engine,
          policy,
        ),
      ),
    ).toBe('genesis-seats');

    const bot = fixtureAt(genesis.seats, 2);
    if (bot.kind !== 'bot') throw new Error('Expected bot fixture');
    const badHostBody: GenesisBody = {
      ...body,
      seats: [
        ...body.seats.slice(0, 2),
        { ...bot, botHost: fixtureAt(identities, 3).peerId },
        fixtureAt(body.seats, 3),
      ],
    };
    expect(
      errorCode(
        validateGenesis(
          { ...genesis, ...badHostBody, gameId: genesisId(badHostBody) },
          engine,
          policy,
        ),
      ),
    ).toBe('genesis-bot-host');

    const invalidKeyBody: GenesisBody = {
      ...body,
      seats: [
        { ...fixtureAt(body.seats, 0), publicKey: toBase64Url(new Uint8Array(32)) },
        ...body.seats.slice(1),
      ],
    };
    expect(
      errorCode(
        validateGenesis(
          { ...genesis, ...invalidKeyBody, gameId: genesisId(invalidKeyBody) },
          engine,
          policy,
        ),
      ),
    ).toBe('genesis-key');

    expect(
      errorCode(
        validateGenesis(
          { ...genesis, signatures: genesis.signatures.toReversed() },
          engine,
          policy,
        ),
      ),
    ).toBe('genesis-signatures');
    expect(
      errorCode(
        validateGenesis(
          {
            ...genesis,
            signatures: [
              signGenesis(body, 0, fixtureAt(identities, 1).secretKey),
              fixtureAt(genesis.signatures, 1),
            ],
          },
          engine,
          policy,
        ),
      ),
    ).toBe('genesis-signatures');
  });

  test('rejects absent voters, duplicate identities or colours, seat mapping, and signature counts', () => {
    const { engine, body, genesis } = protocolFixture();
    const policy = { allowStub: true };
    const changed = (patch: Partial<GenesisBody>) => {
      const nextBody = { ...body, ...patch };
      return { ...genesis, ...nextBody, gameId: genesisId(nextBody) };
    };
    const botsOnly = body.seats.map((seat) => ({
      ...seat,
      kind: 'bot' as const,
      botHost: fixtureAt(body.seats, 0).publicKey,
    }));
    expect(errorCode(validateGenesis(changed({ seats: botsOnly }), engine, policy))).toBe(
      'genesis-voters',
    );
    expect(
      errorCode(
        validateGenesis(
          changed({
            seats: [
              fixtureAt(body.seats, 0),
              { ...fixtureAt(body.seats, 1), publicKey: fixtureAt(body.seats, 0).publicKey },
              ...body.seats.slice(2),
            ],
          }),
          engine,
          policy,
        ),
      ),
    ).toBe('genesis-duplicates');
    expect(
      errorCode(
        validateGenesis(
          changed({
            seats: [
              fixtureAt(body.seats, 0),
              { ...fixtureAt(body.seats, 1), colour: fixtureAt(body.seats, 0).colour },
              ...body.seats.slice(2),
            ],
          }),
          engine,
          policy,
        ),
      ),
    ).toBe('genesis-duplicates');
    expect(
      errorCode(
        validateGenesis(
          changed({ config: { ...body.config, seats: [0, 1, 3, 2] } }),
          engine,
          policy,
        ),
      ),
    ).toBe('genesis-seats');
    expect(errorCode(validateGenesis({ ...genesis, signatures: [] }, engine, policy))).toBe(
      'genesis-signatures',
    );
    expect(
      errorCode(
        validateGenesis(
          { ...genesis, signatures: [...genesis.signatures, fixtureAt(genesis.signatures, 0)] },
          engine,
          policy,
        ),
      ),
    ).toBe('genesis-signatures');
  });

  test('requires explicit verified-ceremony callback and forbids stub commitments', () => {
    const { engine, body, genesis, identities } = protocolFixture();
    expect(
      errorCode(
        validateGenesis({ ...genesis, commitments: { forged: true } }, engine, { allowStub: true }),
      ),
    ).toBe('genesis-id');
    const withCommitmentsBody: GenesisBody = { ...body, commitments: { forged: true } };
    const stubWithCommitments: Genesis = {
      ...withCommitmentsBody,
      gameId: genesisId(withCommitmentsBody),
      signatures: [
        signGenesis(withCommitmentsBody, 0, fixtureAt(identities, 0).secretKey),
        signGenesis(withCommitmentsBody, 1, fixtureAt(identities, 1).secretKey),
      ],
    };
    expect(errorCode(validateGenesis(stubWithCommitments, engine, { allowStub: true }))).toBe(
      'stub-commitments',
    );

    const verifiedBody: GenesisBody = {
      ...body,
      security: 'verified',
      commitments: { proof: 'opaque' },
    };
    const verified: Genesis = {
      ...verifiedBody,
      gameId: genesisId(verifiedBody),
      signatures: [
        signGenesis(verifiedBody, 0, fixtureAt(identities, 0).secretKey),
        signGenesis(verifiedBody, 1, fixtureAt(identities, 1).secretKey),
      ],
    };
    expect(errorCode(validateGenesis(verified, engine))).toBe('commitments-unavailable');
    const callback = vi.fn<() => Result<void>>(() => success(undefined));
    expect(validateGenesis(verified, engine, { verifyCommitments: callback }).ok).toBe(true);
    expect(callback).toHaveBeenCalledOnce();
    expect(
      errorCode(
        validateGenesis(verified, engine, {
          verifyCommitments: () => failure('bad-commitment', 'Invalid commitment'),
        }),
      ),
    ).toBe('bad-commitment');
    expect(
      errorCode(
        validateGenesis(verified, engine, {
          verifyCommitments: () => {
            throw new Error('bad proof');
          },
        }),
      ),
    ).toBe('commitments-invalid');
  });

  test('rejects malformed canonical data and unsupported or invalid genesis state', () => {
    const { engine, genesis } = protocolFixture();
    const cyclic = { ...genesis, commitments: {} as Record<string, unknown> };
    cyclic.commitments.self = cyclic;
    expect(errorCode(validateGenesis(cyclic, engine, { allowStub: true }))).toBe(
      'invalid-encoding',
    );
    const accessor = { ...genesis };
    Object.defineProperty(accessor, 'createdAt', { enumerable: true, get: () => 1 });
    expect(errorCode(validateGenesis(accessor, engine, { allowStub: true }))).toBe(
      'invalid-encoding',
    );
    expect(
      errorCode(
        validateGenesis(
          genesis,
          {
            ...engine,
            createGame: () => {
              throw new Error('unsupported');
            },
          },
          { allowStub: true },
        ),
      ),
    ).toBe('genesis-config');
    expect(
      errorCode(
        validateGenesis(
          genesis,
          { ...engine, checkInvariants: () => ['invalid genesis'] },
          { allowStub: true },
        ),
      ),
    ).toBe('genesis-state');
  });

  test('returns detached validated genesis and first entry despite caller mutation', () => {
    const { engine, genesis, entry } = protocolFixture();
    const acceptedGenesis = validateGenesis(genesis, engine, { allowStub: true });
    const acceptedEntry = validateGenesisEntry(entry, engine, { allowStub: true });
    expect(acceptedGenesis.ok).toBe(true);
    expect(acceptedEntry.ok).toBe(true);
    if (!acceptedGenesis.ok || !acceptedEntry.ok) return;
    const configOptions = genesis.config.options.base;
    if (typeof configOptions !== 'object' || configOptions === null)
      throw new Error('Expected nested options fixture');
    Reflect.set(configOptions, 'mapLayout', 'corrupted');
    fixtureAt(genesis.seats, 0).name = 'Mallory';
    entry.payload = { kind: 'membership', change: {} };
    expect(acceptedGenesis.value.genesis.config.options.base).toEqual({ mapLayout: 'random' });
    expect(fixtureAt(acceptedGenesis.value.genesis.seats, 0).name).toBe('Alice');
    expect(acceptedEntry.value.entry.payload.kind).toBe('genesis');
  });

  test('refuses malformed or incorrectly signed initial log entries', () => {
    const { engine, entry, identities } = protocolFixture();
    const first = fixtureAt(identities, 0);
    const policy = { allowStub: true };
    for (const body of [
      { ...entry, seq: 1 },
      { ...entry, term: 2 },
      { ...entry, prevHash: 'f'.repeat(64) },
      { ...entry, payload: { kind: 'membership' as const, change: {} } },
    ]) {
      const signed = signEntry(body, first.secretKey);
      expect(errorCode(validateGenesisEntry(signed, engine, policy))).toBe('genesis-entry');
    }
    expect(errorCode(validateGenesisEntry({ ...entry, sig: 'A'.repeat(86) }, engine, policy))).toBe(
      'sequencer-signature',
    );
    expect(
      errorCode(
        validateGenesisEntry(
          signEntry({ ...entry, stateHash: 'f'.repeat(64) }, first.secretKey),
          engine,
          policy,
        ),
      ),
    ).toBe('state-hash');
    expect(
      errorCode(
        validateGenesisEntry(
          signEntry(
            { ...entry, sequencer: fixtureAt(identities, 1).peerId },
            fixtureAt(identities, 1).secretKey,
          ),
          engine,
          policy,
        ),
      ),
    ).toBe('sequencer-signature');
  });
});
