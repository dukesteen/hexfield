import {
  decodePoint,
  decodeScalar,
  encodePoint,
  encodeScalar,
  G,
  pedersenCommit,
  scalePoint,
} from '@cp2p/crypto';
import type { Result, Seat } from '@cp2p/engine';
import { failure, success } from '@cp2p/engine';
import * as v from 'valibot';
import { BASE_CARD_KINDS, kindRecordSchema, toKindMap } from './card-kinds.js';
import type { CardKinds, KindMap } from './card-kinds.js';
import { seatSchema } from './schema-values.js';
import { parseCanonical } from './validation.js';

export const MAX_HAND_RESOURCE_COUNT = 63;

// Memoize only successful canonical public encodings, never points or proof results.
// Identity remains a legal commitment. Untrusted traffic can retain at most 256 strings.
const VALIDATED_COMMITMENT_LIMIT = 256;
const validatedCommitments = new Set<string>();

export interface SeatHandCommitments {
  seat: Seat;
  commitments: KindMap<string>;
}

export type PublicHandCommitments = readonly SeatHandCommitments[];

export interface PublicResourceEffect {
  seat: Seat;
  resource: string;
  direction: 'credit' | 'debit';
  count: number;
}

const commitmentSchema = v.string();
const unknownSchema = v.unknown();
const handSchemas = new Map<
  string,
  v.GenericSchema<unknown, { seat: number; commitments: Record<string, string> }[]>
>();

function handSchemaFor(kinds: CardKinds) {
  const id = kinds.join(',');
  const known = handSchemas.get(id);
  if (known) return known;
  const schema = v.pipe(
    v.array(
      v.strictObject({
        seat: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5)),
        commitments: kindRecordSchema(kinds, commitmentSchema),
      }),
    ),
    v.maxLength(6),
  );
  handSchemas.set(id, schema);
  return schema;
}

function buildEffectSchema(kinds: CardKinds) {
  return v.strictObject({
    seat: seatSchema,
    resource: v.picklist(kinds),
    direction: v.picklist(['credit', 'debit']),
    count: v.number(),
  });
}
const effectSchemas = new Map<string, ReturnType<typeof buildEffectSchema>>();

function effectSchemaFor(kinds: CardKinds) {
  const id = kinds.join(',');
  const known = effectSchemas.get(id);
  if (known) return known;
  const schema = buildEffectSchema(kinds);
  effectSchemas.set(id, schema);
  return schema;
}

function checkedSeats(value: readonly Seat[]): Result<readonly Seat[]> {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 6 ||
    value.some(
      (seat, index) =>
        !Number.isInteger(seat) ||
        seat < 0 ||
        seat > 5 ||
        (index > 0 && seat <= (value[index - 1] ?? -1)),
    )
  )
    return failure('hand-seats', 'Expected unique seats in ascending canonical order');
  return success([...value]);
}

/** Initializes one identity commitment per resource for each expected seat. */
export function emptyHandCommitments(
  expectedSeats: readonly Seat[],
  kinds: CardKinds = BASE_CARD_KINDS,
): Result<PublicHandCommitments> {
  const seats = checkedSeats(expectedSeats);
  if (!seats.ok) return seats;
  return success(
    seats.value.map((seat) => ({
      seat,
      commitments: emptyCommitmentMap(kinds),
    })),
  );
}

/** Copies and validates exact seats/resources and canonical Ristretto commitments. */
export function validateHandCommitments(
  value: unknown,
  expectedSeats: readonly Seat[],
  kinds: CardKinds = BASE_CARD_KINDS,
): Result<PublicHandCommitments> {
  const seats = checkedSeats(expectedSeats);
  if (!seats.ok) return seats;
  const parsed = parseCanonical(value, handSchemaFor(kinds));
  if (!parsed.ok) return parsed;
  if (parsed.value.length !== seats.value.length)
    return failure('hand-seat-count', 'Hand commitments differ from the expected seat roster');
  const copied: SeatHandCommitments[] = [];
  for (let index = 0; index < seats.value.length; index++) {
    const row = parsed.value[index];
    const seat = seats.value[index];
    if (!row || row.seat !== seat)
      return failure('hand-seat-order', 'Hand commitments differ from the expected seat order');
    const commitments: Record<string, string> = {};
    for (const resource of kinds) {
      const commitment = row.commitments[resource];
      if (commitment === undefined) return failure('hand-commitment-kind', 'Commitment is missing');
      if (!validatedCommitments.has(commitment)) {
        try {
          if (encodePoint(decodePoint(commitment)) !== commitment)
            return failure('hand-commitment-point', 'Commitment point is not canonically encoded');
        } catch {
          return failure('hand-commitment-point', 'Commitment point is malformed');
        }
        validatedCommitments.add(commitment);
        if (validatedCommitments.size > VALIDATED_COMMITMENT_LIMIT) {
          const oldest = validatedCommitments.values().next().value;
          if (oldest !== undefined) validatedCommitments.delete(oldest);
        }
      }
      commitments[resource] = commitment;
    }
    const map = toKindMap(commitments);
    if (!map) return failure('hand-commitment-kind', 'Commitments must cover the base resources');
    copied.push({ seat, commitments: map });
  }
  return success(copied);
}

