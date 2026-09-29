import type { CommandHandler, PhaseHandler } from '../../core/modules/index.js';
import type { CommandShape } from '../../core/pipeline/index.js';
import type { GameState, PhaseFrame } from '../../core/state/index.js';
import { failure, success } from '../../core/types/index.js';
import type { Seat } from '../../core/types/index.js';
import { claimCommands } from '../base/legal.js';
import { applyPrivateProduction } from '../base/production.js';
import { resolveRoll } from '../base/phases/turn.js';
import {
  playerPending,
  popPhase,
  pushPhase,
  replaceTop,
  topFrame,
  updateSeat,
  withClaim,
} from '../base/shared.js';
import { BARBARIAN_STEPS, KNIGHTS_ID } from './config.js';
import { availableCities } from './improvements.js';
import { beginTieDraws } from './progress/draw.js';
import { knightsExt, updateKnights } from './types.js';
import type { AttackReport, PillageFrameData } from './types.js';

export const PILLAGE_FRAME = 'pillage';

/** Seats in turn order, starting with the active seat. */
function turnOrder(state: GameState): Seat[] {
  const seats = state.config.seats;
  const start = Math.max(0, seats.indexOf(state.turn.activeSeat));
  return seats.map((_, offset) => seats[(start + offset) % seats.length]).filter(isSeat);
}

function isSeat(value: Seat | undefined): value is Seat {
  return value !== undefined;
}

/** Cities on the board, over all seats. A metropolis city counts once and a sideways piece not at all. */
export function barbarianStrength(state: GameState): number {
  return state.board.buildings.filter((piece) => piece.kind === 'city').length;
}

/** Each seat's contribution: the levels of its active knights. */
export function contributions(state: GameState): number[] {
  return state.config.seats.map((seat) =>
    knightsExt(state)
      .knights.filter((knight) => knight.seat === seat && knight.active)
      .reduce((sum, knight) => sum + knight.level, 0),
  );
}

/**
 * The seats that tied for the top contribution each pick a deck and draw one progress card, in
 * turn order from the active seat. The draws hold the roll back in a `progress` frame (like a
 * pillage choice); the tie itself is recorded in `lastAttack.tied`.
 */
export function awardTieDraws(state: GameState, seats: readonly Seat[], roll: number): GameState {
  return beginTieDraws(state, seats, roll);
}

/**
 * A city loses its top: it becomes a settlement and its wall goes back to its owner. With no
 * settlement piece in the supply the city piece lies on its side instead.
 */
export function pillageCity(
  state: GameState,
  seat: Seat,
  vertex: string,
): { state: GameState; sideways: boolean } {
  const holder = state.seats.find((item) => item.seat === seat);
  const sideways = (holder?.piecesLeft.settlement ?? 0) <= 0;
  let next: GameState = {
    ...state,
    board: {
      ...state.board,
      buildings: state.board.buildings.map((piece) =>
        piece.vertex === vertex ? { ...piece, kind: 'settlement' } : piece,
      ),
    },
  };
  next = updateSeat(next, seat, (old) => ({
    ...old,
    piecesLeft: sideways
      ? { ...old.piecesLeft, sideways: (old.piecesLeft.sideways ?? 0) + 1 }
      : {
          ...old.piecesLeft,
          city: (old.piecesLeft.city ?? 0) + 1,
          settlement: (old.piecesLeft.settlement ?? 0) - 1,
        },
  }));
  next = updateKnights(next, (old) => ({
    ...old,
    walls: old.walls.filter((wall) => wall.vertex !== vertex),
    sideways: sideways
      ? [...old.sideways, { seat, vertex }].toSorted((a, b) =>
          a.vertex < b.vertex ? -1 : a.vertex > b.vertex ? 1 : 0,
        )
      : old.sideways,
    lastAttack: old.lastAttack
      ? {
          ...old.lastAttack,
          pillaged: [...old.lastAttack.pillaged, { seat, vertex, sideways }],
        }
      : old.lastAttack,
  }));
  return { state: next, sideways };
}

function pillageFrame(data: PillageFrameData): PhaseFrame {
  return { id: PILLAGE_FRAME, module: KNIGHTS_ID, data };
}

function pillageData(state: GameState): PillageFrameData {
  const top = topFrame(state);
  const value: unknown = top?.data;
  if (top?.module !== KNIGHTS_ID || top.id !== PILLAGE_FRAME || typeof value !== 'object')
    throw new Error('Expected a pillage choice');
  // Only the attack and CHOOSE_PILLAGE build this phase data.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as PillageFrameData;
}

/**
 * The barbarians land. Strength is the cities on the board and defense the active knights. When
 * the defense holds, the strictly best defender takes a Defender of Catan card (a tie goes to the
 * K5 seam). Otherwise the lowest contributors among seats with a city without a metropolis each
 * lose one city; a seat with several to choose from answers a `pillage` frame, which holds the
 * roll back until every choice is made. Afterwards every knight is inactive, the ship is back at
 * the start and the robber is free.
 */
