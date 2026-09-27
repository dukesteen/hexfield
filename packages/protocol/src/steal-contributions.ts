import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import {
  stealOperationId,
  signedStealDisputeSchema,
  signedStealReceiptSchema,
  validateStealOperation,
  verifyStealContribution,
  verifyStealDispute,
  verifyStealReceipt,
} from './steal-delivery.js';
import type {
  FixedSteal,
  SignedStealContribution,
  SignedStealDispute,
  SignedStealReceipt,
  StealOperation,
} from './steal-delivery.js';
import type { LogContext } from './log.js';
import { hashSchema, key32Schema, nonnegativeIntegerSchema, seatSchema } from './schema-values.js';
import { MAX_MESSAGE_BYTES, parseCanonical } from './validation.js';
import { resolveArtifactSigner } from './authority.js';
import type { ArtifactSigner } from './authority-types.js';

export interface StealDeliveryStore {
  load(id: string): Promise<Uint8Array | null>;
  /** Insert immutable canonical bytes durably before returning true. */
  putIfAbsent(id: string, bytes: Uint8Array): Promise<boolean>;
}

export class MemoryStealDeliveryStore implements StealDeliveryStore {
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

export type StealContributionProducer = (
  operation: StealOperation,
  seat: Seat,
  context: LogContext,
  signingKey: Uint8Array,
) => Result<SignedStealContribution>;

export type StealResponse =
  | { readonly kind: 'receipt'; readonly value: SignedStealReceipt }
  | { readonly kind: 'dispute'; readonly value: SignedStealDispute };

export type StealResponseProducer = (
  fixed: FixedSteal,
  seat: Seat,
  context: LogContext,
  signingKey: Uint8Array,
) => Result<StealResponse>;

const entryRefSchema = v.strictObject({
  seq: nonnegativeIntegerSchema,
  hash: hashSchema,
});
const fixedStealSchema = v.strictObject({
  operation: v.unknown(),
  contribution: v.unknown(),
  entry: v.unknown(),
  signer: v.optional(
    v.strictObject({
      seat: seatSchema,
      publicKey: key32Schema,
      generation: entryRefSchema,
    }),
  ),
});
const responseSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('receipt'), value: signedStealReceiptSchema }),
  v.strictObject({ kind: v.literal('dispute'), value: signedStealDisputeSchema }),
]);

function signerMatches(key: Uint8Array, publicKey: string): boolean {
  const identity = identityFromSecret(key);
  const matches = identity.peerId === publicKey;
  identity.secretKey.fill(0);
  return matches;
}

function contributionRecord(
  bytes: Uint8Array,
  operation: StealOperation,
  seat: Seat,
  signer?: ArtifactSigner,
): Result<SignedStealContribution> {
  try {
    if (bytes.byteLength > MAX_MESSAGE_BYTES)
      return failure('steal-outbox-record', 'Stored steal contribution exceeds its byte limit');
    const verified = verifyStealContribution(canonicalDecode(bytes), operation, signer);
    return verified.ok && verified.value.body.seat === seat
      ? verified
      : failure('steal-outbox-record', 'Stored steal contribution is corrupt or misplaced');
  } catch {
    return failure('steal-outbox-record', 'Stored steal contribution is not canonical data');
  }
}

function fixedSteal(value: FixedSteal): Result<FixedSteal> {
  try {
    const parsed = parseCanonical(value, fixedStealSchema);
    if (!parsed.ok) return parsed;
    const operation = validateStealOperation(parsed.value.operation);
    if (!operation.ok) return operation;
    const contribution = verifyStealContribution(
      parsed.value.contribution,
      operation.value,
      parsed.value.signer,
    );
    if (!contribution.ok) return contribution;
    const entry = parseCanonical(parsed.value.entry, entryRefSchema);
    if (!entry.ok) return entry;
    const checked: FixedSteal = {
      operation: operation.value,
      contribution: contribution.value,
      entry: entry.value,
      ...(parsed.value.signer ? { signer: parsed.value.signer } : {}),
    };
    if (checked.entry.seq <= checked.operation.anchor.seq)
      return failure('steal-response-fixed', 'Fixed contribution must follow its beacon anchor');
    return success(checked);
  } catch {
    return failure('steal-response-fixed', 'Fixed steal context is malformed');
  }
}

function responseRecord(
  bytes: Uint8Array,
  fixed: FixedSteal,
  seat: Seat,
  signer?: ArtifactSigner,
): Result<StealResponse> {
  try {
    if (bytes.byteLength > MAX_MESSAGE_BYTES)
      return failure('steal-response-record', 'Stored steal response exceeds its byte limit');
    const parsed = parseCanonical(canonicalDecode(bytes), responseSchema);
    if (!parsed.ok) return parsed;
    if (parsed.value.kind === 'receipt') {
      const verified = verifyStealReceipt(parsed.value.value, fixed, signer);
      return verified.ok && verified.value.body.seat === seat
        ? success({ kind: 'receipt', value: verified.value })
        : failure('steal-response-record', 'Stored steal receipt is corrupt or misplaced');
    }
    const verified = verifyStealDispute(parsed.value.value, fixed, signer);
    return verified.ok && verified.value.body.binding.seat === seat
      ? success({ kind: 'dispute', value: verified.value })
      : failure('steal-response-record', 'Stored steal dispute is corrupt or misplaced');
  } catch {
    return failure('steal-response-record', 'Stored steal response is not canonical data');
  }
}

