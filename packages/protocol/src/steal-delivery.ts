import { canonicalDecode, canonicalEncode, fromBase64Url, hashValue, toHex } from '@cp2p/codec';
import {
  DERIVATION_LABELS,
  G,
  decodePoint,
  decodeScalar,
  deriveScalar,
  encodePoint,
  encodeScalar,
  identityFromSecret,
  openSealed,
  openSealedWithSharedPoint,
  parsePeerId,
  pedersenCommit,
  proveDleq,
  proveHiddenTransfer,
  scalePoint,
  seal,
  signObject,
  verifyDleq,
  verifyHiddenTransfer,
  verifyObject,
} from '@cp2p/crypto';
import type { DleqProof, SealedPayload } from '@cp2p/crypto';
import { RESOURCES, failure, success } from '@cp2p/engine';
import type { Resource, Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import type { EntryRef } from './beacon-state.js';
import { MAX_HAND_RESOURCE_COUNT, verifyHandOpening } from './hand-commitments.js';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import { parseCanonical } from './validation.js';

export const STEAL_EVIDENCE_PROTOCOL = 'hidden-steal-v1';

/** Frozen from the certified beacon result and the current victim commitments. */
export interface StealOperation {
  protocol: typeof STEAL_EVIDENCE_PROTOCOL;
  genesisDigest: string;
  epoch: number;
  anchor: EntryRef;
  beaconOperationId: string;
  thief: { seat: Seat; publicKey: string; encryptionKey: string };
  victim: { seat: Seat; publicKey: string };
  handSize: number;
  index: number;
  commitments: Readonly<Record<Resource, string>>;
}

export interface SignedStealContribution {
  body: {
    operationId: string;
    seat: Seat;
    transfer: readonly string[];
    sealed: SealedPayload;
    proof: unknown;
  };
  sig: string;
}

/** The caller obtains entry from the certified STEAL_FIXED entry, never a peer claim. */
export interface FixedSteal {
  operation: StealOperation;
  contribution: SignedStealContribution;
  entry: EntryRef;
}

export interface StealOpening {
  resource: Resource;
  blindings: Readonly<Record<Resource, string>>;
}

interface StealReceiptBody {
  operationId: string;
  fixed: EntryRef;
  contributionHash: string;
  payloadHash: string;
  transferHash: string;
  seat: Seat;
}

export interface SignedStealReceipt {
  body: StealReceiptBody;
  sig: string;
}

export interface SignedStealDispute {
  body: {
    binding: StealReceiptBody;
    sharedPoint: string;
    proof: DleqProof;
  };
  sig: string;
}

const resourcePoints = v.strictObject({
  brick: key32Schema,
  lumber: key32Schema,
  wool: key32Schema,
  grain: key32Schema,
  ore: key32Schema,
});
const resourceCount = v.pipe(nonnegativeIntegerSchema, v.maxValue(MAX_HAND_RESOURCE_COUNT));
const resourceCounts = v.strictObject({
  brick: resourceCount,
  lumber: resourceCount,
  wool: resourceCount,
  grain: resourceCount,
  ore: resourceCount,
});
const entryRefSchema = v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema });
const participantSchema = v.strictObject({ seat: seatSchema, publicKey: key32Schema });
const operationSchema = v.strictObject({
  protocol: v.literal(STEAL_EVIDENCE_PROTOCOL),
  genesisDigest: key32Schema,
  epoch: nonnegativeIntegerSchema,
  anchor: entryRefSchema,
  beaconOperationId: hashSchema,
  thief: v.strictObject({
    seat: seatSchema,
    publicKey: key32Schema,
    encryptionKey: key32Schema,
  }),
  victim: participantSchema,
  handSize: v.pipe(
    nonnegativeIntegerSchema,
    v.minValue(1),
    v.maxValue(5 * MAX_HAND_RESOURCE_COUNT),
  ),
  index: nonnegativeIntegerSchema,
  commitments: resourcePoints,
});
const openingSchema = v.strictObject({
  type: v.picklist([0, 1, 2, 3, 4]),
  blindings: v.pipe(v.array(key32Schema), v.length(5)),
});
// Every resource uses one digit; every scalar uses 43 characters. Ciphertext length
// must not disclose the resource through variable-length names or encodings.
export const STEAL_OPENING_BYTES = canonicalEncode({
  type: 0,
  blindings: Array.from({ length: 5 }, () => encodeScalar(0n)),
}).length;
const sealedSchema = v.strictObject({
  ephemeral: key32Schema,
  ciphertext: v.pipe(
    v.string(),
    v.length(Math.ceil((STEAL_OPENING_BYTES * 4) / 3)),
    v.check((value) => {
      try {
        return fromBase64Url(value).length === STEAL_OPENING_BYTES;
      } catch {
        return false;
      }
    }),
  ),
});
export const signedStealContributionSchema = v.strictObject({
  body: v.strictObject({
    operationId: hashSchema,
    seat: seatSchema,
    transfer: v.pipe(v.array(key32Schema), v.length(5)),
    sealed: sealedSchema,
    proof: v.unknown(),
  }),
  sig: signature64Schema,
});
const receiptBodySchema = v.strictObject({
  operationId: hashSchema,
  fixed: entryRefSchema,
  contributionHash: hashSchema,
  payloadHash: hashSchema,
  transferHash: hashSchema,
  seat: seatSchema,
});
export const signedStealReceiptSchema = v.strictObject({
  body: receiptBodySchema,
  sig: signature64Schema,
});
export const signedStealDisputeSchema = v.strictObject({
  body: v.strictObject({
    binding: receiptBodySchema,
    sharedPoint: key32Schema,
    proof: v.strictObject({
      commitments: v.tuple([key32Schema, key32Schema]),
      response: key32Schema,
    }),
  }),
  sig: signature64Schema,
});

