import { G, encodePoint, decodePoint, proveRange, scalePoint, verifyRange } from '@cp2p/crypto';
import type { RangeProof } from '@cp2p/crypto';
import { RESOURCES, failure, kindBounds, success } from '@cp2p/engine';
import type { GameState, Input, Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import type { DeckRevealContext } from './deck-draw.js';
import type { PublicHandCommitments } from './hand-commitments.js';
import { key32Schema, seatSchema } from './schema-values.js';
import { parseCanonical } from './validation.js';

/**
 * A debit that one seat's signature will not cover: a Commercial Harbor's offered card leaves the
 * player's hand when the other seat answers. The player proves at the offer that its committed
 * count is at least the offered count; that stays true while the commitment does not change, so
 * the answer's plan needs no proof from the player for exactly that debit.
 */
export interface DebitPreproof {
  seat: Seat;
  resource: string;
  count: number;
  /** The seat's commitment for `resource` when the proof was made. */
  commitment: string;
}

const bitProofSchema = v.strictObject({
  challenges: v.tuple([key32Schema, key32Schema]),
  responses: v.tuple([key32Schema, key32Schema]),
});
export const preproofEvidenceSchema = v.strictObject({
  kind: v.literal('debit-preproof'),
  proof: v.strictObject({
    commitments: v.pipe(v.array(key32Schema), v.length(6)),
    proofs: v.pipe(v.array(bitProofSchema), v.length(6)),
  }),
});
export const debitPreproofSchema = v.strictObject({
  seat: seatSchema,
  resource: v.pipe(v.string(), v.minLength(1), v.maxLength(16)),
  count: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(63)),
  commitment: key32Schema,
});

export interface PreproofNeed {
  seat: Seat;
  resource: string;
  count: number;
}

/** The debit an input announces that public bounds cannot establish, if any. */
export function preproofNeed(before: GameState, input: Input): PreproofNeed | null {
  if (input.kind !== 'command' || input.command.type !== 'HARBOR_OFFER') return null;
  const resource = input.command.resource;
  if (typeof resource !== 'string' || !RESOURCES.some((kind) => kind === resource)) return null;
  const holder = before.seats.find((seat) => seat.seat === input.seat);
  if (!holder) return null;
  return (kindBounds(holder.resources).min[resource] ?? 0) >= 1
    ? null
    : { seat: input.seat, resource, count: 1 };
}

function statement(commitment: string, count: number) {
  return {
    commitment: encodePoint(decodePoint(commitment).subtract(scalePoint(G, BigInt(count)))),
    bits: 6,
  };
}

function proofContext(need: PreproofNeed, commitment: string, action: DeckRevealContext) {
  return { domain: 'cp2p/v1/debit-preproof', need, commitment, action };
}

/** The owner proves `held - count` is a 6-bit value, so it holds at least `count`. */
export function proveDebitPreproof(
  need: PreproofNeed,
  commitment: string,
  held: number,
  blinding: bigint,
  seed: Uint8Array,
  action: DeckRevealContext,
): unknown {
  if (held < need.count) throw new RangeError('The owned hand does not hold the offered card');
  return {
    kind: 'debit-preproof',
    proof: proveRange(
      statement(commitment, need.count),
      BigInt(held - need.count),
      blinding,
      seed,
      proofContext(need, commitment, action),
    ),
  };
}

export function verifyDebitPreproof(
  need: PreproofNeed,
  commitment: string,
  evidence: unknown,
  action: DeckRevealContext,
): Result<DebitPreproof> {
  const parsed = parseCanonical(evidence, preproofEvidenceSchema);
  if (!parsed.ok) return parsed;
  const proof: RangeProof = parsed.value.proof;
  return verifyRange(
    statement(commitment, need.count),
    proof,
    proofContext(need, commitment, action),
  )
    ? success({ ...need, commitment })
    : failure('preproof-invalid', 'The offered card is not proven to be held');
}

/** Drop every proof whose commitment is no longer the seat's current one. */
export function prunePreproofs(
  hands: PublicHandCommitments,
  list: readonly DebitPreproof[] | undefined,
): DebitPreproof[] {
  return (list ?? []).filter(
    (item) =>
      hands.find((row) => row.seat === item.seat)?.commitments[item.resource] === item.commitment,
  );
}

/** Whether a stored proof already establishes a debit of `count` from this commitment. */
export function coversDebit(
  list: readonly DebitPreproof[] | undefined,
  seat: Seat,
  resource: string,
  count: number,
  commitment: string,
): boolean {
  return (list ?? []).some(
    (item) =>
      item.seat === seat &&
      item.resource === resource &&
      item.commitment === commitment &&
      item.count >= count,
  );
}
