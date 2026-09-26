import { RESOURCES, failure, success } from '@cp2p/engine';
import type { Engine, GameState, Resource, Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import type { EntryRef } from './beacon-state.js';
import {
  COUNT_EVIDENCE_PROTOCOL,
  countOperationSchema,
  validateCountOperation,
} from './count-reveal.js';
import type { CountState } from './count-reveal.js';
import { genesisDigest } from './genesis.js';
import { MAX_HAND_RESOURCE_COUNT } from './hand-commitments.js';
import type { PublicHandCommitments } from './hand-commitments.js';
import { nonnegativeIntegerSchema, seatSchema } from './schema-values.js';
import type { Genesis } from './types.js';
import { parseCanonical } from './validation.js';

const remainingSchema = v.pipe(v.array(seatSchema), v.minLength(1), v.maxLength(5));
const stateSchema = v.strictObject({ operation: countOperationSchema, remaining: remainingSchema });
const phaseDataSchema = v.strictObject({
  seat: seatSchema,
  resource: v.picklist(RESOURCES),
  remaining: remainingSchema,
});
const pendingSchema = v.strictObject({
  kind: v.literal('reveal'),
  seat: seatSchema,
  request: v.strictObject({
    type: v.literal('monopolyCount'),
    resource: v.picklist(RESOURCES),
    max: v.pipe(nonnegativeIntegerSchema, v.minValue(1), v.maxValue(MAX_HAND_RESOURCE_COUNT)),
  }),
  systemType: v.literal('REVEAL_COUNT'),
});

interface PendingCounts {
  monopolist: Seat;
  resource: Resource;
  remaining: readonly Seat[];
}

function pendingCounts(engine: Engine, state: GameState): Result<PendingCounts | null> {
  if (state.result !== null) return success(null);
  const requests = engine
    .getPending(state)
    .filter((item) => item.kind === 'reveal' && item.systemType === 'REVEAL_COUNT');
  if (requests.length === 0) return success(null);
  const phase = state.turn.phase.at(-1);
  if (phase?.module !== 'base' || phase.id !== 'monopoly')
    return failure('count-phase', 'Only the base Monopoly phase may request a count opening');
  const data = parseCanonical(phase.data, phaseDataSchema);
  if (!data.ok) return data;
  if (data.value.seat !== state.turn.activeSeat || requests.length !== data.value.remaining.length)
    return failure('count-pending', 'Monopoly requests differ from the current actor or victims');
  const remaining: Seat[] = [];
  for (const item of requests) {
    const parsed = parseCanonical(item, pendingSchema);
    if (!parsed.ok) return parsed;
    const holder = state.seats.find((seat) => seat.seat === parsed.value.seat);
    if (
      parsed.value.request.resource !== data.value.resource ||
      parsed.value.seat === data.value.seat ||
      !data.value.remaining.includes(parsed.value.seat) ||
      holder?.resources.max[data.value.resource] !== parsed.value.request.max
    )
      return failure('count-pending', 'Count request differs from public resource bounds');
    remaining.push(parsed.value.seat);
  }
  remaining.sort((a, b) => a - b);
  if (
    new Set(remaining).size !== remaining.length ||
    new Set(data.value.remaining).size !== remaining.length
  )
    return failure('count-pending', 'Monopoly victims must be unique');
  return success({ monopolist: data.value.seat, resource: data.value.resource, remaining });
}

/** Compare saved metadata with the current engine pending and every unconsumed commitment. */
export function validateCountState(
  value: unknown,
  genesis: Genesis,
  engine: Engine,
  state: GameState,
  hands: PublicHandCommitments,
  epoch: number,
): Result<CountState | null> {
  const pending = pendingCounts(engine, state);
  if (!pending.ok) return pending;
  if (value === null)
    return pending.value === null
      ? success(null)
      : failure('count-context-required', 'Monopoly pending requires frozen count metadata');
  const parsed = parseCanonical(value, stateSchema);
  if (!parsed.ok) return parsed;
  const checked = validateCountOperation(parsed.value.operation);
  if (!checked.ok) return checked;
  const operation = checked.value;
  const requested = pending.value;
  if (
    !requested ||
    operation.genesisDigest !== genesisDigest(genesis) ||
    operation.epoch !== epoch ||
    operation.monopolist !== requested.monopolist ||
    operation.resource !== requested.resource ||
    !genesis.config.seats.includes(operation.monopolist) ||
    operation.victims.some(
      (victim) =>
        genesis.seats.find((seat) => seat.seat === victim.seat)?.publicKey !== victim.publicKey,
    ) ||
    parsed.value.remaining.length !== requested.remaining.length ||
    parsed.value.remaining.some((seat, index) => seat !== requested.remaining[index])
  )
    return failure(
      'count-context',
      'Frozen counts differ from genesis or current Monopoly requests',
    );
  for (const seat of parsed.value.remaining) {
    const victim = operation.victims.find((item) => item.seat === seat);
    if (
      !victim ||
      hands.find((hand) => hand.seat === seat)?.commitments[operation.resource] !==
        victim.commitment
    )
      return failure(
        'count-commitment-changed',
        'Unconsumed count commitment changed since Monopoly',
      );
  }
  return success({ operation, remaining: parsed.value.remaining });
}

/** Called only after applying a certified entry, with consumed victims already removed. */
export function captureCountPending(
  current: CountState | null,
  genesis: Genesis,
  engine: Engine,
  state: GameState,
  hands: PublicHandCommitments,
  epoch: number,
  anchor: EntryRef,
): Result<CountState | null> {
  if (state.result !== null) return success(null);
  if (current !== null) return validateCountState(current, genesis, engine, state, hands, epoch);
  const pending = pendingCounts(engine, state);
  if (!pending.ok) return pending;
  if (!pending.value) return success(null);
  const { monopolist, resource, remaining } = pending.value;
  const victims = [];
  for (const seat of remaining) {
    const owner = genesis.seats.find((item) => item.seat === seat);
    const hand = hands.find((item) => item.seat === seat);
    if (!owner || !hand)
      return failure('count-victim', 'Count victim is missing from genesis or hands');
    victims.push({ seat, publicKey: owner.publicKey, commitment: hand.commitments[resource] });
  }
  return validateCountState(
    {
      operation: {
        protocol: COUNT_EVIDENCE_PROTOCOL,
        genesisDigest: genesisDigest(genesis),
        epoch,
        anchor,
        monopolist,
        resource,
        victims,
      },
      remaining,
    },
    genesis,
    engine,
    state,
    hands,
    epoch,
  );
}
