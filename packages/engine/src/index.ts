export const PACKAGE_NAME = '@cp2p/engine';

export { baseModule, createBaseEngine } from './modules/base/index.js';
export {
  FIVE_SIX_BANK,
  FIVE_SIX_DEV_CARDS,
  FIVE_SIX_ID,
  FIVE_SIX_VERSION,
  SBP_COMMANDS,
  fiveSixModule,
} from './modules/five-six/index.js';
export { FIVE_SIX_BOARD, FIVE_SIX_HEXES } from './modules/five-six/board.js';
export { finishTurnFlowFrame } from './modules/base/phases/turn.js';
export { STANDARD_BOARD, STANDARD_HEXES } from './modules/base/board/shapes.js';
export {
  MODULE_CATALOGUE,
  checkModuleSelection,
  createCatalogueEngine,
  deckCatalogueFor,
  decksFor,
  devCardCatalogueFor,
  devCardCountsFor,
  engineForConfig,
  engineForModules,
  moduleSelection,
  registerAdHocModule,
} from './modules/catalogue.js';
export {
  EXPANSION_IDS,
  MODULE_COMPAT,
  checkModuleCombination,
  compatibility,
} from './modules/compat.js';
export type { Compatibility, ExpansionId } from './modules/compat.js';
export {
  boardShapeProblems,
  coastEdgeCycle,
  fixtureSlotProblem,
  frameHexes,
  seaSideOfEdge,
} from './core/board/index.js';
export { FixtureSlotError } from './core/state/createGame.js';
export { CITY_COST, DEV_COST, ROAD_COST, SETTLEMENT_COST } from './modules/base/constants.js';
export {
  BANK_START,
  BASE_DEV_CARD_CATALOGUE,
  BASE_VERSION,
  DEV_CARD_COUNTS,
  PIECES_START,
  devCardCatalogue,
} from './modules/base/constants.js';
export { harborRate as baseHarborRate } from './modules/base/board/index.js';
export { longestRoadLength as baseLongestRoadLength } from './modules/base/awards/index.js';
export type { BaseOptions, TurnTimer, MapLayout, DiceMode } from './modules/base/config.js';
export type { TradeOffer } from './modules/base/types.js';
export { enumerateCommands } from './core/enumerate.js';
export type { EnumerateOptions } from './core/enumerate.js';

export { createEngine, isPublicDraw, LocalGame, publicDrawInput } from './core/pipeline/index.js';
export type {
  Engine,
  Input,
  CommandInput,
  SystemInput,
  Pending,
  PrivateInputData,
  LegalCommandSet,
  LocalRandomSource,
  LocalRandomAnswer,
  LocalStep,
  LocalGameOptions,
  CommandShape,
} from './core/pipeline/index.js';
export { ENGINE_VERSION } from './core/state/index.js';
export type {
  GameConfig,
  GameState,
  PrivateState,
  PublicView,
  BoardFixture,
  BoardState,
  BoardHex,
  PhaseFrame,
  CardSlot,
  SeatState,
  ModuleSelection,
} from './core/state/index.js';
export type {
  Blocker,
  BoardShapeSpec,
  DeckReveal,
  DeckSpec,
  DiceSpec,
  FixtureDeclaration,
  FixtureSlot,
  HookName,
  ModuleHooks,
  RenderHint,
  RouteGraph,
  SeatRange,
  TimeoutRequest,
  GameModule,
  CommandHandler,
  SystemInputHandler,
  PhaseHandler,
  Hooks,
  HookPipeline,
  OptionSpec,
  VpContribution,
  HandlerContext,
  InputKeys,
  SetupCtx,
  GenesisRandom,
  Transition,
} from './core/modules/index.js';
export type { GameEvent } from './core/events/index.js';
export type { EngineEffect, ResourceEndpoint } from './core/effects/index.js';
export type { ResourceBounds } from './core/resources/index.js';
export {
  addCounts,
  subtractCounts,
  sumCounts,
  validateCounts,
  zeroCounts,
  canAfford,
  checkBounds,
  createResourceBounds,
  exactResourceBounds,
  gainHidden,
  gainKnown,
  isExact,
  loseHidden,
  loseKnown,
  normalizeBounds,
  revealExact,
} from './core/resources/index.js';
export { RESOURCES, failure, ruleError, success } from './core/types/index.js';
export type {
  CardKind,
  CountMap,
  Resource,
  ResourceCounts,
  Seat,
  Result,
  RuleError,
} from './core/types/index.js';