/** Persist the exact signed hidden transfer before returning it for broadcast. */
export async function prepareStealContribution(
  operation: StealOperation,
  seat: Seat,
  key: Uint8Array,
  context: LogContext,
  produce: StealContributionProducer,
  store: StealDeliveryStore,
): Promise<Result<SignedStealContribution>> {
  const checked = validateStealOperation(operation);
  if (!checked.ok) return checked;
  if (seat !== checked.value.victim.seat)
    return failure('steal-outbox-seat', 'Seat is not the frozen victim');
  const signer =
    context.authority || (context.crypto?.epoch ?? 0) > 0
      ? resolveArtifactSigner(context.authority, context.genesis, context.crypto?.epoch ?? 0, seat)
      : success(undefined);
  if (!signer.ok) return signer;
  let signingKey: Uint8Array;
  try {
    if (!(key instanceof Uint8Array) || key.length !== 32)
      return failure('steal-outbox-key', 'The local signer key is invalid');
    signingKey = key.slice();
  } catch {
    return failure('steal-outbox-key', 'The local signer key is invalid');
  }
  try {
    let matches = false;
    try {
      matches = signerMatches(
        signingKey,
        signer.value?.publicKey ?? checked.value.victim.publicKey,
      );
    } catch {
      return failure('steal-outbox-key', 'The local signer key is invalid');
    }
    if (!matches)
      return failure('steal-outbox-key', 'The local signer key does not match the frozen victim');
    const generation = signer.value?.generation;
    const id = `steal-contribution/${stealOperationId(checked.value)}/${seat}${generation ? `/${generation.seq}/${generation.hash}` : ''}`;
    const existing = await store.load(id);
    if (existing !== null) return contributionRecord(existing, checked.value, seat, signer.value);
    let signed: SignedStealContribution;
    try {
      const produced = produce(checked.value, seat, context, signingKey);
      if (!produced.ok) return produced;
      const verified = verifyStealContribution(produced.value, checked.value, signer.value);
      if (!verified.ok) return verified;
      signed = verified.value;
    } catch {
      return failure(
        'steal-outbox-source',
        'Could not produce or verify the frozen hidden transfer',
      );
    }
    const bytes = canonicalEncode(signed);
    if (bytes.byteLength > MAX_MESSAGE_BYTES)
      return failure('steal-outbox-record', 'Steal contribution exceeds its byte limit');
    if (await store.putIfAbsent(id, bytes)) return success(signed);
    const winner = await store.load(id);
    return winner
      ? contributionRecord(winner, checked.value, seat, signer.value)
      : failure('steal-outbox-record', 'The winning steal contribution is missing');
  } catch {
    return failure('steal-outbox-write', 'Could not persist the outgoing steal contribution');
  } finally {
    signingKey.fill(0);
  }
}

/** Persist one mutually exclusive receipt-or-dispute response for a fixed transfer. */
export async function prepareStealResponse(
  fixed: FixedSteal,
  seat: Seat,
  key: Uint8Array,
  context: LogContext,
  produce: StealResponseProducer,
  store: StealDeliveryStore,
): Promise<Result<StealResponse>> {
  const checkedFixed = fixedSteal(fixed);
  if (!checkedFixed.ok) return checkedFixed;
  const thief = checkedFixed.value.operation.thief;
  if (seat !== thief.seat)
    return failure('steal-response-seat', 'Seat is not the frozen recipient');
  const signer =
    context.authority || (context.crypto?.epoch ?? 0) > 0
      ? resolveArtifactSigner(context.authority, context.genesis, context.crypto?.epoch ?? 0, seat)
      : success(undefined);
  if (!signer.ok) return signer;
  let signingKey: Uint8Array;
  try {
    if (!(key instanceof Uint8Array) || key.length !== 32)
      return failure('steal-response-key', 'The local signer key is invalid');
    signingKey = key.slice();
  } catch {
    return failure('steal-response-key', 'The local signer key is invalid');
  }
  try {
    let matches = false;
    try {
      matches = signerMatches(signingKey, signer.value?.publicKey ?? thief.publicKey);
    } catch {
      return failure('steal-response-key', 'The local signer key is invalid');
    }
    if (!matches)
      return failure(
        'steal-response-key',
        'The local signer key does not match the frozen recipient',
      );
    const operationId = stealOperationId(checkedFixed.value.operation);
    const generation = signer.value?.generation;
    const id = `steal-response/${operationId}/${checkedFixed.value.entry.hash}/${seat}${generation ? `/${generation.seq}/${generation.hash}` : ''}`;
    const existing = await store.load(id);
    if (existing !== null) return responseRecord(existing, checkedFixed.value, seat, signer.value);
    let response: StealResponse;
    try {
      const produced = produce(checkedFixed.value, seat, context, signingKey);
      if (!produced.ok) return produced;
      const verified = responseRecord(
        canonicalEncode(produced.value),
        checkedFixed.value,
        seat,
        signer.value,
      );
      if (!verified.ok) return verified;
      response = verified.value;
    } catch {
      return failure('steal-response-source', 'Could not produce or verify the steal response');
    }
    const bytes = canonicalEncode(response);
    if (bytes.byteLength > MAX_MESSAGE_BYTES)
      return failure('steal-response-record', 'Steal response exceeds its byte limit');
    if (await store.putIfAbsent(id, bytes)) return success(response);
    const winner = await store.load(id);
    return winner
      ? responseRecord(winner, checkedFixed.value, seat, signer.value)
      : failure('steal-response-record', 'The winning steal response is missing');
  } catch {
    return failure('steal-response-write', 'Could not persist the outgoing steal response');
  } finally {
    signingKey.fill(0);
  }
}
