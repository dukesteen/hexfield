import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import {
  G,
  H,
  decodePoint,
  decodeScalar,
  encodePoint,
  proveRange,
  proveSchnorr,
  scalePoint,
  verifyRange,
  verifySchnorr,
} from '@cp2p/crypto';
import type { RangeProof, SchnorrProof } from '@cp2p/crypto';
import { VICTORY_CARDS, failure, kindBounds, kindsOfCounts, success } from '@cp2p/engine';
import type { EngineEffect, GameState, Input, Result, Seat, Transition } from '@cp2p/engine';
import * as v from 'valibot';
import { kindRecordSchema } from './card-kinds.js';
import type { CardKinds } from './card-kinds.js';
import type { EntryRef } from './beacon-state.js';
import {
  MAX_HAND_RESOURCE_COUNT,
  applyPublicResourceEffect,
  validateHandCommitments,
  verifyHandOpening,
} from './hand-commitments.js';
import type { PublicHandCommitments } from './hand-commitments.js';
import { verifyResourceAccounting } from './resource-accounting.js';
import { hashSchema, key32Schema, nonnegativeIntegerSchema, seatSchema } from './schema-values.js';
import { coversDebit } from './preproof.js';
import type { DebitPreproof } from './preproof.js';
import { bodyInput, sameInput } from './seat-input.js';
import type { CommandBody } from './types.js';
import { signedCommandSchema } from './schemas.js';
import { parseCanonical } from './validation.js';

export interface HandObligation {
  kind: 'range' | 'count';
  seat: Seat;
  resource: string;
  /** Gross debit for a range proof; exact parent count for a count opening. */
  count: number;
  commitment: string;
  effectIndices: readonly number[];
}

/** A hidden slot an input shows to every seat; the owner must prove the identity. */
export interface CardReveal {
  seat: Seat;
  deck: string;
  slotId: string;
  card: string;
}

/**
 * A hidden slot whose owner says its card is none of `excluded` (a drawn progress card that is
 * not a victory card); the owner must prove that without naming the card.
 */
export interface CardDenial {
  seat: Seat;
  deck: string;
  slotId: string;
  excluded: readonly string[];
}

/** An unrevealed slot that changes hands (the Spy takes a progress card). */
export interface SlotMove {
  from: Seat;
  to: Seat;
  deck: string;
  slotId: string;
}

/** Local engine-derived plan. Never deserialize a plan from a peer. */
export interface HandTransitionPlan {
  /** The game's card kinds, derived from its public bank. */
  kinds: CardKinds;
  input: Input;
  effects: readonly EngineEffect[];
  obligations: readonly HandObligation[];
  /** Hidden slots shown by the input, in effect order. Slots whose identity is public need no proof. */
  reveals: readonly CardReveal[];
  denials: readonly CardDenial[];
  moves: readonly SlotMove[];
  parentHands: PublicHandCommitments;
  hands: PublicHandCommitments;
}

export interface HandProofBinding {
  genesisDigest: string;
  epoch: number;
  anchor: EntryRef;
  command: Omit<CommandBody, 'evidence'> | null;
}

export type HandProof = {
  seat: Seat;
  resource: string;
  count: number;
} & ({ kind: 'range'; proof: RangeProof } | { kind: 'count'; proof: SchnorrProof });

const countSchema = v.pipe(nonnegativeIntegerSchema, v.maxValue(MAX_HAND_RESOURCE_COUNT));
const bitProofSchema = v.strictObject({
  challenges: v.tuple([key32Schema, key32Schema]),
  responses: v.tuple([key32Schema, key32Schema]),
});
// The resource must name one of the game's kinds; verification compares it to the obligation.
const proofFields = {
  seat: seatSchema,
  resource: v.pipe(v.string(), v.minLength(1), v.maxLength(16)),
  count: countSchema,
};
const handProofSchema = v.variant('kind', [
  v.strictObject({
    ...proofFields,
    kind: v.literal('range'),
    proof: v.strictObject({
      commitments: v.pipe(v.array(key32Schema), v.length(6)),
      proofs: v.pipe(v.array(bitProofSchema), v.length(6)),
    }),
  }),
  v.strictObject({
    ...proofFields,
    kind: v.literal('count'),
    proof: v.strictObject({ commitment: key32Schema, response: key32Schema }),
  }),
]);
export const handProofsSchema = v.pipe(v.array(handProofSchema), v.maxLength(30));
const bindingSchema = v.strictObject({
  genesisDigest: key32Schema,
  epoch: nonnegativeIntegerSchema,
  anchor: v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema }),
  command: v.nullable(v.omit(signedCommandSchema.entries.body, ['evidence'])),
});
const scalarCountSchema = countSchema;

