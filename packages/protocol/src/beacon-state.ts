import { fromBase64Url } from '@cp2p/codec';
import { parsePeerId } from '@cp2p/crypto';
import { failure, success } from '@cp2p/engine';
import type { GameState, Result, Seat } from '@cp2p/engine';
import * as v from 'valibot';
import { completeBeacon, validateBeaconOperation } from './beacon.js';
import type { BeaconOperation } from './beacon.js';
import { completeBeaconExtension } from './beacon-extension.js';
import { genesisDigest, genesisId } from './genesis.js';
import { randomDerivations } from './random-derivations.js';
import type { BeaconOutcome, RandomPending } from './random-derivations.js';
import {
  hashSchema,
  key32Schema,
  nonnegativeIntegerSchema,
  positiveIntegerSchema,
  seatSchema,
} from './schema-values.js';
import { genesisSchema } from './schemas.js';
import type { Genesis } from './types.js';
import { parseCanonical } from './validation.js';
import { resolveArtifactSigner } from './authority.js';
import type { ArtifactSigner, SeatAuthorities } from './authority-types.js';

const MAX_CHAIN_LENGTH = 65_536;
const chainLengthSchema = v.pipe(positiveIntegerSchema, v.maxValue(MAX_CHAIN_LENGTH));
const chainSchema = v.strictObject({
  seat: seatSchema,
  publicKey: key32Schema,
  chainEpoch: nonnegativeIntegerSchema,
  index: nonnegativeIntegerSchema,
  length: chainLengthSchema,
  tip: key32Schema,
});
const entryRefSchema = v.strictObject({ seq: nonnegativeIntegerSchema, hash: hashSchema });
const pendingSchema = v.strictObject({
  kind: v.literal('random'),
  request: v.objectWithRest(
    { type: v.pipe(v.string(), v.minLength(1), v.maxLength(64)) },
    v.unknown(),
  ),
  systemType: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
});
const frozenSchema = v.strictObject({
  genesisDigest: key32Schema,
  epoch: nonnegativeIntegerSchema,
  anchor: entryRefSchema,
  round: positiveIntegerSchema,
  pending: pendingSchema,
  participants: v.pipe(v.array(chainSchema), v.minLength(1), v.maxLength(6)),
});
const fixedSchema = v.strictObject({
  operation: v.unknown(),
  seed: key32Schema,
  outcome: v.strictObject({
    kind: v.literal('steal-index'),
    thief: seatSchema,
    victim: seatSchema,
    handSize: positiveIntegerSchema,
    index: nonnegativeIntegerSchema,
  }),
  entry: entryRefSchema,
});
const stateSchema = v.strictObject({
  genesisDigest: key32Schema,
  chains: v.pipe(v.array(chainSchema), v.minLength(1), v.maxLength(6)),
  round: nonnegativeIntegerSchema,
  active: v.nullable(frozenSchema),
  fixed: v.nullable(fixedSchema),
});
const commitmentSchema = v.pipe(
  v.array(v.strictObject({ seat: seatSchema, length: chainLengthSchema, tip: key32Schema })),
  v.minLength(1),
  v.maxLength(6),
);

export interface BeaconChain {
  seat: Seat;
  publicKey: string;
  chainEpoch: number;
  /** Number of links consumed in this chain; the next reveal uses index + 1. */
  index: number;
  length: number;
  tip: string;
}

export interface EntryRef {
  seq: number;
  hash: string;
}

export interface FrozenBeaconRequest {
  genesisDigest: string;
  epoch: number;
  anchor: EntryRef;
  round: number;
  pending: RandomPending;
  participants: readonly BeaconChain[];
}

export interface BeaconState {
  genesisDigest: string;
  chains: readonly BeaconChain[];
  /** Completed rounds; an active request has round + 1. */
  round: number;
  active: FrozenBeaconRequest | null;
  fixed: {
    operation: BeaconOperation;
    seed: string;
    outcome: Extract<BeaconOutcome, { kind: 'steal-index' }>;
    entry: EntryRef;
  } | null;
}

