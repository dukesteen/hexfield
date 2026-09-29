import type { GameState, Resource, Seat } from '@cp2p/engine';
import { RESOURCES } from '@cp2p/engine';
import { boardInfo, productionRates, tradeRates, vertexPips } from './board.js';
import type { BoardInfo, Rates } from './board.js';
import { firstRoadsToward, openSites, roadDistances } from './sites.js';
import { needWeights, vertexScore } from './vertex.js';

export type Cost = Readonly<Record<Resource, number>>;

export const ROAD: Cost = { brick: 1, lumber: 1, wool: 0, grain: 0, ore: 0 };
export const SETTLEMENT: Cost = { brick: 1, lumber: 1, wool: 1, grain: 1, ore: 0 };
export const CITY: Cost = { brick: 0, lumber: 0, wool: 0, grain: 2, ore: 3 };
export const DEV_CARD: Cost = { brick: 0, lumber: 0, wool: 1, grain: 1, ore: 1 };
export const NOTHING: Cost = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };

export type GoalKind = 'city' | 'settlement' | 'devCard' | 'road';

export interface Goal {
  kind: GoalKind;
  /** Everything the goal costs, the roads to reach a settlement site included. */
  cost: Cost;
  /** Victory points it brings. */
  vp: number;
  /** Weighted pips of production it adds. */
  gain: number;
  /** The vertex to settle or upgrade. */
  vertex?: string;
  /** Roads still needed to reach `vertex`. */
  roads?: number;
  /** Edges that start the road toward `vertex`. */
  firstEdges?: ReadonlySet<string>;
  /** Expected turns until the seat can pay (see `turnsToAfford`). */
  turns: number;
  /** Plan score: value per expected turn, strategic bias included. */
  score: number;
}

export interface PlanWeights {
  /** Value of one weighted pip of new production, in victory points. */
  production: number;
  /** Multipliers on each goal kind's value. */
  city: number;
  settlement: number;
  devCard: number;
  /** Turns added to every estimate, so near-equal goals prefer the bigger one. */
  patience: number;
  /** How many roads a settlement goal may need. */
  maxRoads: number;
}

export const DEFAULT_PLAN: PlanWeights = {
  production: 0.07,
  city: 1,
  settlement: 1.05,
  devCard: 0.85,
  patience: 1.5,
  maxRoads: 3,
};

function addCost(a: Cost, b: Cost, times = 1): Cost {
  return {
    brick: a.brick + b.brick * times,
    lumber: a.lumber + b.lumber * times,
    wool: a.wool + b.wool * times,
    grain: a.grain + b.grain * times,
    ore: a.ore + b.ore * times,
  };
}

/** Handles hands that also hold commodities: only the five resources count toward a cost. */
export function resourceHand(hand: Readonly<Record<string, number>>): Rates {
  return {
    brick: hand.brick ?? 0,
    lumber: hand.lumber ?? 0,
    wool: hand.wool ?? 0,
    grain: hand.grain ?? 0,
    ore: hand.ore ?? 0,
  };
}

/** Missing cards for a cost, not counting trades. */
export function shortfall(hand: Readonly<Rates>, cost: Cost): number {
  return RESOURCES.reduce((sum, resource) => sum + Math.max(0, cost[resource] - hand[resource]), 0);
}

/** Whether a hand pays a cost once its surplus is traded at the seat's maritime rates. */
export function affordableWithTrades(
  hand: Readonly<Rates>,
  cost: Cost,
  rates: Readonly<Rates>,
): boolean {
  let deficit = 0;
  let trades = 0;
  for (const resource of RESOURCES) {
    const left = hand[resource] - cost[resource];
    if (left < 0) deficit -= left;
    else trades += Math.floor(left / rates[resource]);
  }
  return deficit <= trades + 1e-9;
}

/**
 * Expected turns (of this seat) until it can pay `cost`, given expected cards per turn and its
 * maritime rates. Zero when it can pay now; capped at `max`.
 */
