import {
  canAfford,
  gainKnown,
  kindsOfCounts,
  kindBounds,
  loseKnown,
  seatBounds,
  zeroCounts,
} from '../../core/resources/index.js';
import type { ResourceBounds } from '../../core/resources/index.js';
import type { GameState, PhaseFrame, PrivateState, SeatState } from '../../core/state/index.js';
import type { Pending, TimerSpec } from '../../core/pipeline/index.js';
import type { HandlerContext, Transition } from '../../core/modules/index.js';
import type { EngineEffect, ResourceEndpoint } from '../../core/effects/index.js';
import { RESOURCES, failure, success } from '../../core/types/index.js';
import type { CardCounts, Resource, ResourceCounts, Result, Seat } from '../../core/types/index.js';
import { BASE_COSTS } from './constants.js';
import { baseExt, baseOptions } from './types.js';
import type { BaseExt } from './types.js';

/** The top frame, whichever module owns it. */
export function topFrame(state: GameState): PhaseFrame | undefined {
  return state.turn.phase.at(-1);
}

/**
 * True while module turn-flow frames (such as a special build phase) run between turns.
 * The ending seat can no longer win or claim, and nobody else is active yet.
 */
export function inTurnFlow(state: GameState): boolean {
  return state.turn.phase.some((item) => item.module === 'base' && item.id === 'turnEnd');
}

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

/** The card kinds in play: base resources plus module kinds, read from the bank's keys. */
export function cardKindsOf(state: Pick<GameState, 'bank'>): readonly string[] {
  return kindsOfCounts(state.bank);
}

/** Accept partial command maps and fill omitted base-resource keys with zero. */
export function parseCounts(value: unknown): Result<ResourceCounts> {
  const parsed = parseCardCounts(value, RESOURCES);
  if (!parsed.ok) return parsed;
  return success({
    brick: parsed.value.brick ?? 0,
    lumber: parsed.value.lumber ?? 0,
    wool: parsed.value.wool ?? 0,
    grain: parsed.value.grain ?? 0,
    ore: parsed.value.ore ?? 0,
  });
}

/** Like `parseCounts` for any card kinds, such as a game with commodities. */
export function parseCardCounts(value: unknown, kinds: readonly string[]): Result<CardCounts> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return failure('invalid-counts', 'Resource counts must be an object');
  }
  const counts: Record<string, number> = { ...zeroCounts(kinds) };
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !kinds.includes(key))
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

export function countTotal(counts: CardCounts): number {
  let total = 0;
  for (const count of Object.values(counts)) total += count;
  return total;
}

/** Counts over exactly the given kinds, omitted kinds being zero. A kind outside them is a bug. */
export function fillCounts(counts: CardCounts, kinds: readonly string[]): Record<string, number> {
  const filled: Record<string, number> = { ...zeroCounts(kinds) };
  for (const [kind, count] of Object.entries(counts)) {
    if (!kinds.includes(kind)) {
      if (count === 0) continue;
      throw new Error(`Card kind ${kind} is not part of this game`);
    }
    filled[kind] = count;
  }
  return filled;
}

export function affordable(state: GameState, seat: Seat, cost: CardCounts): Result<void> {
  const kinds = cardKindsOf(state);
  const possible = canAfford(
    kindBounds(ownSeat(state, seat).resources),
    fillCounts(cost, kinds),
    kinds,
  );
  if (!possible.ok) return possible;
  return possible.value
    ? success(undefined)
    : failure('insufficient-resources', 'Seat cannot afford the cost');
}

function changedBounds(
  bounds: ResourceBounds<string>,
  counts: CardCounts,
  gain: boolean,
  kinds: readonly string[],
): ResourceBounds<string> {
  const filled = fillCounts(counts, kinds);
  const result = gain ? gainKnown(bounds, filled, kinds) : loseKnown(bounds, filled, kinds);
  if (!result.ok) throw new Error(`Validated resource update failed: ${result.error.code}`);
  return result.value;
}

/** Record the gross movements used by the caller's resource update. */
export function resourceTransfers(
  from: ResourceEndpoint,
  to: ResourceEndpoint,
  counts: CardCounts,
): EngineEffect[] {
  return kindsOfCounts(counts).flatMap((resource) => {
    const count = counts[resource] ?? 0;
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error(`Invalid ${resource} transfer count`);
    return count === 0 ? [] : [{ type: 'resource-transfer' as const, from, to, resource, count }];
  });
}