export function resolveAttack(state: GameState, roll: number): GameState {
  const order = turnOrder(state);
  const strength = barbarianStrength(state);
  const levels = contributions(state);
  const defense = levels.reduce((sum, level) => sum + level, 0);
  let next = state;
  const defenders = [...knightsExt(state).defenders];
  const choosing: Seat[] = [];
  const report: AttackReport = {
    turn: state.turn.number,
    strength,
    defense,
    contributions: levels,
    outcome: defense >= strength ? 'defended' : 'pillaged',
    defender: null,
    tied: [],
    pillaged: [],
  };
  next = updateKnights(next, (old) => ({ ...old, lastAttack: report }));
  if (defense >= strength) {
    const best = Math.max(0, ...levels);
    const leaders = best > 0 ? order.filter((seat) => levels[seat] === best) : [];
    const only = leaders.length === 1 ? leaders[0] : undefined;
    if (only !== undefined) {
      defenders[only] = (defenders[only] ?? 0) + 1;
      next = updateKnights(next, (old) => ({
        ...old,
        lastAttack: old.lastAttack ? { ...old.lastAttack, defender: only } : old.lastAttack,
      }));
    } else if (leaders.length > 1) {
      next = updateKnights(next, (old) => ({
        ...old,
        lastAttack: old.lastAttack ? { ...old.lastAttack, tied: leaders } : old.lastAttack,
      }));
      next = awardTieDraws(next, leaders, roll);
    }
  } else {
    const eligible = order.filter((seat) => availableCities(next, seat).length > 0);
    const lowest = Math.min(...eligible.map((seat) => levels[seat] ?? 0));
    for (const seat of eligible) {
      if ((levels[seat] ?? 0) !== lowest) continue;
      const cities = availableCities(next, seat);
      const only = cities[0];
      if (cities.length === 1 && only !== undefined) next = pillageCity(next, seat, only).state;
      else choosing.push(seat);
    }
  }
  next = updateKnights(next, (old) => ({
    ...old,
    robberLocked: false,
    barbarians: { step: 0 },
    defenders,
    knights: old.knights.map((knight) => ({ ...knight, active: false, ready: false })),
  }));
  return choosing.length ? pushPhase(next, pillageFrame({ remaining: choosing, roll })) : next;
}

/** The `onDiceResult` step for a ship face: the barbarians move a step, and attack on the last. */
export function advanceBarbarians(state: GameState, roll: number): GameState {
  const step = knightsExt(state).barbarians.step + 1;
  return step >= BARBARIAN_STEPS
    ? resolveAttack(state, roll)
    : updateKnights(state, (old) => ({ ...old, barbarians: { step } }));
}

function vertexOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A seat that lost a city chooses which of its cities without a metropolis it is. */
export const choosePillage: CommandHandler = {
  keys: { allowed: ['vertex'] },
  validate: (state, input) => {
    const top = topFrame(state);
    if (top?.module !== KNIGHTS_ID || top.id !== PILLAGE_FRAME)
      return failure('no-pillage', 'No pillage choice is open');
    if (!pillageData(state).remaining.includes(input.seat))
      return failure('not-pillaged', 'This seat has no city to lose');
    const vertex = vertexOf(input.command.vertex);
    return vertex !== null && availableCities(state, input.seat).includes(vertex)
      ? success(undefined)
      : failure('illegal-pillage', 'Choose one of your cities without a metropolis');
  },
  apply: (state, input, ctx) => {
    const data = pillageData(state);
    const vertex = vertexOf(input.command.vertex);
    if (vertex === null) throw new Error('Validated pillage vertex missing');
    const lost = pillageCity(state, input.seat, vertex);
    const event = { type: 'cityPillaged', seat: input.seat, vertex, sideways: lost.sideways };
    const remaining = data.remaining.filter((seat) => seat !== input.seat);
    if (remaining.length)
      return {
        state: replaceTop(lost.state, pillageFrame({ remaining, roll: data.roll })),
        events: [event],
        effects: [],
      };
    // The last choice releases the held-back roll: production and the rest come now.
    const resolved = resolveRoll(popPhase(lost.state), data.roll, ctx);
    return {
      state: resolved.state,
      events: [event, ...resolved.events],
      effects: resolved.effects,
    };
  },
  applyPrivate: (priv, before, input, _data, ctx) => {
    const data = pillageData(before);
    const vertex = vertexOf(input.command.vertex);
    if (vertex === null || data.remaining.length > 1 || data.roll === 7) return success(priv);
    const lost = pillageCity(before, input.seat, vertex);
    return applyPrivateProduction(priv, popPhase(lost.state), data.roll, ctx);
  },
};

export const pillagePhase: PhaseHandler = {
  pending: (state) =>
    withClaim(
      state,
      pillageData(state).remaining.map((seat) =>
        playerPending(state, seat, ['CHOOSE_PILLAGE'], PILLAGE_FRAME),
      ),
    ),
  legalCommands: (state, _frame, seat, priv, ctx) => {
    const claim = claimCommands(state, seat, priv, ctx);
    if (!pillageData(state).remaining.includes(seat)) return claim;
    return {
      commands: [
        ...availableCities(state, seat).map((vertex) => ({ type: 'CHOOSE_PILLAGE', vertex })),
        ...claim.commands,
      ],
      templates: claim.templates,
    };
  },
};

/** The timeout choice: the seat's city without a metropolis that has the lowest vertex id. */
export function automaticPillage(state: GameState, seat: Seat): CommandShape | null {
  const vertex = availableCities(state, seat)[0];
  return pillageData(state).remaining.includes(seat) && vertex !== undefined
    ? { type: 'CHOOSE_PILLAGE', vertex }
    : null;
}
