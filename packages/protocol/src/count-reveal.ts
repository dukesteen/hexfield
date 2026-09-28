import { hashValue, toHex } from '@cp2p/codec';
import {
  G,
  H,
  decodePoint,
  decodeScalar,
  encodePoint,
  identityFromSecret,
  parsePeerId,
  proveSchnorr,
  scalePoint,
  signObject,
  verifyObject,
  verifySchnorr,
} from '@cp2p/crypto';
import type { SchnorrProof } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat, SystemInput } from '@cp2p/engine';
import * as v from 'valibot';
import type { ArtifactSigner } from './authority-types.js';
import type { EntryRef } from './beacon-state.js';
import { isKindName } from './card-kinds.js';
import { MAX_HAND_RESOURCE_COUNT } from './hand-commitments.js';
import type { HandTransitionPlan } from './hand-transition.js';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import type { SystemEvidence } from './types.js';
import { parseCanonical } from './validation.js';

export const COUNT_EVIDENCE_PROTOCOL = 'monopoly-count-v1';

/** Frozen at the certified Monopoly command, not at each later reveal's parent. */
export interface CountOperation {
  protocol: typeof COUNT_EVIDENCE_PROTOCOL;
  genesisDigest: string;
  epoch: number;
  anchor: EntryRef;
  monopolist: Seat;
  resource: string;
  victims: readonly { seat: Seat; publicKey: string; commitment: string }[];
}

export interface CountState {
  operation: CountOperation;
  remaining: readonly Seat[];
}

export interface SignedCountContribution {
  body: { operationId: string; seat: Seat; count: number; proof: SchnorrProof };
  sig: string;
}

/** A card kind name; the frozen game supplies the kinds this may take. */
export const kindNameSchema = v.pipe(
  v.string(),
  v.check((value: string) => isKindName(value)),
);
const countSchema = v.pipe(nonnegativeIntegerSchema, v.maxValue(MAX_HAND_RESOURCE_COUNT));
export const countOperationSchema = v.strictObject({
  protocol: v.literal(COUNT_EVIDENCE_PROTOCOL),
  genesisDigest: key32Schema,
  epoch: nonnegativeIntegerSchema,
  anchor: v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema }),
  monopolist: seatSchema,
  resource: kindNameSchema,
  victims: v.pipe(
    v.array(v.strictObject({ seat: seatSchema, publicKey: key32Schema, commitment: key32Schema })),
    v.minLength(1),
    v.maxLength(5),
  ),
});
export const signedCountContributionSchema = v.strictObject({
  body: v.strictObject({
    operationId: hashSchema,
    seat: seatSchema,
    count: countSchema,
    proof: v.strictObject({ commitment: key32Schema, response: key32Schema }),
  }),
  sig: signature64Schema,
});
const countInputSchema = v.strictObject({
  kind: v.literal('system'),
  type: v.literal('REVEAL_COUNT'),
  seat: seatSchema,
  resource: kindNameSchema,
  count: countSchema,
});

/** Structural validation only. Operations must originate in certified engine state. */
export function validateCountOperation(value: unknown): Result<CountOperation> {
  const parsed = parseCanonical(value, countOperationSchema);
  if (!parsed.ok) return parsed;
  let previous = -1;
  const keys = new Set<string>();
  for (const victim of parsed.value.victims) {
    if (
      victim.seat <= previous ||
      victim.seat === parsed.value.monopolist ||
      keys.has(victim.publicKey)
    )
      return failure(
        'count-victims',
        'Count victims must be unique, ordered and exclude the actor',
      );
    previous = victim.seat;
    keys.add(victim.publicKey);
    try {
      parsePeerId(victim.publicKey);
      if (encodePoint(decodePoint(victim.commitment)) !== victim.commitment)
        return failure('count-commitment', 'Count commitment is not canonical');
    } catch {
      return failure('count-victim', 'Count victim has an invalid public key or commitment');
    }
  }
  return success(parsed.value);
}

function checkedOperation(operation: CountOperation): CountOperation {
  const checked = validateCountOperation(operation);
  if (!checked.ok) throw new TypeError(checked.error.message);
  return checked.value;
}

export function countOperationId(operation: CountOperation): string {
  return toHex(
    hashValue({
      domain: 'cp2p/v1/monopoly-count-operation',
      operation: checkedOperation(operation),
    }),
  );
}

/** Same statement and proof randomness across earlier victims and proposer controls. */
export function countProofContext(operation: CountOperation, seat: Seat, count: number): unknown {
  const checked = checkedOperation(operation);
  const victim = checked.victims.find((item) => item.seat === seat);
  if (!victim || !v.is(countSchema, count))
    throw new RangeError('Invalid count witness seat or count');
  return {
    protocol: 'monopoly-count-opening-v1',
    operationId: countOperationId(checked),
    seat,
    resource: checked.resource,
    commitment: victim.commitment,
    count,
  };
}

function statement(operation: CountOperation, seat: Seat, count: number) {
  const victim = operation.victims.find((item) => item.seat === seat);
  if (!victim) throw new RangeError('Seat is not a frozen count victim');
  return {
    base: encodePoint(H),
    publicPoint: encodePoint(decodePoint(victim.commitment).subtract(scalePoint(G, BigInt(count)))),
  };
}