function copy<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This only detaches typed engine output or schema-validated protocol data.
  return canonicalDecode(canonicalEncode(value)) as T;
}

function isSeatNumber(value: unknown): value is Seat {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5;
}

function requireValue<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Derive obligations against parent balances, never against incoming credits. */
export function planHandTransition(
  ledger: PublicHandCommitments,
  before: GameState,
  input: Input,
  transition: Transition,
  /** Debits their owners proved ahead of the input that makes them (see `DebitPreproof`). */
  preproofs: readonly DebitPreproof[] = [],
): Result<HandTransitionPlan> {
  try {
    if (input.kind === 'system' && input.type === 'STEAL_RESULT')
      return failure(
        'hand-steal-unavailable',
        'Verified steals require the sealed transfer protocol',
      );
    const accounting = verifyResourceAccounting(before, transition.state, transition.effects);
    if (!accounting.ok) return accounting;
    const seats = before.seats.map((seat) => seat.seat);
    const kinds = kindsOfCounts(before.bank);
    const parent = validateHandCommitments(ledger, seats, kinds);
    if (!parent.ok) return parent;
    for (const state of [before, transition.state])
      for (const seat of state.seats)
        for (const resource of kinds)
          if ((kindBounds(seat.resources).max[resource] ?? Infinity) > MAX_HAND_RESOURCE_COUNT)
            return failure('hand-count-bound', 'Public bounds exceed the six-bit hand range');

    const effects = copy(transition.effects);
    const debits = new Map<
      string,
      { seat: Seat; resource: string; count: number; indices: number[] }
    >();
    const reveals = new Map<string, HandObligation>();
    const commitment = (seat: Seat, resource: string): string => {
      const row = parent.value.find((item) => item.seat === seat);
      if (!row) throw new Error('Unknown hand commitment seat');
      const point = row.commitments[resource];
      if (point === undefined) throw new Error('Unknown hand commitment kind');
      return point;
    };
    let hands = parent.value;
    for (const [index, effect] of effects.entries()) {
      if (effect.type === 'hidden-resource-transfer')
        return failure(
          'hand-steal-unavailable',
          'Hidden movements require the sealed transfer protocol',
        );
      if (
        (effect.type === 'resource-count-revealed' || effect.type === 'resource-transfer') &&
        !kinds.includes(effect.resource)
      )
        return failure('hand-card-kind-unsupported', 'Hand proofs cover this game card kinds only');
      if (effect.type === 'resource-count-revealed') {
        reveals.set(`${effect.seat}:${effect.resource}`, {
          kind: 'count',
          seat: effect.seat,
          resource: effect.resource,
          count: effect.count,
          commitment: commitment(effect.seat, effect.resource),
          effectIndices: [index],
        });
      }
      if (effect.type !== 'resource-transfer') continue;
      if (effect.from.kind === 'seat') {
        const key = `${effect.from.seat}:${effect.resource}`;
        const debit = debits.get(key) ?? {
          seat: effect.from.seat,
          resource: effect.resource,
          count: 0,
          indices: [],
        };
        debit.count += effect.count;
        debit.indices.push(index);
        if (debit.count > MAX_HAND_RESOURCE_COUNT)
          return failure('hand-debit-bound', 'Gross debit exceeds the six-bit hand range');
        debits.set(key, debit);
        hands = requireValue(
          applyPublicResourceEffect(
            hands,
            seats,
            {
              seat: effect.from.seat,
              resource: effect.resource,
              direction: 'debit',
              count: effect.count,
            },
            kinds,
          ),
        );
      }
      if (effect.to.kind === 'seat')
        hands = requireValue(
          applyPublicResourceEffect(
            hands,
            seats,
            {
              seat: effect.to.seat,
              resource: effect.resource,
              direction: 'credit',
              count: effect.count,
            },
            kinds,
          ),
        );
    }
    const obligations: HandObligation[] = [...reveals.values()];
    for (const seat of before.seats)
      for (const resource of kinds) {
        const key = `${seat.seat}:${resource}`;
        const debit = debits.get(key);
        if (!debit) continue;
        const revealed = reveals.get(key);
        if (revealed) {
          if (debit.count > revealed.count)
            return failure(
              'hand-revealed-overspend',
              'Gross debit exceeds the revealed parent count',
            );
          continue;
        }
        if (debit.count <= (kindBounds(seat.resources).min[resource] ?? 0)) continue;
        if (
          coversDebit(preproofs, seat.seat, resource, debit.count, commitment(seat.seat, resource))
        )
          continue;
        obligations.push({
          kind: 'range',
          seat: seat.seat,
          resource,
          count: debit.count,
          commitment: commitment(seat.seat, resource),
          effectIndices: debit.indices,
        });
      }
    const cardReveals: CardReveal[] = [];
    for (const effect of effects) {
      if (effect.type !== 'card-slot-revealed') continue;
      const slot = before.seats
        .find((seat) => seat.seat === effect.seat)
        ?.cardSlots.find((item) => item.slotId === effect.slotId);
      // A slot with a public identity has no hidden card to prove.
      if (slot?.known === undefined)
        cardReveals.push({
          seat: effect.seat,
          deck: effect.deck,
          slotId: effect.slotId,
          card: effect.card,
        });
    }
    const denials: CardDenial[] = [];
    if (input.kind === 'system' && input.type === 'REVEAL_PROGRESS' && input.card === 'none') {
      const seat = input.seat;
      const slotId = input.slotId;
      const slot = before.seats
        .find((item) => item.seat === seat)
        ?.cardSlots.find((item) => item.slotId === slotId);
      // A hidden card the seat says is no victory card. A known slot is public and needs no proof.
      if (slot && slot.known === undefined && isSeatNumber(seat))
        denials.push({
          seat,
          deck: slot.deck,
          slotId: slot.slotId,
          excluded: Object.keys(VICTORY_CARDS).toSorted(),
        });
    }
    const moves: SlotMove[] = effects.flatMap((effect) =>
      effect.type === 'card-slot-moved'
        ? [{ from: effect.from, to: effect.to, deck: effect.deck, slotId: effect.slotId }]
        : [],
    );
    return success({
      kinds,
      input: copy(input),
      effects,
      obligations,
      reveals: cardReveals,
      denials,
      moves,
      parentHands: parent.value,
      hands,
    });
  } catch {
    return failure('hand-transition', 'Could not derive committed hand transition');
  }
}

