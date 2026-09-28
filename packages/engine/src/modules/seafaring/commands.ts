import type { CommandHandler, HandlerContext } from '../../core/modules/index.js';
import type { GameState } from '../../core/state/index.js';
import { failure, success } from '../../core/types/index.js';
import type { Result, Seat } from '../../core/types/index.js';
import { recomputeLongestRoadAward } from '../base/awards/index.js';
import { freePlacements } from '../base/devcards.js';
import { advanceSetup, setup } from '../base/phases/setup.js';
import {
  affordable,
  buildCost,
  exchangeBank,
  frame,
  ownSeat,
  popPhase,
  privateExchange,
  replaceTop,
  updateSeat,
} from '../base/shared.js';
import { canPlaceShip, movableShips } from './ships.js';
import { seafaringExt, updateSeafaring } from './types.js';

function edgeOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function hasShipPiece(state: GameState, seat: Seat): boolean {
  return (ownSeat(state, seat).piecesLeft.ship ?? 0) > 0;
}

function topFrame(state: GameState) {
  return state.turn.phase.at(-1);
}

/** Put a ship on the board and use up one supply piece. */
function placeShip(state: GameState, seat: Seat, edge: string, ctx: HandlerContext): GameState {
  let next: GameState = {
    ...state,
    board: { ...state.board, ships: [...(state.board.ships ?? []), { edge, seat }] },
  };
  next = updateSeat(next, seat, (old) => ({
    ...old,
    piecesLeft: { ...old.piecesLeft, ship: (old.piecesLeft.ship ?? 0) - 1 },
  }));
  next = updateSeafaring(next, (old) => ({ ...old, builtThisTurn: [...old.builtThisTurn, edge] }));
  next = ctx.hooks.afterBuild(next, seat, 'ship', edge);
  return recomputeLongestRoadAward(next, ctx);
}

/** Buy a ship in the main phase, or in a special build phase. */
export const buildShip: CommandHandler = {
  keys: { allowed: ['edge'] },
  validate: (state, input, ctx) => {
    const edge = edgeOf(input.command.edge);
    if (edge === null) return failure('invalid-edge', 'Edge id is required');
    if (!canPlaceShip(state, input.seat, edge))
      return failure('illegal-ship', 'Ship location is illegal');
    if (!hasShipPiece(state, input.seat)) return failure('no-ships', 'No ship pieces remain');
    const cost = buildCost(state, 'ship', ctx);
    return cost.ok ? affordable(state, input.seat, cost.value) : cost;
  },
  apply: (state, input, ctx) => {
    const edge = edgeOf(input.command.edge);
    const cost = buildCost(state, 'ship', ctx);
    if (edge === null || !cost.ok) throw new Error('Validated ship build missing');
    const spent = exchangeBank(state, input.seat, cost.value, false);
    return {
      state: placeShip(spent.state, input.seat, edge, ctx),
      events: [{ type: 'shipBuilt', seat: input.seat, edge }],
      effects: spent.effects,
    };
  },
  applyPrivate: (priv, before, input, _data, ctx) => {
    if (priv.seat !== input.seat) return success(priv);
    const cost = buildCost(before, 'ship', ctx);
    return cost.ok ? privateExchange(priv, cost.value, false) : cost;
  },
};

/** A ship instead of the road that follows a setup settlement. */
export const placeSetupShip: CommandHandler = {
  keys: { allowed: ['edge'] },
  validate: (state, input) => {
    const top = topFrame(state);
    if (top?.module !== 'base' || top.id !== 'setup') return failure('not-setup', 'Setup is over');
    const data = setup(state);
    if (data.step !== 'road' || !data.lastVertex)
      return failure('wrong-setup-step', 'A settlement is pending');
    const edge = edgeOf(input.command.edge);
    if (edge === null) return failure('invalid-edge', 'Edge id is required');
    if (!canPlaceShip(state, input.seat, edge, { setupVertex: data.lastVertex }))
      return failure('illegal-ship', 'Ship must touch the new settlement and the sea');
    return hasShipPiece(state, input.seat)
      ? success(undefined)
      : failure('no-ships', 'No ship pieces remain');
  },
  apply: (state, input, ctx) => {
    const edge = edgeOf(input.command.edge);
    if (edge === null) throw new Error('Validated edge missing');
    const data = setup(state);
    const next = advanceSetup(placeShip(state, input.seat, edge, ctx), data, ctx);
    return { state: next, events: [{ type: 'shipBuilt', seat: input.seat, edge }], effects: [] };
  },
};

