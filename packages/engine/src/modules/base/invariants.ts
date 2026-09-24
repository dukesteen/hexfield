import type { GameState, PrivateState } from '../../core/state/index.js';
import { RESOURCES } from '../../core/types/index.js';
import type { Seat } from '../../core/types/index.js';
import { boardGraph } from './board/index.js';
import { longestRoadLength } from './awards/index.js';
import { BANK_START, PIECES_START } from './constants.js';
import { baseExt } from './types.js';

/** Public checks that run without seeing any owner's secret cards. */
export function baseInvariants(state: GameState): string[] {
  const errors: string[] = [];
  const graph = boardGraph(state);
  const edgeIds = new Set(state.board.roads.map((road) => road.edge));
  const vertexIds = new Set(state.board.buildings.map((building) => building.vertex));
  if (edgeIds.size !== state.board.roads.length) errors.push('duplicate road edge');
  if (vertexIds.size !== state.board.buildings.length) errors.push('duplicate building vertex');
  if (state.board.roads.some((road) => graph.edgeIndex[road.edge] === undefined))
    errors.push('road uses unknown edge');
  if (state.board.roads.some((road) => !state.config.seats.includes(road.seat)))
    errors.push('road has unknown owner');
  if (state.board.buildings.some((building) => graph.vertexIndex[building.vertex] === undefined))
    errors.push('building uses unknown vertex');
  if (state.board.buildings.some((building) => !state.config.seats.includes(building.seat)))
    errors.push('building has unknown owner');
  if (
    state.board.buildings.some(
      (building) => building.kind !== 'settlement' && building.kind !== 'city',
    )
  )
    errors.push('building has unknown kind');
  if (state.board.harbors.some((harbor) => graph.edgeIndex[harbor.edge] === undefined))
    errors.push('harbor uses unknown edge');
  if (!state.board.robberHex || graph.hexIndex[state.board.robberHex] === undefined)
    errors.push('robber must occupy one board hex');
  for (const seat of state.seats) {
    const ownedRoads = state.board.roads.filter((road) => road.seat === seat.seat).length;
    const settlements = state.board.buildings.filter(
      (building) => building.seat === seat.seat && building.kind === 'settlement',
    ).length;
    const cities = state.board.buildings.filter(
      (building) => building.seat === seat.seat && building.kind === 'city',
    ).length;
    for (const kind of ['road', 'settlement', 'city'] as const) {
      const remaining = seat.piecesLeft[kind];
      if (
        remaining === undefined ||
        !Number.isSafeInteger(remaining) ||
        remaining < 0 ||
        remaining > PIECES_START[kind]
      ) {
        errors.push(`seat ${seat.seat} invalid ${kind} supply`);
      }
    }
    if (
      ownedRoads > PIECES_START.road ||
      settlements > PIECES_START.settlement ||
      cities > PIECES_START.city
    )
      errors.push(`seat ${seat.seat} placed too many pieces`);
    if (ownedRoads + (seat.piecesLeft.road ?? -1) !== PIECES_START.road)
      errors.push(`seat ${seat.seat} road supply mismatch`);
    if (settlements + (seat.piecesLeft.settlement ?? -1) !== PIECES_START.settlement)
      errors.push(`seat ${seat.seat} settlement supply mismatch`);
    if (cities + (seat.piecesLeft.city ?? -1) !== PIECES_START.city)
      errors.push(`seat ${seat.seat} city supply mismatch`);
  }
  const lengths = state.config.seats.map((seat) => longestRoadLength(state, seat));
  const roadHolder = state.awards.longestRoad;
  if (roadHolder !== null && roadHolder !== undefined && (lengths[roadHolder] ?? 0) < 5)
    errors.push('longest road holder is below threshold');
  const armyHolder = state.awards.largestArmy;
  if (
    armyHolder !== null &&
    armyHolder !== undefined &&
    (baseExt(state.ext.base).knightsPlayed[armyHolder] ?? 0) < 3
  )
    errors.push('largest army holder is below threshold');
  for (const resource of RESOURCES) {
    const bank = state.bank[resource];
    if (bank === undefined || bank < 0 || bank > BANK_START[resource])
      errors.push(`invalid bank ${resource}`);
  }
  const allSlots = state.seats.flatMap((seat) => seat.cardSlots.map((slot) => slot.slotId));
  if (new Set(allSlots).size !== allSlots.length) errors.push('duplicate card slot');
  if ((state.decks.dev?.remaining ?? -1) + (state.decks.dev?.drawn.length ?? 0) !== 25)
    errors.push('development deck count mismatch');
  const playedOn = baseExt(state.ext.base).devPlayedTurn;
  if (playedOn !== null && playedOn > state.turn.number)
    errors.push('development play turn is in the future');
  return errors;
}

/** Exact local audit: bank and all private resource hands conserve the 19-card supply. */
export function basePrivateInvariants(
  state: GameState,
  privates: ReadonlyMap<Seat, PrivateState>,
): string[] {
  const errors: string[] = [];
  for (const resource of RESOURCES) {
    let total = state.bank[resource] ?? 0;
    for (const seat of state.config.seats) {
      const privateState = privates.get(seat);
      if (!privateState) {
        errors.push(`missing private state for seat ${seat}`);
        continue;
      }
      total += privateState.hand[resource] ?? 0;
    }
    if (total !== BANK_START[resource])
      errors.push(
        `${resource} bank and private hands total ${total}, expected ${BANK_START[resource]}`,
      );
  }
  return errors;
}
