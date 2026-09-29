import type { VpContribution } from '../../../core/modules/index.js';
import type { GameState } from '../../../core/state/index.js';
import type { Seat } from '../../../core/types/index.js';
import { COMMODITIES } from '../config.js';
import { hasAbility } from '../improvements.js';
import { knightsExt, updateKnights } from '../types.js';
import { VICTORY_CARDS } from './catalogue.js';
import { merchantKind } from './merchant.js';

/**
 * The `bankRate` hook: Trade level 3 makes commodities 2:1, the merchant makes the resource of its
 * hex 2:1 for its controller, and a Merchant Fleet makes each named kind 2:1 for the turn. The
 * rates never combine: the best one applies.
 */
export function bankRates(state: GameState, seat: Seat, kind: string, rate: number): number {
  const ext = knightsExt(state);
  let best = rate;
  if (COMMODITIES.includes(kind) && hasAbility(state, seat, 'trade')) best = Math.min(best, 2);
  if (ext.merchant?.seat === seat && merchantKind(state, ext.merchant.hex) === kind)
    best = Math.min(best, 2);
  if (ext.fleet?.seat === seat && ext.fleet.kinds.includes(kind)) best = Math.min(best, 2);
  return best;
}

/** The `victoryPoints` hook: the merchant (while controlled) and shown Printer or Constitution cards. */
export function progressPoints(
  state: GameState,
  seat: Seat,
  acc: readonly VpContribution[],
): readonly VpContribution[] {
  const merchant = knightsExt(state).merchant?.seat === seat ? 1 : 0;
  const shown =
    state.seats
      .find((item) => item.seat === seat)
      ?.cardSlots.filter(
        (slot) => slot.revealed !== undefined && Object.hasOwn(VICTORY_CARDS, slot.revealed),
      ).length ?? 0;
  return [
    ...acc,
    ...(merchant > 0 ? [{ source: 'merchant', points: 1, public: true, stored: true }] : []),
    ...(shown > 0 ? [{ source: 'progress', points: shown, public: true, stored: true }] : []),
  ];
}

/** The `onTurnEnd` hook: a Merchant Fleet and a Commercial Harbor last only for the turn. */
export function clearTurnEffects(state: GameState): GameState {
  const ext = knightsExt(state);
  return ext.fleet === null && ext.harbor === null
    ? state
    : updateKnights(state, (old) => ({ ...old, fleet: null, harbor: null }));
}
