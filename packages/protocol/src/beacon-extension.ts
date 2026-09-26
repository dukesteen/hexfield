import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { identityFromSecret, parsePeerId, signObject, verifyObject } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import type { BeaconOperation } from './beacon.js';
import { validateBeaconOperation } from './beacon.js';
import {
  hashSchema,
  key32Schema,
  positiveIntegerSchema,
  seatSchema,
  signature64Schema,
} from './schema-values.js';
import { parseCanonical } from './validation.js';

/** The same frozen random request and participants, at their exhausted chain tips. */
export type BeaconExtensionOperation = BeaconOperation;

export interface SignedBeaconExtension {
  body: {
    operationId: string;
    seat: Seat;
    chainEpoch: number;
    length: number;
    tip: string;
  };
  sig: string;
}

export interface BeaconChainCommitment {
  seat: Seat;
  publicKey: string;
  chainEpoch: number;
  length: number;
  tip: string;
}

const chainLength = v.pipe(positiveIntegerSchema, v.maxValue(65_536));
const signedExtensionSchema = v.strictObject({
  body: v.strictObject({
    operationId: hashSchema,
    seat: seatSchema,
    chainEpoch: positiveIntegerSchema,
    length: chainLength,
    tip: key32Schema,
  }),
  sig: signature64Schema,
});

/** Shape validation only; the caller supplies an operation frozen from certified history. */
export function validateBeaconExtensionOperation(value: unknown): Result<BeaconExtensionOperation> {
  const checked = validateBeaconOperation(value);
  if (!checked.ok) return checked;
  for (const participant of checked.value.participants) {
    if (participant.index !== participant.length)
      return failure(
        'beacon-extension-position',
        'Every frozen participant chain must be exhausted',
      );
    if (participant.chainEpoch === Number.MAX_SAFE_INTEGER)
      return failure('beacon-extension-epoch', 'Beacon chain epoch cannot be extended');
  }
  return checked;
}

function checkedOperation(operation: BeaconExtensionOperation): BeaconExtensionOperation {
  const checked = validateBeaconExtensionOperation(operation);
  if (!checked.ok) throw new TypeError(`${checked.error.code}: ${checked.error.message}`);
  return checked.value;
}

export function beaconExtensionOperationId(operation: BeaconExtensionOperation): string {
  return toHex(
    hashValue({ domain: 'cp2p/v1/beacon-extension', operation: checkedOperation(operation) }),
  );
}

export function signBeaconExtension(
  operation: BeaconExtensionOperation,
  seat: Seat,
  length: number,
  tip: Uint8Array,
  key: Uint8Array,
): SignedBeaconExtension {
  const checked = checkedOperation(operation);
  const participant = checked.participants.find((item) => item.seat === seat);
  if (!participant) throw new RangeError('Seat is not a frozen beacon participant');
  if (!Number.isSafeInteger(length) || length < 1 || length > 65_536)
    throw new RangeError('Beacon extension length is out of bounds');
  if (!(tip instanceof Uint8Array) || tip.length !== 32)
    throw new TypeError('Beacon extension tip must be exactly 32 bytes');
  const encodedTip = toBase64Url(tip);
  if (encodedTip === participant.previous)
    throw new RangeError('Beacon extension must commit a new tip');
  const identity = identityFromSecret(key);
  const matches = identity.peerId === participant.publicKey;
  identity.secretKey.fill(0);
  if (!matches) throw new RangeError('Beacon key does not belong to the frozen seat');
  const body = {
    operationId: beaconExtensionOperationId(checked),
    seat,
    chainEpoch: participant.chainEpoch + 1,
    length,
    tip: encodedTip,
  };
  return { body, sig: signObject('beacon-extension', body, key) };
}

export function verifyBeaconExtension(
  value: unknown,
  operation: BeaconExtensionOperation,
): Result<SignedBeaconExtension> {
  const checked = validateBeaconExtensionOperation(operation);
  if (!checked.ok) return checked;
  const parsed = parseCanonical(value, signedExtensionSchema);
  if (!parsed.ok) return parsed;
  const extension = parsed.value;
  const participant = checked.value.participants.find((item) => item.seat === extension.body.seat);
  if (!participant || extension.body.chainEpoch !== participant.chainEpoch + 1)
    return failure(
      'beacon-extension-seat',
      'Beacon extension is not for this participant and next chain epoch',
    );
  if (extension.body.operationId !== beaconExtensionOperationId(checked.value))
    return failure('beacon-extension-operation', 'Beacon extension belongs to another operation');
  if (extension.body.tip === participant.previous)
    return failure('beacon-extension-tip', 'Beacon extension must commit a new tip');
  if (
    !verifyObject(
      'beacon-extension',
      extension.body,
      extension.sig,
      parsePeerId(participant.publicKey),
    )
  )
    return failure('beacon-extension-signature', 'Beacon extension signature is invalid');
  return success(extension);
}

function exactExtensions(value: unknown, count: number): unknown[] | null {
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

/** Requires one next-chain commitment per exhausted participant, in frozen seat order. */
export function completeBeaconExtension(
  operation: BeaconExtensionOperation,
  extensions: unknown,
): Result<{
  commitments: readonly BeaconChainCommitment[];
  extensions: readonly SignedBeaconExtension[];
}> {
  const checked = validateBeaconExtensionOperation(operation);
  if (!checked.ok) return checked;
  const entries = exactExtensions(extensions, checked.value.participants.length);
  if (!entries)
    return failure('beacon-extension-incomplete', 'Beacon needs one extension per participant');
  const ordered: SignedBeaconExtension[] = [];
  const commitments: BeaconChainCommitment[] = [];
  for (const [index, participant] of checked.value.participants.entries()) {
    const verified = verifyBeaconExtension(entries[index], checked.value);
    if (!verified.ok) return verified;
    if (verified.value.body.seat !== participant.seat)
      return failure('beacon-extension-order', 'Beacon extensions must be in frozen seat order');
    ordered.push(verified.value);
    commitments.push({
      seat: participant.seat,
      publicKey: participant.publicKey,
      chainEpoch: verified.value.body.chainEpoch,
      length: verified.value.body.length,
      tip: verified.value.body.tip,
    });
  }
  return success({ commitments, extensions: ordered });
}
