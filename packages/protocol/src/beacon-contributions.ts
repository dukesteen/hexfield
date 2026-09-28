import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { beaconOperationId, signBeaconReveal, verifyBeaconReveal } from './beacon.js';
import type { SignedBeaconReveal } from './beacon.js';
import {
  beaconExtensionOperationId,
  signBeaconExtension,
  verifyBeaconExtension,
} from './beacon-extension.js';
import type { SignedBeaconExtension } from './beacon-extension.js';
import {
  getBeaconExtensionOperation,
  getBeaconOperation,
  validateBeaconState,
} from './beacon-state.js';
import type { CryptoContext } from './crypto-context.js';
import { decksReady, validateDeckLedger } from './deck-ledger.js';
import {
  hashSchema,
  key32Schema,
  positiveIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import { MAX_MESSAGE_BYTES } from './validation.js';
import type { ArtifactSigner } from './authority-types.js';
import { identityFromSecret } from '@cp2p/crypto';

export type BeaconContribution =
  | { kind: 'beacon-reveal'; signed: SignedBeaconReveal }
  | { kind: 'beacon-extension'; signed: SignedBeaconExtension };

const chainLength = v.pipe(positiveIntegerSchema, v.maxValue(65_536));

export const beaconContributionSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('beacon-reveal'),
    signed: v.strictObject({
      body: v.strictObject({
        operationId: hashSchema,
        seat: seatSchema,
        index: chainLength,
        value: key32Schema,
      }),
      sig: signature64Schema,
    }),
  }),
  v.strictObject({
    kind: v.literal('beacon-extension'),
    signed: v.strictObject({
      body: v.strictObject({
        operationId: hashSchema,
        seat: seatSchema,
        chainEpoch: positiveIntegerSchema,
        length: chainLength,
        tip: key32Schema,
      }),
      sig: signature64Schema,
    }),
  }),
]);

export interface BeaconSecretSource {
  /**
   * Exact links derived from the retained master, ceremony context, length and chain epoch.
   * Restore must use the retained length, never a potentially changed application default.
   * Restarts and concurrent calls must reproduce the same chain; see createBeaconSecretSource.
   */
  link(chainEpoch: number, index: number): Uint8Array;
  /** Deterministic next-epoch tip, even if an earlier attempt failed before persistence. */
  extension(chainEpoch: number): { length: number; tip: Uint8Array };
}

export interface BeaconContributionStore {
  load(operationId: string): Promise<Uint8Array | null>;
  /** Atomically inserts immutable bytes only if this operation has no record. */
  putIfAbsent(operationId: string, bytes: Uint8Array): Promise<boolean>;
}

export class MemoryBeaconContributionStore implements BeaconContributionStore {
  readonly #records = new Map<string, Uint8Array>();

  async load(operationId: string): Promise<Uint8Array | null> {
    return this.#records.get(operationId)?.slice() ?? null;
  }

