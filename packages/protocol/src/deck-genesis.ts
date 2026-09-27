import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { BASE_DEV_CARD_CATALOGUE, BASE_VERSION, failure, success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import * as v from 'valibot';
import { applyDeckPass, initDeckSetup, replayDeckSetup } from './deck-setup.js';
import type { DeckDefinition, SignedDeckPass } from './deck-setup.js';
import { hashSchema, key32Schema } from './schema-values.js';
import type { GenesisBody } from './types.js';
import { parseCanonical } from './validation.js';

export interface DeckGenesisCommitment {
  definition: DeckDefinition;
  passHashes: readonly string[];
  finalStateHash: string;
}

const commitmentSchema = v.strictObject({
  definition: v.unknown(),
  passHashes: v.pipe(v.array(hashSchema), v.maxLength(12)),
  finalStateHash: hashSchema,
});
const commitmentsSchema = v.pipe(v.array(commitmentSchema), v.maxLength(32));

/** The frozen manifest fields available before seed reveal and final genesis signing. */
export function deckCeremonyId(genesis: GenesisBody): string {
  return toBase64Url(
    hashValue({
      domain: 'cp2p/v1/deck-ceremony',
      protocolVersion: genesis.protocolVersion,
      engineVersion: genesis.engineVersion,
      config: genesis.config,
      seats: genesis.seats,
      ceremonyNonce: genesis.ceremonyNonce,
      masters: genesis.commitments.masters ?? [],
    }),
  );
}

/** Module-owned physical card order, with every signed seat as a deck participant. */
export function genesisDeckDefinitions(genesis: GenesisBody): Result<readonly DeckDefinition[]> {
  try {
    const nonce = parseCanonical(genesis.ceremonyNonce, key32Schema);
    if (!nonce.ok) return nonce;
    const modules = genesis.config.modules;
    const seats = genesis.seats;
    if (
      !Array.isArray(modules) ||
      modules.length < 1 ||
      modules.length > 32 ||
      !Array.isArray(seats) ||
      seats.length < 2 ||
      seats.length > 6 ||
      seats.length !== genesis.config.seats.length ||
      seats.some(({ seat }, index) => seat !== index || genesis.config.seats[index] !== index)
    )
      return failure('deck-genesis-roster', 'Deck genesis needs the exact configured seat order');
    const base = modules.filter((module) => module.id === 'base');
    if (base.length > 1)
      return failure('deck-genesis-module', 'Base module is selected more than once');
    if (base.length === 0) return success([]);
    if (base[0]?.version !== BASE_VERSION)
      return failure('deck-genesis-module', 'Base module version has no matching deck catalogue');
    const definition: DeckDefinition = {
      ceremonyId: deckCeremonyId(genesis),
      deckId: 'dev',
      deckEpoch: 0,
      creation: { kind: 'ceremony' },
      cards: BASE_DEV_CARD_CATALOGUE.map(({ identity, card }) => ({ identity, card })),
      participants: seats.map(({ seat, publicKey }) => ({ seat, publicKey })),
    };
    const initialized = initDeckSetup(definition);
    return initialized.ok ? success([initialized.value.definition]) : initialized;
  } catch {
    return failure('deck-genesis-definition', 'Deck genesis definition is not canonical data');
  }
}

/** Hash the complete signed pass, not merely its statement or proof. */
export function deckPassHash(pass: unknown): string {
  return toHex(hashValue({ domain: 'cp2p/v1/deck-pass-signed', pass }));
}

function lockedStateHash(value: unknown): string {
  return toHex(hashValue({ domain: 'cp2p/v1/locked-deck', deck: value }));
}

export function createDeckGenesisCommitment(
  definition: DeckDefinition,
  passes: readonly SignedDeckPass[],
): Result<DeckGenesisCommitment> {
  const count = definition.participants.length * 2;
  const items = exactArray(passes, count);
  if (!items) return failure('deck-pass-count', 'Deck setup needs every signed pass');
  const checked = replayDeckSetup(definition, items);
  if (!checked.ok) return checked;
  try {
    return success({
      definition: checked.value.definition,
      passHashes: items.map(deckPassHash),
      finalStateHash: lockedStateHash(checked.value),
    });
  } catch {
    return failure('deck-pass-hash', 'Signed deck pass cannot be hashed');
  }
}

/** Shape and canonical-rule check only. It does not verify the omitted pass proofs. */
export function validateDeckGenesisCommitments(
  genesis: GenesisBody,
): Result<readonly DeckGenesisCommitment[]> {
  const expected = genesisDeckDefinitions(genesis);
  if (!expected.ok) return expected;
  let raw: unknown;
  try {
    raw = genesis.commitments.decks;
  } catch {
    return failure('deck-genesis-commitments', 'Deck commitments are unreadable');
  }
  const parsed = parseCanonical(raw, commitmentsSchema);
  if (!parsed.ok) return parsed;
  if (parsed.value.length !== expected.value.length)
    return failure('deck-genesis-count', 'Genesis has missing or extra decks');
  const commitments: DeckGenesisCommitment[] = [];
  for (const [index, item] of parsed.value.entries()) {
    const definition = expected.value[index];
    if (!definition) return failure('deck-genesis-count', 'Unexpected deck commitment');
    const supplied = initDeckSetup(item.definition);
    if (!supplied.ok) return supplied;
    if (toHex(hashValue(supplied.value.definition)) !== toHex(hashValue(definition)))
      return failure('deck-genesis-definition', 'Deck definition differs from module and roster');
    if (
      item.passHashes.length !== definition.participants.length * 2 ||
      new Set(item.passHashes).size !== item.passHashes.length
    )
      return failure('deck-genesis-passes', 'Deck needs distinct ordered pass commitments');
    commitments.push({
      definition,
      passHashes: item.passHashes,
      finalStateHash: item.finalStateHash,
    });
  }
  return success(commitments);
}

function exactArray(value: unknown, size: number): unknown[] | null {
  try {
    if (
      !Array.isArray(value) ||
      value.length !== size ||
      Reflect.ownKeys(value).length !== size + 1
    )
      return null;
    const items: unknown[] = [];
    for (let index = 0; index < size; index += 1) {
      const entry = Object.getOwnPropertyDescriptor(value, String(index));
      if (!entry?.enumerable || !('value' in entry)) return null;
      items.push(entry.value);
    }
    return items;
  } catch {
    return null;
  }
}

/** Mandatory ceremony check before human signers sign the final genesis draft. */
export function validateDeckCeremony(
  genesis: GenesisBody,
  transcripts: readonly { deckId: string; passes: readonly SignedDeckPass[] }[],
): Result<void> {
  const commitments = validateDeckGenesisCommitments(genesis);
  if (!commitments.ok) return commitments;
  const items = exactArray(transcripts, commitments.value.length);
  if (!items) return failure('deck-ceremony-transcripts', 'Deck transcripts are missing or sparse');
  for (const [index, raw] of items.entries()) {
    const commitment = commitments.value[index];
    if (!commitment) return failure('deck-ceremony-transcripts', 'Extra deck transcript');
    let deckId: unknown;
    let passes: unknown;
    try {
      if (
        typeof raw !== 'object' ||
        raw === null ||
        Array.isArray(raw) ||
        Reflect.ownKeys(raw).length !== 2
      )
        return failure('deck-ceremony-transcripts', 'Deck transcript has unexpected fields');
      const id = Object.getOwnPropertyDescriptor(raw, 'deckId');
      const list = Object.getOwnPropertyDescriptor(raw, 'passes');
      if (!id?.enumerable || !('value' in id) || !list?.enumerable || !('value' in list))
        return failure('deck-ceremony-transcripts', 'Deck transcript has an accessor');
      deckId = id.value;
      passes = list.value;
    } catch {
      return failure('deck-ceremony-transcripts', 'Deck transcript is unreadable');
    }
    if (deckId !== commitment.definition.deckId)
      return failure('deck-ceremony-order', 'Deck transcript order differs from genesis');
    const signed = exactArray(passes, commitment.passHashes.length);
    if (!signed) return failure('deck-ceremony-passes', 'Deck pass list is incomplete');
    let state = initDeckSetup(commitment.definition);
    if (!state.ok) return state;
    for (const [passIndex, pass] of signed.entries()) {
      // Detach the hostile pass once: the committed hash and proof must see identical bytes.
      const copied = parseCanonical(pass, v.unknown());
      if (!copied.ok) return copied;
      try {
        if (deckPassHash(copied.value) !== commitment.passHashes[passIndex])
          return failure('deck-ceremony-hash', 'Signed deck pass differs from genesis');
      } catch {
        return failure('deck-ceremony-hash', 'Signed deck pass is not canonical');
      }
      state = applyDeckPass(state.value, copied.value);
      if (!state.ok) return state;
    }
    if (lockedStateHash(state.value) !== commitment.finalStateHash)
      return failure('deck-ceremony-final', 'Final locked deck differs from genesis');
  }
  return success(undefined);
}
