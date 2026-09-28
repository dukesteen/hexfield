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
  sealWithEphemeralProof,
  signObject,
  verifyDleq,
  verifyObject,
  verifySealedEphemeralProof,
} from '@cp2p/crypto';
import type { DleqProof, SchnorrProof, SealedPayload } from '@cp2p/crypto';
import { RESOURCES, failure, kindsOfCounts, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { MAX_CARD_KINDS, isKindName, kindRecordSchema } from './card-kinds.js';
import type { CardKinds } from './card-kinds.js';
import type { EntryRef } from './beacon-state.js';
import type { ArtifactSigner } from './authority-types.js';
import { MAX_HAND_RESOURCE_COUNT, verifyHandOpening } from './hand-commitments.js';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import { parseCanonical } from './validation.js';
import { verifyStealTransfer } from './steal-proof-cache.js';

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
  /** The victim's parent commitments, one per card kind of the game (base kinds first). */
  commitments: Readonly<Record<string, string>>;
}

export interface SignedStealContribution {
  body: {
    operationId: string;
    seat: Seat;
    transfer: readonly string[];
    sealed: SealedPayload;
    ephemeralProof: SchnorrProof;
    proof: unknown;
  };
  sig: string;
}

/** The caller obtains entry from the certified STEAL_FIXED entry, never a peer claim. */
export interface FixedSteal {
  operation: StealOperation;
  contribution: SignedStealContribution;
  entry: EntryRef;
  /** Signer resolved at this certified fixed entry's parent, not at receipt time. */
  signer?: ArtifactSigner;
}

export interface StealOpening {
  resource: string;
  blindings: Readonly<Record<string, string>>;
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

const resourcePoint = key32Schema;
const resourceCount = v.pipe(nonnegativeIntegerSchema, v.maxValue(MAX_HAND_RESOURCE_COUNT));
/** The commitments of a valid steal name every base resource plus at most three module kinds. */
const operationCommitments = v.pipe(
  v.record(v.string(), key32Schema),
  v.check((record) => {
    const keys = Object.keys(record);
    return (
      keys.length >= RESOURCES.length &&
      keys.length <= MAX_CARD_KINDS &&
      RESOURCES.every((resource) => Object.hasOwn(record, resource)) &&
      keys.every(isKindName)
    );
  }),
);
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
    v.maxValue(MAX_CARD_KINDS * MAX_HAND_RESOURCE_COUNT),
  ),
  index: nonnegativeIntegerSchema,
  commitments: operationCommitments,
});
const openingSchemaCache = new Map<number, v.GenericSchema<unknown, StealOpeningPayload>>();
interface StealOpeningPayload {
  type: number;
  blindings: string[];
}

/** One digit for the kind index and one 43-character scalar per kind, whatever the kind. */
export function stealOpeningBytes(kindCount: number): number {
  return canonicalEncode({
    type: 0,
    blindings: Array.from({ length: kindCount }, () => encodeScalar(0n)),
  }).length;
}

function openingSchemaFor(kindCount: number): v.GenericSchema<unknown, StealOpeningPayload> {
  const known = openingSchemaCache.get(kindCount);
  if (known) return known;
  const schema = v.strictObject({
    type: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(kindCount - 1)),
    blindings: v.pipe(v.array(key32Schema), v.length(kindCount)),
  });
  openingSchemaCache.set(kindCount, schema);
  return schema;
}

