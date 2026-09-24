import type {
  CommandHandler,
  PhaseHandler,
  SystemInputHandler,
} from '../../../core/modules/index.js';
import type { GameState, PrivateState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { ResourceCounts, Result, Seat } from '../../../core/types/index.js';
import {
  canPlaceRoad,
  canPlaceSettlement,
  legalRoadEdges,
  legalSettlementVertices,
} from '../placement/index.js';
import { TERRAIN_RESOURCE, emptyResources } from '../constants.js';
import { verticesForHex } from '../board/index.js';
import { exchangeBank, frame, privateExchange, replaceTop, top, updateSeat } from '../shared.js';
import type { SetupData } from '../types.js';

export const initialSetup: SetupData = {
  startSeat: null,
  order: [],
  index: 0,
  step: 'settlement',
  lastVertex: null,
};

function setup(state: GameState): SetupData {
  const data = top(state).data;
  if (typeof data !== 'object' || data === null) throw new Error('Missing setup state');
  // Setup handlers exclusively construct this phase data.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return data as SetupData;
}

function setupSeat(state: GameState, data: SetupData): Seat {
  const seat = data.order[data.index];
  if (seat === undefined || !state.config.seats.includes(seat))
    throw new Error('Invalid setup order');
  return seat;
}

function startingResources(state: GameState, vertex: string): ResourceCounts {
  const counts = emptyResources();
  for (const hex of state.board.hexes) {
    if (!verticesForHex(state, hex.id).includes(vertex)) continue;
    const resource = TERRAIN_RESOURCE[hex.terrain];
    if (resource && (state.bank[resource] ?? 0) > counts[resource]) counts[resource] += 1;
  }
  return counts;
}

export const setupPhase: PhaseHandler = {
  pending: (state) => {
    const data = setup(state);
    if (data.startSeat === null)
      return [
        {
          kind: 'random',
          request: { type: 'startSeat', max: state.seats.length },
          systemType: 'START_SEAT',
        },
      ];
    return [
      {
        kind: 'player',
        seat: setupSeat(state, data),
        allowed: [data.step === 'settlement' ? 'PLACE_SETTLEMENT' : 'PLACE_ROAD'],
      },
    ];
  },
  legalCommands: (state, _phase, seat) => {
    const data = setup(state);
    if (data.startSeat === null || setupSeat(state, data) !== seat)
      return { commands: [], templates: [] };
    return data.step === 'settlement'
      ? {
          commands: legalSettlementVertices(state, seat, { setup: true }).map((vertex) => ({
            type: 'PLACE_SETTLEMENT',
            vertex,
          })),
          templates: [],
        }
      : {
          commands: (data.lastVertex
            ? legalRoadEdges(state, seat, { setupVertex: data.lastVertex })
            : []
          ).map((edge) => ({ type: 'PLACE_ROAD', edge })),
          templates: [],
        };
  },
};

export const startSeatInput: SystemInputHandler = {
  validate: (state, input) =>
    state.config.seats.some((seat) => seat === input.seat)
      ? success(undefined)
      : failure('invalid-start-seat', 'Starting seat is not in the game'),
  apply: (state, input) => {
    const seat = state.config.seats.find((candidate) => candidate === input.seat);
    if (seat === undefined) throw new Error('Validated starting seat missing');
    const startIndex = state.config.seats.indexOf(seat);
    const forward = [
      ...state.config.seats.slice(startIndex),
      ...state.config.seats.slice(0, startIndex),
    ];
    const order = [...forward, ...forward.toReversed()];
    const data: SetupData = {
      startSeat: seat,
      order,
      index: 0,
      step: 'settlement',
      lastVertex: null,
    };
    return {
      state: replaceTop(
        { ...state, turn: { ...state.turn, activeSeat: seat } },
        frame('setup', data),
      ),
      events: [],
    };
  },
};

export const placeSettlement: CommandHandler = {
  validate: (state, input, ctx) => {
    const data = setup(state);
    if (data.step !== 'settlement') return failure('wrong-setup-step', 'A road is pending');
    if (typeof input.command.vertex !== 'string')
      return failure('invalid-vertex', 'Vertex id is required');
    if (
      !ctx.hooks.placementRules.settlement(
        state,
        input.seat,
        input.command.vertex,
        canPlaceSettlement(state, input.seat, input.command.vertex, { setup: true }),
      )
    )
      return failure('illegal-settlement', 'Settlement location is illegal');
    const seat = state.seats.find((item) => item.seat === input.seat);
    if (!seat || (seat.piecesLeft.settlement ?? 0) <= 0)
      return failure('no-settlements', 'No settlement pieces remain');
    return success(undefined);
  },
  apply: (state, input, ctx) => {
    const vertex = input.command.vertex;
    if (typeof vertex !== 'string') throw new Error('Validated vertex missing');
    const data = setup(state);
    let next: GameState = {
      ...state,
      board: {
        ...state.board,
        buildings: [...state.board.buildings, { vertex, seat: input.seat, kind: 'settlement' }],
      },
    };
    next = updateSeat(next, input.seat, (old) => ({
      ...old,
      piecesLeft: { ...old.piecesLeft, settlement: (old.piecesLeft.settlement ?? 0) - 1 },
    }));
    if (data.index >= state.seats.length)
      next = exchangeBank(next, input.seat, startingResources(state, vertex), true);
    next = ctx.hooks.afterBuild(next, input.seat, 'settlement', vertex);
    next = replaceTop(next, frame('setup', { ...data, step: 'road', lastVertex: vertex }));
    return { state: next, events: [{ type: 'settlementBuilt', seat: input.seat, vertex }] };
  },
  applyPrivate: (priv, before, input): Result<PrivateState> => {
    if (priv.seat !== input.seat || setup(before).index < before.seats.length) return success(priv);
    const vertex = input.command.vertex;
    return typeof vertex === 'string'
      ? privateExchange(priv, startingResources(before, vertex), true)
      : failure('invalid-vertex', 'Vertex id is required');
  },
};

export const placeRoad: CommandHandler = {
  validate: (state, input, ctx) => {
    const data = setup(state);
    if (data.step !== 'road' || !data.lastVertex)
      return failure('wrong-setup-step', 'A settlement is pending');
    if (typeof input.command.edge !== 'string')
      return failure('invalid-edge', 'Edge id is required');
    if (
      !ctx.hooks.placementRules.road(
        state,
        input.seat,
        input.command.edge,
        canPlaceRoad(state, input.seat, input.command.edge, { setupVertex: data.lastVertex }),
      )
    )
      return failure('illegal-road', 'Road must touch the new settlement');
    const seat = state.seats.find((item) => item.seat === input.seat);
    return seat && (seat.piecesLeft.road ?? 0) > 0
      ? success(undefined)
      : failure('no-roads', 'No road pieces remain');
  },
  apply: (state, input, ctx) => {
    const edge = input.command.edge;
    if (typeof edge !== 'string') throw new Error('Validated edge missing');
    const data = setup(state);
    let next: GameState = {
      ...state,
      board: { ...state.board, roads: [...state.board.roads, { edge, seat: input.seat }] },
    };
    next = updateSeat(next, input.seat, (old) => ({
      ...old,
      piecesLeft: { ...old.piecesLeft, road: (old.piecesLeft.road ?? 0) - 1 },
    }));
    next = ctx.hooks.afterBuild(next, input.seat, 'road', edge);
    const index = data.index + 1;
    const upcoming = data.order[index];
    if (upcoming === undefined) {
      if (data.startSeat === null) throw new Error('Setup has no start seat');
      next = replaceTop(next, frame('preRoll'));
      next = { ...next, turn: { ...next.turn, activeSeat: data.startSeat, number: 1 } };
      next = ctx.hooks.onTurnStart(next, data.startSeat);
    } else {
      next = replaceTop(
        next,
        frame('setup', { ...data, index, step: 'settlement', lastVertex: null }),
      );
      next = { ...next, turn: { ...next.turn, activeSeat: upcoming } };
    }
    return { state: next, events: [{ type: 'roadBuilt', seat: input.seat, edge }] };
  },
};
