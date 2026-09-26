import { hashValue, toHex } from '@cp2p/codec';
import { decodePoint, encodePoint } from '@cp2p/crypto';
import { RESOURCES, failure, success } from '@cp2p/engine';
import type { EngineEffect, GameState, Result } from '@cp2p/engine';
import * as v from 'valibot';
import { beaconOperationId } from './beacon.js';
import { consumeFixedBeacon } from './beacon-state.js';
import type { BeaconState, EntryRef } from './beacon-state.js';
import { genesisDigest } from './genesis.js';
import { MAX_HAND_RESOURCE_COUNT, validateHandCommitments } from './hand-commitments.js';
import type { PublicHandCommitments } from './hand-commitments.js';
import { verifyResourceAccounting } from './resource-accounting.js';
import {
  signedStealContributionSchema,
  signedStealDisputeSchema,
  stealOperationId,
  stealReceiptBinding,
  validateStealOperation,
  verifyStealContribution,
  verifyStealDispute,
  verifyStealReceipt,
} from './steal-delivery.js';
import type {
  FixedSteal,
  SignedStealDispute,
  SignedStealReceipt,
  StealOperation,
} from './steal-delivery.js';
import type { Genesis } from './types.js';
import { hashSchema, nonnegativeIntegerSchema } from './schema-values.js';
import { parseCanonical } from './validation.js';

const entryRefSchema = v.strictObject({
  seq: nonnegativeIntegerSchema,
  hash: hashSchema,
});

/** Only certified entries can advance this replayed public lifecycle. */
export interface StealState {
  operation: StealOperation;
  fixed: FixedSteal | null;
  dispute: SignedStealDispute | null;
}

function same(left: unknown, right: unknown): boolean {
  return toHex(hashValue(left)) === toHex(hashValue(right));
}

function operationFromBeacon(
  genesis: Genesis,
  beacon: BeaconState,
  hands: PublicHandCommitments,
  state: GameState,
  epoch: number,
): Result<StealOperation | null> {
  const fixed = beacon.fixed;
  if (!fixed) return success(null);
  const { thief, victim, handSize, index } = fixed.outcome;
  const pending = fixed.operation.pending;
  if (
    pending.systemType !== 'STEAL_RESULT' ||
    pending.request.type !== 'stealIndex' ||
    pending.request.thief !== thief ||
    pending.request.victim !== victim ||
    pending.request.handSize !== handSize
  )
    return failure('steal-freeze-request', 'Fixed index differs from the certified steal request');
  const thiefSeat = genesis.seats.find((seat) => seat.seat === thief);
  const victimSeat = genesis.seats.find((seat) => seat.seat === victim);
  const victimHand = hands.find((row) => row.seat === victim);
  const victimState = state.seats.find((seat) => seat.seat === victim);
  if (
    !thiefSeat?.encryptionKey ||
    !victimSeat ||
    !victimHand ||
    !victimState ||
    victimState.resources.total !== handSize ||
    fixed.operation.epoch !== epoch ||
    fixed.operation.genesisDigest !== genesisDigest(genesis)
  )
    return failure(
      'steal-freeze-context',
      'Frozen steal differs from the certified roster or hand',
    );
  return validateStealOperation({
    protocol: 'hidden-steal-v1',
    genesisDigest: genesisDigest(genesis),
    epoch,
    anchor: fixed.entry,
    beaconOperationId: beaconOperationId(fixed.operation),
    thief: {
      seat: thief,
      publicKey: thiefSeat.publicKey,
      encryptionKey: thiefSeat.encryptionKey,
    },
    victim: { seat: victim, publicKey: victimSeat.publicKey },
    handSize,
    index,
    commitments: victimHand.commitments,
  });
}

/** Reconstructs authority from the certified beacon and parent ledger. */
export function freezeStealState(
  genesis: Genesis,
  beacon: BeaconState,
  hands: PublicHandCommitments,
  state: GameState,
  epoch: number,
): Result<StealState> {
  const operation = operationFromBeacon(genesis, beacon, hands, state, epoch);
  if (!operation.ok) return operation;
  if (!operation.value) return failure('steal-freeze-beacon', 'No certified steal index is fixed');
  return success({ operation: operation.value, fixed: null, dispute: null });
}

/** Checks structural continuity; proofs were checked when their entries certified. */
export function validateStealState(
  value: StealState | null,
  genesis: Genesis,
  beacon: BeaconState,
  hands: PublicHandCommitments,
  state: GameState,
  epoch: number,
): Result<StealState | null> {
  const expected = operationFromBeacon(genesis, beacon, hands, state, epoch);
  if (!expected.ok) return expected;
  if (!expected.value)
    return value === null
      ? success(null)
      : failure('steal-state-orphan', 'Steal state has no fixed beacon outcome');
  if (!value) return failure('steal-state-required', 'Fixed beacon needs a steal state');
  const operation = validateStealOperation(value.operation);
  if (!operation.ok) return operation;
  if (!same(operation.value, expected.value))
    return failure('steal-state-operation', 'Steal operation differs from the certified context');
  if (value.dispute && !value.fixed)
    return failure('steal-state-dispute', 'A dispute requires a certified fixed contribution');
  let fixed: FixedSteal | null = null;
  if (value.fixed) {
    const contribution = parseCanonical(value.fixed.contribution, signedStealContributionSchema);
    if (!contribution.ok) return contribution;
    const entry = parseCanonical(value.fixed.entry, entryRefSchema);
    if (!entry.ok) return entry;
    if (
      !same(value.fixed.operation, operation.value) ||
      contribution.value.body.operationId !== stealOperationId(operation.value) ||
      contribution.value.body.seat !== operation.value.victim.seat ||
      entry.value.seq <= operation.value.anchor.seq
    )
      return failure('steal-state-fixed', 'Fixed contribution differs from the frozen operation');
    fixed = { operation: operation.value, contribution: contribution.value, entry: entry.value };
  }
  let dispute: SignedStealDispute | null = null;
  if (value.dispute) {
    const parsed = parseCanonical(value.dispute, signedStealDisputeSchema);
    if (!parsed.ok) return parsed;
    if (!fixed || !same(parsed.value.body.binding, stealReceiptBinding(fixed)))
      return failure('steal-state-dispute', 'Stored dispute differs from its fixed contribution');
    dispute = parsed.value;
  }
  return success({ operation: operation.value, fixed, dispute });
}

