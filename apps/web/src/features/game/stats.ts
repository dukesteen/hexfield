import { RESOURCES, type GameEvent, type GameState, type Seat } from '@cp2p/engine';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function diceHistogram(
  events: readonly GameEvent[],
): readonly { roll: number; count: number }[] {
  const counts = Array.from({ length: 11 }, (_, index) => ({ roll: index + 2, count: 0 }));
  for (const event of events) {
    if (event.type !== 'diceRolled' || typeof event.roll !== 'number') continue;
    const bin = counts[event.roll - 2];
    if (bin) bin.count += 1;
  }
  return counts;
}

/** Counts known production events; trades and private gains are excluded by definition. */
export function productionBySeat(events: readonly GameEvent[], seat: Seat): number {
  let total = 0;
  for (const event of events) {
    if (event.type !== 'resourcesProduced' || !record(event.bySeat)) continue;
    const gains = event.bySeat[String(seat)];
    if (!record(gains)) continue;
    for (const resource of RESOURCES) {
      const count = gains[resource];
      if (typeof count === 'number') total += count;
    }
  }
  return total;
}

export function victoryBreakdown(state: GameState, seat: Seat, hidden: number | null) {
  const buildings = state.board.buildings.reduce(
    (points, item) => points + (item.seat === seat ? (item.kind === 'city' ? 2 : 1) : 0),
    0,
  );
  const awards =
    (state.awards.longestRoad === seat ? 2 : 0) + (state.awards.largestArmy === seat ? 2 : 0);
  const publicSeat = state.seats.find((item) => item.seat === seat);
  const revealed =
    publicSeat?.cardSlots.filter((slot) => slot.revealed === 'victoryPoint').length ?? 0;
  return {
    buildings,
    awards,
    revealed,
    hidden,
    total: hidden === null ? null : buildings + awards + revealed + hidden,
  };
}
