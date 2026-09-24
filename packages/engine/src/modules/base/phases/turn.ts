import type {
  CommandHandler,
  HandlerContext,
  PhaseHandler,
  SystemInputHandler,
} from '../../../core/modules/index.js';
import type { SystemInput } from '../../../core/pipeline/index.js';
import type { GameState, PrivateState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Result, Seat } from '../../../core/types/index.js';
import { applyPrivateProduction, applyProduction } from '../production.js';
import { baseExt, baseOptions } from '../types.js';
import type { DiscardData } from '../types.js';
import {
  affordable,
  countTotal,
  exchangeBank,
  frame,
  parseCounts,
  playerPending,
  privateExchange,
  replaceTop,
  top,
  updateBase,
  withClaim,
} from '../shared.js';
import { tradePendings } from '../trade.js';
import { claimCommands, discardLegal, mainLegal, preRollLegal } from '../legal.js';

const MAIN_COMMANDS = [
  'BUILD_ROAD',
  'BUILD_SETTLEMENT',
  'BUILD_CITY',
  'BUY_DEV_CARD',
  'PLAY_DEV_CARD',
  'MARITIME_TRADE',
  'OFFER_TRADE',
  'CONFIRM_TRADE',
  'CANCEL_TRADE',
  'END_TURN',
];

function discardData(state: GameState): DiscardData {
  const value = top(state).data;
  if (
    typeof value !== 'object' ||
    value === null ||
    !('remaining' in value) ||
    !Array.isArray(value.remaining)
  )
    throw new Error('Missing discard data');
  // The dice-result handler constructs this phase data from game seats.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as DiscardData;
}

function nextSeat(state: GameState): Seat {
  const index = state.config.seats.indexOf(state.turn.activeSeat);
  const seat = state.config.seats[(index + 1) % state.config.seats.length];
  if (seat === undefined) throw new Error('Missing next seat');
  return seat;
}

function validDice(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every(
      (face) => typeof face === 'number' && Number.isSafeInteger(face) && face >= 1 && face <= 6,
    )
  );
}

function diceForIndex(index: number): readonly [number, number] {
  return [Math.floor(index / 6) + 1, (index % 6) + 1];
}

function preparedDiceState(state: GameState, input: SystemInput, ctx: HandlerContext): GameState {
  if (!validDice(input.dice)) throw new Error('Validated dice missing');
  let next = ctx.hooks.afterDiceRolled(state, input.dice);
  if (baseOptions(next.config.options.base).diceMode === 'balanced') {
    const index = input.index;
    if (typeof index !== 'number') throw new Error('Validated index missing');
    next = updateBase(next, (old) => ({
      ...old,
      diceDeck: old.diceDeck.filter((_, item) => item !== index),
    }));
  }
  return next;
}

export const preRollPhase: PhaseHandler = {
  pending: (state) =>
    withClaim(state, [
      playerPending(state, state.turn.activeSeat, ['ROLL_DICE', 'PLAY_DEV_CARD'], 'preRoll'),
    ]),
  legalCommands: (state, _phase, seat, priv) => preRollLegal(state, seat, priv),
};

export const dicePhase: PhaseHandler = {
  legalCommands: (state, _frame, seat, priv) => claimCommands(state, seat, priv),
  pending: (state) =>
    withClaim(state, [
      {
        kind: 'random',
        request:
          baseOptions(state.config.options.base).diceMode === 'balanced'
            ? { type: 'dice', mode: 'balanced', remaining: baseExt(state.ext.base).diceDeck.length }
            : { type: 'dice', mode: 'random', sides: 6, count: 2 },
        systemType: 'DICE_RESULT',
      },
    ]),
};

export const mainPhase: PhaseHandler = {
  pending: (state) => {
    const allowed = baseOptions(state.config.options.base).playerTrades
      ? MAIN_COMMANDS
      : MAIN_COMMANDS.filter(
          (type) => !['OFFER_TRADE', 'CONFIRM_TRADE', 'CANCEL_TRADE'].includes(type),
        );
    const active = playerPending(state, state.turn.activeSeat, allowed, 'main');
    return withClaim(state, [active, ...tradePendings(state)]);
  },
  legalCommands: (state, _phase, seat, priv, ctx) => mainLegal(state, seat, priv, ctx),
};

export const discardPhase: PhaseHandler = {
  pending: (state) =>
    withClaim(
      state,
      discardData(state).remaining.map((seat) =>
        playerPending(state, seat, ['DISCARD'], 'discard'),
      ),
    ),
  legalCommands: (state, _phase, seat, priv) => discardLegal(state, seat, priv),
};

