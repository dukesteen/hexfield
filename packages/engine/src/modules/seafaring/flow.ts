import type { HandlerContext } from '../../core/modules/index.js';
import type { CommandShape, LegalCommandSet, Pending } from '../../core/pipeline/index.js';
import type { GameState, PhaseFrame, PrivateState } from '../../core/state/index.js';
import { RESOURCES } from '../../core/types/index.js';
import type { Seat } from '../../core/types/index.js';
import { affordable, buildCost, ownSeat } from '../base/shared.js';
import { setup } from '../base/phases/setup.js';
import { pirateHexes } from './pirate.js';
import { legalShipEdges, legalShipMoves } from './ships.js';
import { seafaringExt } from './types.js';

/** What the top frame lets the seafaring commands do. */
type Slot = 'main' | 'sbp' | 'roadBuilding' | 'moveRobber' | 'setupRoad';

function sbpSeat(state: GameState, frame: PhaseFrame): Seat | null {
  const seat: unknown =
    typeof frame.data === 'object' && frame.data !== null
      ? Reflect.get(frame.data, 'seat')
      : undefined;
  return state.config.seats.find((item) => item === seat) ?? null;
}

function slotOf(state: GameState): Slot | null {
  const top = state.turn.phase.at(-1);
  if (!top) return null;
  if (top.module === 'five-six' && top.id === 'sbp') return 'sbp';
  if (top.module !== 'base') return null;
  if (top.id === 'main' || top.id === 'roadBuilding' || top.id === 'moveRobber') return top.id;
  return top.id === 'setup' && setup(state).step === 'road' ? 'setupRoad' : null;
}

/** The command types the module adds to the seat's pending entry in each slot. */
const ADDED: Readonly<Record<Slot, readonly string[]>> = {
  main: ['BUILD_SHIP', 'MOVE_SHIP'],
  sbp: ['BUILD_SHIP'],
  roadBuilding: ['PLACE_FREE_SHIP'],
  moveRobber: ['MOVE_PIRATE'],
  setupRoad: ['PLACE_SETUP_SHIP'],
};

/** The `pending` hook: allow ship and pirate commands where the base phase lists its own. */
export function addShipPending(state: GameState, acc: readonly Pending[]): readonly Pending[] {
  const slot = slotOf(state);
  if (slot === null) return acc;
  const top = state.turn.phase.at(-1);
  const seat =
    slot === 'sbp' && top
      ? sbpSeat(state, top)
      : slot === 'setupRoad'
        ? null
        : state.turn.activeSeat;
  return acc.map((item) =>
    item.kind === 'player' &&
    (seat === null || item.seat === seat) &&
    !(slot === 'main' && !item.allowed.includes('END_TURN'))
      ? { ...item, allowed: [...item.allowed, ...ADDED[slot]] }
      : item,
  );
}

function canPayShip(
  state: GameState,
  seat: Seat,
  ctx: HandlerContext,
  priv: PrivateState | undefined,
): boolean {
  const cost = buildCost(state, 'ship', ctx);
  if (!cost.ok || (ownSeat(state, seat).piecesLeft.ship ?? 0) <= 0) return false;
  return priv
    ? RESOURCES.every((kind) => (priv.hand[kind] ?? 0) >= (cost.value[kind] ?? 0))
    : affordable(state, seat, cost.value).ok;
}

/** The `legalCommands` hook: ship builds and moves, the pirate, and setup ships. */
export function addShipCommands(
  state: GameState,
  seat: Seat,
  priv: PrivateState | undefined,
  acc: LegalCommandSet,
  ctx: HandlerContext,
): LegalCommandSet {
  const slot = slotOf(state);
  const top = state.turn.phase.at(-1);
  const commands: CommandShape[] = [];
  if (slot === 'main' && seat === state.turn.activeSeat) {
    if (canPayShip(state, seat, ctx, priv))
      commands.push(...legalShipEdges(state, seat).map((edge) => ({ type: 'BUILD_SHIP', edge })));
    if (seafaringExt(state).shipMovedTurn !== state.turn.number)
      commands.push(
        ...legalShipMoves(state, seat).map(({ from, to }) => ({ type: 'MOVE_SHIP', from, to })),
      );
  } else if (slot === 'sbp' && top && sbpSeat(state, top) === seat) {
    if (canPayShip(state, seat, ctx, priv))
      commands.push(...legalShipEdges(state, seat).map((edge) => ({ type: 'BUILD_SHIP', edge })));
  } else if (slot === 'moveRobber' && seat === state.turn.activeSeat) {
    commands.push(...pirateHexes(state, ctx).map((hex) => ({ type: 'MOVE_PIRATE', hex })));
  } else if (slot === 'setupRoad') {
    const data = setup(state);
    if (data.lastVertex && data.order[data.index] === seat)
      commands.push(
        ...legalShipEdges(state, seat, { setupVertex: data.lastVertex }).map((edge) => ({
          type: 'PLACE_SETUP_SHIP',
          edge,
        })),
      );
  }
  return commands.length
    ? { commands: [...acc.commands, ...commands], templates: acc.templates }
    : acc;
}

/** The `freePieces` hook: a free ship anywhere a ship could be built, while supply lasts. */
export function addFreeShips(
  state: GameState,
  seat: Seat,
  acc: readonly CommandShape[],
): readonly CommandShape[] {
  if ((ownSeat(state, seat).piecesLeft.ship ?? 0) <= 0) return acc;
  return [
    ...acc,
    ...legalShipEdges(state, seat).map((edge) => ({ type: 'PLACE_FREE_SHIP', edge })),
  ];
}
