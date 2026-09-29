import type {
  BoardShapeSpec,
  CommandHandler,
  GameModule,
  RenderHint,
} from '../../core/modules/index.js';
import type { BoardState, GameConfig } from '../../core/state/index.js';
import { finalize } from '../base/shared.js';
import { incompatibleModules } from '../compat.js';
import { chooseGold, goldChoicePhase, goldTimeout, openGoldChoices, GOLD_FRAME } from './gold.js';
import { buildShip, moveShip, placeFreeShip, placeSetupShip } from './commands.js';
import { addFreeShips, addShipCommands, addShipPending } from './flow.js';
import {
  hexesForEdge,
  hexesForVertexOf,
  inSetupArea,
  islandBonusPoints,
  recordSettlement,
} from './islands.js';
import { generateArchipelagoLayout, archipelagoParamsFor, pirateStartHex } from './archipelago.js';
import { perimeterFixtureSlot } from './fixture.js';
import {
  FOG_FRAME,
  FOG_REVEALED,
  fogDecks,
  fogProblem,
  fogRevealPhase,
  fogRevealed,
  openFogReveal,
  queueFogReveals,
} from './fog.js';
import { seafaringInvariants } from './invariants.js';
import { movePirate, pirateBlocker } from './pirate.js';
import { tradeRoute } from './routes.js';
import { noteBuiltShip, shipEdges } from './ships.js';
import {
  SEAFARING_ID,
  SEAFARING_OPTIONS,
  SEAFARING_VERSION,
  SHIP_COST,
  SHIPS_PER_SEAT,
} from './config.js';
import type { SeafaringExt } from './types.js';
import { seafaringExt, seafaringOptions, updateSeafaring } from './types.js';

export { SEAFARING_ID, SEAFARING_VERSION, SHIP_COST, SHIPS_PER_SEAT } from './config.js';
export type { FogOption, SeafaringLayout, SeafaringOptions } from './config.js';
export { FOG_REVEALED, FOG_TERRAIN_DECK, FOG_TOKEN_DECK } from './fog.js';
export type { FogReveal, GoldFrameData, IslandBonusToken, SeafaringExt } from './types.js';
export { seafaringExt, seafaringOptions } from './types.js';
export { canPlaceShip, legalShipEdges, legalShipMoves, movableShips, shipEdges } from './ships.js';
export { regionMap, regionOfVertex } from './islands.js';
export { legalPirateHexes } from './pirate.js';

const COMMAND_HANDLERS: Record<string, CommandHandler> = {
  BUILD_SHIP: buildShip,
  PLACE_SETUP_SHIP: placeSetupShip,
  PLACE_FREE_SHIP: placeFreeShip,
  MOVE_SHIP: moveShip,
  MOVE_PIRATE: movePirate,
  CHOOSE_GOLD: chooseGold,
};

function finalized(entries: Record<string, CommandHandler>): Record<string, CommandHandler> {
  return Object.fromEntries(
    Object.entries(entries).map(([name, handler]) => [
      name,
      { ...handler, apply: (state, input, ctx) => finalize(handler.apply(state, input, ctx), ctx) },
    ]),
  );
}

/** True when genesis builds the board itself: the archipelago layout with no explicit board. */
function generatesBoard(config: GameConfig): boolean {
  const options: unknown = config.options[SEAFARING_ID];
  const layout: unknown =
    typeof options === 'object' && options !== null ? Reflect.get(options, 'layout') : undefined;
  return layout === 'archipelago' && !config.board;
}

const specs = new WeakMap<BoardState, BoardShapeSpec>();

/**
 * The fixed board's own shape: every hex including sea, and the bags it already holds. Seafaring
 * boards are explicit, so validation checks structure (tokens follow terrain, harbors are
 * coastal, the robber stands on land) and not counts.
 */
function shapeOf(board: BoardState): BoardShapeSpec {
  let spec = specs.get(board);
  if (!spec) {
    const bare: BoardShapeSpec = {
      id: 'seafaring',
      hexes: board.hexes.map(({ q, r }) => ({ q, r })),
      terrains: board.hexes.map((hex) => hex.terrain),
      tokens: board.hexes.flatMap((hex) => (hex.token === null ? [] : [hex.token])),
      harbors: board.harbors.map((harbor) => harbor.kind),
      harborSlots: board.harbors.map((harbor) => harbor.edge),
      fixtureSlots: [],
      pipCaps: {},
      seafaring: true,
    };
    // An explicit board has no frame, so a fixture (the barbarian track) goes outside the perimeter.
    const slot = perimeterFixtureSlot(bare);
    spec = slot ? { ...bare, fixtureSlots: [slot] } : bare;
    specs.set(board, spec);
  }
  return spec;
}