export function fixStealContribution(
  state: StealState,
  evidence: unknown,
  entry: EntryRef,
): Result<StealState> {
  if (state.fixed || state.dispute)
    return failure('steal-already-fixed', 'Steal contribution is already fixed');
  if (entry.seq <= state.operation.anchor.seq)
    return failure('steal-fixed-entry', 'Fixed contribution must follow the beacon result');
  const contribution = verifyStealContribution(evidence, state.operation);
  return contribution.ok
    ? success({
        ...state,
        fixed: { operation: state.operation, contribution: contribution.value, entry },
      })
    : contribution;
}

export function disputeStealContribution(state: StealState, evidence: unknown): Result<StealState> {
  if (!state.fixed || state.dispute)
    return failure('steal-dispute-state', 'Dispute needs one undisputed fixed contribution');
  const dispute = verifyStealDispute(evidence, state.fixed);
  return dispute.ok ? success({ ...state, dispute: dispute.value }) : dispute;
}

export function verifyStealResult(
  state: StealState | null,
  input: unknown,
  evidence: unknown,
): Result<SignedStealReceipt> {
  if (!state?.fixed || state.dispute)
    return failure('steal-result-state', 'Steal result needs an undisputed fixed contribution');
  if (
    !input ||
    typeof input !== 'object' ||
    !('kind' in input) ||
    input.kind !== 'system' ||
    !('type' in input) ||
    input.type !== 'STEAL_RESULT' ||
    !('thief' in input) ||
    input.thief !== state.operation.thief.seat ||
    !('victim' in input) ||
    input.victim !== state.operation.victim.seat ||
    !('resource' in input) ||
    input.resource !== 'hidden' ||
    Object.keys(input).toSorted().join(',') !== 'kind,resource,thief,type,victim'
  )
    return failure('steal-result-input', 'Only the frozen hidden steal may complete');
  if (
    !evidence ||
    typeof evidence !== 'object' ||
    !('kind' in evidence) ||
    evidence.kind !== 'proof' ||
    !('protocol' in evidence) ||
    evidence.protocol !== 'hidden-steal-v1' ||
    !('data' in evidence)
  )
    return failure('steal-result-evidence', 'Hidden steal needs its signed receipt');
  return verifyStealReceipt(evidence.data, state.fixed);
}

/** Applies the publicly proven one-hot transfer only after engine accounting agrees. */
export function completeStealResult(
  steal: StealState,
  beacon: BeaconState,
  hands: PublicHandCommitments,
  before: GameState,
  after: GameState,
  effects: readonly EngineEffect[],
): Result<{ hands: PublicHandCommitments; beacon: BeaconState; steal: null }> {
  if (!steal.fixed || steal.dispute)
    return failure('steal-result-state', 'Steal result needs an undisputed fixed contribution');
  const transfer = effects[0];
  if (
    effects.length !== 1 ||
    transfer?.type !== 'hidden-resource-transfer' ||
    transfer.from !== steal.operation.victim.seat ||
    transfer.to !== steal.operation.thief.seat ||
    transfer.count !== 1
  )
    return failure('steal-result-effect', 'Engine must produce exactly the frozen hidden transfer');
  const accounting = verifyResourceAccounting(before, after, effects);
  if (!accounting.ok) return accounting;
  if (
    after.seats.some((seat) =>
      RESOURCES.some(
        (resource) =>
          seat.resources.min[resource] < 0 ||
          seat.resources.max[resource] > MAX_HAND_RESOURCE_COUNT,
      ),
    )
  )
    return failure('steal-result-bound', 'Hidden transfer exceeds the hand proof range');
  const checked = validateHandCommitments(
    hands,
    before.seats.map((seat) => seat.seat),
  );
  if (!checked.ok) return checked;
  try {
    const transferPoints = steal.fixed.contribution.body.transfer.map((point) =>
      decodePoint(point),
    );
    if (transferPoints.length !== RESOURCES.length)
      return failure('steal-result-transfer', 'Fixed transfer has the wrong resource width');
    const next = checked.value.map((row) => {
      const commitments = { ...row.commitments };
      for (const [index, resource] of RESOURCES.entries()) {
        const point = decodePoint(row.commitments[resource]);
        const moved = transferPoints[index];
        if (!moved) throw new TypeError('Missing transfer point');
        const updated =
          row.seat === steal.operation.victim.seat
            ? point.subtract(moved)
            : row.seat === steal.operation.thief.seat
              ? point.add(moved)
              : point;
        commitments[resource] = encodePoint(updated);
      }
      return { seat: row.seat, commitments };
    });
    const folded = validateHandCommitments(
      next,
      before.seats.map((seat) => seat.seat),
    );
    if (!folded.ok) return folded;
    const consumed = consumeFixedBeacon(beacon, steal.operation.anchor);
    return consumed.ok
      ? success({ hands: folded.value, beacon: consumed.value, steal: null })
      : consumed;
  } catch {
    return failure('steal-result-transfer', 'Could not fold the fixed transfer commitments');
  }
}
