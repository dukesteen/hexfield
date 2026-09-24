import { createEngine } from '../../core/pipeline/index.js';
import type {
  CommandHandler,
  GameModule,
  SystemInputHandler,
  Transition,
} from '../../core/modules/index.js';
import type { GameState } from '../../core/state/index.js';
import { BASE_OPTIONS } from './config.js';
import { BANK_START, BASE_VERSION, PIECES_START } from './constants.js';
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

function finalize(transition: Transition): Transition {
  const state = afterInput(transition.state);
  if (!transition.state.result && state.result) {
    return {
      state,
      events: [
        ...transition.events,
        { type: 'gameEnded', winner: state.result.winner, reason: state.result.reason },
      ],
    };
  }
  return { ...transition, state };
}

function finalizedCommands(
  entries: Record<string, CommandHandler>,
): Record<string, CommandHandler> {
  const output: Record<string, CommandHandler> = {};
  for (const [name, handler] of Object.entries(entries)) {
    output[name] = {
      ...handler,
      apply: (state, input, ctx) => {
        const transition = handler.apply(state, input, ctx);
        return finalize(transition);
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
    output[name] = {
      ...handler,
      apply: (state, input, ctx) => {
        const transition = handler.apply(state, input, ctx);
        return finalize(transition);
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
    conflictsWith: [],
    optionsSchema: [...BASE_OPTIONS],
    modifyConfig: (config) => {
      if (config.seats.length < 2 || config.seats.length > 4)
        throw new Error('Base game requires two to four seats');
      return config;
    },
    buildBoard: (ctx) => {
      const options = baseOptions(ctx.config.options.base);
      return generateBoard(
        ctx.rng,
        { mapLayout: options.mapLayout, strictBalance: options.strictBalance },
        ctx.config.board,
      );
    },
    initState: (ctx) => ({
      knightsPlayed: ctx.config.seats.map(() => 0),
      devPlayedTurn: null,
      offers: [],
      diceDeck: Array.from({ length: 36 }, (_, index) => index),
    }),
    initializeState: (_ctx, state): GameState => ({
      ...state,
      bank: { ...BANK_START },
      decks: { dev: { remaining: 25, drawn: [] } },
      awards: { longestRoad: null, largestArmy: null },
      seats: state.seats.map((seat) => ({ ...seat, piecesLeft: { ...PIECES_START } })),
    }),
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
    },
    autoInput: automaticVictoryClaim,
    victoryPoints: hiddenVictoryPoints,
    invariants: baseInvariants,
    privateInvariants: basePrivateInvariants,
  };
}

/** Bind a default rules engine to the base module without global registration. */
export function createBaseEngine() {
  return createEngine([baseModule()]);
}