/**
 * Applies one public gross movement and returns a fresh commitment ledger.
 * This arithmetic does not authorize a debit or prove that funds are available.
 */
export function applyPublicResourceEffect(
  value: unknown,
  expectedSeats: readonly Seat[],
  effect: unknown,
  kinds: CardKinds = BASE_CARD_KINDS,
): Result<PublicHandCommitments> {
  const checked = validateHandCommitments(value, expectedSeats, kinds);
  if (!checked.ok) return checked;
  const parsedEffect = parseCanonical(effect, effectSchemaFor(kinds));
  if (!parsedEffect.ok) return parsedEffect;
  const movement = parsedEffect.value;
  if (
    !Number.isSafeInteger(movement.count) ||
    movement.count < 0 ||
    movement.count > MAX_HAND_RESOURCE_COUNT
  )
    return failure(
      'hand-resource-count-range',
      'Resource movement count is outside the six-bit proof bound',
    );
  const seatIndex = expectedSeats.indexOf(movement.seat);
  if (seatIndex < 0)
    return failure('hand-resource-seat', 'Resource movement targets an unknown seat');
  const row = checked.value[seatIndex];
  if (!row) return failure('hand-resource-seat', 'Resource movement seat is missing');
  try {
    const current = row.commitments[movement.resource];
    if (current === undefined) return failure('hand-resource-kind', 'Unknown hand resource kind');
    const point = decodePoint(current);
    const delta = scalePoint(G, BigInt(movement.count));
    const updated = movement.direction === 'credit' ? point.add(delta) : point.subtract(delta);
    return success(
      checked.value.map((seatRow, index) => ({
        seat: seatRow.seat,
        commitments:
          index === seatIndex
            ? { ...seatRow.commitments, [movement.resource]: encodePoint(updated) }
            : { ...seatRow.commitments },
      })),
    );
  } catch {
    return failure('hand-resource-update', 'Could not update resource commitment');
  }
}

/** Checks that one owner's counts and canonical blindings open their public commitments. */
export function verifyHandOpening(
  value: unknown,
  expectedSeats: readonly Seat[],
  seat: Seat,
  counts: unknown,
  blindings: unknown,
  kinds: CardKinds = BASE_CARD_KINDS,
): Result<void> {
  const checked = validateHandCommitments(value, expectedSeats, kinds);
  if (!checked.ok) return checked;
  const row = checked.value.find((item) => item.seat === seat);
  if (!row) return failure('hand-opening-seat', 'Opening seat is not in the expected roster');
  const parsedCounts = parseCanonical(counts, kindRecordSchema(kinds, unknownSchema));
  const parsedBlindings = parseCanonical(blindings, kindRecordSchema(kinds, unknownSchema));
  if (!parsedCounts.ok || !parsedBlindings.ok)
    return failure(
      'hand-opening-shape',
      'Opening counts and blindings must contain exactly the game card kinds',
    );
  for (const resource of kinds) {
    const count = parsedCounts.value[resource];
    const encodedBlinding = parsedBlindings.value[resource];
    if (
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0 ||
      count > MAX_HAND_RESOURCE_COUNT ||
      typeof encodedBlinding !== 'string'
    )
      return failure(
        'hand-opening-value',
        'Opening count or blinding is outside its canonical bound',
      );
    try {
      const blinding = decodeScalar(encodedBlinding);
      if (encodeScalar(blinding) !== encodedBlinding)
        return failure('hand-opening-scalar', 'Opening blinding is not canonically encoded');
      const commitment = row.commitments[resource];
      if (commitment !== pedersenCommit(BigInt(count), blinding))
        return failure(
          'hand-opening-mismatch',
          'Private opening does not match its public commitment',
        );
    } catch {
      return failure('hand-opening-scalar', 'Opening blinding is malformed');
    }
  }
  return success(undefined);
}

function emptyCommitmentMap(kinds: CardKinds): KindMap<string> {
  const identity = pedersenCommit(0n, 0n);
  const map = toKindMap(Object.fromEntries(kinds.map((kind) => [kind, identity])));
  if (!map) throw new RangeError('Card kinds must include the base resources');
  return map;
}