// Every kind uses one digit; every scalar uses 43 characters. Ciphertext length
// must not disclose the kind through variable-length names or encodings. It depends only
// on the public number of card kinds of the game (five for base games).
export const STEAL_OPENING_BYTES = stealOpeningBytes(RESOURCES.length);
const OPENING_LENGTHS = new Set(
  Array.from({ length: MAX_CARD_KINDS - RESOURCES.length + 1 }, (_, extra) =>
    stealOpeningBytes(RESOURCES.length + extra),
  ),
);
const sealedSchema = v.strictObject({
  ephemeral: key32Schema,
  ciphertext: v.pipe(
    v.string(),
    v.maxLength(Math.ceil((stealOpeningBytes(MAX_CARD_KINDS) * 4) / 3)),
    v.check((value) => {
      try {
        return OPENING_LENGTHS.has(fromBase64Url(value).length);
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
    transfer: v.pipe(
      v.array(key32Schema),
      v.minLength(RESOURCES.length),
      v.maxLength(MAX_CARD_KINDS),
    ),
    sealed: sealedSchema,
    ephemeralProof: v.strictObject({ commitment: key32Schema, response: key32Schema }),
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
    for (const commitment of Object.values(operation.commitments)) decodePoint(commitment);
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

/** The card kinds a steal covers, read from the frozen victim commitments (canonical order). */
function operationKinds(operation: StealOperation): CardKinds {
  return kindsOfCounts(operation.commitments);
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

function ephemeralContext(operation: StealOperation, transfer: readonly string[]) {
  return { protocol: 'steal-ephemeral-v1', operationId: stealOperationId(operation), transfer };
}

function commitmentOf(operation: StealOperation, resource: string): string {
  const commitment = operation.commitments[resource];
  if (commitment === undefined) throw new TypeError('Steal operation lacks a commitment');
  return commitment;
}

function transferStatement(operation: StealOperation, body: SignedStealContribution['body']) {
  return {
    commitments: operationKinds(operation).map((resource) => commitmentOf(operation, resource)),
    transfer: body.transfer,
    handSize: operation.handSize,
    index: operation.index,
    payloadHash: toHex(hashValue(body.sealed)),
  };
}

/** The private driver checks current ownership/head before calling this pure producer. */
export function createStealContribution(
  operation: StealOperation,
  counts: Readonly<Record<string, number>>,
  blindings: Readonly<Record<string, string>>,
  seed: Uint8Array,
  signingKey: Uint8Array,
  signer?: ArtifactSigner,
): Result<SignedStealContribution> {
  try {
    const op = checked(validateStealOperation(operation));
    if (signer && signer.seat !== op.victim.seat)
      return failure('steal-contribution-signer', 'Controller is not the frozen victim');
    assertSigner(signingKey, signer?.publicKey ?? op.victim.publicKey);
    const kinds = operationKinds(op);
    const ownedCounts = checked(parseCanonical(counts, kindRecordSchema(kinds, resourceCount)));
    const ownedBlindings = checked(
      parseCanonical(blindings, kindRecordSchema(kinds, resourcePoint)),
    );
    const opening = verifyHandOpening(
      [{ seat: op.victim.seat, commitments: op.commitments }],
      [op.victim.seat],
      op.victim.seat,
      ownedCounts,
      ownedBlindings,
      kinds,
    );
    if (!opening.ok) return opening;
    const values = kinds.map((resource) => ownedCounts[resource] ?? 0);
    if (values.reduce((sum, count) => sum + count, 0) !== op.handSize)
      return failure('steal-hand-size', 'Private hand differs from the frozen public total');
    let prefix = 0;
    const type = values.findIndex((count) => {
      prefix += count;
      return op.index < prefix;
    });
    if (type < 0) return failure('steal-index', 'Frozen index has no private resource');
    const operationId = stealOperationId(op);
    const transferBlindings = kinds.map((resource) =>
      deriveScalar(seed, DERIVATION_LABELS.transferBlind, { operationId, resource }),
    );
    const transfer = transferBlindings.map((blinding, index) =>
      pedersenCommit(index === type ? 1n : 0n, blinding),
    );
    const plaintext = canonicalEncode({ type, blindings: transferBlindings.map(encodeScalar) });
    let sealed: SealedPayload;
    let ephemeralProof: SchnorrProof;
    try {
      ({ sealed, ephemeralProof } = sealWithEphemeralProof(
        plaintext,
        op.thief.encryptionKey,
        seed,
        sealContext(op, transfer),
        ephemeralContext(op, transfer),
      ));
    } finally {
      plaintext.fill(0);
    }
    const partial = {
      operationId,
      seat: op.victim.seat,
      transfer,
      sealed,
      ephemeralProof,
      proof: null,
    };
    const proof = proveHiddenTransfer(
      transferStatement(op, partial),
      {
        counts: values,
        blindings: kinds.map((resource) => decodeScalar(ownedBlindings[resource] ?? '')),
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

/** Rebuilds the victim's fixed transfer opening from its owned parent hand. */
export function recoverStealTransferOpening(
  operation: StealOperation,
  contribution: SignedStealContribution,
  counts: Readonly<Record<string, number>>,
  blindings: Readonly<Record<string, string>>,
  seed: Uint8Array,
): Result<StealOpening> {
  try {
    const op = checked(validateStealOperation(operation));
    const checkedContribution = checked(verifyStealContribution(contribution, op));
    const opened = verifyHandOpening(
      [{ seat: op.victim.seat, commitments: op.commitments }],
      [op.victim.seat],
      op.victim.seat,
      counts,
      blindings,
      operationKinds(op),
    );
    if (!opened.ok) return opened;
    const kinds = operationKinds(op);
    const values = kinds.map((resource) => counts[resource] ?? 0);
    if (values.reduce((sum, count) => sum + count, 0) !== op.handSize)
      return failure('steal-hand-size', 'Private hand differs from the frozen public total');
    let prefix = 0;
    const type = values.findIndex((count) => {
      prefix += count;
      return op.index < prefix;
    });
    if (type < 0) return failure('steal-index', 'Frozen index has no private resource');
    const operationId = stealOperationId(op);
    const transferBlindings = kinds.map((resource) =>
      deriveScalar(seed, DERIVATION_LABELS.transferBlind, { operationId, resource }),
    );
    for (const [index, blinding] of transferBlindings.entries())
      if (
        pedersenCommit(index === type ? 1n : 0n, blinding) !==
        checkedContribution.body.transfer[index]
      )
        return failure('steal-transfer-opening', 'Fixed transfer differs from owned derivation');
    const resource = kinds[type];
    if (!resource) throw new Error('Incomplete fixed transfer');
    return success({
      resource,
      blindings: Object.fromEntries(
        kinds.map((kind, index) => [kind, encodeScalar(transferBlindings[index] ?? 0n)]),
      ),
    });
  } catch {
    return failure('steal-transfer-opening', 'Could not recover the fixed owned transfer');
  }
}

export function verifyStealContribution(
  value: unknown,
  operation: StealOperation,
  signer?: ArtifactSigner,
): Result<SignedStealContribution> {
  try {
    const op = checked(validateStealOperation(operation));
    const signed = checked(parseCanonical(value, signedStealContributionSchema));
    if (signed.body.operationId !== stealOperationId(op) || signed.body.seat !== op.victim.seat)
      return failure('steal-contribution-operation', 'Contribution belongs to another steal');
    decodePoint(signed.body.sealed.ephemeral, { nonIdentity: true });
    const kinds = operationKinds(op);
    if (
      signed.body.transfer.length !== kinds.length ||
      fromBase64Url(signed.body.sealed.ciphertext).length !== stealOpeningBytes(kinds.length)
    )
      return failure('steal-contribution-shape', 'Contribution does not cover the game card kinds');
    if (
      (signer !== undefined && signer.seat !== op.victim.seat) ||
      !verifyObject(
        'steal-contribution',
        signed.body,
        signed.sig,
        parsePeerId(signer?.publicKey ?? op.victim.publicKey),
      )
    )
      return failure('steal-contribution-signature', 'Victim signature is invalid');
    if (
      !verifySealedEphemeralProof(
        signed.body.sealed,
        op.thief.encryptionKey,
        signed.body.ephemeralProof,
        sealContext(op, signed.body.transfer),
        ephemeralContext(op, signed.body.transfer),
      )
    )
      return failure(
        'steal-ephemeral-proof',
        'Victim does not prove ownership of the sealed ephemeral',
      );
    if (
      !verifyStealTransfer(transferStatement(op, signed.body), signed.body.proof, proofContext(op))
    )
      return failure('steal-transfer-proof', 'Hidden transfer does not prove the frozen index');
    return success(signed);
  } catch {
    return failure('steal-contribution', 'Hidden transfer contribution is malformed');
  }
}

function openingFromBytes(
  bytes: Uint8Array,
  transfer: readonly string[],
  kinds: CardKinds,
): Result<StealOpening> {
  try {
    if (bytes.length !== stealOpeningBytes(kinds.length) || transfer.length !== kinds.length)
      return failure('steal-opening-size', 'Sealed opening has an invalid length');
    const parsed = checked(parseCanonical(canonicalDecode(bytes), openingSchemaFor(kinds.length)));
    const resource = kinds[parsed.type];
    if (!resource) return failure('steal-opening-type', 'Unknown resource index');
    const blindings: Record<string, string> = {};
    for (const [index, item] of kinds.entries()) {
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
    operationKinds(operation),
  );
}

export function openStealContribution(
  operation: StealOperation,
  value: unknown,
  recipientSecret: bigint,
  signer?: ArtifactSigner,
): Result<StealOpening> {
  try {
    const op = checked(validateStealOperation(operation));
    const contribution = checked(verifyStealContribution(value, op, signer));
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
        signer: v.optional(
          v.strictObject({
            seat: seatSchema,
            publicKey: key32Schema,
            generation: entryRefSchema,
          }),
        ),
      }),
    ),
  );
  const operation = checked(validateStealOperation(parsed.operation));
  if (parsed.entry.seq <= operation.anchor.seq)
    throw new TypeError('Fixed contribution must follow the certified beacon anchor');
  return {
    operation,
    contribution: parsed.contribution,
    entry: parsed.entry,
    ...(parsed.signer === undefined ? {} : { signer: parsed.signer }),
  };
}

function checkedFixed(value: FixedSteal): FixedSteal {
  const fixed = parseFixed(value);
  const contribution = checked(
    verifyStealContribution(fixed.contribution, fixed.operation, fixed.signer),
  );
  return { ...fixed, contribution };
}

export function stealReceiptBinding(fixed: FixedSteal): StealReceiptBody {
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
  signer?: ArtifactSigner,
): Result<SignedStealReceipt> {
  try {
    const verified = checkedFixed(fixed);
    if (signer && signer.seat !== verified.operation.thief.seat)
      return failure('steal-receipt-signer', 'Controller is not the frozen recipient');
    assertSigner(signingKey, signer?.publicKey ?? verified.operation.thief.publicKey);
    const opening = openChecked(verified.operation, verified.contribution, recipientSecret);
    if (!opening.ok) return opening;
    const body = stealReceiptBinding(verified);
    return success({ body, sig: signObject('steal-receipt', body, signingKey) });
  } catch {
    return failure('steal-receipt-production', 'Could not acknowledge the fixed transfer');
  }
}

export function verifyStealReceipt(
  value: unknown,
  fixed: FixedSteal,
  signer?: ArtifactSigner,
): Result<SignedStealReceipt> {
  try {
    const signed = checked(parseCanonical(value, signedStealReceiptSchema));
    const verified = parseFixed(fixed);
    if (toHex(hashValue(signed.body)) !== toHex(hashValue(stealReceiptBinding(verified))))
      return failure(
        'steal-receipt-binding',
        'Receipt does not acknowledge this fixed contribution',
      );
    if (
      !verifyObject(
        'steal-receipt',
        signed.body,
        signed.sig,
        parsePeerId(signer?.publicKey ?? verified.operation.thief.publicKey),
      )
    )
      return failure('steal-receipt-signature', 'Recipient signature is invalid');
    // Only an authenticated matching recipient reaches the expensive public proof.
    if (signer && signer.seat !== verified.operation.thief.seat)
      return failure('steal-receipt-signer', 'Controller is not the frozen recipient');
    const contribution = verifyStealContribution(
      verified.contribution,
      verified.operation,
      verified.signer,
    );
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
    operationKinds(fixed.operation),
  );
}

/** A complaint reveals the shared point. Only demonstrably bad delivery is evidence. */
export function createStealDispute(
  fixed: FixedSteal,
  recipientSecret: bigint,
  signingKey: Uint8Array,
  seed: Uint8Array,
  signer?: ArtifactSigner,
): Result<SignedStealDispute> {
  try {
    const verified = checkedFixed(fixed);
    if (signer && signer.seat !== verified.operation.thief.seat)
      return failure('steal-dispute-signer', 'Controller is not the frozen recipient');
    assertSigner(signingKey, signer?.publicKey ?? verified.operation.thief.publicKey);
    if (encodePoint(scalePoint(G, recipientSecret)) !== verified.operation.thief.encryptionKey)
      return failure('steal-recipient-key', 'Secret does not match the frozen encryption key');
    const sharedPoint = encodePoint(
      scalePoint(decodePoint(verified.contribution.body.sealed.ephemeral), recipientSecret),
    );
    if (openDisputed(verified, sharedPoint).ok)
      return failure('steal-good-delivery', 'A valid opening is not evidence against the victim');
    const binding = stealReceiptBinding(verified);
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
export function verifyStealDispute(
  value: unknown,
  fixed: FixedSteal,
  signer?: ArtifactSigner,
): Result<SignedStealDispute> {
  try {
    const signed = checked(parseCanonical(value, signedStealDisputeSchema));
    const verified = parseFixed(fixed);
    if (toHex(hashValue(signed.body.binding)) !== toHex(hashValue(stealReceiptBinding(verified))))
      return failure('steal-dispute-binding', 'Dispute belongs to another fixed contribution');
    if (
      !verifyObject(
        'steal-dispute',
        signed.body,
        signed.sig,
        parsePeerId(signer?.publicKey ?? verified.operation.thief.publicKey),
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
    // A signed, DLEQ-authenticated good opening already disproves the complaint.
    if (openDisputed(verified, signed.body.sharedPoint).ok)
      return failure('steal-good-delivery', 'The authenticated opening is valid');
    if (signer && signer.seat !== verified.operation.thief.seat)
      return failure('steal-dispute-signer', 'Controller is not the frozen recipient');
    const contribution = verifyStealContribution(
      verified.contribution,
      verified.operation,
      verified.signer,
    );
    return contribution.ok ? success(signed) : contribution;
  } catch {
    return failure('steal-dispute', 'Dispute could not be verified');
  }
}
