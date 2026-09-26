import {
  DERIVATION_LABELS,
  deriveBytes,
  deriveScalar,
  scalarFromBytes,
  uniformInt,
} from '@cp2p/crypto';
import type { Seat } from '@cp2p/engine';
import { deckSetupId, initDeckSetup } from './deck-setup.js';
import type { DeckDefinition } from './deck-setup.js';

const ROLE = /^[a-z][a-z0-9-]{0,63}$/;

export interface DeckSecretSource {
  shuffle(): bigint;
  /** old index → new index. */
  permutation(): readonly number[];
  lock(position: number): bigint;
  proofSeed(role: string, context: unknown): Uint8Array;
  dispose(): void;
}

/** Deterministic per-deck secrets; a fresh factory reproduces an interrupted pass. */
export function createDeckSecretSource(
  master: Uint8Array,
  definition: DeckDefinition,
  seat: Seat,
): DeckSecretSource {
  if (!(master instanceof Uint8Array) || master.length !== 32)
    throw new TypeError('Deck master must be a canonical nonzero 32-byte scalar');
  scalarFromBytes(master, { nonzero: true });
  const initialized = initDeckSetup(definition);
  if (!initialized.ok) throw new TypeError(initialized.error.message);
  if (
    !Number.isSafeInteger(seat) ||
    !initialized.value.definition.participants.some((p) => p.seat === seat)
  )
    throw new RangeError('Deck seat must be a participant');
  const bound = initialized.value.definition;
  const secret = master.slice();
  const deckId = deckSetupId(bound);
  const size = bound.cards.length;
  let disposed = false;

  const check = (): void => {
    if (disposed) throw new Error('Deck secret source has been disposed');
  };
  const domain = { definition: bound, deckId, seat };
  return {
    shuffle() {
      check();
      return deriveScalar(secret, DERIVATION_LABELS.deckShuffle, domain);
    },
    permutation() {
      check();
      const seed = deriveBytes(secret, DERIVATION_LABELS.deckPermutation, domain, 32);
      const permutation = Array.from({ length: size }, (_, index) => index);
      try {
        for (let end = size - 1; end > 0; end -= 1) {
          const swap = uniformInt(seed, 'deck-permutation-step', end + 1, { deckId, seat, end });
          const atEnd = permutation[end];
          const atSwap = permutation[swap];
          if (atEnd === undefined || atSwap === undefined)
            throw new TypeError('Deck permutation index is missing');
          permutation[end] = atSwap;
          permutation[swap] = atEnd;
        }
        return permutation;
      } finally {
        seed.fill(0);
      }
    },
    lock(position) {
      check();
      if (!Number.isSafeInteger(position) || position < 0 || position >= size)
        throw new RangeError('Deck lock position is out of range');
      return deriveScalar(secret, DERIVATION_LABELS.deckLock, { ...domain, position });
    },
    proofSeed(role, context) {
      check();
      if (typeof role !== 'string' || !ROLE.test(role))
        throw new TypeError('Deck proof role must be a bounded lowercase label');
      return deriveBytes(
        secret,
        DERIVATION_LABELS.proofRandomness,
        { ...domain, role, context },
        32,
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      secret.fill(0);
    },
  };
}
