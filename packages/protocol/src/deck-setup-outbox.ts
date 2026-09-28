import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import type { DeckContributionStore } from './deck-outbox.js';
import type { DeckSecretSource } from './deck-source.js';
import {
  applyDeckPass,
  deckPassOperationId,
  deckSetupId,
  signDeckLock,
  signDeckShuffle,
  validateDeckSetupState,
} from './deck-setup.js';
import type { DeckSetupState, SignedDeckPass } from './deck-setup.js';
import { MAX_MESSAGE_BYTES } from './validation.js';

/**
 * A seat may sign only one shuffle and one lock pass per deck definition. The
 * outbox key deliberately does not contain the pre-pass state: a competing
 * history must fail rather than elicit a second use of the same secrets.
 */
export async function prepareDeckPass(
  value: DeckSetupState,
  seat: Seat,
  key: Uint8Array,
  source: Pick<DeckSecretSource, 'shuffle' | 'permutation' | 'lock' | 'proofSeed'>,
  store: DeckContributionStore,
): Promise<Result<SignedDeckPass | null>> {
  const checked = validateDeckSetupState(value);
  if (!checked.ok) return checked;
  const state = checked.value;
  const participantCount = state.definition.participants.length;
  const phase = state.shuffleKeys.length < participantCount ? 'shuffle' : 'lock';
  const actorIndex = phase === 'shuffle' ? state.shuffleKeys.length : state.lockKeys.length;
  const actor = state.definition.participants[actorIndex];
  if (!actor || actor.seat !== seat) return success(null);

  // Copy the signer before the first await, just as the validated state is copied.
  const signer = key.slice();
  try {
    const identity = identityFromSecret(signer);
    const matches = identity.peerId === actor.publicKey;
    identity.secretKey.fill(0);
    if (!matches) {
      signer.fill(0);
      return failure('deck-outbox-signer', 'The deck pass signer is not the elected actor');
    }
  } catch {
    signer.fill(0);
    return failure('deck-outbox-signer', 'The deck pass signer is invalid');
  }
  try {
    const operationId = deckPassOperationId(state);
    const id = `deck-pass/${deckSetupId(state.definition)}/${seat}/${phase}`;
    const stored = (bytes: Uint8Array): Result<SignedDeckPass> => {
      try {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_MESSAGE_BYTES)
          return failure('deck-outbox-record', 'Stored pass exceeds its byte limit');
        const pass = canonicalDecode(bytes);
        // Our own stored pass: structural still binds actor, order and operation id, which
        // keeps each seat to one pass per setup (the single-use record).
        const applied = applyDeckPass(state, pass, { proofs: 'structural' });
        return applied.ok
          ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- applyDeckPass parses the complete signed-pass schema and verifies this exact decoded value.
            success(pass as SignedDeckPass)
          : failure('deck-outbox-record', 'Stored pass belongs to a conflicting setup history');
      } catch {
        return failure('deck-outbox-record', 'Stored pass is not canonical data');
      }
    };
    try {
      const existing = await store.load(id);
      if (existing) return stored(existing);
    } catch {
      return failure('deck-outbox-read', 'Could not read the outgoing deck pass');
    }

    let signed: SignedDeckPass;
    try {
      const proofSeed = source.proofSeed(phase, { operationId, phase, seat });
      try {
        signed =
          phase === 'shuffle'
            ? signDeckShuffle(state, source.shuffle(), source.permutation(), proofSeed, signer)
            : signDeckLock(
                state,
                source.shuffle(),
                state.points.map((_, position) => source.lock(position)),
                proofSeed,
                signer,
              );
      } finally {
        proofSeed.fill(0);
      }
    } catch {
      return failure('deck-outbox-source', 'Could not derive or sign the frozen setup pass');
    }
    try {
      const bytes = canonicalEncode(signed);
      if (await store.putIfAbsent(id, bytes)) return success(signed);
      const winner = await store.load(id);
      return winner
        ? stored(winner)
        : failure('deck-outbox-record', 'The winning deck pass record is missing');
    } catch {
      return failure('deck-outbox-write', 'Could not persist the outgoing deck pass');
    }
  } finally {
    signer.fill(0);
  }
}
