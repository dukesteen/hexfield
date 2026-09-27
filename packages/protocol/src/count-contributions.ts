import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import type { SchnorrProof } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import {
  countOperationId,
  signCountContribution,
  validateCountOperation,
  verifyCountContribution,
} from './count-reveal.js';
import type { CountOperation, SignedCountContribution } from './count-reveal.js';
import type { LogContext } from './log.js';
import { MAX_MESSAGE_BYTES } from './validation.js';
import { resolveArtifactSigner } from './authority.js';

export interface CountContributionStore {
  load(id: string): Promise<Uint8Array | null>;
  /** Insert immutable bytes durably before returning true. */
  putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean>;
}

export class MemoryCountContributionStore implements CountContributionStore {
  readonly #records = new Map<string, Uint8Array>();

  async load(id: string): Promise<Uint8Array | null> {
    return this.#records.get(id)?.slice() ?? null;
  }

  async putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean> {
    if (this.#records.has(id)) return false;
    this.#records.set(id, bytes.slice());
    return true;
  }
}

export type CountProofProducer = (
  operation: CountOperation,
  seat: Seat,
  context: LogContext,
) => Result<{ count: number; proof: SchnorrProof }>;

/** Durable signed delivery for one owner and frozen Monopoly operation. */
export async function prepareCountContribution(
  operation: CountOperation,
  seat: Seat,
  key: Uint8Array,
  context: LogContext,
  produce: CountProofProducer,
  store: CountContributionStore,
): Promise<Result<SignedCountContribution>> {
  const checked = validateCountOperation(operation);
  if (!checked.ok) return checked;
  const victim = checked.value.victims.find((item) => item.seat === seat);
  if (!victim) return failure('count-outbox-seat', 'Seat is not a frozen Monopoly victim');
  const signer =
    context.authority || (context.crypto?.epoch ?? 0) > 0
      ? resolveArtifactSigner(context.authority, context.genesis, context.crypto?.epoch ?? 0, seat)
      : success(undefined);
  if (!signer.ok) return signer;
  let signingKey: Uint8Array;
  try {
    if (!(key instanceof Uint8Array) || key.length !== 32)
      return failure('count-outbox-key', 'The local signer key is invalid');
    signingKey = key.slice();
  } catch {
    return failure('count-outbox-key', 'The local signer key is invalid');
  }
  try {
    const identity = identityFromSecret(signingKey);
    try {
      if (identity.peerId !== (signer.value?.publicKey ?? victim.publicKey))
        return failure('count-outbox-key', 'The local signer key does not match this victim');
    } finally {
      identity.secretKey.fill(0);
    }
    const operationId = countOperationId(checked.value);
    const generation = signer.value?.generation;
    const id = `count-contribution/${operationId}/${seat}${generation ? `/${generation.seq}/${generation.hash}` : ''}`;
    const stored = (bytes: Uint8Array): Result<SignedCountContribution> => {
      try {
        if (bytes.byteLength > MAX_MESSAGE_BYTES)
          return failure('count-outbox-record', 'Stored count contribution exceeds its byte limit');
        const verified = verifyCountContribution(
          canonicalDecode(bytes),
          checked.value,
          signer.value,
        );
        return verified.ok && verified.value.body.seat === seat
          ? verified
          : failure('count-outbox-record', 'Stored count contribution is corrupt or misplaced');
      } catch {
        return failure('count-outbox-record', 'Stored count contribution is not canonical data');
      }
    };
    const existing = await store.load(id);
    if (existing !== null) return stored(existing);
    let signed: SignedCountContribution;
    try {
      const proof = produce(checked.value, seat, context);
      if (!proof.ok) return proof;
      signed = signCountContribution(
        checked.value,
        seat,
        proof.value.count,
        proof.value.proof,
        signingKey,
        signer.value,
      );
      const verified = verifyCountContribution(signed, checked.value, signer.value);
      if (!verified.ok) return verified;
      signed = verified.value;
    } catch {
      return failure('count-outbox-source', 'Could not derive or sign the frozen count reveal');
    }
    const bytes = canonicalEncode(signed);
    if (bytes.byteLength > MAX_MESSAGE_BYTES)
      return failure('count-outbox-record', 'Count contribution exceeds its byte limit');
    if (await store.putIfAbsent(id, bytes)) return success(signed);
    const winner = await store.load(id);
    return winner
      ? stored(winner)
      : failure('count-outbox-record', 'The winning count contribution is missing');
  } catch {
    return failure('count-outbox-write', 'Could not persist the outgoing count contribution');
  } finally {
    signingKey.fill(0);
  }
}
