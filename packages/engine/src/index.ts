export const PACKAGE_NAME = '@cp2p/engine';

export { baseModule, createBaseEngine } from './modules/base/index.js';
export type { BaseOptions, TurnTimer, MapLayout, DiceMode } from './modules/base/config.js';

export { createEngine, LocalGame } from './core/pipeline/index.js';
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
} from './core/pipeline/index.js';
export { ENGINE_VERSION } from './core/state/index.js';
export type {
  GameConfig,
  GameState,
  PrivateState,
  PublicView,
  BoardState,
  BoardHex,
  PhaseFrame,
  CardSlot,
  SeatState,
  ModuleSelection,
} from './core/state/index.js';
export type {
  GameModule,
  CommandHandler,
  SystemInputHandler,
  PhaseHandler,
  Hooks,
  HookPipeline,
  OptionSpec,
  VpContribution,
  HandlerContext,
  SetupCtx,
  GenesisRandom,
  Transition,
} from './core/modules/index.js';
export type { GameEvent } from './core/events/index.js';
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