/** The private driver authorizes ownership and checks the complete current hand first. */
export function proveCountOpening(
  operation: CountOperation,
  seat: Seat,
  count: number,
  blinding: string,
  seed: Uint8Array,
): Result<SchnorrProof> {
  try {
    const context = countProofContext(operation, seat, count);
    const witness = decodeScalar(blinding);
    const publicStatement = statement(operation, seat, count);
    if (encodePoint(scalePoint(H, witness)) !== publicStatement.publicPoint)
      return failure('count-witness', 'Owned count does not open the frozen commitment');
    return success(proveSchnorr(publicStatement, witness, seed, context));
  } catch {
    return failure('count-proof-production', 'Could not prove the frozen count opening');
  }
}

export function signCountContribution(
  operation: CountOperation,
  seat: Seat,
  count: number,
  proof: SchnorrProof,
  key: Uint8Array,
  signer?: ArtifactSigner,
): SignedCountContribution {
  const checked = checkedOperation(operation);
  const victim = checked.victims.find((item) => item.seat === seat);
  const identity = identityFromSecret(key);
  const matches =
    identity.peerId === (signer?.publicKey ?? victim?.publicKey) &&
    (signer === undefined || signer.seat === seat);
  identity.secretKey.fill(0);
  if (!matches) throw new RangeError('Count signing key does not belong to the frozen victim');
  const context = countProofContext(checked, seat, count);
  if (!verifySchnorr(statement(checked, seat, count), proof, context))
    throw new RangeError('Invalid count opening proof');
  const body = { operationId: countOperationId(checked), seat, count, proof };
  const signed = parseCanonical(
    { body, sig: signObject('monopoly-count', body, key) },
    signedCountContributionSchema,
  );
  if (!signed.ok) throw new TypeError(signed.error.message);
  return signed.value;
}

export function verifyCountContribution(
  value: unknown,
  operation: CountOperation,
  signer?: ArtifactSigner,
): Result<SignedCountContribution> {
  try {
    const checked = validateCountOperation(operation);
    if (!checked.ok) return checked;
    const parsed = parseCanonical(value, signedCountContributionSchema);
    if (!parsed.ok) return parsed;
    const signed = parsed.value;
    const victim = checked.value.victims.find((item) => item.seat === signed.body.seat);
    if (!victim || signed.body.operationId !== countOperationId(checked.value))
      return failure(
        'count-operation',
        'Count contribution belongs to another operation or victim',
      );
    if (signer && signer.seat !== victim.seat)
      return failure('count-signature', 'Count signer is not the frozen victim');
    if (
      !verifyObject(
        'monopoly-count',
        signed.body,
        signed.sig,
        parsePeerId(signer?.publicKey ?? victim.publicKey),
      )
    )
      return failure('count-signature', 'Count contribution signature is invalid');
    if (
      !verifySchnorr(
        statement(checked.value, signed.body.seat, signed.body.count),
        signed.body.proof,
        countProofContext(checked.value, signed.body.seat, signed.body.count),
      )
    )
      return failure('count-proof', 'Count contribution does not open the frozen commitment');
    return success(signed);
  } catch {
    return failure('count-contribution', 'Count contribution could not be verified');
  }
}

/** Mandatory owner authentication, before any optional generic system policy. */
export function verifyCountInput(
  current: CountState | null,
  input: SystemInput,
  evidence: SystemEvidence,
  signer?: ArtifactSigner,
): Result<SignedCountContribution> {
  const parsed = parseCanonical(input, countInputSchema);
  if (!parsed.ok) return parsed;
  if (
    !current ||
    !current.remaining.includes(parsed.value.seat) ||
    parsed.value.resource !== current.operation.resource ||
    evidence.kind !== 'proof' ||
    evidence.protocol !== COUNT_EVIDENCE_PROTOCOL
  )
    return failure('count-pending', 'Count input must answer a remaining frozen request');
  const signed = verifyCountContribution(evidence.data, current.operation, signer);
  if (!signed.ok) return signed;
  return signed.value.body.seat === parsed.value.seat &&
    signed.value.body.count === parsed.value.count
    ? signed
    : failure('count-input', 'Signed count differs from the proposed engine input');
}

/** Match authenticated evidence to the engine-derived obligation and exact movement. */
export function completeCountHandPlan(
  current: CountState,
  plan: HandTransitionPlan,
): Result<CountState | null> {
  const parsed = parseCanonical(plan.input, countInputSchema);
  if (!parsed.ok) return parsed;
  const { seat, resource, count } = parsed.value;
  const victim = current.operation.victims.find((item) => item.seat === seat);
  const obligation = plan.obligations[0];
  if (
    !victim ||
    !current.remaining.includes(seat) ||
    resource !== current.operation.resource ||
    plan.obligations.length !== 1 ||
    obligation?.kind !== 'count' ||
    obligation.seat !== seat ||
    obligation.resource !== resource ||
    obligation.count !== count ||
    obligation.commitment !== victim.commitment
  )
    return failure('count-obligation', 'Count proof does not cover the derived hand obligation');
  const expected = [
    { type: 'resource-count-revealed', seat, resource, count },
    ...(count === 0
      ? []
      : [
          {
            type: 'resource-transfer',
            from: { kind: 'seat', seat },
            to: { kind: 'seat', seat: current.operation.monopolist },
            resource,
            count,
          },
        ]),
  ];
  if (toHex(hashValue(plan.effects)) !== toHex(hashValue(expected)))
    return failure('count-effects', 'Count effects differ from the frozen Monopoly transfer');
  const remaining = current.remaining.filter((item) => item !== seat);
  return success(remaining.length === 0 ? null : { operation: current.operation, remaining });
}
