import type { CommandHandler, PhaseHandler } from '../../core/modules/index.js';
import type { CommandShape } from '../../core/pipeline/index.js';
import type { GameState, PhaseFrame } from '../../core/state/index.js';
import { RESOURCES, failure, isBaseResource, success } from '../../core/types/index.js';
import type { Resource, Seat } from '../../core/types/index.js';
import { claimCommands } from '../base/legal.js';
import {
  exchangeBank,
  playerPending,
  popPhase,
  privateExchange,
  pushPhase,
  replaceTop,
  topFrame,
  withClaim,
} from '../base/shared.js';
import { KNIGHTS_ID } from './config.js';
import { hasAbility } from './improvements.js';
import { knightsExt, updateKnights } from './types.js';
import type { AqueductFrameData } from './types.js';

export const AQUEDUCT_FRAME = 'aqueduct';

/** Resources (never commodities) the bank still holds, in canonical order. */
export function bankResources(state: GameState): Resource[] {
  return RESOURCES.filter((kind) => (state.bank[kind] ?? 0) > 0);
}

/** The `onNoProduction` hook: remember an Aqueduct seat that received no card of any kind. */
export function noteNoProduction(state: GameState, seat: Seat): GameState {
  return hasAbility(state, seat, 'science')
    ? updateKnights(state, (old) => ({ ...old, noProduction: [...old.noProduction, seat] }))
    : state;
}

function aqueductFrame(queue: readonly Seat[]): PhaseFrame {
  return { id: AQUEDUCT_FRAME, module: KNIGHTS_ID, data: { queue: [...queue] } };
}

function aqueductData(state: GameState): AqueductFrameData {
  const frame = topFrame(state);
  const value: unknown = frame?.data;
  if (frame?.module !== KNIGHTS_ID || frame.id !== AQUEDUCT_FRAME || typeof value !== 'object')
    throw new Error('Expected an aqueduct choice');
  // Only afterProduction and CHOOSE_AQUEDUCT build this phase data.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as AqueductFrameData;
}

function headSeat(state: GameState): Seat {
  const head = aqueductData(state).queue[0];
  if (head === undefined) throw new Error('Empty aqueduct queue');
  return head;
}

/**
 * The `afterProduction` hook: open the Aqueduct choices, one per qualifying seat in turn order
 * from the active seat, when the bank still holds a resource. It runs only on a non-7 roll.
 */
export function openAqueductChoices(state: GameState, roll: number): GameState {
  const noted = knightsExt(state).noProduction;
  if (noted.length === 0) return state;
  const cleared = updateKnights(state, (old) => ({ ...old, noProduction: [] }));
  if (roll === 7 || bankResources(cleared).length === 0) return cleared;
  const seats = cleared.config.seats;
  const start = Math.max(0, seats.indexOf(cleared.turn.activeSeat));
  const queue = seats
    .map((_, offset) => seats[(start + offset) % seats.length])
    .filter((seat): seat is Seat => seat !== undefined && noted.includes(seat));
  return queue.length ? pushPhase(cleared, aqueductFrame(queue)) : cleared;
}

export const aqueductPhase: PhaseHandler = {
  pending: (state) =>
    withClaim(state, [playerPending(state, headSeat(state), ['CHOOSE_AQUEDUCT'], AQUEDUCT_FRAME)]),
  legalCommands: (state, _frame, seat, priv, ctx) => {
    const claim = claimCommands(state, seat, priv, ctx);
    if (headSeat(state) !== seat) return claim;
    return {
      commands: [
        ...bankResources(state).map((resource) => ({ type: 'CHOOSE_AQUEDUCT', resource })),
        ...claim.commands,
      ],
      templates: claim.templates,
    };
  },
};

function resourceOf(state: GameState, value: unknown): Resource | null {
  return isBaseResource(value) && (state.bank[value] ?? 0) > 0 ? value : null;
}

/** Take one resource of the seat's choice from the bank. */
export const chooseAqueduct: CommandHandler = {
  keys: { allowed: ['resource'] },
  validate: (state, input) => {
    const frame = topFrame(state);
    if (frame?.module !== KNIGHTS_ID || frame.id !== AQUEDUCT_FRAME)
      return failure('not-choosing-aqueduct', 'No Aqueduct choice is open');
    if (headSeat(state) !== input.seat)
      return failure('not-choosing-aqueduct', 'It is not this seat’s Aqueduct choice');
    return resourceOf(state, input.command.resource)
      ? success(undefined)
      : failure('invalid-aqueduct-choice', 'Choose a resource the bank holds');
  },
  apply: (state, input) => {
    const resource = resourceOf(state, input.command.resource);
    if (!resource) throw new Error('Validated Aqueduct choice missing');
    const paid = exchangeBank(state, input.seat, { [resource]: 1 }, true);
    const rest = aqueductData(state).queue.slice(1);
    const next =
      rest.length && bankResources(paid.state).length > 0
        ? replaceTop(paid.state, aqueductFrame(rest))
        : popPhase(paid.state);
    return {
      state: next,
      events: [{ type: 'aqueductChosen', seat: input.seat, resource }],
      effects: paid.effects,
    };
  },
  applyPrivate: (priv, before, input) => {
    if (priv.seat !== input.seat) return success(priv);
    const resource = resourceOf(before, input.command.resource);
    return resource
      ? privateExchange(priv, { [resource]: 1 }, true)
      : failure('invalid-aqueduct-choice', 'Aqueduct choice invalid');
  },
};

/** The choice a timeout makes: the first resource in canonical order the bank holds. */
export function automaticAqueduct(state: GameState, seat: Seat): CommandShape | null {
  const resource = bankResources(state)[0];
  return resource !== undefined && headSeat(state) === seat
    ? { type: 'CHOOSE_AQUEDUCT', resource }
    : null;
}