function checked<T>(result: Result<T>): T {
  if (!result.ok) throw new TypeError(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** Shape and point checks only. Certified history supplies operation authority. */
export function validateStealOperation(value: unknown): Result<StealOperation> {
  const parsed = parseCanonical(value, operationSchema);
  if (!parsed.ok) return parsed;
  const operation = parsed.value;
  if (
    operation.index >= operation.handSize ||
    operation.thief.seat === operation.victim.seat ||
    operation.thief.publicKey === operation.victim.publicKey
  )
    return failure('steal-operation', 'Steal requires distinct owners and an index in the hand');
  try {
    parsePeerId(operation.thief.publicKey);
    parsePeerId(operation.victim.publicKey);
    decodePoint(operation.thief.encryptionKey, { nonIdentity: true });
    for (const resource of RESOURCES) decodePoint(operation.commitments[resource]);
  } catch {
    return failure('steal-operation-key', 'Steal contains an invalid key or commitment');
  }
  return success(operation);
}

export function stealOperationId(operation: StealOperation): string {
  return toHex(
    hashValue({
      domain: 'cp2p/v1/steal-operation',
      operation: checked(validateStealOperation(operation)),
    }),
  );
}

function assertSigner(key: Uint8Array, publicKey: string): void {
  const identity = identityFromSecret(key);
  const matches = identity.peerId === publicKey;
  identity.secretKey.fill(0);
  if (!matches) throw new TypeError('Signing key does not match the frozen owner');
}

function sealContext(operation: StealOperation, transfer: readonly string[]) {
  return { protocol: 'steal-seal-v1', operationId: stealOperationId(operation), transfer };
}

function proofContext(operation: StealOperation) {
  return { protocol: 'steal-transfer-v1', operationId: stealOperationId(operation) };
}

function transferStatement(operation: StealOperation, body: SignedStealContribution['body']) {
  return {
    commitments: RESOURCES.map((resource) => operation.commitments[resource]),
    transfer: body.transfer,
    handSize: operation.handSize,
    index: operation.index,
    payloadHash: toHex(hashValue(body.sealed)),
  };
}

/** The private driver checks current ownership/head before calling this pure producer. */
export function createStealContribution(
  operation: StealOperation,
  counts: Readonly<Record<Resource, number>>,
  blindings: Readonly<Record<Resource, string>>,
  seed: Uint8Array,
  signingKey: Uint8Array,
): Result<SignedStealContribution> {
  try {
    const op = checked(validateStealOperation(operation));
    assertSigner(signingKey, op.victim.publicKey);
    const ownedCounts = checked(parseCanonical(counts, resourceCounts));
    const ownedBlindings = checked(parseCanonical(blindings, resourcePoints));
    const opening = verifyHandOpening(
      [{ seat: op.victim.seat, commitments: op.commitments }],
      [op.victim.seat],
      op.victim.seat,
      ownedCounts,
      ownedBlindings,
    );
    if (!opening.ok) return opening;
    const values = RESOURCES.map((resource) => ownedCounts[resource]);
    if (values.reduce((sum, count) => sum + count, 0) !== op.handSize)
      return failure('steal-hand-size', 'Private hand differs from the frozen public total');
    let prefix = 0;
    const type = values.findIndex((count) => {
      prefix += count;
      return op.index < prefix;
    });
    if (type < 0) return failure('steal-index', 'Frozen index has no private resource');
    const operationId = stealOperationId(op);
    const transferBlindings = RESOURCES.map((resource) =>
      deriveScalar(seed, DERIVATION_LABELS.transferBlind, { operationId, resource }),
    );
    const transfer = transferBlindings.map((blinding, index) =>
      pedersenCommit(index === type ? 1n : 0n, blinding),
    );
    const plaintext = canonicalEncode({ type, blindings: transferBlindings.map(encodeScalar) });
    let sealed: SealedPayload;
    try {
      sealed = seal(plaintext, op.thief.encryptionKey, seed, sealContext(op, transfer));
    } finally {
      plaintext.fill(0);
    }
    const partial = { operationId, seat: op.victim.seat, transfer, sealed, proof: null };
    const proof = proveHiddenTransfer(
      transferStatement(op, partial),
      {
        counts: values,
        blindings: RESOURCES.map((resource) => decodeScalar(ownedBlindings[resource])),
        transferBlindings,
      },
      seed,
      proofContext(op),
    );
    const body = { ...partial, proof };
    return parseCanonical(
      { body, sig: signObject('steal-contribution', body, signingKey) },
      signedStealContributionSchema,
    );
  } catch {
    return failure('steal-production', 'Could not produce the frozen hidden transfer');
  }
}

export function verifyStealContribution(
  value: unknown,
  operation: StealOperation,
): Result<SignedStealContribution> {
  try {
    const op = checked(validateStealOperation(operation));
    const signed = checked(parseCanonical(value, signedStealContributionSchema));
    if (signed.body.operationId !== stealOperationId(op) || signed.body.seat !== op.victim.seat)
      return failure('steal-contribution-operation', 'Contribution belongs to another steal');
    decodePoint(signed.body.sealed.ephemeral, { nonIdentity: true });
    if (
      !verifyObject('steal-contribution', signed.body, signed.sig, parsePeerId(op.victim.publicKey))
    )
      return failure('steal-contribution-signature', 'Victim signature is invalid');
    if (
      !verifyHiddenTransfer(transferStatement(op, signed.body), signed.body.proof, proofContext(op))
    )
      return failure('steal-transfer-proof', 'Hidden transfer does not prove the frozen index');
    return success(signed);
  } catch {
    return failure('steal-contribution', 'Hidden transfer contribution is malformed');
  }
}

function openingFromBytes(bytes: Uint8Array, transfer: readonly string[]): Result<StealOpening> {
  try {
    if (bytes.length !== STEAL_OPENING_BYTES)
      return failure('steal-opening-size', 'Sealed opening has an invalid length');
    const parsed = checked(parseCanonical(canonicalDecode(bytes), openingSchema));
    const resource = RESOURCES[parsed.type];
    if (!resource) return failure('steal-opening-type', 'Unknown resource index');
    const blindings: Record<Resource, string> = {
      brick: '',
      lumber: '',
      wool: '',
      grain: '',
      ore: '',
    };
    for (const [index, item] of RESOURCES.entries()) {
      const scalar = parsed.blindings[index];
      if (
        !scalar ||
        pedersenCommit(index === parsed.type ? 1n : 0n, decodeScalar(scalar)) !== transfer[index]
      )
        return failure(
          'steal-opening-mismatch',
          'Sealed opening does not match the fixed transfer',
        );
      blindings[item] = scalar;
    }
    return success({ resource, blindings });
  } catch {
    return failure('steal-opening', 'Sealed opening is malformed');
  } finally {
    bytes.fill(0);
  }
}

function openChecked(
  operation: StealOperation,
  contribution: SignedStealContribution,
  secret: bigint,
): Result<StealOpening> {
  if (encodePoint(scalePoint(G, secret)) !== operation.thief.encryptionKey)
    return failure('steal-recipient-key', 'Secret does not match the frozen encryption key');
  return openingFromBytes(
    openSealed(
      contribution.body.sealed,
      secret,
      sealContext(operation, contribution.body.transfer),
    ),
    contribution.body.transfer,
  );
}

export function openStealContribution(
  operation: StealOperation,
  value: unknown,
  recipientSecret: bigint,
): Result<StealOpening> {
  try {
    const op = checked(validateStealOperation(operation));
    const contribution = checked(verifyStealContribution(value, op));
    return openChecked(op, contribution, recipientSecret);
  } catch {
    return failure('steal-opening', 'Could not open the verified contribution');
  }
}

function parseFixed(value: FixedSteal): FixedSteal {
  const parsed = checked(
    parseCanonical(
      value,
      v.strictObject({
        operation: operationSchema,
        contribution: signedStealContributionSchema,
        entry: entryRefSchema,
      }),
    ),
  );
  const operation = checked(validateStealOperation(parsed.operation));
  if (parsed.entry.seq <= operation.anchor.seq)
    throw new TypeError('Fixed contribution must follow the certified beacon anchor');
  return { operation, contribution: parsed.contribution, entry: parsed.entry };
}

function checkedFixed(value: FixedSteal): FixedSteal {
  const fixed = parseFixed(value);
  const contribution = checked(verifyStealContribution(fixed.contribution, fixed.operation));
  return { ...fixed, contribution };
}

function receiptBody(fixed: FixedSteal): StealReceiptBody {
  return {
    operationId: stealOperationId(fixed.operation),
    fixed: fixed.entry,
    contributionHash: toHex(hashValue(fixed.contribution.body)),
    payloadHash: toHex(hashValue(fixed.contribution.body.sealed)),
    transferHash: toHex(hashValue(fixed.contribution.body.transfer)),
    seat: fixed.operation.thief.seat,
  };
}

/** Decrypts provisionally; the returned opening is not yet a committed hand change. */
export function createStealReceipt(
  fixed: FixedSteal,
  recipientSecret: bigint,
  signingKey: Uint8Array,
): Result<SignedStealReceipt> {
  try {
    const verified = checkedFixed(fixed);
    assertSigner(signingKey, verified.operation.thief.publicKey);
    const opening = openChecked(verified.operation, verified.contribution, recipientSecret);
    if (!opening.ok) return opening;
    const body = receiptBody(verified);
    return success({ body, sig: signObject('steal-receipt', body, signingKey) });
  } catch {
    return failure('steal-receipt-production', 'Could not acknowledge the fixed transfer');
  }
}

export function verifyStealReceipt(value: unknown, fixed: FixedSteal): Result<SignedStealReceipt> {
  try {
    const signed = checked(parseCanonical(value, signedStealReceiptSchema));
    const verified = parseFixed(fixed);
    if (toHex(hashValue(signed.body)) !== toHex(hashValue(receiptBody(verified))))
      return failure(
        'steal-receipt-binding',
        'Receipt does not acknowledge this fixed contribution',
      );
    if (
      !verifyObject(
        'steal-receipt',
        signed.body,
        signed.sig,
        parsePeerId(verified.operation.thief.publicKey),
      )
    )
      return failure('steal-receipt-signature', 'Recipient signature is invalid');
    // Only an authenticated matching recipient reaches the expensive public proof.
    const contribution = verifyStealContribution(verified.contribution, verified.operation);
    return contribution.ok ? success(signed) : contribution;
  } catch {
    return failure('steal-receipt', 'Receipt could not be verified');
  }
}

function disputeStatement(fixed: FixedSteal, sharedPoint: string) {
  return {
    base1: encodePoint(G),
    point1: fixed.operation.thief.encryptionKey,
    base2: fixed.contribution.body.sealed.ephemeral,
    point2: sharedPoint,
  };
}

function disputeContext(binding: StealReceiptBody) {
  return { protocol: 'steal-dispute-v1', binding };
}

function openDisputed(fixed: FixedSteal, sharedPoint: string): Result<StealOpening> {
  return openingFromBytes(
    openSealedWithSharedPoint(
      fixed.contribution.body.sealed,
      fixed.operation.thief.encryptionKey,
      sharedPoint,
      sealContext(fixed.operation, fixed.contribution.body.transfer),
    ),
    fixed.contribution.body.transfer,
  );
}

/** A complaint reveals the shared point. Only demonstrably bad delivery is evidence. */
export function createStealDispute(
  fixed: FixedSteal,
  recipientSecret: bigint,
  signingKey: Uint8Array,
  seed: Uint8Array,
): Result<SignedStealDispute> {
  try {
    const verified = checkedFixed(fixed);
    assertSigner(signingKey, verified.operation.thief.publicKey);
    if (encodePoint(scalePoint(G, recipientSecret)) !== verified.operation.thief.encryptionKey)
      return failure('steal-recipient-key', 'Secret does not match the frozen encryption key');
    const sharedPoint = encodePoint(
      scalePoint(decodePoint(verified.contribution.body.sealed.ephemeral), recipientSecret),
    );
    if (openDisputed(verified, sharedPoint).ok)
      return failure('steal-good-delivery', 'A valid opening is not evidence against the victim');
    const binding = receiptBody(verified);
    const proof = proveDleq(
      disputeStatement(verified, sharedPoint),
      recipientSecret,
      seed,
      disputeContext(binding),
    );
    const body = { binding, sharedPoint, proof };
    return success({ body, sig: signObject('steal-dispute', body, signingKey) });
  } catch {
    return failure('steal-dispute-production', 'Could not prove invalid sealed delivery');
  }
}

/**
 * Success authenticates bad delivery. Failure alone is never accusation evidence;
 * any false-complaint accusation must separately authenticate its signed context.
 */
export function verifyStealDispute(value: unknown, fixed: FixedSteal): Result<SignedStealDispute> {
  try {
    const signed = checked(parseCanonical(value, signedStealDisputeSchema));
    const verified = parseFixed(fixed);
    if (toHex(hashValue(signed.body.binding)) !== toHex(hashValue(receiptBody(verified))))
      return failure('steal-dispute-binding', 'Dispute belongs to another fixed contribution');
    if (
      !verifyObject(
        'steal-dispute',
        signed.body,
        signed.sig,
        parsePeerId(verified.operation.thief.publicKey),
      )
    )
      return failure('steal-dispute-signature', 'Dispute is not signed by the recipient');
    decodePoint(signed.body.sharedPoint, { nonIdentity: true });
    if (
      !verifyDleq(
        disputeStatement(verified, signed.body.sharedPoint),
        signed.body.proof,
        disputeContext(signed.body.binding),
      )
    )
      return failure('steal-dispute-proof', 'Disclosed shared point is not authenticated');
    const contribution = verifyStealContribution(verified.contribution, verified.operation);
    if (!contribution.ok) return contribution;
    return openDisputed(verified, signed.body.sharedPoint).ok
      ? failure('steal-good-delivery', 'The authenticated opening is valid')
      : success(signed);
  } catch {
    return failure('steal-dispute', 'Dispute could not be verified');
  }
}
