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
import { RESOURCES, failure, success } from '@cp2p/engine';
import type {
  EngineEffect,
  GameState,
  Input,
  Resource,
  Result,
  Seat,
  Transition,
} from '@cp2p/engine';
import * as v from 'valibot';
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
import type { CommandBody } from './types.js';
import { signedCommandSchema } from './schemas.js';
import { parseCanonical } from './validation.js';

export interface HandObligation {
  kind: 'range' | 'count';
  seat: Seat;
  resource: Resource;
  /** Gross debit for a range proof; exact parent count for a count opening. */
  count: number;
  commitment: string;
  effectIndices: readonly number[];
}

/** Local engine-derived plan. Never deserialize a plan from a peer. */
export interface HandTransitionPlan {
  input: Input;
  effects: readonly EngineEffect[];
  obligations: readonly HandObligation[];
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
  resource: Resource;
  count: number;
} & ({ kind: 'range'; proof: RangeProof } | { kind: 'count'; proof: SchnorrProof });

const countSchema = v.pipe(nonnegativeIntegerSchema, v.maxValue(MAX_HAND_RESOURCE_COUNT));
const bitProofSchema = v.strictObject({
  challenges: v.tuple([key32Schema, key32Schema]),
  responses: v.tuple([key32Schema, key32Schema]),
});
const proofFields = { seat: seatSchema, resource: v.picklist(RESOURCES), count: countSchema };
export const handProofsSchema = v.pipe(
  v.array(
    v.variant('kind', [
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
    ]),
  ),
  v.maxLength(30),
);
const bindingSchema = v.strictObject({
  genesisDigest: key32Schema,
  epoch: nonnegativeIntegerSchema,
  anchor: v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema }),
  command: v.nullable(v.omit(signedCommandSchema.entries.body, ['evidence'])),
});
const countsSchema = v.strictObject({
  brick: countSchema,
  lumber: countSchema,
  wool: countSchema,
  grain: countSchema,
  ore: countSchema,
});
const blindingsSchema = v.strictObject({
  brick: key32Schema,
  lumber: key32Schema,
  wool: key32Schema,
  grain: key32Schema,
  ore: key32Schema,
});

function copy<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This only detaches typed engine output or schema-validated protocol data.
  return canonicalDecode(canonicalEncode(value)) as T;
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
    const parent = validateHandCommitments(ledger, seats);
    if (!parent.ok) return parent;
    for (const state of [before, transition.state])
      for (const seat of state.seats)
        for (const resource of RESOURCES)
          if ((seat.resources.max[resource] ?? Infinity) > MAX_HAND_RESOURCE_COUNT)
            return failure('hand-count-bound', 'Public bounds exceed the six-bit hand range');

    const effects = copy(transition.effects);
    const debits = new Map<
      string,
      { seat: Seat; resource: Resource; count: number; indices: number[] }
    >();
    const reveals = new Map<string, HandObligation>();
    const commitment = (seat: Seat, resource: Resource): string => {
      const row = parent.value.find((item) => item.seat === seat);
      if (!row) throw new Error('Unknown hand commitment seat');
      return row.commitments[resource];
    };
    let hands = parent.value;
    for (const [index, effect] of effects.entries()) {
      if (effect.type === 'hidden-resource-transfer')
        return failure(
          'hand-steal-unavailable',
          'Hidden movements require the sealed transfer protocol',
        );
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
          applyPublicResourceEffect(hands, seats, {
            seat: effect.from.seat,
            resource: effect.resource,
            direction: 'debit',
            count: effect.count,
          }),
        );
      }
      if (effect.to.kind === 'seat')
        hands = requireValue(
          applyPublicResourceEffect(hands, seats, {
            seat: effect.to.seat,
            resource: effect.resource,
            direction: 'credit',
            count: effect.count,
          }),
        );
    }
    const obligations: HandObligation[] = [...reveals.values()];
    for (const seat of before.seats)
      for (const resource of RESOURCES) {
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
        if (debit.count <= (seat.resources.min[resource] ?? 0)) continue;
        obligations.push({
          kind: 'range',
          seat: seat.seat,
          resource,
          count: debit.count,
          commitment: commitment(seat.seat, resource),
          effectIndices: debit.indices,
        });
      }
    return success({ input: copy(input), effects, obligations, parentHands: parent.value, hands });
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
  } else if (parsed.command !== null) throw new Error('System hand proof cannot carry a command');
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

/** Verify exactly the derived obligations; extra, omitted or reordered proofs fail. */
export function verifyHandProofs(
  plan: HandTransitionPlan,
  proofs: unknown,
  binding: HandProofBinding,
): Result<void> {
  try {
    const parsed = parseCanonical(proofs, handProofsSchema);
    if (!parsed.ok) return parsed;
    if (parsed.value.length !== plan.obligations.length)
      return failure('hand-proof-count', 'Evidence must cover exactly the required hand proofs');
    for (const [index, proof] of parsed.value.entries()) {
      const obligation = plan.obligations[index];
      if (
        !obligation ||
        proof.kind !== obligation.kind ||
        proof.seat !== obligation.seat ||
        proof.resource !== obligation.resource ||
        proof.count !== obligation.count
      )
        return failure('hand-proof-obligation', 'Hand proof differs from the required obligation');
      const context = handProofContext(plan, index, binding);
      const point = adjustedPoint(obligation);
      const valid =
        proof.kind === 'range'
          ? verifyRange({ commitment: point, bits: 6 }, proof.proof, context)
          : verifySchnorr({ base: encodePoint(H), publicPoint: point }, proof.proof, context);
      if (!valid) return failure('hand-proof-invalid', 'Committed hand proof is invalid');
    }
    return success(undefined);
  } catch {
    return failure(
      'hand-proof-invalid',
      'Committed hand proof is malformed or has the wrong context',
    );
  }
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
    const parsedCounts = parseCanonical(counts, countsSchema);
    const parsedBlindings = parseCanonical(blindings, blindingsSchema);
    if (!parsedCounts.ok) return parsedCounts;
    if (!parsedBlindings.ok) return parsedBlindings;
    const opening = verifyHandOpening(
      plan.parentHands,
      plan.parentHands.map((row) => row.seat),
      obligation.seat,
      parsedCounts.value,
      parsedBlindings.value,
    );
    if (!opening.ok) return opening;
    const count = parsedCounts.value[obligation.resource];
    if (count < obligation.count || (obligation.kind === 'count' && count !== obligation.count))
      return failure('hand-proof-witness', 'Owned hand does not satisfy the required count');
    const blinding = decodeScalar(parsedBlindings.value[obligation.resource]);
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
