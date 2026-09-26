import { toBase64Url } from '@cp2p/codec';
import { signObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { describe, expect, test, vi } from 'vitest';
import {
  entryHash,
  genesisBody,
  genesisDigest,
  genesisId,
  signEntry,
  signGenesis,
  signVerifiedGenesis,
  validateGenesis,
  validateGenesisEntry,
} from './genesis.js';
import { deckPassHash, validateDeckGenesisCommitments } from './deck-genesis.js';
import { createGenesisDeckFixture } from './testing/deck-fixture.js';
import { fixtureAt, protocolFixture } from './testing/fixtures.js';
import { createSimulationGenesis } from './testing/simulation-genesis.js';
import type { Genesis, GenesisBody } from './types.js';

function errorCode(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}

function verifiedFixture() {
  const simulation = createSimulationGenesis({
    seed: 67,
    humanCount: 1,
    config: {
      modules: [{ id: 'base', version: '1.0.0' }],
      seats: [0, 1],
      options: { base: { mapLayout: 'random' } },
    },
  });
  const draft: GenesisBody = {
    ...genesisBody(simulation.genesis),
    security: 'verified',
    commitments: {},
  };
  const ceremony = createGenesisDeckFixture(draft, simulation.identities);
  const human = simulation.identities.get(0);
  const bot = simulation.identities.get(1);
  if (!human || !bot) throw new Error('Missing fixture signer');
  const signature = signVerifiedGenesis(ceremony.body, ceremony.transcripts, 0, human.secretKey);
  if (!signature.ok) throw new Error(`Verified consent failed: ${signature.error.message}`);
  const genesis: Genesis = {
    ...ceremony.body,
    gameId: genesisId(ceremony.body),
    signatures: [signature.value],
  };
  return { ...simulation, ceremony, human, bot, genesis };
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

  test('requires the canonical base deck despite a permissive callback and forbids stub commitments', () => {
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

    const verified = verifiedFixture();
    expect(errorCode(validateGenesis(verified.genesis, verified.engine))).toBe(
      'commitments-unavailable',
    );
    const callback = vi.fn<() => Result<void>>(() => success(undefined));
    expect(
      validateGenesis(verified.genesis, verified.engine, { verifyCommitments: callback }).ok,
    ).toBe(true);
    expect(callback).toHaveBeenCalledOnce();
    const noDeckBody: GenesisBody = { ...verified.ceremony.body, commitments: { decks: [] } };
    const noDeck: Genesis = {
      ...noDeckBody,
      gameId: genesisId(noDeckBody),
      signatures: [signGenesis(noDeckBody, 0, verified.human.secretKey)],
    };
    expect(
      errorCode(validateGenesis(noDeck, verified.engine, { verifyCommitments: callback })),
    ).toBe('deck-genesis-count');
    expect(
      errorCode(
        validateGenesis(verified.genesis, verified.engine, {
          verifyCommitments: () => failure('bad-commitment', 'Invalid commitment'),
        }),
      ),
    ).toBe('bad-commitment');
    expect(
      errorCode(
        validateGenesis(verified.genesis, verified.engine, {
          verifyCommitments: () => {
            throw new Error('bad proof');
          },
        }),
      ),
    ).toBe('commitments-invalid');
  }, 15_000);

  test('rejects verified genesis whose engine begins with a nonempty hand', () => {
    const fixture = verifiedFixture();
    const createGame = fixture.engine.createGame.bind(fixture.engine);
    const alteredEngine = {
      ...fixture.engine,
      checkInvariants: () => [],
      createGame(config: Parameters<typeof createGame>[0], seed: Parameters<typeof createGame>[1]) {
        const state = createGame(config, seed);
        return {
          ...state,
          seats: state.seats.map((seat, index) =>
            index === 0
              ? {
                  ...seat,
                  resources: {
                    min: { ...seat.resources.min, brick: 1 },
                    max: { ...seat.resources.max, brick: 1 },
                    total: 1,
                  },
                }
              : seat,
          ),
        };
      },
    };
    expect(
      errorCode(
        validateGenesis(fixture.genesis, alteredEngine, {
          verifyCommitments: () => success(undefined),
        }),
      ),
    ).toBe('genesis-hands');
  }, 15_000);

  test('human consent signs only a fully replayed fixed-deck ceremony', () => {
    const { ceremony, human, bot, genesis } = verifiedFixture();
    const signed = signVerifiedGenesis(ceremony.body, ceremony.transcripts, 0, human.secretKey);
    expect(signed).toMatchObject({ ok: true, value: genesis.signatures[0] });
    expect(errorCode(signVerifiedGenesis(ceremony.body, [], 0, human.secretKey))).toBe(
      'deck-ceremony-transcripts',
    );
    expect(
      errorCode(signVerifiedGenesis(ceremony.body, ceremony.transcripts, 0, bot.secretKey)),
    ).toBe('genesis-signer');
    expect(
      errorCode(signVerifiedGenesis(ceremony.body, ceremony.transcripts, 1, bot.secretKey)),
    ).toBe('genesis-signer');
    expect(
      errorCode(
        signVerifiedGenesis(
          { ...ceremony.body, security: 'stub' },
          ceremony.transcripts,
          0,
          human.secretKey,
        ),
      ),
    ).toBe('genesis-security');

    const transcript = fixtureAt(ceremony.transcripts, 0);
    const first = fixtureAt(transcript.passes, 0);
    if (first.body.phase !== 'shuffle') throw new Error('Expected first shuffle pass');
    const changed = {
      ...first,
      body: {
        ...first.body,
        proof: {
          ...first.body.proof,
          challenge: 'f'.repeat(16),
        },
      },
    };
    const resigned = { ...changed, sig: signObject('deck-pass', changed.body, human.secretKey) };
    const changedTranscripts = [
      {
        deckId: transcript.deckId,
        passes: [resigned, ...transcript.passes.slice(1)],
      },
    ];
    const commitments = validateDeckGenesisCommitments(ceremony.body);
    if (!commitments.ok) throw new Error(commitments.error.message);
    const original = fixtureAt(commitments.value, 0);
    const changedBody: GenesisBody = {
      ...ceremony.body,
      commitments: {
        decks: [
          { ...original, passHashes: [deckPassHash(resigned), ...original.passHashes.slice(1)] },
        ],
      },
    };
    expect(
      errorCode(signVerifiedGenesis(changedBody, changedTranscripts, 0, human.secretKey)),
    ).toBe('deck-shuffle-proof');
    expect(
      errorCode(signVerifiedGenesis(ceremony.body, changedTranscripts, 0, human.secretKey)),
    ).toBe('deck-ceremony-hash');
  }, 15_000);

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
