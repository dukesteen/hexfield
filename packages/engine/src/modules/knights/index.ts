import type { CommandHandler, GameModule, RenderHint } from '../../core/modules/index.js';
import { finalize } from '../base/shared.js';
import { incompatibleModules } from '../compat.js';
import {
  AQUEDUCT_FRAME,
  aqueductPhase,
  automaticAqueduct,
  chooseAqueduct,
  noteNoProduction,
  openAqueductChoices,
} from './aqueduct.js';
import { COMMODITIES, KNIGHTS_ID, KNIGHTS_OPTIONS, KNIGHTS_VERSION } from './config.js';
import { addKnightsCommands, addKnightsPending } from './flow.js';
import {
  METROPOLIS_FRAME,
  automaticMetropolis,
  buildImprovement,
  hasAbility,
  metropolisPhase,
  placeMetropolisCommand,
} from './improvements.js';
import { knightsInvariants } from './invariants.js';
import {
  cityProduction,
  commodityBank,
  knightsTarget,
  limitWithWalls,
  lockRobber,
  lockSteals,
  metropolisPoints,
  recordEventDie,
  setupCity,
  withEventDie,
} from './rules.js';
import type { KnightsExt } from './types.js';
import { knightsExt } from './types.js';

export {
  ABILITY_LEVEL,
  BARBARIAN_STEPS,
  COMMODITIES,
  COMMODITY_BANK,
  COMMODITY_BANK_FIVE_SIX,
  EVENT_DIE,
  KNIGHTS_ID,
  KNIGHTS_VERSION,
  KNIGHTS_VP_TARGET,
  MAX_LEVEL,
  TRACKS,
  TRACK_COMMODITY,
  WALLS_PER_SEAT,
} from './config.js';
export type { Track } from './config.js';
export {
  availableCities,
  citiesOf,
  hasAbility,
  improvementCost,
  improvementLegal,
  improvementProblem,
  metropolisAward,
} from './improvements.js';
export { knightsExt, levelOf } from './types.js';
export type {
  AqueductFrameData,
  KnightsExt,
  MetropolisFrameData,
  MetropolisHolder,
  TrackLevels,
  WallPiece,
} from './types.js';

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  BUILD_IMPROVEMENT: buildImprovement,
  PLACE_METROPOLIS: placeMetropolisCommand,
  CHOOSE_AQUEDUCT: chooseAqueduct,
};

function finalized(entries: Record<string, CommandHandler>): Record<string, CommandHandler> {
  return Object.fromEntries(
    Object.entries(entries).map(([name, handler]) => [
      name,
      { ...handler, apply: (state, input, ctx) => finalize(handler.apply(state, input, ctx), ctx) },
    ]),
  );
}

/**
 * Cities and Knights, sub-milestones K1 and K2: commodities, the event die, the robber lock, and
 * city improvements with metropolises. Knights, barbarians and progress cards come later.
 */
export function knightsModule(): GameModule {
  return {
    id: KNIGHTS_ID,
    version: KNIGHTS_VERSION,
    dependsOn: ['base'],
    conflictsWith: incompatibleModules(KNIGHTS_ID),
    optionsSchema: [...KNIGHTS_OPTIONS],
    initState: (ctx): KnightsExt => ({
      robberLocked: true,
      barbarians: { step: 0 },
      improvements: ctx.config.seats.map(() => ({ trade: 0, politics: 0, science: 0 })),
      metropolises: { trade: null, politics: null, science: null },
      walls: [],
      eventDie: null,
      noProduction: [],
    }),
    hooks: {
      cardKinds: (acc) => [...acc, ...COMMODITIES],
      bankInit: commodityBank,
      // No development deck: it is empty, so BUY_DEV_CARD and PLAY_DEV_CARD are never legal.
      devDeck: () => ({}),
      diceSpec: withEventDie,
      onDiceResult: recordEventDie,
      production: cityProduction,
      onNoProduction: noteNoProduction,
      afterProduction: openAqueductChoices,
      afterBuild: setupCity,
      handLimit: limitWithWalls,
      robberLike: lockRobber,
      stealTargets: (state, _seat, _blocker, _hex, targets) => lockSteals(state, targets),
      bankRate: (state, seat, kind, rate) =>
        COMMODITIES.includes(kind) && hasAbility(state, seat, 'trade') ? Math.min(rate, 2) : rate,
      vpTarget: (_config, acc) => knightsTarget(acc),
      victoryPoints: (state, seat, _priv, acc) => metropolisPoints(state, seat, acc),
      pending: addKnightsPending,
      legalCommands: (state, seat, priv, acc) => addKnightsCommands(state, seat, priv, acc),
      timeoutAction: (state, request, acc) => {
        if (acc) return acc;
        if (request.phase === AQUEDUCT_FRAME) return automaticAqueduct(state, request.seat);
        if (request.phase === METROPOLIS_FRAME) return automaticMetropolis(state, request.seat);
        return null;
      },
      renderHints: (state, acc) => {
        const ext = knightsExt(state);
        const hints: RenderHint[] = [
          { module: KNIGHTS_ID, kind: 'robber-lock', locked: ext.robberLocked },
          { module: KNIGHTS_ID, kind: 'barbarians', step: ext.barbarians.step },
          { module: KNIGHTS_ID, kind: 'event-die', face: ext.eventDie },
          ...Object.entries(ext.metropolises).flatMap(([track, holder]) =>
            holder ? [{ module: KNIGHTS_ID, kind: 'metropolis', track, ...holder }] : [],
          ),
        ];
        return [...acc, ...hints];
      },
    },
    commands: finalized(COMMAND_HANDLERS),
    systemInputs: {},
    phases: { [AQUEDUCT_FRAME]: aqueductPhase, [METROPOLIS_FRAME]: metropolisPhase },
    invariants: knightsInvariants,
  };
}
