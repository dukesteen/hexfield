import type { GameState, TradeOffer } from '@cp2p/engine';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The open player-trade offers in a state. */
export function openOffers(state: GameState): TradeOffer[] {
  const base = state.ext.base;
  const offers = record(base) ? base.offers : undefined;
  // The engine owns this shape; the reader only skips what it cannot use.
  return Array.isArray(offers)
    ? offers.filter((offer): offer is TradeOffer => record(offer) && typeof offer.id === 'number')
    : [];
}