export type BeaconDerivations = typeof randomDerivations;

function validChains(chains: readonly BeaconChain[]): boolean {
  let previousSeat = -1;
  const keys = new Set<string>();
  for (const chain of chains) {
    if (chain.seat <= previousSeat || chain.index > chain.length || keys.has(chain.publicKey))
      return false;
    previousSeat = chain.seat;
    keys.add(chain.publicKey);
    try {
      parsePeerId(chain.publicKey);
    } catch {
      return false;
    }
  }
  return true;
}

function sameChain(left: BeaconChain, right: BeaconChain | undefined): boolean {
  return (
    right !== undefined &&
    left.seat === right.seat &&
    left.publicKey === right.publicKey &&
    left.chainEpoch === right.chainEpoch &&
    left.index === right.index &&
    left.length === right.length &&
    left.tip === right.tip
  );
}

/** Canonically copies saved public state before any transition. No cache is authority. */
export function validateBeaconState(value: unknown): Result<BeaconState> {
  const parsed = parseCanonical(value, stateSchema);
  if (!parsed.ok) return parsed;
  const state = parsed.value;
  if (!validChains(state.chains))
    return failure('beacon-state-chains', 'Beacon chains are invalid or out of order');
  if (state.round === Number.MAX_SAFE_INTEGER)
    return failure('beacon-state-round', 'Beacon round is exhausted');
  if (state.active && state.fixed)
    return failure('beacon-state-active', 'Beacon cannot be active and fixed simultaneously');
  if (state.active) {
    const active = state.active;
    if (
      active.genesisDigest !== state.genesisDigest ||
      active.round !== state.round + 1 ||
      active.participants.length !== state.chains.length ||
      active.participants.some((chain, index) => !sameChain(chain, state.chains[index]))
    )
      return failure('beacon-state-active', 'Frozen beacon request differs from its chains');
  }
  let fixed: BeaconState['fixed'] = null;
  if (state.fixed) {
    const operation = validateBeaconOperation(state.fixed.operation);
    if (!operation.ok) return operation;
    if (
      state.active ||
      operation.value.genesisDigest !== state.genesisDigest ||
      operation.value.round !== state.round ||
      state.fixed.outcome.index >= state.fixed.outcome.handSize ||
      state.fixed.entry.seq <= operation.value.anchor.seq
    )
      return failure('beacon-state-fixed', 'Fixed beacon outcome is inconsistent');
    fixed = { ...state.fixed, operation: operation.value };
  }
  return success({
    genesisDigest: state.genesisDigest,
    chains: state.chains,
    round: state.round,
    active: state.active,
    fixed,
  });
}

/** Genesis is trusted only after its signature/config validation by the caller. */
export function initializeBeaconState(genesis: Genesis): Result<BeaconState> {
  const checkedGenesis = parseCanonical(genesis, genesisSchema);
  if (!checkedGenesis.ok) return checkedGenesis;
  if (checkedGenesis.value.gameId !== genesisId(checkedGenesis.value))
    return failure('beacon-genesis', 'Beacon commitments belong to an invalid genesis');
  if (checkedGenesis.value.security !== 'verified')
    return failure('beacon-security', 'Stub genesis cannot initialize verified beacon chains');
  const parsed = parseCanonical(checkedGenesis.value.commitments.beaconChains, commitmentSchema);
  if (!parsed.ok) return parsed;
  const humans = checkedGenesis.value.seats.filter((seat) => seat.kind === 'human');
  if (humans.length === 0 || parsed.value.length !== humans.length)
    return failure('beacon-roster', 'Every human needs exactly one ordered beacon commitment');
  const chains: BeaconChain[] = [];
  for (const [index, human] of humans.entries()) {
    const commitment = parsed.value[index];
    if (!commitment || commitment.seat !== human.seat)
      return failure('beacon-roster', 'Beacon commitments do not match the human roster');
    chains.push({
      seat: human.seat,
      publicKey: human.publicKey,
      chainEpoch: 0,
      index: 0,
      length: commitment.length,
      tip: commitment.tip,
    });
  }
  const state: BeaconState = {
    genesisDigest: genesisDigest(checkedGenesis.value),
    chains,
    round: 0,
    active: null,
    fixed: null,
  };
  return validateBeaconState(state);
}

