import { canAfford, gainKnown, loseKnown } from '../../core/resources/index.js';
import type { ResourceBounds } from '../../core/resources/index.js';
import type { GameState, PhaseFrame, PrivateState, SeatState } from '../../core/state/index.js';
import type { Pending, TimerSpec } from '../../core/pipeline/index.js';
import type { HandlerContext } from '../../core/modules/index.js';
import { RESOURCES, failure, success } from '../../core/types/index.js';
import type { Resource, ResourceCounts, Result, Seat } from '../../core/types/index.js';
import { emptyResources } from './constants.js';
import { baseExt, baseOptions } from './types.js';
import type { BaseExt } from './types.js';

export function top(state: GameState): PhaseFrame {
  const activePhase = state.turn.phase.at(-1);
  if (!activePhase || activePhase.module !== 'base') throw new Error('Expected a base phase');
  return activePhase;
}

export function replaceTop(state: GameState, nextPhase: PhaseFrame): GameState {
  return {
    ...state,
    turn: { ...state.turn, phase: [...state.turn.phase.slice(0, -1), nextPhase] },
  };
}

export function pushPhase(state: GameState, nextPhase: PhaseFrame): GameState {
  return { ...state, turn: { ...state.turn, phase: [...state.turn.phase, nextPhase] } };
}

export function popPhase(state: GameState): GameState {
  return { ...state, turn: { ...state.turn, phase: state.turn.phase.slice(0, -1) } };
}

export function frame(id: string, data: unknown = null): PhaseFrame {
  return { id, module: 'base', data };
}

export function ownSeat(state: GameState, seat: Seat): SeatState {
  const found = state.seats.find((item) => item.seat === seat);
  if (!found) throw new Error(`Missing seat ${seat}`);
  return found;
}

export function updateSeat(
  state: GameState,
  seat: Seat,
  change: (old: SeatState) => SeatState,
): GameState {
  return { ...state, seats: state.seats.map((item) => (item.seat === seat ? change(item) : item)) };
}

export function updateBase(state: GameState, change: (old: BaseExt) => BaseExt): GameState {
  return { ...state, ext: { ...state.ext, base: change(baseExt(state.ext.base)) } };
}

export function isResource(value: unknown): value is Resource {
  switch (value) {
    case 'brick':
    case 'lumber':
    case 'wool':
    case 'grain':
    case 'ore':
      return true;
    default:
      return false;
  }
}

