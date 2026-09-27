import { hashValue, toHex } from '@cp2p/codec';
import { G, encodePoint, scalePoint, scalarToBytes } from '@cp2p/crypto';
import type { Identity } from '@cp2p/crypto';
import type { Seat } from '@cp2p/engine';
import { createDeckGenesisCommitment, genesisDeckDefinitions } from '../deck-genesis.js';
import type { DeckGenesisCommitment } from '../deck-genesis.js';
import { createDeckSecretSource } from '../deck-source.js';
import type { DeckSecretSource } from '../deck-source.js';
import {
  applyDeckPass,
  deckPassOperationId,
  initDeckSetup,
  signDeckLock,
  signDeckShuffle,
} from '../deck-setup.js';
import type { DeckDefinition, DeckSetupState, SignedDeckPass } from '../deck-setup.js';
import type { GenesisBody } from '../types.js';
import { createStealSecretSource } from '../steal-source.js';
import { createGenesisEscrowFixture } from './escrow-fixture.js';

const CACHE_LIMIT = 4;
const cache = new Map<string, CachedDeckFixture>();

interface CachedDeckFixture {
  definitions: readonly DeckDefinition[];
  commitments: readonly DeckGenesisCommitment[];
  passes: readonly (readonly SignedDeckPass[])[];
}

export interface DeckTranscript {
  deckId: string;
  passes: readonly SignedDeckPass[];
}

export interface GenesisDeckFixture {
  body: GenesisBody;
  transcripts: readonly DeckTranscript[];
  createSource(seat: Seat): DeckSecretSource;
}

function copyDefinition(value: DeckDefinition): DeckDefinition {
  return {
    ...value,
    creation: { ...value.creation },
    cards: value.cards.map((card) => ({ ...card })),
    participants: value.participants.map((participant) => ({ ...participant })),
  };
}

function copyPass(value: SignedDeckPass): SignedDeckPass {
  if (value.body.phase === 'shuffle')
    return {
      sig: value.sig,
      body: {
        ...value.body,
        output: [...value.body.output],
        proof: {
          challenge: value.body.proof.challenge,
          responses: value.body.proof.responses.map((response) => ({
            scalar: response.scalar,
            permutation: [...response.permutation],
          })),
        },
      },
    };
  return {
    sig: value.sig,
    body: {
      ...value.body,
      output: [...value.body.output],
      lockKeys: [...value.body.lockKeys],
      proofs: value.body.proofs.map((proof) => ({
        commitments: [proof.commitments[0], proof.commitments[1]],
        response: proof.response,
      })),
    },
  };
}

function copyCommitment(value: DeckGenesisCommitment): DeckGenesisCommitment {
  return {
    definition: copyDefinition(value.definition),
    passHashes: [...value.passHashes],
    finalStateHash: value.finalStateHash,
  };
}

function masterFor(seat: Seat): Uint8Array {
  return scalarToBytes(BigInt(17 + seat));
}

function createPasses(
  definition: DeckDefinition,
  identities: ReadonlyMap<Seat, Identity>,
): readonly SignedDeckPass[] {
  let stateResult = initDeckSetup(definition);
  if (!stateResult.ok) throw new Error(stateResult.error.message);
  let state: DeckSetupState = stateResult.value;
  const passes: SignedDeckPass[] = [];
  const seats = definition.participants.map(({ seat }) => seat);

  for (const seat of seats) {
    const identity = identities.get(seat);
    if (!identity) throw new Error(`Missing deck signer identity for seat ${seat}`);
    const source = createDeckSecretSource(masterFor(seat), definition, seat);
    try {
      const proofSeed = source.proofSeed('fixture-shuffle', {
        operationId: deckPassOperationId(state),
        seat,
      });
      try {
        const pass = signDeckShuffle(
          state,
          source.shuffle(),
          source.permutation(),
          proofSeed,
          identity.secretKey,
        );
        const applied = applyPass(state, pass);
        state = applied;
        passes.push(pass);
      } finally {
        proofSeed.fill(0);
      }
    } finally {
      source.dispose();
    }
  }

  for (const seat of seats) {
    const identity = identities.get(seat);
    if (!identity) throw new Error(`Missing deck signer identity for seat ${seat}`);
    const source = createDeckSecretSource(masterFor(seat), definition, seat);
    try {
      const proofSeed = source.proofSeed('fixture-lock', {
        operationId: deckPassOperationId(state),
        seat,
      });
      try {
        const locks = definition.cards.map((_, position) => source.lock(position));
        const pass = signDeckLock(state, source.shuffle(), locks, proofSeed, identity.secretKey);
        state = applyPass(state, pass);
        passes.push(pass);
      } finally {
        proofSeed.fill(0);
      }
    } finally {
      source.dispose();
    }
  }
  return passes;
}

