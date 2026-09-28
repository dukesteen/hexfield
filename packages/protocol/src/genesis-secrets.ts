import { fromBase64Url, hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { G, encodePoint, scalarFromBytes, scalePoint } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { createBeaconSecretSource } from './beacon-source.js';
import { initializeBeaconState } from './beacon-state.js';
import { deckCeremonyId, validateDeckGenesisCommitments } from './deck-genesis.js';
import { validateDeckLedger } from './deck-ledger.js';
import type { DeckLedger } from './deck-ledger.js';
import { createDeckSecretSource } from './deck-source.js';
import { genesisDigest, genesisId } from './genesis.js';
import { validateGenesisMasters } from './genesis-masters.js';
import { key32Schema } from './schema-values.js';
import { genesisSchema } from './schemas.js';
import { createStealSecretSource } from './steal-source.js';
import type { GenesisBody } from './types.js';
import { parseCanonical } from './validation.js';

const bodySchema = v.union([genesisSchema, v.omit(genesisSchema, ['gameId', 'signatures'])]);

function same(left: unknown, right: unknown): boolean {
  return toHex(hashValue(left)) === toHex(hashValue(right));
}

/**
 * Check a recovered/revealed master against the original public keys and chain.
 * Call only after authorized disclosure. This function neither authorizes it nor
 * authenticates genesis/certificates; callers must supply their certified genesis.
 * It does not constitute the full historical game audit.
 */
export function verifyRevealedMaster(
  value: GenesisBody,
  ledger: DeckLedger,
  seat: Seat,
  suppliedMaster: unknown,
): Result<void> {
  const body = parseCanonical(value, bodySchema);
  if (!body.ok) return body;
  const genesis = body.value;
  if (genesis.security !== 'verified')
    return failure('master-security', 'Only verified games have recoverable masters');
  const masters = validateGenesisMasters(genesis);
  if (!masters.ok) return masters;
  const owner = genesis.seats.find((item) => item.seat === seat);
  const commitment = masters.value.find((item) => item.seat === seat);
  if (!owner || !commitment)
    return failure('master-reveal', 'Master reveal has an invalid seat or scalar encoding');
  let master: Uint8Array | undefined;
  try {
    // Private import paths pass bytes directly. Do not create an unwipeable
    // base64 string for a master that has not been publicly revealed.
    if (suppliedMaster instanceof Uint8Array) {
      if (suppliedMaster.byteLength !== 32)
        return failure('master-reveal', 'Master must contain exactly 32 bytes');
      master = new Uint8Array(suppliedMaster);
    } else {
      const parsed = parseCanonical(suppliedMaster, key32Schema);
      if (!parsed.ok)
        return failure('master-reveal', 'Master reveal has an invalid scalar encoding');
      master = fromBase64Url(parsed.value);
    }
    const scalar = scalarFromBytes(master, { nonzero: true });
    if (encodePoint(scalePoint(G, scalar)) !== commitment.masterPub)
      return failure('master-public-key', 'Revealed master does not match its commitment');
    const encryption = createStealSecretSource(
      master,
      genesis.ceremonyNonce,
      seat,
      owner.publicKey,
    );
    try {
      if (encodePoint(scalePoint(G, encryption.encryptionSecret())) !== owner.encryptionKey)
        return failure('master-encryption-key', 'Master does not reproduce the encryption key');
    } finally {
      encryption.dispose();
    }

    const beacon = initializeBeaconState({
      ...genesis,
      gameId: genesisId(genesis),
      signatures: [],
    });
    if (!beacon.ok) return beacon;
    const chain = beacon.value.chains.find((item) => item.seat === seat);
    if (chain) {
      const source = createBeaconSecretSource(
        master,
        { ceremonyId: deckCeremonyId(genesis), seat },
        chain.length,
      );
      try {
        if (toBase64Url(source.initialCommitment.tip) !== chain.tip)
          return failure('master-beacon-tip', 'Master does not reproduce the initial beacon tip');
      } finally {
        source.dispose();
      }
    }

    const expected = validateDeckGenesisCommitments(genesis);
    if (!expected.ok) return expected;
    const checked = validateDeckLedger(ledger);
    if (!checked.ok) return checked;
    if (
      checked.value.genesisDigest !== genesisDigest(genesis) ||
      !same(
        checked.value.decks.map((deck) => deck.commitment),
        expected.value,
      )
    )
      return failure('master-deck-context', 'Locked decks differ from the certified genesis');
    for (const deck of checked.value.decks) {
      const index = deck.setup.definition.participants.findIndex((item) => item.seat === seat);
      if (index < 0)
        return failure('master-deck-context', 'Original seat is missing from a genesis deck');
      // Deck passes certify during setup, so a game can end (for example on certified cheat
      // evidence) before every pass is in. Check the keys the certified passes established.
      const source = createDeckSecretSource(master, deck.setup.definition, seat);
      try {
        if (
          index < deck.setup.shuffleKeys.length &&
          encodePoint(scalePoint(G, source.shuffle())) !== deck.setup.shuffleKeys[index]
        )
          return failure('master-shuffle-key', 'Master does not reproduce a deck shuffle key');
        const keys = deck.setup.lockKeys[index];
        if (
          index < deck.setup.lockKeys.length &&
          keys &&
          deck.setup.definition.cards.some(
            (_, position) => encodePoint(scalePoint(G, source.lock(position))) !== keys[position],
          )
        )
          return failure('master-lock-key', 'Master does not reproduce every deck lock key');
      } finally {
        source.dispose();
      }
    }
    return success(undefined);
  } catch {
    return failure('master-reveal', 'Master reveal contains invalid secret or context data');
  } finally {
    master?.fill(0);
  }
}
