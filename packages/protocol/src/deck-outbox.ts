import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import {
  deckDrawOperationId,
  freezeDeckDraw,
  signDeckUnlock,
  verifyDeckUnlock,
  verifyDeckUnlockPrefix,
} from './deck-draw.js';
import type { DeckDrawRequest, SignedDeckUnlock } from './deck-draw.js';
import { deckSetupId, validateDeckSetupState } from './deck-setup.js';
import type { DeckSetupState } from './deck-setup.js';
import type { DeckSecretSource } from './deck-source.js';
import { MAX_MESSAGE_BYTES } from './validation.js';
import type { ArtifactSigner } from './authority-types.js';

export interface DeckContributionStore {
  load(id: string): Promise<Uint8Array | null>;
  /**
   * Atomic, immutable insert. Return true only after the transaction is durable.
   * A losing writer must read and verify the winner. Retain records across restarts.
   */
  putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean>;
}

/**
 * The request must come from the caller's certified pending and the setup from
 * verified replay. The initial point and keys are always derived locally.
 * Every participant, including the drawer, durably reserves the position before
 * returning. A different request can never reuse that position's secrets.
 * Returns only durable signed bytes. The caller sends them after this resolves.
 */
export async function prepareDeckUnlock(
  setup: DeckSetupState,
  request: DeckDrawRequest,
  prefix: readonly SignedDeckUnlock[],
  seat: Seat,
  key: Uint8Array,
  source: Pick<DeckSecretSource, 'lock' | 'proofSeed'>,
  store: DeckContributionStore,
  signers?: readonly ArtifactSigner[],
  localSigner?: ArtifactSigner,
): Promise<Result<SignedDeckUnlock | null>> {
  const frozenSigners = signers?.map((signer) => ({
    ...signer,
    generation: { ...signer.generation },
  }));
  const frozenLocalSigner = localSigner
    ? { ...localSigner, generation: { ...localSigner.generation } }
    : undefined;
  const validatedSetup = validateDeckSetupState(setup);
  if (!validatedSetup.ok) return validatedSetup;
  const frozen = freezeDeckDraw(validatedSetup.value, request);
  if (!frozen.ok) return frozen;
  const checked = verifyDeckUnlockPrefix(frozen.value, prefix, frozenSigners);
  if (!checked.ok) return checked;
  const op = checked.value.operation;
  const participant = op.participants.find((item) => item.seat === seat);
  if (!participant)
    return failure('deck-outbox-seat', 'Only a frozen participant can reserve this position');
  const unlockers = op.participants.filter((item) => item.seat !== op.seat);
  const signer = frozenLocalSigner;
  if (signer && signer.seat !== seat)
    return failure('deck-outbox-authority', 'Local signer belongs to another seat');
  if (
    frozenSigners &&
    (frozenSigners.length !== unlockers.length ||
      frozenSigners.some((item, index) => item.seat !== unlockers[index]?.seat))
  )
    return failure('deck-outbox-authority', 'Unlock signers differ from frozen seat order');
  let setupId: string;
  try {
    setupId = deckSetupId(validatedSetup.value.definition);
  } catch {
    return failure('deck-outbox-setup', 'The verified deck definition is invalid');
  }
  let signingKey: Uint8Array;
  try {
    if (!(key instanceof Uint8Array) || key.length !== 32)
      return failure('deck-outbox-key', 'The local signer key is invalid');
    signingKey = key.slice();
  } catch {
    return failure('deck-outbox-key', 'The local signer key is invalid');
  }
  let signerMatches = false;
  try {
    const identity = identityFromSecret(signingKey);
    try {
      signerMatches = identity.peerId === (signer?.publicKey ?? participant.publicKey);
    } finally {
      identity.secretKey.fill(0);
    }
  } catch {
    signingKey.fill(0);
    return failure('deck-outbox-key', 'The local signer key is invalid');
  }
  if (!signerMatches) {
    signingKey.fill(0);
    return failure('deck-outbox-key', 'The local signer key does not match this seat');
  }
  const step = checked.value.unlocks.length;
  const actor = op.participants.filter((entry) => entry.seat !== op.seat)[step];
  const positionId = `${setupId}/${op.position}/${seat}`;
  const reservationId = `deck-position/${positionId}`;
  const operationId = deckDrawOperationId(op);
  const id = `deck-unlock/${positionId}${signer ? `/${signer.generation.seq}/${signer.generation.hash}` : ''}`;
  const stored = (bytes: Uint8Array): Result<SignedDeckUnlock> => {
    try {
      if (bytes.byteLength > MAX_MESSAGE_BYTES)
        return failure('deck-outbox-record', 'Stored unlock exceeds its byte limit');
      const result = verifyDeckUnlock(
        op,
        checked.value.unlocks,
        canonicalDecode(bytes),
        frozenSigners,
      );
      return result.ok
        ? result
        : failure('deck-outbox-record', 'Stored unlock is corrupt or belongs to another operation');
    } catch {
      return failure('deck-outbox-record', 'Stored unlock is not canonical data');
    }
  };
  const reservationMatches = (bytes: Uint8Array): boolean => {
    try {
      return bytes.length <= MAX_MESSAGE_BYTES && canonicalDecode(bytes) === operationId;
    } catch {
      return false;
    }
  };
  try {
    const reserved = await store.load(reservationId);
    if (reserved !== null) {
      if (!reservationMatches(reserved))
        return failure(
          'deck-outbox-position',
          'This position is reserved for another draw or its record is corrupt',
        );
    } else if (!(await store.putIfAbsent(reservationId, canonicalEncode(operationId)))) {
      const winner = await store.load(reservationId);
      if (!winner || !reservationMatches(winner))
        return failure(
          'deck-outbox-position',
          'The winning position reservation does not match this draw',
        );
    }
    if (!actor || actor.seat !== seat) return success(null);
    const existing = await store.load(id);
    if (existing) return stored(existing);
    let signed: SignedDeckUnlock;
    try {
      const seed = source.proofSeed('unlock', { operation: op, step });
      try {
        signed = signDeckUnlock(
          op,
          checked.value.unlocks,
          source.lock(op.position),
          seed,
          signingKey,
          frozenSigners,
        );
      } finally {
        seed.fill(0);
      }
    } catch {
      return failure('deck-outbox-source', 'Could not derive or sign the frozen position unlock');
    }
    const bytes = canonicalEncode(signed);
    if (await store.putIfAbsent(id, bytes)) return success(signed);
    const winner = await store.load(id);
    return winner
      ? stored(winner)
      : failure('deck-outbox-record', 'The winning unlock record is missing');
  } catch {
    return failure('deck-outbox-write', 'Could not persist the outgoing unlock');
  } finally {
    signingKey.fill(0);
  }
}