function applyPass(state: DeckSetupState, pass: SignedDeckPass): DeckSetupState {
  const result = applyDeckPass(state, pass);
  if (!result.ok) throw new Error(`Generated deck fixture pass failed: ${result.error.message}`);
  return result.value;
}

function cachedFixture(
  definitions: readonly DeckDefinition[],
  identities: ReadonlyMap<Seat, Identity>,
): CachedDeckFixture {
  const key = toHex(hashValue({ domain: 'cp2p/test/deck-fixture/v1', definitions }));
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const passes = definitions.map((definition) => createPasses(definition, identities));
  const commitments = definitions.map((definition, index) => {
    const transcript = passes[index];
    if (!transcript) throw new Error('Generated deck fixture is missing a transcript');
    const result = createDeckGenesisCommitment(definition, transcript);
    if (!result.ok) throw new Error(`Generated deck commitment failed: ${result.error.message}`);
    return result.value;
  });
  const value: CachedDeckFixture = {
    definitions: definitions.map(copyDefinition),
    commitments: commitments.map(copyCommitment),
    passes: passes.map((items) => items.map(copyPass)),
  };
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return value;
}

/**
 * Creates verified base-deck genesis commitments and their signed ceremony
 * transcripts for deterministic protocol tests. Setup is cached by the full
 * ordered definition; returned transcripts are detached from the bounded cache.
 */
export function createGenesisDeckFixture(
  body: GenesisBody,
  identities: ReadonlyMap<Seat, Identity>,
): GenesisDeckFixture {
  // Encryption keys are part of the signed roster before any shuffle transcript.
  const keyedBody: GenesisBody = {
    ...body,
    commitments: {
      ...body.commitments,
      masters:
        body.commitments.masters ??
        body.seats.map(({ seat }) => ({
          seat,
          masterPub: encodePoint(scalePoint(G, BigInt(17 + seat))),
        })),
    },
    seats: body.seats.map((seat) => {
      if (seat.encryptionKey !== undefined) return { ...seat };
      const source = createStealSecretSource(
        masterFor(seat.seat),
        body.ceremonyNonce,
        seat.seat,
        seat.publicKey,
      );
      try {
        return { ...seat, encryptionKey: encodePoint(scalePoint(G, source.encryptionSecret())) };
      } finally {
        source.dispose();
      }
    }),
  };
  const definitions = genesisDeckDefinitions(keyedBody);
  if (!definitions.ok) throw new Error(`Deck definitions failed: ${definitions.error.message}`);
  const generated = cachedFixture(definitions.value, identities);
  const decks = generated.commitments.map(copyCommitment);
  const transcripts = generated.definitions.map((definition, index) => {
    const passes = generated.passes[index];
    if (!passes) throw new Error('Cached deck fixture is missing a transcript');
    return { deckId: definition.deckId, passes: passes.map(copyPass) };
  });
  const nextBody: GenesisBody = {
    ...keyedBody,
    commitments: {
      ...keyedBody.commitments,
      decks,
    },
  };
  return {
    body: createGenesisEscrowFixture(nextBody, identities),
    transcripts,
    createSource(seat) {
      const sourceDefinition = generated.definitions.find((item) =>
        item.participants.some((participant) => participant.seat === seat),
      );
      if (!sourceDefinition) throw new RangeError(`Seat ${seat} is not a deck participant`);
      return createDeckSecretSource(masterFor(seat), sourceDefinition, seat);
    },
  };
}