export const rollDice: CommandHandler = {
  validate: () => success(undefined),
  apply: (state) => {
    const options = baseOptions(state.config.options.base);
    let next = state;
    if (options.diceMode === 'balanced' && baseExt(state.ext.base).diceDeck.length <= 6) {
      next = updateBase(next, (old) => ({
        ...old,
        diceDeck: Array.from({ length: 36 }, (_, index) => index),
      }));
    }
    return { state: replaceTop(next, frame('dice')), events: [] };
  },
};

export const diceResult: SystemInputHandler = {
  validate: (state, input) => {
    if (!validDice(input.dice))
      return failure('invalid-dice', 'Dice must contain two faces from 1 to 6');
    if (baseOptions(state.config.options.base).diceMode !== 'balanced')
      return Object.hasOwn(input, 'index')
        ? failure('unknown-field', 'Random dice results cannot include an index')
        : success(undefined);
    if (typeof input.index !== 'number' || !Number.isSafeInteger(input.index))
      return failure('invalid-dice-index', 'Balanced dice index is required');
    const id = baseExt(state.ext.base).diceDeck[input.index];
    if (id === undefined)
      return failure('invalid-dice-index', 'Index is outside the remaining dice deck');
    const pair = diceForIndex(id);
    return pair[0] === input.dice[0] && pair[1] === input.dice[1]
      ? success(undefined)
      : failure('dice-index-mismatch', 'Dice faces do not match the indexed card');
  },
  apply: (state, input, ctx) => {
    if (!validDice(input.dice)) throw new Error('Validated dice missing');
    const roll = input.dice[0] + input.dice[1];
    let next = preparedDiceState(state, input, ctx);
    if (roll !== 7) {
      next = applyProduction(next, roll, ctx);
      next = replaceTop(next, frame('main'));
    } else {
      const limit = baseOptions(next.config.options.base).discardLimit;
      const remaining = next.config.seats.filter((seat) => {
        const holder = next.seats.find((item) => item.seat === seat);
        return (
          holder &&
          holder.resources.total > ctx.hooks.handLimit(next, seat, limit) &&
          Math.floor(holder.resources.total / 2) > 0
        );
      });
      next = replaceTop(
        next,
        remaining.length
          ? frame('discard', { remaining })
          : frame('moveRobber', { returnTo: 'main' }),
      );
    }
    return { state: next, events: [{ type: 'diceRolled', dice: input.dice, roll }] };
  },
  applyPrivate: (priv, before, input, _data, ctx): Result<PrivateState> => {
    if (!validDice(input.dice)) return failure('invalid-dice', 'Dice missing');
    const roll = input.dice[0] + input.dice[1];
    return roll === 7
      ? success(priv)
      : applyPrivateProduction(priv, preparedDiceState(before, input, ctx), roll, ctx);
  },
};

export const discard: CommandHandler = {
  validate: (state, input) => {
    if (!discardData(state).remaining.includes(input.seat))
      return failure('not-discarding', 'Seat has no discard pending');
    const parsed = parseCounts(input.command.cards);
    if (!parsed.ok) return parsed;
    const holder = state.seats.find((seat) => seat.seat === input.seat);
    if (!holder) return failure('invalid-seat', 'Unknown seat');
    const expected = Math.floor(holder.resources.total / 2);
    if (countTotal(parsed.value) !== expected)
      return failure('wrong-discard-count', `Seat must discard ${expected} cards`);
    return affordable(state, input.seat, parsed.value);
  },
  apply: (state, input) => {
    const parsed = parseCounts(input.command.cards);
    if (!parsed.ok) throw new Error('Validated discard missing');
    let next = exchangeBank(state, input.seat, parsed.value, false);
    const remaining = discardData(state).remaining.filter((seat) => seat !== input.seat);
    next = replaceTop(
      next,
      remaining.length
        ? frame('discard', { remaining })
        : frame('moveRobber', { returnTo: 'main' }),
    );
    return {
      state: next,
      events: [{ type: 'resourcesDiscarded', seat: input.seat, count: countTotal(parsed.value) }],
    };
  },
  applyPrivate: (priv, _before, input) => {
    if (priv.seat !== input.seat) return success(priv);
    const parsed = parseCounts(input.command.cards);
    return parsed.ok ? privateExchange(priv, parsed.value, false) : parsed;
  },
};

export const endTurn: CommandHandler = {
  validate: () => success(undefined),
  apply: (state, _input, ctx) => {
    const oldSeat = state.turn.activeSeat;
    const upcoming = nextSeat(state);
    let next = ctx.hooks.onTurnEnd(state, oldSeat);
    next = updateBase(next, (old) => ({ ...old, offers: [] }));
    next = replaceTop(next, frame('preRoll'));
    next = { ...next, turn: { ...next.turn, activeSeat: upcoming, number: state.turn.number + 1 } };
    next = ctx.hooks.onTurnStart(next, upcoming);
    return { state: next, events: [{ type: 'turnStarted', seat: upcoming }] };
  },
};
