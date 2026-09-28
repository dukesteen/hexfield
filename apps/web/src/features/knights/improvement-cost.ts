import { TRACK_COMMODITY, improvementCost } from '@cp2p/engine';
import type { GameState, Seat, Track } from '@cp2p/engine';

/** How many commodities the next level of a track costs a seat (its next level number). */
export function improvementCostOf(state: Readonly<GameState>, seat: Seat, track: Track): number {
  // The engine reads the state and never writes it.
  const cost = improvementCost(state as GameState, seat, track);
  return cost[TRACK_COMMODITY[track]] ?? 0;
}
