import { failure, success } from '../../../core/types/index.js';
import { knightsOf, setKnights } from '../pieces.js';
import { changed, plainCard } from './card.js';
import type { CardModule } from './card.js';

/**
 * Warlord (Encouragement): activate all of your knights for free. A knight that was inactive when
 * the action phase began still cannot act this turn: activation never makes a knight ready.
 */
export const warlord: CardModule = {
  card: plainCard({
    id: 'warlord',
    timing: 'main',
    problem: (state, seat) =>
      knightsOf(state, seat).some((knight) => !knight.active)
        ? success(undefined)
        : failure('nothing-to-activate', 'You have no inactive knight'),
    apply: (state, seat) =>
      changed(
        setKnights(state, (list) =>
          list.map((knight) => (knight.seat === seat ? { ...knight, active: true } : knight)),
        ),
        { type: 'knightsActivated', seat },
      ),
  }),
};
