import { toBase64Url } from '@cp2p/codec';
import { identityFromSecret, signObject } from '@cp2p/crypto';
import { BASE_DEV_CARD_CATALOGUE, BASE_VERSION } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { beforeAll, describe, expect, test } from 'vitest';
import {
  createDeckGenesisCommitment,
  deckCeremonyId,
  deckPassHash,
  genesisDeckDefinitions,
  validateDeckCeremony,
  validateDeckGenesisCommitments,
} from './deck-genesis.js';
import { applyDeckPass, initDeckSetup, signDeckLock, signDeckShuffle } from './deck-setup.js';
import type { DeckDefinition, SignedDeckPass } from './deck-setup.js';
import { createSimulationGenesis } from './testing/simulation-genesis.js';
import type { GenesisBody } from './types.js';

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

const keys = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)] as const;
const seed = new Uint8Array(32).fill(9);
const small: DeckDefinition = {
  ceremonyId: toBase64Url(new Uint8Array(32).fill(7)),
  deckId: 'dev',
  deckEpoch: 0,
  creation: { kind: 'ceremony' },
  cards: [
    { identity: 'knight#1', card: 'knight' },
    { identity: 'knight#2', card: 'knight' },
    { identity: 'roadBuilding#1', card: 'roadBuilding' },
  ],
  participants: [
    { seat: 0, publicKey: identityFromSecret(keys[0]).peerId },
    { seat: 1, publicKey: identityFromSecret(keys[1]).peerId },
  ],
};

function passesFor(definition: DeckDefinition, secrets: readonly Uint8Array[]): SignedDeckPass[] {
  let state = value(initDeckSetup(definition));
  const passes: SignedDeckPass[] = [];
  for (const [index, secret] of secrets.entries()) {
    const permutation = Array.from({ length: definition.cards.length }, (_, position) =>
      index === 0 ? position : definition.cards.length - position - 1,
    );
    const signed = signDeckShuffle(state, BigInt(13 + index * 4), permutation, seed, secret);
    passes.push(signed);
    state = value(applyDeckPass(state, signed));
  }
  for (const [index, secret] of secrets.entries()) {
    const locks = state.points.map((_, position) => BigInt(3 + index * 31 + position));
    const signed = signDeckLock(state, BigInt(13 + index * 4), locks, seed, secret);
    passes.push(signed);
    state = value(applyDeckPass(state, signed));
  }
  return passes;
}

let cachedBase: {
  body: GenesisBody;
  passes: SignedDeckPass[];
} | null = null;

function baseFixture() {
  if (cachedBase) return cachedBase;
  const simulation = createSimulationGenesis({
    seed: 103,
    config: {
      modules: [{ id: 'base', version: BASE_VERSION }],
      seats: [0, 1],
      options: { base: { mapLayout: 'random' } },
    },
  });
  const body: GenesisBody = { ...simulation.genesis, security: 'verified', commitments: {} };
  const definition = value(genesisDeckDefinitions(body))[0];
  if (!definition) throw new Error('Base deck definition missing');
  const first = simulation.identities.get(0);
  const second = simulation.identities.get(1);
  if (!first || !second) throw new Error('Base signers missing');
  const passes = passesFor(definition, [first.secretKey, second.secretKey]);
  const commitment = value(createDeckGenesisCommitment(definition, passes));
  cachedBase = { body: { ...body, commitments: { decks: [commitment] } }, passes };
  return cachedBase;
}

