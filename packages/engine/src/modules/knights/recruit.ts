import type { CommandHandler, HandlerContext } from '../../core/modules/index.js';
import type { GameEvent } from '../../core/events/index.js';
import type { GameState, PrivateState } from '../../core/state/index.js';
import { failure, success } from '../../core/types/index.js';
import type { CardCounts, Result, Seat } from '../../core/types/index.js';
import { recomputeLongestRoadAward } from '../base/awards/index.js';
import {
  affordable,
  buildCost,
  exchangeBank,
  privateExchange,
  updateSeat,
} from '../base/shared.js';
import { MIGHTY, WALLS_PER_SEAT } from './config.js';
import { hasAbility } from './improvements.js';
import { knightAt, recruitSites, setKnights, supplyOf } from './pieces.js';
import { buildSlot } from './slot.js';
import { knightsExt, updateKnights } from './types.js';

/** A purchase on one vertex: knights, promotions, activations, walls and sideways upgrades. */
interface Purchase {
  /** The key of the price in the `costs` hook. */
  cost: string;
  problem(state: GameState, seat: Seat, vertex: string): Result<void>;
  change(
    state: GameState,
    seat: Seat,
    vertex: string,
    ctx: HandlerContext,
  ): { state: GameState; events: GameEvent[] };
}

export function recruitProblem(state: GameState, seat: Seat, vertex: string): Result<void> {
  if (supplyOf(state, seat, 1) <= 0)
    return failure('no-basic-knight', 'Both basic knights are on the board');
  return recruitSites(state, seat).includes(vertex)
    ? success(undefined)
    : failure('illegal-knight-site', 'A knight needs an empty vertex where your road ends');
}

export function activateProblem(state: GameState, seat: Seat, vertex: string): Result<void> {
  const knight = knightAt(state, vertex);
  if (knight?.seat !== seat) return failure('no-knight', 'You have no knight there');
  return knight.active
    ? failure('already-active', 'The knight is already active')
    : success(undefined);
}

export function promoteProblem(state: GameState, seat: Seat, vertex: string): Result<void> {
  const knight = knightAt(state, vertex);
  if (knight?.seat !== seat) return failure('no-knight', 'You have no knight there');
  if (knight.level >= MIGHTY) return failure('max-knight', 'A mighty knight cannot be promoted');
  if (knight.promotedTurn === state.turn.number)
    return failure('already-promoted', 'A knight is promoted once per turn');
  if (knight.level + 1 === MIGHTY && !hasAbility(state, seat, 'politics'))
    return failure('no-fortress', 'A mighty knight needs the Fortress (politics level 3)');
  return supplyOf(state, seat, knight.level + 1) > 0
    ? success(undefined)
    : failure('no-knight-piece', 'The next knight piece is already on the board');
}

export function wallProblem(state: GameState, seat: Seat, vertex: string): Result<void> {
  const ext = knightsExt(state);
  if (
    !state.board.buildings.some(
      (piece) => piece.vertex === vertex && piece.seat === seat && piece.kind === 'city',
    )
  )
    return failure('no-city', 'A city wall goes under one of your cities');
  if (ext.walls.some((wall) => wall.vertex === vertex))
    return failure('walled', 'The city already has a wall');
  return ext.walls.filter((wall) => wall.seat === seat).length < WALLS_PER_SEAT
    ? success(undefined)
    : failure('no-wall-piece', 'All three city walls are on the board');
}

export function restoreProblem(state: GameState, seat: Seat, vertex: string): Result<void> {
  return knightsExt(state).sideways.some((piece) => piece.seat === seat && piece.vertex === vertex)
    ? success(undefined)
    : failure('not-sideways', 'That piece is not lying on its side');
}

function knightEvent(type: string, seat: Seat, vertex: string, more: object = {}): GameEvent {
  return { type, seat, vertex, ...more };
}

interface Change {
  state: GameState;
  events: GameEvent[];
}

/** Promote the seat's knight one level and remember the turn (a knight is promoted once per turn). */
export function promotePiece(state: GameState, seat: Seat, vertex: string): Change {
  const level = (knightAt(state, vertex)?.level ?? 0) + 1;
  return {
    state: setKnights(state, (list) =>
      list.map((knight) =>
        knight.vertex === vertex ? { ...knight, level, promotedTurn: state.turn.number } : knight,
      ),
    ),
    events: [knightEvent('knightPromoted', seat, vertex, { level })],
  };
}

/** Put a city wall under the seat's city. */
export function placeWall(state: GameState, seat: Seat, vertex: string): Change {
  return {
    state: updateKnights(state, (old) => ({ ...old, walls: [...old.walls, { seat, vertex }] })),
    events: [knightEvent('cityWallBuilt', seat, vertex)],
  };
}

/** Turn a sideways city piece upright. It was already a city piece, so no supply changes hands. */
export function upgradeSideways(
  state: GameState,
  seat: Seat,
  vertex: string,
  ctx: HandlerContext,
): Change {
  let next: GameState = {
    ...state,
    board: {
      ...state.board,
      buildings: state.board.buildings.map((piece) =>
        piece.vertex === vertex ? { ...piece, kind: 'city' } : piece,
      ),
    },
  };
  next = updateSeat(next, seat, (old) => ({
    ...old,
    piecesLeft: { ...old.piecesLeft, sideways: (old.piecesLeft.sideways ?? 1) - 1 },
  }));
  next = updateKnights(next, (old) => ({
    ...old,
    sideways: old.sideways.filter((piece) => piece.vertex !== vertex),
  }));
  return {
    state: ctx.hooks.afterBuild(next, seat, 'city', vertex),
    events: [{ type: 'cityBuilt', seat, vertex }],
  };
}