  async putIfAbsent(operationId: string, bytes: Uint8Array): Promise<boolean> {
    if (this.#records.has(operationId)) return false;
    this.#records.set(operationId, bytes.slice());
    return true;
  }
}

/** The stored bytes are authority for retries; corrupt records are never overwritten. */
export async function prepareBeaconContribution(
  crypto: CryptoContext,
  seat: Seat,
  key: Uint8Array,
  source: BeaconSecretSource,
  store: BeaconContributionStore,
  signer?: ArtifactSigner,
): Promise<Result<BeaconContribution | null>> {
  const currentSigner = signer ? { ...signer, generation: { ...signer.generation } } : undefined;
  const decks = validateDeckLedger(crypto.decks);
  if (!decks.ok) return decks;
  if (!decksReady(decks.value)) return success(null);
  const state = validateBeaconState(crypto.beacon);
  if (!state.ok) return state;
  if (!state.value.active) return success(null);
  const extensionPending = state.value.active.participants.some(
    (participant) => participant.index === participant.length,
  );
  const operation = extensionPending
    ? getBeaconExtensionOperation(state.value)
    : getBeaconOperation(state.value);
  if (!operation.ok) return operation;
  const participant = operation.value.participants.find((item) => item.seat === seat);
  if (!participant) return success(null);
  if (crypto.epoch > 0 && !currentSigner)
    return failure('beacon-contribution-authority', 'Recovered contribution needs current signer');
  if (currentSigner && currentSigner.seat !== seat)
    return failure('beacon-contribution-authority', 'Signer belongs to another seat');
  let signingKey: Uint8Array | null = null;
  try {
    signingKey = key.slice();
    const identity = identityFromSecret(signingKey);
    const matches = identity.peerId === (currentSigner?.publicKey ?? participant.publicKey);
    identity.secretKey.fill(0);
    if (!matches) {
      signingKey.fill(0);
      return failure('beacon-contribution-key', 'Local signing key differs from controller');
    }
  } catch {
    signingKey?.fill(0);
    return failure('beacon-contribution-key', 'Local signing key is invalid');
  }
  const operationId = extensionPending
    ? beaconExtensionOperationId(operation.value)
    : beaconOperationId(operation.value);
  const id = `${operationId}/${seat}${currentSigner ? `/${currentSigner.generation.seq}/${currentSigner.generation.hash}` : ''}`;

  const verifyStored = (bytes: Uint8Array): Result<BeaconContribution> => {
    try {
      if (!(bytes instanceof Uint8Array) || bytes.length > MAX_MESSAGE_BYTES)
        return failure('beacon-contribution-store', 'Stored beacon contribution is invalid');
      const parsed = v.safeParse(beaconContributionSchema, canonicalDecode(bytes));
      if (!parsed.success)
        return failure('beacon-contribution-corrupt', 'Stored beacon contribution is malformed');
      const contribution = parsed.output;
      if (
        contribution.signed.body.seat !== seat ||
        contribution.signed.body.operationId !== operationId
      )
        return failure(
          'beacon-contribution-context',
          'Stored beacon contribution belongs to another operation or seat',
        );
      if (extensionPending) {
        if (contribution.kind !== 'beacon-extension')
          return failure(
            'beacon-contribution-kind',
            'Stored beacon contribution has the wrong kind',
          );
        const verified = verifyBeaconExtension(contribution.signed, operation.value, currentSigner);
        return verified.ok ? success(contribution) : verified;
      }
      if (contribution.kind !== 'beacon-reveal')
        return failure('beacon-contribution-kind', 'Stored beacon contribution has the wrong kind');
      const verified = verifyBeaconReveal(contribution.signed, operation.value, currentSigner);
      return verified.ok ? success(contribution) : verified;
    } catch {
      return failure(
        'beacon-contribution-corrupt',
        'Stored beacon contribution could not be decoded',
      );
    }
  };

  try {
    const persisted = await store.load(id);
    if (persisted !== null) return verifyStored(persisted);
    let contribution: BeaconContribution;
    try {
      if (extensionPending) {
        const next = source.extension(participant.chainEpoch + 1);
        contribution = {
          kind: 'beacon-extension',
          signed: signBeaconExtension(
            operation.value,
            seat,
            next.length,
            next.tip,
            signingKey,
            currentSigner,
          ),
        };
      } else {
        contribution = {
          kind: 'beacon-reveal',
          signed: signBeaconReveal(
            operation.value,
            seat,
            source.link(participant.chainEpoch, participant.index),
            signingKey,
            currentSigner,
          ),
        };
      }
    } catch {
      return failure(
        'beacon-contribution-source',
        'Could not derive or sign the local contribution for this frozen chain',
      );
    }
    const bytes = canonicalEncode(contribution);
    if (await store.putIfAbsent(id, bytes)) return success(contribution);
    const winner = await store.load(id);
    return winner === null
      ? failure('beacon-contribution-store', 'Winning beacon contribution is missing')
      : verifyStored(winner);
  } catch {
    return failure('beacon-contribution-prepare', 'Beacon contribution could not be persisted');
  } finally {
    signingKey.fill(0);
  }
}