/** Accept partial command maps and fill omitted base-resource keys with zero. */
export function parseCounts(value: unknown): Result<ResourceCounts> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return failure('invalid-counts', 'Resource counts must be an object');
  }
  const counts = emptyResources();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !isResource(key))
      return failure('invalid-resource', `Unknown resource ${String(key)}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'number' ||
      !Number.isSafeInteger(descriptor.value) ||
      descriptor.value < 0
    ) {
      return failure('invalid-counts', `Count for ${key} must be a non-negative integer`);
    }
    counts[key] = descriptor.value;
  }
  return success(counts);
}

export function countTotal(counts: ResourceCounts): number {
  return RESOURCES.reduce((total, resource) => total + counts[resource], 0);
}

export function affordable(state: GameState, seat: Seat, cost: ResourceCounts): Result<void> {
  const possible = canAfford(ownSeat(state, seat).resources, cost);
  if (!possible.ok) return possible;
  return possible.value
    ? success(undefined)
    : failure('insufficient-resources', 'Seat cannot afford the cost');
}

function changedBounds(
  bounds: ResourceBounds,
  counts: ResourceCounts,
  gain: boolean,
): ResourceBounds {
  const result = gain ? gainKnown(bounds, counts) : loseKnown(bounds, counts);
  if (!result.ok) throw new Error(`Validated resource update failed: ${result.error.code}`);
  return result.value;
}

/** Transfer publicly known cards between a seat and the bank. */
export function exchangeBank(
  state: GameState,
  seat: Seat,
  counts: ResourceCounts,
  gain: boolean,
): GameState {
  const bank = { ...state.bank };
  for (const kind of RESOURCES) {
    const next = (bank[kind] ?? 0) + (gain ? -counts[kind] : counts[kind]);
    if (next < 0) throw new Error(`Bank lacks ${kind}`);
    bank[kind] = next;
  }
  return updateSeat({ ...state, bank }, seat, (old) => ({
    ...old,
    resources: changedBounds(old.resources, counts, gain),
  }));
}

export function privateExchange(
  priv: PrivateState,
  counts: ResourceCounts,
  gain: boolean,
): Result<PrivateState> {
  const hand = { ...priv.hand };
  for (const kind of RESOURCES) {
    const next = (hand[kind] ?? 0) + (gain ? counts[kind] : -counts[kind]);
    if (next < 0) return failure('private-insufficient-resources', `Private hand lacks ${kind}`);
    hand[kind] = next;
  }
  return success({ ...priv, hand });
}

export function bankHas(state: GameState, counts: ResourceCounts): boolean {
  return RESOURCES.every((kind) => (state.bank[kind] ?? 0) >= counts[kind]);
}

export function buildCost(
  state: GameState,
  buildType: string,
  baseCost: ResourceCounts,
  ctx: HandlerContext,
): Result<ResourceCounts> {
  return parseCounts(ctx.hooks.costOf(state, buildType, baseCost));
}

export function timer(state: GameState, phase: string): TimerSpec | undefined {
  const setting = baseOptions(state.config.options.base).turnTimer;
  if (!setting) return undefined;
  const seconds =
    phase === 'preRoll'
      ? setting.preRollSec
      : phase === 'main' || phase === 'roadBuilding'
        ? setting.mainSec
        : phase === 'discard'
          ? setting.discardSec
          : setting.robberSec;
  return { phase, seconds };
}

export function playerPending(
  state: GameState,
  seat: Seat,
  allowed: string[],
  phase: string,
): Pending {
  const deadline = timer(state, phase);
  return deadline ? { kind: 'player', seat, allowed, deadline } : { kind: 'player', seat, allowed };
}

/** Hidden VP claims remain available during every turn interrupt. */
export function withClaim(state: GameState, pending: Pending[]): Pending[] {
  if (top(state).id === 'setup') return pending;
  const seat = state.turn.activeSeat;
  const existing = pending.find((item) => item.kind === 'player' && item.seat === seat);
  if (existing?.kind === 'player') {
    return pending.map((item) =>
      item === existing ? { ...item, allowed: [...item.allowed, 'CLAIM_VICTORY'] } : item,
    );
  }
  return [...pending, { kind: 'player', seat, allowed: ['CLAIM_VICTORY'] }];
}

export function afterInput(state: GameState): GameState {
  let next = state;
  const offers = baseExt(state.ext.base).offers;
  if (offers.length) {
    let changed = false;
    const checked = offers.map((offer) => {
      const possible = canAfford(ownSeat(next, offer.proposer).resources, offer.give);
      const valid = possible.ok && possible.value;
      if (valid === offer.valid) return offer;
      changed = true;
      return { ...offer, valid };
    });
    if (changed) next = updateBase(next, (old) => ({ ...old, offers: checked }));
  }
  const buildingVp = new Map<Seat, number>();
  for (const building of next.board.buildings)
    buildingVp.set(
      building.seat,
      (buildingVp.get(building.seat) ?? 0) + (building.kind === 'city' ? 2 : 1),
    );
  let seatsChanged = false;
  const seats = next.seats.map((seat) => {
    const awards =
      (next.awards.longestRoad === seat.seat ? 2 : 0) +
      (next.awards.largestArmy === seat.seat ? 2 : 0);
    let revealed = 0;
    for (const slot of seat.cardSlots) if (slot.revealed === 'victoryPoint') revealed++;
    const publicVp = (buildingVp.get(seat.seat) ?? 0) + awards + revealed;
    if (publicVp === seat.publicVp) return seat;
    seatsChanged = true;
    return { ...seat, publicVp };
  });
  if (seatsChanged) next = { ...next, seats };
  const active = ownSeat(next, next.turn.activeSeat);
  const options = baseOptions(next.config.options.base);
  if (!next.result && top(next).id !== 'setup' && active.publicVp >= options.vpTarget) {
    next = {
      ...next,
      result: { winner: active.seat, reason: 'public-vp', atTurn: next.turn.number },
    };
  }
  return next;
}