/** The caller establishes this is engine.getPending() from a certified state. */
export function freezeBeaconRequest(
  value: BeaconState,
  pending: unknown,
  publicState: GameState,
  anchor: EntryRef,
  epoch: number,
  registry: BeaconDerivations = randomDerivations,
): Result<BeaconState> {
  const state = validateBeaconState(value);
  if (!state.ok) return state;
  if (state.value.active || state.value.fixed)
    return failure('beacon-busy', 'An existing beacon operation must finish first');
  const request = parseCanonical(pending, pendingSchema);
  if (!request.ok) return request;
  const entry = parseCanonical(anchor, entryRefSchema);
  if (!entry.ok) return entry;
  if (!Number.isSafeInteger(epoch) || epoch < 0)
    return failure('beacon-epoch', 'Certified membership epoch is invalid');
  const valid = registry.validate(publicState, request.value);
  if (!valid.ok) return valid;
  return validateBeaconState({
    ...state.value,
    active: {
      genesisDigest: state.value.genesisDigest,
      epoch,
      anchor: entry.value,
      round: state.value.round + 1,
      pending: request.value,
      participants: state.value.chains,
    },
  });
}

/** Next reveal index is derived from the consumed chain count, never caller gossip. */
export function getBeaconOperation(value: BeaconState): Result<BeaconOperation> {
  const state = validateBeaconState(value);
  if (!state.ok) return state;
  const active = state.value.active;
  if (!active) return failure('beacon-inactive', 'No beacon request is pending');
  if (active.participants.some((chain) => chain.index === chain.length))
    return failure('beacon-extension-required', 'A participant chain is exhausted');
  return validateBeaconOperation({
    genesisDigest: active.genesisDigest,
    epoch: active.epoch,
    anchor: active.anchor,
    round: active.round,
    pending: active.pending,
    participants: active.participants.map((chain) => ({
      seat: chain.seat,
      publicKey: chain.publicKey,
      chainEpoch: chain.chainEpoch,
      index: chain.index + 1,
      length: chain.length,
      previous: chain.tip,
    })),
  });
}

/** Extension is bound to the same frozen request, but only exhausted seats sign it. */
export function getBeaconExtensionOperation(value: BeaconState): Result<BeaconOperation> {
  const state = validateBeaconState(value);
  if (!state.ok) return state;
  const active = state.value.active;
  if (!active) return failure('beacon-inactive', 'No beacon request is pending');
  const exhausted = active.participants.filter((chain) => chain.index === chain.length);
  if (exhausted.length === 0)
    return failure('beacon-extension-unneeded', 'No participant chain is exhausted');
  return validateBeaconOperation({
    genesisDigest: active.genesisDigest,
    epoch: active.epoch,
    anchor: active.anchor,
    round: active.round,
    pending: active.pending,
    participants: exhausted.map((chain) => ({
      seat: chain.seat,
      publicKey: chain.publicKey,
      chainEpoch: chain.chainEpoch,
      index: chain.index,
      length: chain.length,
      previous: chain.tip,
    })),
  });
}