/** Transfer publicly known cards between a seat and the bank. */
export function exchangeBank(
  state: GameState,
  seat: Seat,
  counts: CardCounts,
  gain: boolean,
): { state: GameState; effects: EngineEffect[] } {
  const kinds = cardKindsOf(state);
  const bank = { ...state.bank };
  for (const kind of kinds) {
    const next = (bank[kind] ?? 0) + (gain ? -(counts[kind] ?? 0) : (counts[kind] ?? 0));
    if (next < 0) throw new Error(`Bank lacks ${kind}`);
    bank[kind] = next;
  }
  const next = updateSeat({ ...state, bank }, seat, (old) => ({
    ...old,
    resources: seatBounds(changedBounds(old.resources, counts, gain, kinds)),
  }));
  const owner: ResourceEndpoint = { kind: 'seat', seat };
  const bankEndpoint: ResourceEndpoint = { kind: 'bank' };
  return {
    state: next,
    effects: resourceTransfers(gain ? bankEndpoint : owner, gain ? owner : bankEndpoint, counts),
  };
}

export function privateExchange(
  priv: PrivateState,
  counts: CardCounts,
  gain: boolean,
): Result<PrivateState> {
  const hand = { ...priv.hand };
  for (const kind of kindsOfCounts(priv.hand)) {
    const change = counts[kind] ?? 0;
    const next = (hand[kind] ?? 0) + (gain ? change : -change);
    if (next < 0) return failure('private-insufficient-resources', `Private hand lacks ${kind}`);
    hand[kind] = next;
  }
  return success({ ...priv, hand });
}

export function bankHas(state: GameState, counts: CardCounts): boolean {
  return Object.entries(counts).every(([kind, count]) => (state.bank[kind] ?? 0) >= count);
}

/** Build cost from the config-level costs table, then state-dependent costOf adjustments. */
export function buildCost(
  state: GameState,
  buildType: string,
  ctx: HandlerContext,
): Result<CardCounts> {
  const listed = ctx.hooks.costs(state.config, BASE_COSTS)[buildType];
  if (!listed) return failure('unknown-build-type', `No cost for ${buildType}`);
  return parseCardCounts(ctx.hooks.costOf(state, buildType, listed), cardKindsOf(state));
}

/** Victory target after scenario and module overrides. */
export function vpTarget(state: GameState, ctx: HandlerContext): number {
  return ctx.hooks.vpTarget(state.config, baseOptions(state.config.options.base).vpTarget);
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
  if (topFrame(state)?.id === 'setup' || inTurnFlow(state)) return pending;
  const seat = state.turn.activeSeat;
  const existing = pending.find((item) => item.kind === 'player' && item.seat === seat);
  if (existing?.kind === 'player') {
    return pending.map((item) =>
      item === existing ? { ...item, allowed: [...item.allowed, 'CLAIM_VICTORY'] } : item,
    );
  }
  return [...pending, { kind: 'player', seat, allowed: ['CLAIM_VICTORY'] }];
}

/** Run the post-input checks (offers, public points, victory) and report a game end. */
export function finalize(transition: Transition, ctx: HandlerContext): Transition {
  const state = afterInput(transition.state, ctx);
  if (!transition.state.result && state.result) {
    return {
      state,
      events: [
        ...transition.events,
        { type: 'gameEnded', winner: state.result.winner, reason: state.result.reason },
      ],
      effects: transition.effects,
    };
  }
  return { ...transition, state };
}

export function afterInput(state: GameState, ctx: HandlerContext): GameState {
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
    const folded = ctx.hooks
      .victoryPoints(next, seat.seat, undefined, [])
      .reduce((sum, item) => (item.public && item.stored === true ? sum + item.points : sum), 0);
    const publicVp = (buildingVp.get(seat.seat) ?? 0) + awards + revealed + folded;
    if (publicVp === seat.publicVp) return seat;
    seatsChanged = true;
    return { ...seat, publicVp };
  });
  if (seatsChanged) next = { ...next, seats };
  const active = ownSeat(next, next.turn.activeSeat);
  if (
    !next.result &&
    topFrame(next)?.id !== 'setup' &&
    !inTurnFlow(next) &&
    active.publicVp >= vpTarget(next, ctx)
  ) {
    next = {
      ...next,
      result: { winner: active.seat, reason: 'public-vp', atTurn: next.turn.number },
    };
  }
  return next.result ? next : ctx.hooks.afterInput(next);
}
