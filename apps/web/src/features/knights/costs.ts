import { CITY_COST } from '@cp2p/engine';
import type { CardCounts } from '@cp2p/engine';

/**
 * What the knights module charges, for build buttons and dialogs. The engine's `costs` hook is the
 * source of truth; a test keeps this table equal to it.
 */
export const KNIGHT_COST_TABLE = {
  knight: { wool: 1, ore: 1 },
  promote: { wool: 1, ore: 1 },
  activate: { grain: 1 },
  cityWall: { brick: 2 },
} as const satisfies Record<string, CardCounts>;

/** The cost of the purchase behind each knights placement kind, if it has one. */
export function costOfKind(kind: string): CardCounts | null {
  switch (kind) {
    case 'knight':
      return KNIGHT_COST_TABLE.knight;
    case 'promote':
      return KNIGHT_COST_TABLE.promote;
    case 'activate':
      return KNIGHT_COST_TABLE.activate;
    case 'wall':
      return KNIGHT_COST_TABLE.cityWall;
    case 'sideways':
      return CITY_COST;
    default:
      return null;
  }
}
