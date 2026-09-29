import type { GameState, PrivateState, Seat } from '@cp2p/engine';
import { devCardCountsFor } from '@cp2p/engine';
import type { PointsOf } from './robber.js';

/**
 * Development cards no seat has shown, from one seat's view: the deck's composition less every
 * revealed or publicly known card and the viewer's own cards.
 */
export function unseenDevCards(state: GameState, priv: PrivateState): Record<string, number> {
  const counts: Record<string, number> = { ...devCardCountsFor(state.config) };
  for (const holder of state.seats)
    for (const slot of holder.cardSlots) {
      if (slot.deck !== 'dev') continue;
      const known =
        slot.revealed ??
        slot.known ??
        (holder.seat === priv.seat ? priv.slots[slot.slotId] : undefined);
      if (known !== undefined) counts[known] = (counts[known] ?? 0) - 1;
    }
  return counts;
}

/**
 * Each seat's points as the viewer can estimate them from public information: public points plus,
 * for every unplayed development card, the chance it is a victory point (from the cards not yet
 * seen). The viewer's own hidden points are exact.
 */
export function estimatedPoints(state: GameState, priv: PrivateState): PointsOf {
  const unseen = unseenDevCards(state, priv);
  const total = Object.values(unseen).reduce((sum, count) => sum + Math.max(0, count), 0);
  const chance = total > 0 ? Math.max(0, unseen.victoryPoint ?? 0) / total : 0;
  const points = new Map<Seat, number>();
  for (const holder of state.seats) {
    let hidden = 0;
    for (const slot of holder.cardSlots) {
      if (slot.deck !== 'dev' || slot.revealed !== undefined) continue;
      if (holder.seat === priv.seat) hidden += priv.slots[slot.slotId] === 'victoryPoint' ? 1 : 0;
      else if (slot.known !== undefined) hidden += slot.known === 'victoryPoint' ? 1 : 0;
      else hidden += chance;
    }
    points.set(holder.seat, holder.publicVp + hidden);
  }
  return (seat) => points.get(seat) ?? 0;
}