/** Complete public statement for nonce derivation and Fiat-Shamir binding. */
export function handProofContext(
  plan: HandTransitionPlan,
  index: number,
  binding: HandProofBinding,
): unknown {
  const parsed = requireValue(parseCanonical(binding, bindingSchema));
  const obligation = plan.obligations[index];
  if (!obligation || !Number.isSafeInteger(index) || index < 0)
    throw new Error('Unknown hand proof obligation');
  if (plan.input.kind === 'command') {
    const body = parsed.command;
    if (
      !body ||
      body.genesisDigest !== parsed.genesisDigest ||
      body.headSeq !== parsed.anchor.seq ||
      body.headHash !== parsed.anchor.hash ||
      body.seat !== plan.input.seat ||
      toHex(hashValue(body.command)) !== toHex(hashValue(plan.input.command))
    )
      throw new Error('Hand proof command differs from its input or parent');
  } else if (parsed.command !== null) {
    // A seat's answer to a request travels as a signed envelope around its system input.
    const body = parsed.command;
    if (
      body.genesisDigest !== parsed.genesisDigest ||
      body.headSeq !== parsed.anchor.seq ||
      body.headHash !== parsed.anchor.hash ||
      !sameInput(bodyInput(body.seat, body.command), plan.input)
    )
      throw new Error('Hand proof envelope differs from its input or parent');
  }
  return copy({
    protocol: 'hand-obligation-v1',
    ...parsed,
    input: plan.input,
    effects: plan.effects,
    index,
    obligation,
  });
}

function adjustedPoint(obligation: HandObligation): string {
  return encodePoint(
    decodePoint(obligation.commitment).subtract(scalePoint(G, BigInt(obligation.count))),
  );
}

