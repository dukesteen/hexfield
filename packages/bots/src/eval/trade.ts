import type { GameState, Resource, Seat } from '@cp2p/engine';
import { RESOURCES } from '@cp2p/engine';
import type { Rates } from './board.js';
import type { PointsOf } from './robber.js';
import { resourceHand, shortfall, turnsToAfford } from './plan.js';
import type { Cost } from './plan.js';

type Counts = Readonly<Record<string, number>>;

/** What a hand is worth toward a goal: fewer turns to pay for it is better. */
export interface HandContext {
  cost: Cost;
  income: Readonly<Rates>;
  rates: Readonly<Rates>;
  /** Cards above this total risk a discard on a seven. */
  safeCards?: number;
  /** Value of a card that is not a base resource (a commodity), in the same units. */
  otherKind?: number;
  /** The score's coefficients (`DEFAULT_HAND` when absent). */
  weights?: HandWeights;
}

/** Coefficients of `handScore` besides the expected turns. */
export interface HandWeights {
  /** Penalty per card still missing for the goal. */
  shortfall: number;
  /** Value of any card held. */
  card: number;
  /** Penalty per card above the safe total. */
  risky: number;
}

export const DEFAULT_HAND: HandWeights = { shortfall: 0.35, card: 0.04, risky: 0.18 };

/**
 * The value of a hand toward the goal: minus the expected turns to afford it, minus a little per
 * missing card (so a hand one card closer ranks above an equally slow one), plus a small value per
 * spare card, less a penalty for cards a seven would cost.
 */
export function handScore(hand: Counts, context: HandContext): number {
  const resources = resourceHand(hand);
  const turns = turnsToAfford(resources, context.cost, context.income, context.rates, 30);
  let cards = 0;
  let others = 0;
  for (const [kind, count] of Object.entries(hand)) {
    cards += count;
    if (!(RESOURCES as readonly string[]).includes(kind)) others += count;
  }
  const risky = Math.max(0, cards - (context.safeCards ?? 7));
  const weights = context.weights ?? DEFAULT_HAND;
  return (
    -turns -
    weights.shortfall * shortfall(resources, context.cost) +
    weights.card * cards +
    (context.otherKind ?? 0.1) * others -
    weights.risky * risky
  );
}

function applyTrade(hand: Counts, gets: Counts, gives: Counts): Record<string, number> {
  const next: Record<string, number> = { ...hand };
  for (const [kind, count] of Object.entries(gives)) next[kind] = (next[kind] ?? 0) - count;
  for (const [kind, count] of Object.entries(gets)) next[kind] = (next[kind] ?? 0) + count;
  return next;
}

/** How much a trade improves the hand (negative when it hurts). Null when the hand cannot pay. */
export function tradeGain(
  hand: Counts,
  gets: Counts,
  gives: Counts,
  context: HandContext,
): number | null {
  if (Object.entries(gives).some(([kind, count]) => (hand[kind] ?? 0) < count)) return null;
  return handScore(applyTrade(hand, gets, gives), context) - handScore(hand, context);
}

/** The marginal value of one more card of each resource toward the goal. */
export function resourceValues(hand: Counts, context: HandContext): Rates {
  const base = handScore(hand, context);
  const values = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
  for (const resource of RESOURCES)
    values[resource] =
      handScore({ ...hand, [resource]: (hand[resource] ?? 0) + 1 }, context) - base;
  return values;
}

export interface TradePolicy {
  /** The least gain worth trading for. */
  threshold: number;
  /** Victory points from the target at which a partner counts as dangerous. */
  dangerMargin: number;
  /** The gain needed to trade with a dangerous partner anyway. */
  dangerThreshold: number;
}

export const DEFAULT_TRADE_POLICY: TradePolicy = {
  threshold: 0.25,
  dangerMargin: 2,
  dangerThreshold: 2.5,
};

/** Whether a partner is close enough to winning that helping them is a risk. */
export function dangerous(
  state: GameState,
  partner: Seat,
  target: number,
  margin: number,
  points?: PointsOf,
): boolean {
  if (points) return points(partner) >= target - margin;
  const holder = state.seats.find((item) => item.seat === partner);
  return (holder?.publicVp ?? 0) >= target - margin;
}

/** Accept a trade when it helps enough, and much more when the partner is near winning. */
export function acceptsTrade(
  state: GameState,
  hand: Counts,
  gets: Counts,
  gives: Counts,
  partner: Seat,
  target: number,
  context: HandContext,
  policy: TradePolicy = DEFAULT_TRADE_POLICY,
  points?: PointsOf,
): boolean {
  const gain = tradeGain(hand, gets, gives, context);
  if (gain === null) return false;
  const needed = dangerous(state, partner, target, policy.dangerMargin, points)
    ? policy.dangerThreshold
    : policy.threshold;
  return gain >= needed;
}

/** The value lost by giving up one card of each resource the hand holds (Infinity when it has none). */
export function spareCosts(hand: Counts, context: HandContext): Rates {
  const base = handScore(hand, context);
  const costs = {
    brick: Infinity,
    lumber: Infinity,
    wool: Infinity,
    grain: Infinity,
    ore: Infinity,
  };
  for (const resource of RESOURCES) {
    const held = hand[resource] ?? 0;
    if (held > 0) costs[resource] = base - handScore({ ...hand, [resource]: held - 1 }, context);
  }
  return costs;
}

/** The single resource the hand most wants and the held card it misses least. */
export function wantAndSpare(
  hand: Counts,
  context: HandContext,
): { want: Resource; spare: Resource; wantValue: number; spareValue: number } | null {
  const values = resourceValues(hand, context);
  const costs = spareCosts(hand, context);
  let want: Resource | null = null;
  let spare: Resource | null = null;
  for (const resource of RESOURCES) {
    if (!want || values[resource] > values[want]) want = resource;
    if (costs[resource] !== Infinity && (!spare || costs[resource] < costs[spare]))
      spare = resource;
  }
  if (!want || !spare || want === spare) return null;
  return { want, spare, wantValue: values[want], spareValue: costs[spare] };
}
