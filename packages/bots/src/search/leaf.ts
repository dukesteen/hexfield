import type { Engine, GameState, PrivateState, Seat } from '@cp2p/engine';
import { RESOURCES } from '@cp2p/engine';
import { boardInfo, planGoals, productionRates, tradeRates } from '../eval/index.js';
import type { PlanWeights } from '../eval/index.js';

/**
 * How well a seat stands in a (sampled) position, in victory-point units: its points, plus its
 * production (a settlement's worth of pips is about one point of future value), its cards in hand
 * up to the seven-card limit, its unplayed development cards and its harbors.
 */
export function standing(
  engine: Engine,
  state: GameState,
  seat: Seat,
  priv: PrivateState | undefined,
): number {
  const points = engine.computeVictoryPoints(state, seat, priv);
  const vp = points.total ?? points.public;
  const info = boardInfo(state);
  const rates = productionRates(state, seat, info);
  let production = 0;
  let kinds = 0;
  for (const resource of RESOURCES) {
    production += rates[resource] * 36;
    if (rates[resource] > 0) kinds++;
  }
  const holder = state.seats.find((item) => item.seat === seat);
  const cards = holder?.resources.total ?? 0;
  const devCards =
    holder?.cardSlots.filter((slot) => slot.deck === 'dev' && !slot.revealed).length ?? 0;
  const harbors = Object.values(tradeRates(state, seat, info)).filter((rate) => rate < 4).length;
  return (
    vp +
    0.075 * production +
    0.12 * kinds +
    0.08 * Math.min(cards, 7) -
    0.05 * Math.max(0, cards - 7) +
    0.3 * devCards +
    0.06 * harbors
  );
}

/**
 * The value of a leaf for `seat`: a decisive win or loss when the game ended, otherwise its
 * standing minus the best opponent's, so the search prefers positions that lead the table.
 */
export function leafValue(
  engine: Engine,
  state: GameState,
  privates: ReadonlyMap<Seat, PrivateState>,
  seat: Seat,
): number {
  if (state.result) return state.result.winner === seat ? 10 : -10;
  const mine = standing(engine, state, seat, privates.get(seat));
  let rival = -Infinity;
  for (const holder of state.seats)
    if (holder.seat !== seat)
      rival = Math.max(rival, standing(engine, state, holder.seat, privates.get(holder.seat)));
  return mine - rival;
}

/** Weights of the lookahead's leaf evaluation (see `positionValue`). */
export interface LeafWeights {
  /** Points per expected turn until the seat's hand pays for its best goal (a delay costs). */
  plan: number;
  /** Weight of the best opponent's standing (1: the bot's lead over it). */
  rival: number;
}

export const DEFAULT_LEAF: LeafWeights = { plan: 0.4, rival: 1 };

/**
 * A static evaluation for a short lookahead, in victory-point units: the seat's standing, less
 * the expected turns until its hand pays for its best goal (at `plan` points a turn), less the
 * best opponent's standing.
 */
export function positionValue(
  engine: Engine,
  state: GameState,
  privates: ReadonlyMap<Seat, PrivateState>,
  seat: Seat,
  plan: PlanWeights,
  weights: LeafWeights = DEFAULT_LEAF,
): number {
  if (state.result) return state.result.winner === seat ? 10 : -10;
  const priv = privates.get(seat);
  const info = boardInfo(state);
  const goal = priv ? planGoals(state, seat, priv.hand, plan, info)[0] : undefined;
  const mine = standing(engine, state, seat, priv) - weights.plan * Math.min(goal?.turns ?? 0, 10);
  let rival = -Infinity;
  for (const holder of state.seats)
    if (holder.seat !== seat)
      rival = Math.max(rival, standing(engine, state, holder.seat, privates.get(holder.seat)));
  return mine - weights.rival * rival;
}
