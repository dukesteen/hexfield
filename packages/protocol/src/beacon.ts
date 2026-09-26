import { fromBase64Url, hashValue, sha256, toBase64Url, toHex, canonicalEncode } from '@cp2p/codec';
import {
  identityFromSecret,
  parsePeerId,
  signObject,
  verifyHashChainLink,
  verifyObject,
} from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Pending, Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import { parseCanonical } from './validation.js';

export interface BeaconParticipant {
  seat: Seat;
  publicKey: string;
  chainEpoch: number;
  /** Next link to reveal; `previous` is the certified link at index−1. */
  index: number;
  length: number;
  previous: string;
}

export interface BeaconOperation {
  genesisDigest: string;
  epoch: number;
  anchor: { seq: number; hash: string };
  round: number;
  pending: Extract<Pending, { kind: 'random' }>;
  participants: readonly BeaconParticipant[];
}

export interface SignedBeaconReveal {
  body: { operationId: string; seat: Seat; index: number; value: string };
  sig: string;
}

const label = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
const chainLength = v.pipe(positiveIntegerSchema, v.maxValue(65_536));
const participantSchema = v.strictObject({
  seat: seatSchema,
  publicKey: key32Schema,
  chainEpoch: nonnegativeIntegerSchema,
  index: chainLength,
  length: chainLength,
  previous: key32Schema,
});
const operationSchema = v.strictObject({
  genesisDigest: key32Schema,
  epoch: nonnegativeIntegerSchema,
  anchor: v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema }),
  round: positiveIntegerSchema,
  pending: v.strictObject({
    kind: v.literal('random'),
    request: v.objectWithRest({ type: label }, v.unknown()),
    systemType: label,
  }),
  participants: v.pipe(v.array(participantSchema), v.minLength(1), v.maxLength(6)),
});
const signedRevealSchema = v.strictObject({
  body: v.strictObject({
    operationId: hashSchema,
    seat: seatSchema,
    index: chainLength,
    value: key32Schema,
  }),
  sig: signature64Schema,
});

/** Shape validation only; the caller must freeze this operation from certified history. */
export function validateBeaconOperation(value: unknown): Result<BeaconOperation> {
  const parsed = parseCanonical(value, operationSchema);
  if (!parsed.ok) return parsed;
  const operation = parsed.value;
  let previousSeat = -1;
  const keys = new Set<string>();
  for (const participant of operation.participants) {
    if (participant.seat <= previousSeat || participant.index > participant.length)
      return failure('beacon-participants', 'Beacon participants or chain position are invalid');
    previousSeat = participant.seat;
    if (keys.has(participant.publicKey))
      return failure('beacon-participants', 'Beacon participant keys must be unique');
    keys.add(participant.publicKey);
    try {
      parsePeerId(participant.publicKey);
    } catch {
      return failure('beacon-key', 'Beacon participant key is invalid');
    }
  }
  return success(operation);
}

function checkedOperation(operation: BeaconOperation): BeaconOperation {
  const checked = validateBeaconOperation(operation);
  if (!checked.ok) throw new TypeError(`${checked.error.code}: ${checked.error.message}`);
  return checked.value;
}

/** Full operation identity, independent of the signer or a reveal message. */
export function beaconOperationId(operation: BeaconOperation): string {
  return toHex(
    hashValue({ domain: 'cp2p/v1/beacon-operation', operation: checkedOperation(operation) }),
  );
}

export function signBeaconReveal(
  operation: BeaconOperation,
  seat: Seat,
  value: Uint8Array,
  key: Uint8Array,
): SignedBeaconReveal {
  const checked = checkedOperation(operation);
  const participant = checked.participants.find((item) => item.seat === seat);
  if (!participant) throw new RangeError('Seat is not a frozen beacon participant');
  if (!(value instanceof Uint8Array) || value.length !== 32)
    throw new TypeError('Beacon reveal must be exactly 32 bytes');
  if (!verifyHashChainLink(fromBase64Url(participant.previous), value))
    throw new RangeError('Beacon reveal does not advance its frozen chain');
  const identity = identityFromSecret(key);
  const matches = identity.peerId === participant.publicKey;
  identity.secretKey.fill(0);
  if (!matches) throw new RangeError('Beacon key does not belong to the frozen seat');
  const body = {
    operationId: beaconOperationId(checked),
    seat,
    index: participant.index,
    value: toBase64Url(value),
  };
  return { body, sig: signObject('beacon-reveal', body, key) };
}

export function verifyBeaconReveal(
  value: unknown,
  operation: BeaconOperation,
): Result<SignedBeaconReveal> {
  const checked = validateBeaconOperation(operation);
  if (!checked.ok) return checked;
  const parsed = parseCanonical(value, signedRevealSchema);
  if (!parsed.ok) return parsed;
  const reveal = parsed.value;
  const participant = checked.value.participants.find((item) => item.seat === reveal.body.seat);
  if (!participant || reveal.body.index !== participant.index)
    return failure('beacon-seat', 'Beacon reveal is not for this participant and chain index');
  if (reveal.body.operationId !== beaconOperationId(checked.value))
    return failure('beacon-operation', 'Beacon reveal belongs to another operation');
  if (!verifyObject('beacon-reveal', reveal.body, reveal.sig, parsePeerId(participant.publicKey)))
    return failure('beacon-signature', 'Beacon reveal signature is invalid');
  if (!verifyHashChainLink(fromBase64Url(participant.previous), fromBase64Url(reveal.body.value)))
    return failure('beacon-link', 'Beacon reveal does not advance its frozen chain');
  return success(reveal);
}

function exactReveals(value: unknown, count: number): unknown[] | null {
  try {
    if (
      !Array.isArray(value) ||
      value.length !== count ||
      Reflect.ownKeys(value).length !== count + 1
    )
      return null;
    const copy: unknown[] = [];
    for (let index = 0; index < count; index += 1) {
      const item = Object.getOwnPropertyDescriptor(value, String(index));
      if (!item?.enumerable || !('value' in item)) return null;
      copy.push(item.value);
    }
    return copy;
  } catch {
    return null;
  }
}

/** Requires one signed reveal per frozen participant in seat order. */
export function completeBeacon(
  operation: BeaconOperation,
  reveals: unknown,
): Result<{ seed: string; reveals: readonly SignedBeaconReveal[] }> {
  const checked = validateBeaconOperation(operation);
  if (!checked.ok) return checked;
  const entries = exactReveals(reveals, checked.value.participants.length);
  if (!entries)
    return failure('beacon-incomplete', 'Beacon needs exactly one reveal per participant');
  const ordered: SignedBeaconReveal[] = [];
  for (const [index, participant] of checked.value.participants.entries()) {
    const verified = verifyBeaconReveal(entries[index], checked.value);
    if (!verified.ok) return verified;
    if (verified.value.body.seat !== participant.seat)
      return failure('beacon-order', 'Beacon reveals must be in frozen seat order');
    ordered.push(verified.value);
  }
  const values = ordered.map(({ body }) => ({ seat: body.seat, value: body.value }));
  const seed = toBase64Url(
    sha256(canonicalEncode(['cp2p/v1/beacon', checked.value, checked.value.round, values])),
  );
  return success({ seed, reveals: ordered });
}
