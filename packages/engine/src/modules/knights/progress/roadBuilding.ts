import { failure, success } from '../../../core/types/index.js';
import { freePlacements } from '../../base/devcards.js';
import { frame, pushPhase } from '../../base/shared.js';
import { changed, plainCard } from './card.js';
import type { CardModule } from './card.js';

/**
 * Road Building: build two roads for free, one after another, by the base road rules. The player
 * may stop after the first. It uses base's `roadBuilding` frame, which ends by itself when no legal
 * piece is left. With seafaring the `freePieces` hook adds ships, so the two pieces may be roads,
 * ships or one of each (docs/rules/combos.md).
 */
export const roadBuilding: CardModule = {
  card: plainCard({
    id: 'roadBuilding',
    timing: 'main',
    problem: (state, seat, ctx) =>
      freePlacements(state, seat, ctx).length > 0
        ? success(undefined)
        : failure('no-road-site', 'There is nowhere to build a road'),
    apply: (state, seat) =>
      changed(pushPhase(state, frame('roadBuilding', { remaining: 2 })), {
        type: 'roadBuildingPlayed',
        seat,
      }),
  }),
};