/** Prospective pure transition; only the certified extension entry may install it. */
export function extendBeaconState(
  value: BeaconState,
  extensions: unknown,
  authority?: SeatAuthorities,
  genesis?: Genesis,
  epoch?: number,
): Result<BeaconState> {
  const state = validateBeaconState(value);
  if (!state.ok) return state;
  const operation = getBeaconExtensionOperation(state.value);
  if (!operation.ok) return operation;
  const signers: ArtifactSigner[] = [];
  for (const participant of operation.value.participants) {
    if (!genesis || epoch === undefined) break;
    const signer = resolveArtifactSigner(authority, genesis, epoch, participant.seat);
    if (!signer.ok) return signer;
    signers.push(signer.value);
  }
  const complete = completeBeaconExtension(
    operation.value,
    extensions,
    signers.length === operation.value.participants.length ? signers : undefined,
  );
  if (!complete.ok) return complete;
  const replacements = new Map(complete.value.commitments.map((item) => [item.seat, item]));
  const chains = state.value.chains.map((chain) => {
    const replacement = replacements.get(chain.seat);
    return replacement ? { ...replacement, index: 0 } : chain;
  });
  return validateBeaconState({
    ...state.value,
    chains,
    active: state.value.active ? { ...state.value.active, participants: chains } : null,
  });
}

/** Prospective pure transition; certification/replay controls when the result is installed. */
export function completeBeaconState(
  value: BeaconState,
  reveals: unknown,
  publicState: GameState,
  entryRef: EntryRef,
  registry: BeaconDerivations = randomDerivations,
  authority?: SeatAuthorities,
  genesis?: Genesis,
  epoch?: number,
): Result<{ state: BeaconState; outcome: BeaconOutcome }> {
  const state = validateBeaconState(value);
  if (!state.ok) return state;
  const operation = getBeaconOperation(state.value);
  if (!operation.ok) return operation;
  const entry = parseCanonical(entryRef, entryRefSchema);
  if (!entry.ok) return entry;
  if (entry.value.seq <= operation.value.anchor.seq)
    return failure('beacon-result-entry', 'Beacon result must follow its frozen request');
  const signers: ArtifactSigner[] = [];
  for (const participant of operation.value.participants) {
    if (!genesis || epoch === undefined) break;
    const signer = resolveArtifactSigner(authority, genesis, epoch, participant.seat);
    if (!signer.ok) return signer;
    signers.push(signer.value);
  }
  const completed = completeBeacon(
    operation.value,
    reveals,
    signers.length === operation.value.participants.length ? signers : undefined,
  );
  if (!completed.ok) return completed;
  const active = state.value.active;
  if (!active) return failure('beacon-inactive', 'No beacon request is pending');
  const derived = registry.derive(
    publicState,
    active.pending,
    fromBase64Url(completed.value.seed),
    operation.value,
  );
  if (!derived.ok) return derived;
  const revealed = new Map(completed.value.reveals.map(({ body }) => [body.seat, body.value]));
  const chains: BeaconChain[] = [];
  for (const chain of state.value.chains) {
    const tip = revealed.get(chain.seat);
    if (!tip) return failure('beacon-incomplete', 'A frozen participant reveal is missing');
    chains.push({ ...chain, index: chain.index + 1, tip });
  }
  const next = validateBeaconState({
    ...state.value,
    chains,
    round: active.round,
    active: null,
    fixed:
      derived.value.kind === 'steal-index'
        ? {
            operation: operation.value,
            seed: completed.value.seed,
            outcome: derived.value,
            entry: entry.value,
          }
        : null,
  });
  return next.ok ? success({ state: next.value, outcome: derived.value }) : next;
}

/** Later certified steal completion clears the marker; it cannot consume tips again. */
export function consumeFixedBeacon(value: BeaconState, fixedEntry: EntryRef): Result<BeaconState> {
  const state = validateBeaconState(value);
  if (!state.ok) return state;
  const expected = parseCanonical(fixedEntry, entryRefSchema);
  if (!expected.ok) return expected;
  const fixed = state.value.fixed;
  if (!fixed || fixed.entry.seq !== expected.value.seq || fixed.entry.hash !== expected.value.hash)
    return failure('beacon-fixed-entry', 'Steal result refers to another fixed beacon');
  return validateBeaconState({ ...state.value, fixed: null });
}
