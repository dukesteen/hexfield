import type {
  CommandHandler,
  DiceSpec,
  HandlerContext,
  PhaseHandler,
  SystemInputHandler,
  Transition,
} from '../../../core/modules/index.js';
import type { RandomRequest, SystemInput } from '../../../core/pipeline/index.js';
import type { GameEvent } from '../../../core/events/index.js';
import type { GameState, PrivateState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { Result, Seat } from '../../../core/types/index.js';
import { applyPrivateProduction, applyProduction } from '../production.js';
import { baseExt, baseOptions } from '../types.js';
import type { DiscardData } from '../types.js';
import {
  affordable,
  cardKindsOf,
  countTotal,
  exchangeBank,
  frame,
  parseCardCounts,
  playerPending,
  privateExchange,
  replaceTop,
  top,
  updateBase,
  withClaim,
} from '../shared.js';
import { robberStepFrame } from '../robber.js';
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

/** The extra dice's faces of a `DICE_RESULT`, or an empty record without any. */
function extraFaces(input: SystemInput): Record<string, string> {
  const value = input.extra;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** The extra dice of a `DICE_RESULT` must be exactly the ones `diceSpec` declared. */
function checkExtraDice(state: GameState, input: SystemInput, ctx: HandlerContext): Result<void> {
  const declared = ctx.hooks.diceSpec(state, BASE_DICE).extra;
  if (declared.length === 0)
    return Object.hasOwn(input, 'extra')
      ? failure('unknown-field', 'This game has no extra dice')
      : success(undefined);
  const value = input.extra;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return failure('invalid-dice', 'Extra dice faces are required');
  const keys = Object.keys(value);
  if (keys.length !== declared.length || !declared.every((die) => keys.includes(die.id)))
    return failure('invalid-dice', 'Extra dice do not match the game’s dice');
  const faces = extraFaces(input);
  return declared.every((die) => die.faces.includes(faces[die.id] ?? ''))
    ? success(undefined)
    : failure('invalid-dice', 'An extra die shows a face it does not have');
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
  let next = ctx.hooks.onDiceResult(state, input.dice, extraFaces(input));
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
  legalCommands: (state, _phase, seat, priv, ctx) => preRollLegal(state, seat, priv, ctx),
};

/** The standard pair of six-sided dice; modules add extra dice through the diceSpec hook. */
export const BASE_DICE: DiceSpec = Object.freeze({ count: 2, sides: 6, extra: [] });

function extraRequest(spec: DiceSpec): { extra?: { id: string; faces: string[] }[] } {
  return spec.extra.length
    ? { extra: spec.extra.map((die) => ({ id: die.id, faces: [...die.faces] })) }
    : {};
}

function diceRequest(state: GameState, ctx: HandlerContext): RandomRequest {
  if (baseOptions(state.config.options.base).diceMode === 'balanced')
    return {
      type: 'dice',
      mode: 'balanced',
      remaining: baseExt(state.ext.base).diceDeck.length,
      ...extraRequest(ctx.hooks.diceSpec(state, BASE_DICE)),
    };
  const spec = ctx.hooks.diceSpec(state, BASE_DICE);
  return {
    type: 'dice',
    mode: 'random',
    sides: spec.sides,
    count: spec.count,
    ...extraRequest(spec),
  };
}

export const dicePhase: PhaseHandler = {
  legalCommands: (state, _frame, seat, priv, ctx) => claimCommands(state, seat, priv, ctx),
  pending: (state, _frame, ctx) =>
    withClaim(state, [
      { kind: 'random', request: diceRequest(state, ctx), systemType: 'DICE_RESULT' },
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
  legalCommands: (state, _phase, seat, priv, ctx) => discardLegal(state, seat, priv, ctx),
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
    return { state: replaceTop(next, frame('dice')), events: [], effects: [] };
  },
};

export const diceResult: SystemInputHandler = {
  validate: (state, input, ctx) => {
    if (!validDice(input.dice))
      return failure('invalid-dice', 'Dice must contain two faces from 1 to 6');
    const extra = checkExtraDice(state, input, ctx);
    if (!extra.ok) return extra;
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
    let productionEvent: GameEvent | null = null;
    let effects: ReturnType<typeof applyProduction>['effects'] = [];
    if (roll !== 7) {
      const production = applyProduction(next, roll, ctx);
      next = production.state;
      effects = production.effects;
      productionEvent = { type: 'resourcesProduced', bySeat: production.bySeat };
      for (const seat of next.config.seats)
        if (!Object.hasOwn(production.bySeat, seat)) next = ctx.hooks.onNoProduction(next, seat);
      next = replaceTop(next, frame('main'));
      next = ctx.hooks.afterProduction(next, roll);
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
        remaining.length ? frame('discard', { remaining }) : robberStepFrame(next, ctx),
      );
    }
    const extra = extraFaces(input);
    return {
      state: next,
      events: [
        {
          type: 'diceRolled',
          dice: input.dice,
          roll,
          ...(Object.keys(extra).length ? { extra } : {}),
        },
        ...(productionEvent ? [productionEvent] : []),
      ],
      effects,
    };
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
    const parsed = parseCardCounts(input.command.cards, cardKindsOf(state));
    if (!parsed.ok) return parsed;
    const holder = state.seats.find((seat) => seat.seat === input.seat);
    if (!holder) return failure('invalid-seat', 'Unknown seat');
    const expected = Math.floor(holder.resources.total / 2);
    if (countTotal(parsed.value) !== expected)
      return failure('wrong-discard-count', `Seat must discard ${expected} cards`);
    return affordable(state, input.seat, parsed.value);
  },
  apply: (state, input, ctx) => {
    const parsed = parseCardCounts(input.command.cards, cardKindsOf(state));
    if (!parsed.ok) throw new Error('Validated discard missing');
    const spent = exchangeBank(state, input.seat, parsed.value, false);
    let next = spent.state;
    const remaining = discardData(state).remaining.filter((seat) => seat !== input.seat);
    next = replaceTop(
      next,
      remaining.length ? frame('discard', { remaining }) : robberStepFrame(next, ctx),
    );
    return {
      state: next,
      events: [{ type: 'resourcesDiscarded', seat: input.seat, count: countTotal(parsed.value) }],
      effects: spent.effects,
    };
  },
  applyPrivate: (priv, before, input) => {
    if (priv.seat !== input.seat) return success(priv);
    const parsed = parseCardCounts(input.command.cards, cardKindsOf(before));
    return parsed.ok ? privateExchange(priv, parsed.value, false) : parsed;
  },
};

/** Start the next seat's turn from a base turn-end marker or the ending main phase. */
export function startNextTurn(state: GameState, ctx: HandlerContext): Transition {
  const upcoming = nextSeat(state);
  let next = replaceTop(state, frame('preRoll'));
  next = { ...next, turn: { ...next.turn, activeSeat: upcoming, number: state.turn.number + 1 } };
  next = ctx.hooks.onTurnStart(next, upcoming);
  return { state: next, events: [{ type: 'turnStarted', seat: upcoming }], effects: [] };
}

/**
 * Leave a module-inserted turn-flow frame. When only the base turn-end marker remains,
 * the next seat's turn begins in the same input.
 */
export function finishTurnFlowFrame(state: GameState, ctx: HandlerContext): Transition {
  const next = { ...state, turn: { ...state.turn, phase: state.turn.phase.slice(0, -1) } };
  const marker = next.turn.phase.at(-1);
  if (marker?.module === 'base' && marker.id === 'turnEnd') return startNextTurn(next, ctx);
  return { state: next, events: [], effects: [] };
}

export const endTurn: CommandHandler = {
  validate: () => success(undefined),
  apply: (state, _input, ctx) => {
    const oldSeat = state.turn.activeSeat;
    let next = ctx.hooks.onTurnEnd(state, oldSeat);
    next = updateBase(next, (old) => ({ ...old, offers: [] }));
    const flow = ctx.hooks.turnFlow(next, []);
    if (flow.length === 0) return startNextTurn(next, ctx);
    next = replaceTop(next, frame('turnEnd'));
    next = { ...next, turn: { ...next.turn, phase: [...next.turn.phase, ...flow.toReversed()] } };
    return { state: next, events: [{ type: 'turnFlowStarted', seat: oldSeat }], effects: [] };
  },
};

/** A marker below module turn-flow frames. It never reaches the top of the stack. */
export const turnEndPhase: PhaseHandler = {
  pending: () => {
    throw new Error('The turn-end marker cannot be the active phase');
  },
};