/** Verify one locally derived obligation at its canonical index. */
export function verifyHandProof(
  plan: HandTransitionPlan,
  index: number,
  proof: unknown,
  binding: HandProofBinding,
): Result<void> {
  try {
    const parsed = parseCanonical(proof, handProofSchema);
    if (!parsed.ok) return parsed;
    const obligation = plan.obligations[index];
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !obligation ||
      parsed.value.kind !== obligation.kind ||
      parsed.value.seat !== obligation.seat ||
      parsed.value.resource !== obligation.resource ||
      parsed.value.count !== obligation.count
    )
      return failure('hand-proof-obligation', 'Hand proof differs from the required obligation');
    const context = handProofContext(plan, index, binding);
    const point = adjustedPoint(obligation);
    const valid =
      parsed.value.kind === 'range'
        ? verifyRange({ commitment: point, bits: 6 }, parsed.value.proof, context)
        : verifySchnorr({ base: encodePoint(H), publicPoint: point }, parsed.value.proof, context);
    if (!valid) return failure('hand-proof-invalid', 'Committed hand proof is invalid');
    return success(undefined);
  } catch {
    return failure(
      'hand-proof-invalid',
      'Committed hand proof is malformed or has the wrong context',
    );
  }
}

/** Verify exactly the derived obligations; extra, omitted or reordered proofs fail. */
export function verifyHandProofs(
  plan: HandTransitionPlan,
  proofs: unknown,
  binding: HandProofBinding,
): Result<void> {
  const parsed = parseCanonical(proofs, handProofsSchema);
  if (!parsed.ok) return parsed;
  if (parsed.value.length !== plan.obligations.length)
    return failure('hand-proof-count', 'Evidence must cover exactly the required hand proofs');
  for (const [index, proof] of parsed.value.entries()) {
    const verified = verifyHandProof(plan, index, proof, binding);
    if (!verified.ok) return verified;
  }
  return success(undefined);
}

/** Owner-only proof production. The caller supplies a separate master-derived seed. */
export function proveHandObligation(
  plan: HandTransitionPlan,
  index: number,
  counts: unknown,
  blindings: unknown,
  seed: Uint8Array,
  binding: HandProofBinding,
): Result<HandProof> {
  try {
    const obligation = plan.obligations[index];
    if (!obligation) return failure('hand-proof-obligation', 'Unknown hand proof obligation');
    const parsedCounts = parseCanonical(counts, kindRecordSchema(plan.kinds, scalarCountSchema));
    const parsedBlindings = parseCanonical(blindings, kindRecordSchema(plan.kinds, key32Schema));
    if (!parsedCounts.ok) return parsedCounts;
    if (!parsedBlindings.ok) return parsedBlindings;
    const opening = verifyHandOpening(
      plan.parentHands,
      plan.parentHands.map((row) => row.seat),
      obligation.seat,
      parsedCounts.value,
      parsedBlindings.value,
      plan.kinds,
    );
    if (!opening.ok) return opening;
    const count = parsedCounts.value[obligation.resource];
    const encodedBlinding = parsedBlindings.value[obligation.resource];
    if (count === undefined || encodedBlinding === undefined)
      return failure('hand-proof-obligation', 'Obligation names an unknown card kind');
    if (count < obligation.count || (obligation.kind === 'count' && count !== obligation.count))
      return failure('hand-proof-witness', 'Owned hand does not satisfy the required count');
    const blinding = decodeScalar(encodedBlinding);
    const context = handProofContext(plan, index, binding);
    const point = adjustedPoint(obligation);
    const common = {
      seat: obligation.seat,
      resource: obligation.resource,
      count: obligation.count,
    };
    return success(
      obligation.kind === 'range'
        ? {
            ...common,
            kind: 'range',
            proof: proveRange(
              { commitment: point, bits: 6 },
              BigInt(count - obligation.count),
              blinding,
              seed,
              context,
            ),
          }
        : {
            ...common,
            kind: 'count',
            proof: proveSchnorr(
              { base: encodePoint(H), publicPoint: point },
              blinding,
              seed,
              context,
            ),
          },
    );
  } catch {
    return failure('hand-proof-production', 'Could not prove the owned committed hand');
  }
}
