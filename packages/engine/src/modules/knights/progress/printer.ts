import { changed, plainCard } from './card.js';
import type { CardModule } from './card.js';

/**
 * Printer (Printing): a victory card worth 1 point. It is shown the moment it is drawn, so playing
 * it later only happens for a card a drawer kept hidden. The point is counted by the module's
 * `victoryPoints` hook from the revealed slot.
 */
export const printer: CardModule = {
  card: plainCard({
    id: 'printer',
    timing: 'main',
    apply: (state, seat) => changed(state, { type: 'victoryCardShown', seat, card: 'printer' }),
  }),
};
