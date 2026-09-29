import type { GameState, Seat } from '@cp2p/engine';
import { boardInfo, pips } from './board.js';

/** How much a seat's production matters to this bot: more for leaders, most for near-winners. */
export function threatWeight(state: GameState, seat: Seat, me: Seat, target: number): number {
  const vp = (holder: Seat): number =>
    state.seats.find((item) => item.seat === holder)?.publicVp ?? 0;
  const lead = vp(seat) - vp(me);
  return 1 + Math.max(0, lead) * 0.3 + (vp(seat) >= target - 2 ? 1 : 0) + vp(seat) * 0.05;
}

/**
 * Score a robber hex: the production it takes from opponents (weighted by how threatening each
 * one is), minus twice what it takes from the bot itself, plus a little for having someone with
 * cards to steal from.
 */
export function robberHexScore(state: GameState, me: Seat, hex: string, target: number): number {
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
    if (building.seat === me) score -= 2 * amount;
    else {
      score += amount * threatWeight(state, building.seat, me, target);
      const cards = state.seats.find((item) => item.seat === building.seat)?.resources.total ?? 0;
      if (cards > 0) steal = Math.max(steal, 1 + Math.min(cards, 8) * 0.15);
    }
  }
  return score + steal;
}

/** The victim to steal from: the leader, then the seat with the most cards. */
export function stealScore(state: GameState, me: Seat, victim: Seat, target: number): number {
  const holder = state.seats.find((item) => item.seat === victim);
  const cards = holder?.resources.total ?? 0;
  if (cards === 0) return -1;
  return threatWeight(state, victim, me, target) * 2 + Math.min(cards, 10) * 0.3;
}
