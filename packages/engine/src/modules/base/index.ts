import { createEngine } from '../../core/pipeline/index.js';
import type {
  CommandHandler,
  GameModule,
  HandlerContext,
  SystemInputHandler,
  Transition,
  InputKeys,
} from '../../core/modules/index.js';
import type { GameState } from '../../core/state/index.js';
import { BASE_OPTIONS } from './config.js';
import { BANK_START, BASE_DECKS, BASE_VERSION, PIECES_START } from './constants.js';
import { STANDARD_BOARD } from './board/shapes.js';
import { incompatibleModules } from '../compat.js';
import { generateBoard } from './setup/board/index.js';
import {
  initialSetup,
  placeRoad,
  placeSettlement,
  setupPhase,
  startSeatInput,
} from './phases/setup.js';
import {
  dicePhase,
  diceResult,
  discard,
  discardPhase,
  endTurn,
  mainPhase,
  preRollPhase,
  rollDice,
  turnEndPhase,
} from './phases/turn.js';
import {
  moveRobber,
  moveRobberPhase,
  steal,
  stealPhase,
  stealResult,
  stealResultPhase,
} from './robber.js';
import { buildCity, buildRoad, buildSettlement } from './builds.js';
import {
  buyDevCard,
  cardDealt,
  drawDevPhase,
  monopolyPhase,
  placeFreeRoad,
  playDevCard,
  revealCount,
  roadBuildingPhase,
  skipRoadBuilding,
} from './devcards.js';
import {
  cancelTrade,
  confirmTrade,
  maritimeTrade,
  offerTrade,
  proposeTrade,
  respondTrade,
} from './trade.js';
import { claimVictory, hiddenVictoryPoints, automaticVictoryClaim } from './victory.js';
import { timeout } from './timeouts.js';
import { baseInvariants, basePrivateInvariants } from './invariants.js';
import { afterInput, frame } from './shared.js';
import { baseOptions } from './types.js';

const COMMAND_KEYS: Record<string, InputKeys> = {
  PLACE_SETTLEMENT: { allowed: ['vertex'] },
  PLACE_ROAD: { allowed: ['edge'] },
  ROLL_DICE: { allowed: [] },
  DISCARD: { allowed: ['cards'] },
  MOVE_ROBBER: { allowed: ['hex'] },
  STEAL: { allowed: ['victim'] },
  BUILD_ROAD: { allowed: ['edge'] },
  BUILD_SETTLEMENT: { allowed: ['vertex'] },
  BUILD_CITY: { allowed: ['vertex'] },
  BUY_DEV_CARD: { allowed: [] },
  PLAY_DEV_CARD: { allowed: ['slotId', 'card', 'params'], optional: ['params'] },
  CLAIM_VICTORY: { allowed: ['slotIds'] },
  PLACE_FREE_ROAD: { allowed: ['edge'] },
  SKIP: { allowed: [] },
  MARITIME_TRADE: { allowed: ['give', 'get'] },
  OFFER_TRADE: { allowed: ['give', 'want', 'to'], optional: ['to'] },
  RESPOND_TRADE: { allowed: ['offerId', 'accept'] },
  PROPOSE_TRADE: { allowed: ['give', 'want'] },
  CONFIRM_TRADE: { allowed: ['offerId', 'withSeat'] },
  CANCEL_TRADE: { allowed: ['offerId'] },
  END_TURN: { allowed: [] },
};

const SYSTEM_KEYS: Record<string, InputKeys> = {
  START_SEAT: { allowed: ['seat'] },
  DICE_RESULT: { allowed: ['dice', 'index'], optional: ['index'] },
  CARD_DEALT: { allowed: ['seat', 'deck', 'slotId', 'card'], optional: ['card'] },
  STEAL_RESULT: { allowed: ['thief', 'victim', 'resource'] },
  REVEAL_COUNT: { allowed: ['seat', 'resource', 'count'] },
  TIMEOUT: { allowed: ['seat', 'phase'] },
};

function finalize(transition: Transition, ctx: HandlerContext): Transition {
  const state = afterInput(transition.state, ctx);
  if (!transition.state.result && state.result) {
    return {
      state,
      events: [
        ...transition.events,
        { type: 'gameEnded', winner: state.result.winner, reason: state.result.reason },
      ],
      effects: transition.effects,
    };
  }
  return { ...transition, state };
}

function finalizedCommands(
  entries: Record<string, CommandHandler>,
): Record<string, CommandHandler> {
  const output: Record<string, CommandHandler> = {};
  for (const [name, handler] of Object.entries(entries)) {
    const keys = COMMAND_KEYS[name];
    if (!keys) throw new Error(`Undeclared base command fields: ${name}`);
    output[name] = {
      ...handler,
      keys,
      apply: (state, input, ctx) => {
        const transition = handler.apply(state, input, ctx);
        return finalize(transition, ctx);
      },
    };
  }
  return output;
}

