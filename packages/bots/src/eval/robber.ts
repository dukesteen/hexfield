import type { GameState, Seat } from '@cp2p/engine';
import { boardInfo, pips } from './board.js';

/** How the robber and steal choices weigh opponents (see `threatWeight`). */
export interface RobberWeights {
  /** Extra weight per point an opponent leads the bot by. */
  lead: number;
  /** Extra weight for an opponent within `nearMargin` points of the target. */
  near: number;
  nearMargin: number;
  /** Extra weight per point an opponent holds. */
  vp: number;
  /** Multiplier on the bot's own production a robber hex would block. */
  own: number;
  /** Steal choice: weight of the victim's threat against its hand size. */
  stealThreat: number;
}

export const DEFAULT_ROBBER: RobberWeights = {
  lead: 0.3,
  near: 1,
  nearMargin: 2,
  vp: 0.05,
  own: 2,
  stealThreat: 2,
};

/** A seat's points as the bot sees them: public points unless an estimate is supplied. */
export type PointsOf = (seat: Seat) => number;

export function publicPoints(state: GameState): PointsOf {
  return (holder) => state.seats.find((item) => item.seat === holder)?.publicVp ?? 0;
}

/** How much a seat's production matters to this bot: more for leaders, most for near-winners. */
export function threatWeight(
  state: GameState,
  seat: Seat,
  me: Seat,
  target: number,
  weights: RobberWeights = DEFAULT_ROBBER,
  points: PointsOf = publicPoints(state),
): number {
  const lead = points(seat) - points(me);
  return (
    1 +
    Math.max(0, lead) * weights.lead +
    (points(seat) >= target - weights.nearMargin ? weights.near : 0) +
    points(seat) * weights.vp
  );
}

/**
 * Score a robber hex: the production it takes from opponents (weighted by how threatening each
 * one is), minus what it takes from the bot itself (twice by default), plus a little for having
 * someone with cards to steal from.
 */
export function robberHexScore(
  state: GameState,
  me: Seat,
  hex: string,
  target: number,
  weights: RobberWeights = DEFAULT_ROBBER,
  points?: PointsOf,
): number {
  const info = boardInfo(state);
  const token = state.board.hexes.find((item) => item.id === hex)?.token;
  const weight = pips(token);
  const index = info.graph.hexIndex[hex];
  const vertices = new Set<string>(
    index === undefined ? [] : (info.graph.hexVertices[index] ?? []),
  );
  let score = 0;
  let steal = 0;
  for (const building of state.board.buildings) {
    if (!vertices.has(building.vertex)) continue;
    const amount = weight * (building.kind === 'settlement' ? 1 : 2);
    if (building.seat === me) score -= weights.own * amount;
    else {
      score += amount * threatWeight(state, building.seat, me, target, weights, points);
      const cards = state.seats.find((item) => item.seat === building.seat)?.resources.total ?? 0;
      if (cards > 0) steal = Math.max(steal, 1 + Math.min(cards, 8) * 0.15);
    }
  }
  return score + steal;
}

/** The victim to steal from: the leader, then the seat with the most cards. */
export function stealScore(
  state: GameState,
  me: Seat,
  victim: Seat,
  target: number,
  weights: RobberWeights = DEFAULT_ROBBER,
  points?: PointsOf,
): number {
  const holder = state.seats.find((item) => item.seat === victim);
  const cards = holder?.resources.total ?? 0;
  if (cards === 0) return -1;
  return (
    threatWeight(state, victim, me, target, weights, points) * weights.stealThreat +
    Math.min(cards, 10) * 0.3
  );
}
