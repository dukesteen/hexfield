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
export {
  SEAFARING_ID,
  SEAFARING_VERSION,
  SHIPS_PER_SEAT,
  SHIP_COST,
  canPlaceShip,
  legalPirateHexes,
  legalShipEdges,
  legalShipMoves,
  movableShips,
  regionMap,
  regionOfVertex,
  seafaringExt,
  seafaringModule,
  seafaringOptions,
  shipEdges,
} from './modules/seafaring/index.js';
export {
  ARCHIPELAGO_MAIN,
  explicitBoard,
  seafaringConfig,
  seafaringEngine,
  testArchipelago,
} from './modules/seafaring/testing.js';
export type { HexSpec, SeafaringConfigOptions } from './modules/seafaring/testing.js';
export type {
  FogOption,
  GoldFrameData,
  IslandBonusToken,
  SeafaringExt,
  SeafaringOptions,
} from './modules/seafaring/index.js';

export {
  ABILITY_LEVEL,
  BARBARIAN_FIXTURE,
  BARBARIAN_STEPS,
  WALLS_PER_SEAT,
  barbarianStrength,
  contributions,
  knightAt,
  knightsOf,
  supplyOf,
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
  HAND_LIMIT,
  PROGRESS_CARDS,
  VICTORY_CARDS,
  availableCities,
  citiesOf,
  deckOfTrack,
  hasAbility,
  improvementCost,
  improvementLegal,
  isVictoryCard,
  knightsExt,
  knightsLook,
  knightsModule,
  levelOf,
  metropolisAward,
  trackOfCard,
  trackOfDeck,
} from './modules/knights/index.js';
export type {
  AqueductFrameData,
  AttackReport,
  CheckEntry,
  DealFrameData,
  DisplacedFrameData,
  DrawEntry,
  KnightPiece,
  KnightsExt,
  LookData,
  PillageFrameData,
  SidewaysPiece,
  ProgressFrameData,
  MetropolisFrameData,
  MetropolisHolder,
  Track,
  TrackLevels,
  WallPiece,
} from './modules/knights/index.js';
export { knightsConfig, knightsEngine } from './modules/knights/testing.js';
export type { KnightsConfigOptions } from './modules/knights/testing.js';
export {
  COMBO_ID,
  COMBO_VERSION,
  comboExt,
  seafarersKnightsModule,
} from './modules/seafarers-knights/index.js';
export type { ComboExt } from './modules/seafarers-knights/index.js';
export {
  seafarersKnightsConfig,
  seafarersKnightsEngine,
} from './modules/seafarers-knights/testing.js';
export type { SeafarersKnightsConfigOptions } from './modules/seafarers-knights/testing.js';

export { finishTurnFlowFrame } from './modules/base/phases/turn.js';
export { STANDARD_BOARD, STANDARD_HEXES } from './modules/base/board/shapes.js';
export {
  MODULE_CATALOGUE,
  cardKindsFor,
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
  SEAFARING_TERRAINS,
  boardShapeProblems,
  classifyEdge,
  coastEdgeCycle,
  coastalEdges,
  detectIslands,
  fixtureSlotProblem,
  frameHexes,
  isFogTerrain,
  isLandTerrain,
  isSeaTerrain,
  isTokenlessTerrain,
  landHexes,
  seaSideOfEdge,
  vertexTouchesLand,
} from './core/board/index.js';
export type { EdgeKind, Island } from './core/board/index.js';
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
export {
  harborRate as baseHarborRate,
  boardIslands,
  edgeKindOf,
  isLandHex,
  vertexOnLand,
} from './modules/base/board/index.js';
export {
  kindTransitions,
  longestRoadLength as baseLongestRoadLength,
  longestTrailLength,
} from './modules/base/awards/index.js';
export type { TransitionAllowed, TrailEdge } from './modules/base/awards/index.js';
export type { BaseOptions, TurnTimer, MapLayout, DiceMode } from './modules/base/config.js';
export type { TradeOffer } from './modules/base/types.js';
export { enumerateCommands } from './core/enumerate.js';
export type { EnumerateOptions } from './core/enumerate.js';

export {
  createEngine,
  extraDiceOf,
  isPublicDraw,
  LocalGame,
  publicDrawInput,
  rollExtraDice,
} from './core/pipeline/index.js';
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
  DrawInfo,
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
  canonicalKinds,
  kindsOfCounts,
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
  kindBounds,
  loseHidden,
  loseKnown,
  normalizeBounds,
  revealExact,
} from './core/resources/index.js';
export { RESOURCES, failure, isBaseResource, ruleError, success } from './core/types/index.js';
export type {
  CardCounts,
  CardKind,
  CountMap,
  Resource,
  ResourceCounts,
  Seat,
  Result,
  RuleError,
} from './core/types/index.js';