function finalizedSystems(
  entries: Record<string, SystemInputHandler>,
): Record<string, SystemInputHandler> {
  const output: Record<string, SystemInputHandler> = {};
  for (const [name, handler] of Object.entries(entries)) {
    const keys = SYSTEM_KEYS[name];
    if (!keys) throw new Error(`Undeclared base system fields: ${name}`);
    output[name] = {
      ...handler,
      keys,
      apply: (state, input, ctx) => {
        const transition = handler.apply(state, input, ctx);
        return finalize(transition, ctx);
      },
    };
  }
  return output;
}

/** Complete 2–4 seat base rules as a self-contained engine module. */
export function baseModule(): GameModule {
  return {
    id: 'base',
    version: BASE_VERSION,
    dependsOn: [],
    conflictsWith: incompatibleModules('base'),
    optionsSchema: [...BASE_OPTIONS],
    buildBoard: (ctx) => {
      const options = baseOptions(ctx.config.options.base);
      return generateBoard(
        ctx.rng,
        { mapLayout: options.mapLayout, strictBalance: options.strictBalance },
        ctx.config.board,
        ctx.hooks.boardSpec(ctx.config, null) ?? STANDARD_BOARD,
      );
    },
    initState: (ctx) => ({
      knightsPlayed: ctx.config.seats.map(() => 0),
      devPlayedTurn: null,
      offers: [],
      diceDeck: Array.from({ length: 36 }, (_, index) => index),
    }),
    initializeState: (ctx, state): GameState => {
      const pieces = ctx.hooks.pieceLimits(ctx.config, PIECES_START);
      const decks = Object.fromEntries(
        Object.entries(ctx.hooks.decks(ctx.config, BASE_DECKS)).map(([id, spec]) => [
          id,
          {
            remaining: Object.values(spec.cards).reduce((sum, count) => sum + count, 0),
            drawn: [],
          },
        ]),
      );
      return {
        ...state,
        bank: { ...ctx.hooks.bankInit(ctx.config, BANK_START) },
        decks,
        awards: { longestRoad: null, largestArmy: null },
        seats: state.seats.map((seat) => ({ ...seat, piecesLeft: { ...pieces } })),
      };
    },
    // Base values are the initial accumulators at base call sites; these hooks only cover
    // values that core, not base, starts.
    hooks: {
      seatRange: () => ({ min: 2, max: 4 }),
      boardSpec: (_config, acc) => acc ?? STANDARD_BOARD,
      victoryPoints: (state, seat, priv, acc) => [
        ...acc,
        ...hiddenVictoryPoints(state, seat, priv),
      ],
    },
    initialPhase: () => frame('setup', initialSetup),
    commands: finalizedCommands({
      PLACE_SETTLEMENT: placeSettlement,
      PLACE_ROAD: placeRoad,
      ROLL_DICE: rollDice,
      DISCARD: discard,
      MOVE_ROBBER: moveRobber,
      STEAL: steal,
      BUILD_ROAD: buildRoad,
      BUILD_SETTLEMENT: buildSettlement,
      BUILD_CITY: buildCity,
      BUY_DEV_CARD: buyDevCard,
      PLAY_DEV_CARD: playDevCard,
      CLAIM_VICTORY: claimVictory,
      PLACE_FREE_ROAD: placeFreeRoad,
      SKIP: skipRoadBuilding,
      MARITIME_TRADE: maritimeTrade,
      OFFER_TRADE: offerTrade,
      RESPOND_TRADE: respondTrade,
      PROPOSE_TRADE: proposeTrade,
      CONFIRM_TRADE: confirmTrade,
      CANCEL_TRADE: cancelTrade,
      END_TURN: endTurn,
    }),
    systemInputs: finalizedSystems({
      START_SEAT: startSeatInput,
      DICE_RESULT: diceResult,
      CARD_DEALT: cardDealt,
      STEAL_RESULT: stealResult,
      REVEAL_COUNT: revealCount,
      TIMEOUT: timeout,
    }),
    phases: {
      setup: setupPhase,
      preRoll: preRollPhase,
      dice: dicePhase,
      discard: discardPhase,
      moveRobber: moveRobberPhase,
      steal: stealPhase,
      stealResult: stealResultPhase,
      main: mainPhase,
      drawDev: drawDevPhase,
      roadBuilding: roadBuildingPhase,
      monopoly: monopolyPhase,
      turnEnd: turnEndPhase,
    },
    autoInput: automaticVictoryClaim,
    invariants: baseInvariants,
    privateInvariants: basePrivateInvariants,
  };
}

/** Bind a default rules engine to the base module without global registration. */
export function createBaseEngine() {
  return createEngine([baseModule()]);
}
