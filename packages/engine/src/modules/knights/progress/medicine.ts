import type { GameState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Result, Seat } from '../../../core/types/index.js';
import { canUpgradeCity } from '../../base/placement/index.js';
import { affordable, exchangeBank, ownSeat } from '../../base/shared.js';
import { upgradeSettlement, upgradeSideways } from '../recruit.js';
import { knightsExt } from '../types.js';
import { paramsObject, stringOf } from './card.js';
import type { CardModule } from './card.js';
import type { HandlerContext } from '../../../core/modules/index.js';

/** Medicine's price: 1 grain and 2 ore, instead of 2 grain and 3 ore. */
const MEDICINE_COST = { grain: 1, ore: 2 };

function vertexOf(params: unknown): Result<string> {
  const object = paramsObject(params, ['vertex']);
  if (!object.ok) return object;
  const vertex = stringOf(object.value.vertex);
  return vertex === undefined
    ? failure('invalid-vertex', 'Choose one of your settlements')
    : success(vertex);
}

function isSideways(state: GameState, seat: Seat, vertex: string): boolean {
  return knightsExt(state).sideways.some((piece) => piece.seat === seat && piece.vertex === vertex);
}

/** The settlements Medicine can upgrade: every city rule applies, a sideways piece going first. */
function upgradable(state: GameState, seat: Seat, vertex: string, ctx: HandlerContext): boolean {
  if (isSideways(state, seat, vertex)) return true;
  return (
    canUpgradeCity(state, seat, vertex) &&
    (ownSeat(state, seat).piecesLeft.city ?? 0) > 0 &&
    ctx.hooks.placement.city(state, seat, vertex, true)
  );
}

/**
 * Medicine, played as part of an upgrade: turn one settlement into a city for 1 grain and 2 ore.
 * One card upgrades one settlement. A sideways city piece is upgraded first, as for any city.
 */
export const medicine: CardModule = {
  card: {
    id: 'medicine',
    timing: 'main',
    problem: (state, seat, params, ctx) => {
      const vertex = vertexOf(params);
      if (!vertex.ok) return vertex;
      if (!upgradable(state, seat, vertex.value, ctx))
        return failure('illegal-city', 'Medicine upgrades one of your settlements to a city');
      return affordable(state, seat, MEDICINE_COST);
    },
    options: (state, seat, ctx, priv) =>
      (priv === undefined || ((priv.hand.grain ?? 0) >= 1 && (priv.hand.ore ?? 0) >= 2)
        ? state.board.buildings
        : []
      )
        .filter((piece) => piece.seat === seat && piece.kind === 'settlement')
        .map((piece) => piece.vertex)
        .toSorted()
        .filter((vertex) => upgradable(state, seat, vertex, ctx))
        .map((vertex) => ({ vertex })),
    apply: (state, seat, params, ctx) => {
      const vertex = vertexOf(params);
      if (!vertex.ok) throw new Error('Validated Medicine vertex missing');
      const paid = exchangeBank(state, seat, MEDICINE_COST, false);
      const built = isSideways(state, seat, vertex.value)
        ? upgradeSideways(paid.state, seat, vertex.value, ctx)
        : upgradeSettlement(paid.state, seat, vertex.value, ctx);
      return { ...built, effects: paid.effects };
    },
  },
};
