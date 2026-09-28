import { changed, plainCard } from './card.js';
import type { CardModule } from './card.js';

/**
 * Constitution: a victory card worth 1 point, shown the moment it is drawn (see the Printer). The
 * point is counted by the module's `victoryPoints` hook from the revealed slot.
 */
export const constitution: CardModule = {
  card: plainCard({
    id: 'constitution',
    timing: 'main',
    apply: (state, seat) =>
      changed(state, { type: 'victoryCardShown', seat, card: 'constitution' }),
  }),
};