export function turnsToAfford(
  hand: Readonly<Rates>,
  cost: Cost,
  income: Readonly<Rates>,
  rates: Readonly<Rates>,
  max = 40,
): number {
  if (shortfall(hand, cost) === 0) return 0;
  for (let turns = 0.5; turns <= max; turns += 0.5) {
    const expected = { ...hand };
    for (const resource of RESOURCES) expected[resource] += income[resource] * turns;
    if (affordableWithTrades(expected, cost, rates)) return turns;
  }
  return max;
}

/** Expected cards per own turn: production per roll times the rolls in one round. */
export function incomePerTurn(state: GameState, seat: Seat, info = boardInfo(state)): Rates {
  const perRoll = productionRates(state, seat, info);
  const rolls = state.config.seats.length;
  for (const resource of RESOURCES) perRoll[resource] *= rolls;
  return perRoll;
}

function seatState(state: GameState, seat: Seat) {
  const holder = state.seats.find((item) => item.seat === seat);
  if (!holder) throw new Error(`Seat ${seat} is not in the game`);
  return holder;
}

/** Every build goal the seat could work toward now, scored, best first. */
export function planGoals(
  state: GameState,
  seat: Seat,
  hand: Readonly<Record<string, number>>,
  weights: PlanWeights = DEFAULT_PLAN,
  info: BoardInfo = boardInfo(state),
): Goal[] {
  const holder = seatState(state, seat);
  const own = resourceHand(hand);
  const income = incomePerTurn(state, seat, info);
  const rates = tradeRates(state, seat, info);
  const need = needWeights(state, seat, info);
  const goals: Goal[] = [];
  const finish = (goal: Omit<Goal, 'turns' | 'score'>, multiplier: number): void => {
    const turns = turnsToAfford(own, goal.cost, income, rates);
    const value = (goal.vp + weights.production * goal.gain) * multiplier;
    goals.push({ ...goal, turns, score: value / (turns + weights.patience) });
  };
  const weighted = (vertex: string): number => {
    const pipsAt = vertexPips(info, vertex, null);
    return RESOURCES.reduce((sum, resource) => sum + pipsAt[resource] * need[resource], 0);
  };
  if ((holder.piecesLeft.city ?? 0) > 0) {
    const settlements = state.board.buildings.filter(
      (piece) => piece.seat === seat && piece.kind === 'settlement',
    );
    let best: { vertex: string; gain: number } | null = null;
    for (const piece of settlements) {
      const gain = weighted(piece.vertex);
      if (!best || gain > best.gain) best = { vertex: piece.vertex, gain };
    }
    if (best)
      finish(
        { kind: 'city', cost: CITY, vp: 1, gain: best.gain, vertex: best.vertex },
        weights.city,
      );
  }
  if ((holder.piecesLeft.settlement ?? 0) > 0) {
    const open = openSites(state, info);
    const distances = roadDistances(state, seat, weights.maxRoads, info);
    const roadsLeft = holder.piecesLeft.road ?? 0;
    let best: Goal | null = null;
    for (const vertex of open) {
      const roads = distances.get(vertex);
      if (roads === undefined || roads > roadsLeft) continue;
      const gain = vertexScore(state, seat, vertex, { weights: need, expansion: 0.15 }, info, open);
      const cost = addCost(SETTLEMENT, ROAD, roads);
      const turns = turnsToAfford(own, cost, income, rates);
      const value = (1 + weights.production * gain) * weights.settlement;
      const score = value / (turns + weights.patience);
      if (!best || score > best.score)
        best = {
          kind: 'settlement',
          cost,
          vp: 1,
          gain,
          vertex,
          roads,
          firstEdges: firstRoadsToward(state, seat, vertex, distances, info),
          turns,
          score,
        };
    }
    if (best) goals.push(best);
  }
  if ((state.decks.dev?.remaining ?? 0) > 0)
    finish({ kind: 'devCard', cost: DEV_CARD, vp: 0.5, gain: 0 }, weights.devCard);
  return goals.toSorted((a, b) => b.score - a.score);
}