/** Replace the seat's settlement with a city: a city piece is used and the settlement piece returns. */
export function upgradeSettlement(
  state: GameState,
  seat: Seat,
  vertex: string,
  ctx: HandlerContext,
): Change {
  let next: GameState = {
    ...state,
    board: {
      ...state.board,
      buildings: state.board.buildings.map((piece) =>
        piece.vertex === vertex ? { ...piece, kind: 'city' } : piece,
      ),
    },
  };
  next = updateSeat(next, seat, (old) => ({
    ...old,
    piecesLeft: {
      ...old.piecesLeft,
      city: (old.piecesLeft.city ?? 0) - 1,
      settlement: (old.piecesLeft.settlement ?? 0) + 1,
    },
  }));
  return {
    state: ctx.hooks.afterBuild(next, seat, 'city', vertex),
    events: [{ type: 'cityBuilt', seat, vertex }],
  };
}

const PURCHASES: Record<string, Purchase> = {
  BUILD_KNIGHT: {
    cost: 'knight',
    problem: recruitProblem,
    change: (state, seat, vertex, ctx) => ({
      state: recomputeLongestRoadAward(
        setKnights(state, (list) => [
          ...list,
          { seat, vertex, level: 1, active: false, ready: false, promotedTurn: null },
        ]),
        ctx,
      ),
      events: [knightEvent('knightBuilt', seat, vertex)],
    }),
  },
  ACTIVATE_KNIGHT: {
    cost: 'activate',
    problem: activateProblem,
    // Active, but not ready: it acts from the next turn on.
    change: (state, seat, vertex) => ({
      state: setKnights(state, (list) =>
        list.map((knight) => (knight.vertex === vertex ? { ...knight, active: true } : knight)),
      ),
      events: [knightEvent('knightActivated', seat, vertex)],
    }),
  },
  PROMOTE_KNIGHT: {
    cost: 'promote',
    problem: promoteProblem,
    change: (state, seat, vertex) => promotePiece(state, seat, vertex),
  },
  BUILD_CITY_WALL: {
    cost: 'cityWall',
    problem: wallProblem,
    change: (state, seat, vertex) => placeWall(state, seat, vertex),
  },
  // The piece is already paid for as a city piece: no supply changes hands.
  UPGRADE_SIDEWAYS_CITY: {
    cost: 'city',
    problem: restoreProblem,
    change: (state, seat, vertex, ctx) => upgradeSideways(state, seat, vertex, ctx),
  },
};

function vertexOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Everything but the price: the phase, and the rule for this piece. */
export function purchaseProblem(
  state: GameState,
  seat: Seat,
  type: string,
  vertex: string,
): Result<void> {
  const purchase = PURCHASES[type];
  if (!purchase) return failure('unknown-command', `Unknown purchase ${type}`);
  const slot = buildSlot(state, seat);
  return slot.ok ? purchase.problem(state, seat, vertex) : slot;
}

/** The price of a purchase through the cost hooks. */
export function purchaseCost(
  state: GameState,
  type: string,
  ctx: HandlerContext,
): Result<CardCounts> {
  const purchase = PURCHASES[type];
  return purchase ? buildCost(state, purchase.cost, ctx) : failure('unknown-command', type);
}

/** Whether the owner's own hand pays, without ever looking at the bank. */
export function privateCanPay(priv: PrivateState, cost: CardCounts): boolean {
  return Object.entries(cost).every(([kind, count]) => (priv.hand[kind] ?? 0) >= count);
}

function handler(type: string): CommandHandler {
  const purchase = PURCHASES[type];
  if (!purchase) throw new Error(`Unknown purchase ${type}`);
  return {
    keys: { allowed: ['vertex'] },
    validate: (state, input, ctx) => {
      const vertex = vertexOf(input.command.vertex);
      if (vertex === null) return failure('invalid-vertex', 'Vertex id is required');
      const problem = purchaseProblem(state, input.seat, type, vertex);
      if (!problem.ok) return problem;
      const cost = purchaseCost(state, type, ctx);
      return cost.ok ? affordable(state, input.seat, cost.value) : cost;
    },
    apply: (state, input, ctx) => {
      const vertex = vertexOf(input.command.vertex);
      const cost = purchaseCost(state, type, ctx);
      if (vertex === null || !cost.ok) throw new Error('Validated purchase missing');
      const spent = exchangeBank(state, input.seat, cost.value, false);
      const done = purchase.change(spent.state, input.seat, vertex, ctx);
      return { state: done.state, events: done.events, effects: spent.effects };
    },
    applyPrivate: (priv, before, input, _data, ctx) => {
      if (priv.seat !== input.seat) return success(priv);
      const cost = purchaseCost(before, type, ctx);
      return cost.ok ? privateExchange(priv, cost.value, false) : cost;
    },
  };
}

export const buildKnight = handler('BUILD_KNIGHT');
export const activateKnight = handler('ACTIVATE_KNIGHT');
export const promoteKnight = handler('PROMOTE_KNIGHT');
export const buildCityWall = handler('BUILD_CITY_WALL');
export const upgradeSidewaysCity = handler('UPGRADE_SIDEWAYS_CITY');
