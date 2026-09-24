import type { GameState, PrivateState } from '../../core/state/index.js';
import type { HandlerContext } from '../../core/modules/index.js';
import { RESOURCES, success } from '../../core/types/index.js';
import type { ResourceCounts, Result, Seat } from '../../core/types/index.js';
import { verticesForHex } from './board/index.js';
import { TERRAIN_RESOURCE, emptyResources } from './constants.js';
import { exchangeBank, parseCounts, privateExchange } from './shared.js';

/** Compute simultaneous payments, including the resource-specific shortage rule. */
export function productionPayments(
  state: GameState,
  roll: number,
  ctx: HandlerContext,
): Map<Seat, ResourceCounts> {
  const demand = new Map<Seat, Record<keyof ResourceCounts, number>>(
    state.config.seats.map((seat) => [seat, emptyResources()]),
  );
  for (const hex of state.board.hexes) {
    if (hex.token !== roll || hex.id === state.board.robberHex) continue;
    const resource = TERRAIN_RESOURCE[hex.terrain];
    if (!resource) continue;
    const vertices = new Set(verticesForHex(state, hex.id));
    for (const building of state.board.buildings) {
      if (!vertices.has(building.vertex)) continue;
      const current = demand.get(building.seat);
      if (current) current[resource] += building.kind === 'city' ? 2 : 1;
    }
  }
  const adjusted = ctx.hooks.computeProduction(
    state,
    roll,
    Object.fromEntries([...demand].map(([seat, counts]) => [seat, counts])),
  );
  for (const seat of state.config.seats) {
    const parsed = parseCounts(adjusted[seat]);
    if (!parsed.ok)
      throw new Error(`Invalid production hook result for seat ${seat}: ${parsed.error.code}`);
    demand.set(seat, { ...parsed.value });
  }
  for (const resource of RESOURCES) {
    const recipients = [...demand].filter(([, counts]) => counts[resource] > 0);
    const total = recipients.reduce((sum, [, counts]) => sum + counts[resource], 0);
    const bank = state.bank[resource] ?? 0;
    if (total <= bank) continue;
    for (const [, counts] of recipients) counts[resource] = 0;
    if (recipients.length === 1) {
      const only = recipients[0];
      if (only) only[1][resource] = bank;
    }
  }
  return demand;
}

export function applyProduction(state: GameState, roll: number, ctx: HandlerContext): GameState {
  let next = state;
  for (const [seat, counts] of productionPayments(state, roll, ctx)) {
    next = exchangeBank(next, seat, counts, true);
  }
  return next;
}

export function applyPrivateProduction(
  priv: PrivateState,
  before: GameState,
  roll: number,
  ctx: HandlerContext,
): Result<PrivateState> {
  const counts = productionPayments(before, roll, ctx).get(priv.seat);
  return counts ? privateExchange(priv, counts, true) : success(priv);
}