function checkGenesis(config: GameConfig, board: BoardState): void {
  const options = config.options[SEAFARING_ID];
  if (typeof options !== 'object' || options === null) throw new Error('Missing seafaring options');
  const { pirateHex, setupAreas, islandBonus, bonusRegions, fog } = seafaringOptions({ config });
  const byId = new Map(board.hexes.map((hex) => [hex.id, hex]));
  const fogHexes = board.hexes.filter((hex) => hex.terrain === 'fog').length;
  if ((fog !== null || fogHexes > 0) && islandBonus !== null)
    throw new Error('Seafaring cannot combine fog with the island bonus');
  if (fog === null && fogHexes > 0) throw new Error('A board with fog hexes needs the fog option');
  if (fog !== null) {
    const problem = fogProblem(fog, fogHexes);
    if (problem) throw new Error(problem);
  }
  if (pirateHex !== null && byId.get(pirateHex)?.terrain !== 'sea')
    throw new Error('The pirate must start on a sea hex');
  for (const hex of [...(setupAreas ?? []), ...(bonusRegions ?? []).flat()])
    if (!byId.has(hex)) throw new Error(`Unknown hex in seafaring options: ${hex}`);
}

/** Ships, the pirate, gold fields, the new-island bonus and the longest trade route. */
export function seafaringModule(): GameModule {
  return {
    id: SEAFARING_ID,
    version: SEAFARING_VERSION,
    dependsOn: ['base'],
    conflictsWith: incompatibleModules(SEAFARING_ID),
    optionsSchema: [...SEAFARING_OPTIONS],
    // An explicit board is validated as fixed. A generated archipelago replaces the board base
    // builds, so base is left to build its (discarded) default layout from the same random stream.
    modifyConfig: (config) => ({
      ...config,
      options: {
        ...config.options,
        base: {
          ...(typeof config.options.base === 'object' ? config.options.base : {}),
          mapLayout: generatesBoard(config) ? 'random' : 'standard-fixed',
        },
      },
    }),
    buildBoard: (ctx, board) => {
      const generated = generatesBoard(ctx.config)
        ? generateArchipelagoLayout(ctx.rng, archipelagoParamsFor(ctx.config.seats.length)).board
        : board;
      checkGenesis(ctx.config, generated);
      return { ...generated, ships: [] };
    },
    initState: (ctx): SeafaringExt => ({
      pirateHex: seafaringOptions(ctx).pirateHex,
      builtThisTurn: [],
      shipMovedTurn: null,
      homeRegions: ctx.config.seats.map(() => []),
      bonus: [],
      ...(seafaringOptions(ctx).fog === null ? {} : { fog: null }),
    }),
    // A generated archipelago names its own pirate start.
    initializeState: (ctx, state) =>
      generatesBoard(ctx.config)
        ? updateSeafaring(state, (old) => ({
            ...old,
            pirateHex: pirateStartHex(state.board.hexes),
          }))
        : state,
    hooks: {
      boardSpec: (config, acc) => (config.board ? shapeOf(config.board) : acc),
      pieceLimits: (_config, acc) => ({ ...acc, ship: SHIPS_PER_SEAT }),
      costs: (_config, acc) => ({ ...acc, ship: { ...SHIP_COST } }),
      afterProduction: openGoldChoices,
      placement: {
        settlement: (state, _seat, loc, verdict) =>
          verdict && inSetupArea(state, hexesForVertexOf(state, loc)),
        road: (state, _seat, loc, verdict) =>
          verdict && inSetupArea(state, hexesForEdge(state, loc)),
      },
      connectivity: (state, seat, acc) => [...acc, ...shipEdges(state, seat)],
      freePieces: addFreeShips,
      routeGraph: tradeRoute,
      robberLike: pirateBlocker,
      decks: fogDecks,
      pending: addShipPending,
      legalCommands: (state, seat, priv, acc, ctx) =>
        ctx ? addShipCommands(state, seat, priv, acc, ctx) : acc,
      afterInput: openFogReveal,
      afterBuild: (state, seat, type, loc) =>
        type === 'settlement'
          ? recordSettlement(state, seat, loc)
          : queueFogReveals(noteBuiltShip(state, type, loc), seat, type, loc),
      onTurnStart: (state) => updateSeafaring(state, (old) => ({ ...old, builtThisTurn: [] })),
      victoryPoints: (state, seat, _priv, acc) => islandBonusPoints(state, seat, acc),
      timeoutAction: (state, request, acc) =>
        acc ?? (request.phase === GOLD_FRAME ? goldTimeout(state, request.seat) : null),
      renderHints: (state, acc) => {
        const ext = seafaringExt(state);
        const hints: RenderHint[] = [
          { module: SEAFARING_ID, kind: 'pirate', hex: ext.pirateHex },
          ...ext.bonus.map((token) => ({ module: SEAFARING_ID, kind: 'island-bonus', ...token })),
        ];
        return [...acc, ...hints];
      },
    },
    commands: finalized(COMMAND_HANDLERS),
    systemInputs: { [FOG_REVEALED]: fogRevealed },
    phases: { [GOLD_FRAME]: goldChoicePhase, [FOG_FRAME]: fogRevealPhase },
    invariants: seafaringInvariants,
  };
}