/** One of the two free pieces of a Road Building card. */
export const placeFreeShip: CommandHandler = {
  keys: { allowed: ['edge'] },
  validate: (state, input) => {
    const top = topFrame(state);
    if (top?.module !== 'base' || top.id !== 'roadBuilding' || input.seat !== state.turn.activeSeat)
      return failure('not-road-building', 'No free pieces are pending');
    const edge = edgeOf(input.command.edge);
    if (edge === null || !canPlaceShip(state, input.seat, edge))
      return failure('illegal-ship', 'Free ship location is illegal');
    return hasShipPiece(state, input.seat)
      ? success(undefined)
      : failure('no-ships', 'No ship pieces remain');
  },
  apply: (state, input, ctx) => {
    const edge = edgeOf(input.command.edge);
    const data: unknown = topFrame(state)?.data;
    const remaining =
      (typeof data === 'object' && data !== null ? Number(Reflect.get(data, 'remaining')) : 1) - 1;
    if (edge === null) throw new Error('Validated edge missing');
    let next = placeShip(state, input.seat, edge, ctx);
    next =
      remaining <= 0 || freePlacements(next, input.seat, ctx).length === 0
        ? popPhase(next)
        : replaceTop(next, frame('roadBuilding', { remaining }));
    return {
      state: next,
      events: [{ type: 'shipBuilt', seat: input.seat, edge, free: true }],
      effects: [],
    };
  },
};

function moveProblem(state: GameState, seat: Seat, from: unknown, to: unknown): Result<void> {
  const top = topFrame(state);
  if (top?.module !== 'base' || top.id !== 'main' || seat !== state.turn.activeSeat)
    return failure('not-main', 'Ships move only in the active seat’s main phase');
  if (seafaringExt(state).shipMovedTurn === state.turn.number)
    return failure('ship-already-moved', 'Only one ship may move per turn');
  if (typeof from !== 'string' || typeof to !== 'string')
    return failure('invalid-edge', 'Both edges are required');
  if (!movableShips(state, seat).includes(from))
    return failure('ship-cannot-move', 'That ship is not at the open end of an open route');
  return to !== from && canPlaceShip(state, seat, to, { ignore: from })
    ? success(undefined)
    : failure('illegal-ship', 'The ship cannot go there');
}

/** Move one ship for free, once per turn. */
export const moveShip: CommandHandler = {
  keys: { allowed: ['from', 'to'] },
  validate: (state, input) => moveProblem(state, input.seat, input.command.from, input.command.to),
  apply: (state, input, ctx) => {
    const { from, to } = input.command;
    if (typeof from !== 'string' || typeof to !== 'string')
      throw new Error('Validated move missing');
    let next: GameState = {
      ...state,
      board: {
        ...state.board,
        ships: (state.board.ships ?? []).map((ship) =>
          ship.edge === from ? { ...ship, edge: to } : ship,
        ),
      },
    };
    next = updateSeafaring(next, (old) => ({
      ...old,
      builtThisTurn: [...old.builtThisTurn, to],
      shipMovedTurn: state.turn.number,
    }));
    next = ctx.hooks.afterBuild(next, input.seat, 'ship', to);
    next = recomputeLongestRoadAward(next, ctx);
    return {
      state: next,
      events: [{ type: 'shipMoved', seat: input.seat, from, to }],
      effects: [],
    };
  },
};
