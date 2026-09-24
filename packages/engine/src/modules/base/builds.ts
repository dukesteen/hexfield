import type { CommandHandler } from '../../core/modules/index.js';
import { failure, success } from '../../core/types/index.js';
import { recomputeLongestRoadAward } from './awards/index.js';
import { CITY_COST, ROAD_COST, SETTLEMENT_COST } from './constants.js';
import { canPlaceRoad, canPlaceSettlement, canUpgradeCity } from './placement/index.js';
import {
  affordable,
  buildCost,
  exchangeBank,
  ownSeat,
  privateExchange,
  updateSeat,
} from './shared.js';

export const buildRoad: CommandHandler = {
  validate: (state, input, ctx) => {
    const edge = input.command.edge;
    if (typeof edge !== 'string') return failure('invalid-edge', 'Edge id is required');
    if (
      !ctx.hooks.placementRules.road(state, input.seat, edge, canPlaceRoad(state, input.seat, edge))
    )
      return failure('illegal-road', 'Road location is illegal');
    if ((ownSeat(state, input.seat).piecesLeft.road ?? 0) <= 0)
      return failure('no-roads', 'No road pieces remain');
    const cost = buildCost(state, 'road', ROAD_COST, ctx);
    return cost.ok ? affordable(state, input.seat, cost.value) : cost;
  },
  apply: (state, input, ctx) => {
    const edge = input.command.edge;
    if (typeof edge !== 'string') throw new Error('Validated edge missing');
    const cost = buildCost(state, 'road', ROAD_COST, ctx);
    if (!cost.ok) throw new Error('Validated road cost missing');
    let next = exchangeBank(state, input.seat, cost.value, false);
    next = {
      ...next,
      board: { ...next.board, roads: [...next.board.roads, { edge, seat: input.seat }] },
    };
    next = updateSeat(next, input.seat, (old) => ({
      ...old,
      piecesLeft: { ...old.piecesLeft, road: (old.piecesLeft.road ?? 0) - 1 },
    }));
    next = ctx.hooks.afterBuild(next, input.seat, 'road', edge);
    next = recomputeLongestRoadAward(next);
    return { state: next, events: [{ type: 'roadBuilt', seat: input.seat, edge }] };
  },
  applyPrivate: (priv, before, input, _data, ctx) => {
    if (priv.seat !== input.seat) return success(priv);
    const cost = buildCost(before, 'road', ROAD_COST, ctx);
    return cost.ok ? privateExchange(priv, cost.value, false) : cost;
  },
};

export const buildSettlement: CommandHandler = {
  validate: (state, input, ctx) => {
    const vertex = input.command.vertex;
    if (typeof vertex !== 'string') return failure('invalid-vertex', 'Vertex id is required');
    if (
      !ctx.hooks.placementRules.settlement(
        state,
        input.seat,
        vertex,
        canPlaceSettlement(state, input.seat, vertex),
      )
    )
      return failure('illegal-settlement', 'Settlement location is illegal');
    if ((ownSeat(state, input.seat).piecesLeft.settlement ?? 0) <= 0)
      return failure('no-settlements', 'No settlement pieces remain');
    const cost = buildCost(state, 'settlement', SETTLEMENT_COST, ctx);
    return cost.ok ? affordable(state, input.seat, cost.value) : cost;
  },
  apply: (state, input, ctx) => {
    const vertex = input.command.vertex;
    if (typeof vertex !== 'string') throw new Error('Validated vertex missing');
    const cost = buildCost(state, 'settlement', SETTLEMENT_COST, ctx);
    if (!cost.ok) throw new Error('Validated settlement cost missing');
    let next = exchangeBank(state, input.seat, cost.value, false);
    next = {
      ...next,
      board: {
        ...next.board,
        buildings: [...next.board.buildings, { vertex, seat: input.seat, kind: 'settlement' }],
      },
    };
    next = updateSeat(next, input.seat, (old) => ({
      ...old,
      piecesLeft: { ...old.piecesLeft, settlement: (old.piecesLeft.settlement ?? 0) - 1 },
    }));
    next = ctx.hooks.afterBuild(next, input.seat, 'settlement', vertex);
    next = recomputeLongestRoadAward(next);
    return { state: next, events: [{ type: 'settlementBuilt', seat: input.seat, vertex }] };
  },
  applyPrivate: (priv, before, input, _data, ctx) => {
    if (priv.seat !== input.seat) return success(priv);
    const cost = buildCost(before, 'settlement', SETTLEMENT_COST, ctx);
    return cost.ok ? privateExchange(priv, cost.value, false) : cost;
  },
};

export const buildCity: CommandHandler = {
  validate: (state, input, ctx) => {
    const vertex = input.command.vertex;
    if (typeof vertex !== 'string') return failure('invalid-vertex', 'Vertex id is required');
    if (
      !ctx.hooks.placementRules.city(
        state,
        input.seat,
        vertex,
        canUpgradeCity(state, input.seat, vertex),
      )
    )
      return failure('illegal-city', 'City must replace your settlement');
    if ((ownSeat(state, input.seat).piecesLeft.city ?? 0) <= 0)
      return failure('no-cities', 'No city pieces remain');
    const cost = buildCost(state, 'city', CITY_COST, ctx);
    return cost.ok ? affordable(state, input.seat, cost.value) : cost;
  },
  apply: (state, input, ctx) => {
    const vertex = input.command.vertex;
    if (typeof vertex !== 'string') throw new Error('Validated vertex missing');
    const cost = buildCost(state, 'city', CITY_COST, ctx);
    if (!cost.ok) throw new Error('Validated city cost missing');
    let next = exchangeBank(state, input.seat, cost.value, false);
    next = {
      ...next,
      board: {
        ...next.board,
        buildings: next.board.buildings.map((piece) =>
          piece.vertex === vertex ? { ...piece, kind: 'city' } : piece,
        ),
      },
    };
    next = updateSeat(next, input.seat, (old) => ({
      ...old,
      piecesLeft: {
        ...old.piecesLeft,
        city: (old.piecesLeft.city ?? 0) - 1,
        settlement: (old.piecesLeft.settlement ?? 0) + 1,
      },
    }));
    next = ctx.hooks.afterBuild(next, input.seat, 'city', vertex);
    return { state: next, events: [{ type: 'cityBuilt', seat: input.seat, vertex }] };
  },
  applyPrivate: (priv, before, input, _data, ctx) => {
    if (priv.seat !== input.seat) return success(priv);
    const cost = buildCost(before, 'city', CITY_COST, ctx);
    return cost.ok ? privateExchange(priv, cost.value, false) : cost;
  },
};
