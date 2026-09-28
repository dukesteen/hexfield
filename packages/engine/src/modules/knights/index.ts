import type { CommandHandler, GameModule, RenderHint } from '../../core/modules/index.js';
import type { GameState } from '../../core/state/index.js';
import type { Seat } from '../../core/types/index.js';
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
import {
  DISPLACED_FRAME,
  automaticRelocation,
  chaseRobber,
  displaceKnight,
  displacedPhase,
  moveKnight,
  relocateKnight,
} from './actions.js';
import { PILLAGE_FRAME, automaticPillage, choosePillage, pillagePhase } from './barbarians.js';
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
  knightRoutes,
  readyForTurn,
  roadNotThroughKnight,
  settlementNotOnKnight,
} from './pieces.js';
import {
  activateKnight,
  buildCityWall,
  buildKnight,
  promoteKnight,
  upgradeSidewaysCity,
} from './recruit.js';
import {
  cityProduction,
  commodityBank,
  knightCosts,
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
export { awardTieDraws, barbarianStrength, contributions } from './barbarians.js';
export { knightAt, knightReach, knightsOf, recruitSites, supplyOf } from './pieces.js';
export type {
  AqueductFrameData,
  AttackReport,
  DisplacedFrameData,
  KnightPiece,
  KnightsExt,
  PillageFrameData,
  SidewaysPiece,
  MetropolisFrameData,
  MetropolisHolder,
  TrackLevels,
  WallPiece,
} from './types.js';

/** While a pillaged city lies on its side, no other settlement may be upgraded first. */
function cityAfterSideways(
  state: GameState,
  seat: Seat,
  _vertex: string,
  verdict: boolean,
): boolean {
  return verdict && !knightsExt(state).sideways.some((piece) => piece.seat === seat);
}

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  BUILD_IMPROVEMENT: buildImprovement,
  PLACE_METROPOLIS: placeMetropolisCommand,
  CHOOSE_AQUEDUCT: chooseAqueduct,
  BUILD_KNIGHT: buildKnight,
  ACTIVATE_KNIGHT: activateKnight,
  PROMOTE_KNIGHT: promoteKnight,
  MOVE_KNIGHT: moveKnight,
  DISPLACE_KNIGHT: displaceKnight,
  RELOCATE_KNIGHT: relocateKnight,
  CHASE_ROBBER: chaseRobber,
  BUILD_CITY_WALL: buildCityWall,
  UPGRADE_SIDEWAYS_CITY: upgradeSidewaysCity,
  CHOOSE_PILLAGE: choosePillage,
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
 * Cities and Knights, sub-milestones K1 to K4: commodities, the event die, the robber lock, city
 * improvements with metropolises, knights with city walls, and the barbarians. Progress cards come
 * later.
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
      knights: [],
      sideways: [],
      defenders: ctx.config.seats.map(() => 0),
      lastAttack: null,
      eventDie: null,
      noProduction: [],
    }),
    hooks: {
      cardKinds: (acc) => [...acc, ...COMMODITIES],
      bankInit: commodityBank,
      // No development deck: it is empty, so BUY_DEV_CARD and PLAY_DEV_CARD are never legal.
      devDeck: () => ({}),
      costs: knightCosts,
      diceSpec: withEventDie,
      onDiceResult: recordEventDie,
      production: cityProduction,
      onNoProduction: noteNoProduction,
      afterProduction: openAqueductChoices,
      afterBuild: setupCity,
      onTurnStart: readyForTurn,
      routeGraph: knightRoutes,
      placement: {
        settlement: settlementNotOnKnight,
        road: roadNotThroughKnight,
        city: cityAfterSideways,
      },
      handLimit: limitWithWalls,
      robberLike: lockRobber,
      stealTargets: (state, _seat, _blocker, _hex, targets) => lockSteals(state, targets),
      bankRate: (state, seat, kind, rate) =>
        COMMODITIES.includes(kind) && hasAbility(state, seat, 'trade') ? Math.min(rate, 2) : rate,
      vpTarget: (_config, acc) => knightsTarget(acc),
      victoryPoints: (state, seat, _priv, acc) => metropolisPoints(state, seat, acc),
      pending: addKnightsPending,
      legalCommands: (state, seat, priv, acc, ctx) =>
        addKnightsCommands(state, seat, priv, acc, ctx),
      timeoutAction: (state, request, acc) => {
        if (acc) return acc;
        if (request.phase === AQUEDUCT_FRAME) return automaticAqueduct(state, request.seat);
        if (request.phase === METROPOLIS_FRAME) return automaticMetropolis(state, request.seat);
        if (request.phase === DISPLACED_FRAME) return automaticRelocation(state, request.seat);
        if (request.phase === PILLAGE_FRAME) return automaticPillage(state, request.seat);
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
          ...ext.knights.map((knight) => ({ module: KNIGHTS_ID, kind: 'knight', ...knight })),
          ...ext.walls.map((wall) => ({ module: KNIGHTS_ID, kind: 'city-wall', ...wall })),
          ...ext.sideways.map((piece) => ({ module: KNIGHTS_ID, kind: 'sideways-city', ...piece })),
        ];
        return [...acc, ...hints];
      },
    },
    commands: finalized(COMMAND_HANDLERS),
    systemInputs: {},
    phases: {
      [AQUEDUCT_FRAME]: aqueductPhase,
      [METROPOLIS_FRAME]: metropolisPhase,
      [DISPLACED_FRAME]: displacedPhase,
      [PILLAGE_FRAME]: pillagePhase,
    },
    invariants: knightsInvariants,
  };
}