describe('deck genesis commitments', () => {
  // The shared 25-card ceremony proves and verifies every shuffle. Its cold
  // construction needs an explicit allowance when the full suite runs in parallel.
  beforeAll(() => {
    baseFixture();
  }, 30_000);

  test('derives a stable cycle-free ceremony ID and canonical base physical catalogue', () => {
    const { body } = baseFixture();
    const definitions = value(genesisDeckDefinitions(body));
    const definition = definitions[0];
    if (!definition) throw new Error('Base deck missing');
    expect(definitions).toHaveLength(1);
    expect(definition).toMatchObject({
      ceremonyId: deckCeremonyId(body),
      deckId: 'dev',
      deckEpoch: 0,
      creation: { kind: 'ceremony' },
    });
    expect(definition.cards).toEqual(BASE_DEV_CARD_CATALOGUE);
    expect(definition.cards).toHaveLength(25);
    expect(definition.participants).toEqual(
      body.seats.map(({ seat, publicKey }) => ({ seat, publicKey })),
    );
    expect(
      deckCeremonyId({
        ...body,
        genesisSeed: toBase64Url(new Uint8Array(32).fill(31)),
        commitments: { different: true },
        createdAt: body.createdAt + 1,
      }),
    ).toBe(definition.ceremonyId);
    expect(
      deckCeremonyId({ ...body, ceremonyNonce: toBase64Url(new Uint8Array(32).fill(32)) }),
    ).not.toBe(definition.ceremonyId);
  });

  test('creates a full signed small-deck commitment and hashes each complete pass', () => {
    const passes = passesFor(small, keys);
    const commitment = value(createDeckGenesisCommitment(small, passes));
    expect(commitment.passHashes).toHaveLength(4);
    expect(commitment.passHashes).toEqual(passes.map(deckPassHash));
    expect(new Set(commitment.passHashes).size).toBe(4);
    expect(commitment.finalStateHash).toMatch(/^[0-9a-f]{64}$/);
    const first = passes[0];
    if (!first) throw new Error('First pass missing');
    expect(deckPassHash({ ...first, sig: 'A'.repeat(86) })).not.toBe(commitment.passHashes[0]);
    expect(createDeckGenesisCommitment(small, passes.slice(0, 3)).ok).toBe(false);
  });

  test('shape-only genesis validation and mandatory pre-sign proof replay remain distinct', () => {
    const { body, passes } = baseFixture();
    expect(value(validateDeckGenesisCommitments(body))).toHaveLength(1);
    expect(validateDeckCeremony(body, [{ deckId: 'dev', passes }]).ok).toBe(true);

    const first = passes[0];
    if (!first || first.body.phase !== 'shuffle') throw new Error('First shuffle missing');
    const alteredBody = { ...first.body, output: [...first.body.output].toReversed() };
    const firstSigner = createSimulationGenesis({
      seed: 103,
      config: body.config,
    }).identities.get(0);
    if (!firstSigner) throw new Error('First signer missing');
    const altered = {
      body: alteredBody,
      sig: signObject('deck-pass', alteredBody, firstSigner.secretKey),
    } satisfies SignedDeckPass;
    const badPasses = [altered, ...passes.slice(1)];
    const original = value(validateDeckGenesisCommitments(body))[0];
    if (!original) throw new Error('Deck commitment missing');
    const changed: GenesisBody = {
      ...body,
      commitments: {
        decks: [
          {
            ...original,
            passHashes: [deckPassHash(altered), ...original.passHashes.slice(1)],
          },
        ],
      },
    };
    expect(validateDeckGenesisCommitments(changed).ok).toBe(true);
    expect(validateDeckCeremony(changed, [{ deckId: 'dev', passes: badPasses }])).toMatchObject({
      ok: false,
      error: { code: 'deck-shuffle-proof' },
    });
  });

  test('hashes and proves the same detached pass after one caller read', () => {
    const { body, passes } = baseFixture();
    const first = passes[0];
    if (!first) throw new Error('Missing first pass');
    const reads = new Map<PropertyKey, number>();
    const observed = new Proxy(first, {
      getOwnPropertyDescriptor(target, key) {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(
      validateDeckCeremony(body, [{ deckId: 'dev', passes: [observed, ...passes.slice(1)] }]),
    ).toMatchObject({ ok: true });
    expect(reads.get('body')).toBe(1);
    expect(reads.get('sig')).toBe(1);
  }, 15_000);

  test('rejects missing, extra, reordered, duplicate and malformed deck commitments', () => {
    const { body, passes } = baseFixture();
    const original = value(validateDeckGenesisCommitments(body))[0];
    if (!original) throw new Error('Deck commitment missing');
    const withDecks = (decks: unknown): GenesisBody => ({
      ...body,
      commitments: { decks },
    });
    expect(validateDeckGenesisCommitments(withDecks([])).ok).toBe(false);
    expect(validateDeckGenesisCommitments(withDecks([original, original])).ok).toBe(false);
    expect(validateDeckGenesisCommitments(withDecks([{ ...original, passHashes: [] }])).ok).toBe(
      false,
    );
    expect(
      validateDeckGenesisCommitments(
        withDecks([
          { ...original, passHashes: original.passHashes.map(() => original.passHashes[0]) },
        ]),
      ).ok,
    ).toBe(false);
    expect(
      validateDeckGenesisCommitments(
        withDecks([
          {
            ...original,
            definition: {
              ...original.definition,
              cards: [...original.definition.cards].toReversed(),
            },
          },
        ]),
      ).ok,
    ).toBe(false);
    expect(
      validateDeckGenesisCommitments(
        withDecks([
          {
            ...original,
            definition: {
              ...original.definition,
              participants: [...original.definition.participants].toReversed(),
            },
          },
        ]),
      ).ok,
    ).toBe(false);
    expect(
      validateDeckGenesisCommitments(
        withDecks([
          {
            ...original,
            definition: {
              ...original.definition,
              ceremonyId: toBase64Url(new Uint8Array(32).fill(8)),
            },
          },
        ]),
      ).ok,
    ).toBe(false);
    expect(validateDeckCeremony(body, [{ deckId: 'dev', passes: passes.toReversed() }]).ok).toBe(
      false,
    );
    const sparse = [...passes];
    Reflect.deleteProperty(sparse, '1');
    expect(validateDeckCeremony(body, [{ deckId: 'dev', passes: sparse }]).ok).toBe(false);
    expect(validateDeckCeremony(body, [{ deckId: 'wrong', passes }]).ok).toBe(false);
  });

  test('requires an explicit empty deck list for a genuinely deck-free module', () => {
    const { body } = baseFixture();
    const deckFree: GenesisBody = {
      ...body,
      config: { ...body.config, modules: [{ id: 'test-counter', version: '1.0.0' }] },
      commitments: { decks: [] },
    };
    expect(value(genesisDeckDefinitions(deckFree))).toEqual([]);
    expect(value(validateDeckGenesisCommitments(deckFree))).toEqual([]);
    expect(validateDeckCeremony(deckFree, []).ok).toBe(true);
    expect(validateDeckGenesisCommitments({ ...deckFree, commitments: {} }).ok).toBe(false);
  });
});
