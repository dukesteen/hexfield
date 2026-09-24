import type { GameEvent } from '../events/index.js';
import type {
  CommandInput,
  Input,
  LegalCommandSet,
  Pending,
  PrivateInputData,
  SystemInput,
} from '../pipeline/types.js';
import type {
  BoardState,
  GameConfig,
  GameState,
  ModuleId,
  PhaseFrame,
  PrivateState,
} from '../state/types.js';
import type { Result, Seat } from '../types/index.js';

export interface GenesisRandom {
  nextU32(): number;
  int(maxExclusive: number): number;
  shuffle<T>(items: readonly T[]): T[];
  pick<T>(items: readonly T[]): T;
}

export interface SetupCtx {
  config: GameConfig;
  rng: GenesisRandom;
}

export interface OptionSpec {
  key: string;
  type: 'boolean' | 'integer' | 'string' | 'enum' | 'object';
  default: unknown;
  values?: readonly string[];
  min?: number;
  max?: number;
  validate?(value: unknown): boolean;
}

export type Production = Record<string, Record<string, number>>;
export type Cost = Record<string, number>;
export type PlacementKind = 'settlement' | 'road' | 'city';

export interface Hooks {
  afterDiceRolled(state: GameState, dice: readonly [number, number]): GameState;
  computeProduction(state: GameState, roll: number, acc: Production): Production;
  placementRules: {
    settlement(state: GameState, seat: Seat, loc: string, verdict: boolean): boolean;
    road(state: GameState, seat: Seat, loc: string, verdict: boolean): boolean;
    city(state: GameState, seat: Seat, loc: string, verdict: boolean): boolean;
  };
  costOf(state: GameState, buildType: string, cost: Cost): Cost;
  afterBuild(state: GameState, seat: Seat, buildType: string, loc: string): GameState;
  onTurnStart(state: GameState, seat: Seat): GameState;
  onTurnEnd(state: GameState, seat: Seat): GameState;
  robberTargets(state: GameState, seat: Seat, hex: string, targets: Seat[]): Seat[];
  handLimit(state: GameState, seat: Seat, limit: number): number;
}

/** Hooks execute in dependency order, then module id order. */
export interface HookPipeline extends Hooks {}

export interface HandlerContext {
  hooks: HookPipeline;
}

export interface Transition {
  state: GameState;
  events: GameEvent[];
}

export interface CommandHandler {
  validate(state: GameState, input: CommandInput, ctx: HandlerContext): Result<void>;
  apply(state: GameState, input: CommandInput, ctx: HandlerContext): Transition;
  applyPrivate?(
    priv: PrivateState,
    before: GameState,
    input: CommandInput,
    data: PrivateInputData | undefined,
  ): Result<PrivateState>;
}

export interface SystemInputHandler {
  validate(state: GameState, input: SystemInput, ctx: HandlerContext): Result<void>;
  apply(state: GameState, input: SystemInput, ctx: HandlerContext): Transition;
  accepts?(pending: Pending, input: SystemInput, state: GameState): boolean;
  applyPrivate?(
    priv: PrivateState,
    before: GameState,
    input: SystemInput,
    data: PrivateInputData | undefined,
  ): Result<PrivateState>;
}

export interface PhaseHandler {
  pending(state: GameState, frame: PhaseFrame, ctx: HandlerContext): Pending[];
  legalCommands?(
    state: GameState,
    frame: PhaseFrame,
    seat: Seat,
    priv: PrivateState | undefined,
    ctx: HandlerContext,
  ): LegalCommandSet;
}

export interface VpContribution {
  source: string;
  points: number;
  public: boolean;
}

/** A module owns its extension state, phase handlers and unique input types. */
export interface GameModule<Ext = unknown, PExt = unknown> {
  id: ModuleId;
  version: string;
  dependsOn: readonly ModuleId[];
  conflictsWith: readonly ModuleId[];
  optionsSchema: readonly OptionSpec[];
  modifyConfig?(config: GameConfig): GameConfig;
  buildBoard?(ctx: SetupCtx, board: BoardState): BoardState;
  initState?(ctx: SetupCtx): Ext;
  /** Ordered genesis hook for bank, decks, seat pieces and other shared fields. */
  initializeState?(ctx: SetupCtx, state: GameState): GameState;
  initPrivate?(seat: Seat): PExt;
  initialPhase?(ctx: SetupCtx): PhaseFrame | null;
  /** Omniscient local driver input, such as a hidden victory claim or reveal. */
  autoInput?(state: GameState, privates: ReadonlyMap<Seat, PrivateState>): Input | null;
  commands: Record<string, CommandHandler>;
  systemInputs: Record<string, SystemInputHandler>;
  phases: Record<string, PhaseHandler>;
  hooks?: Partial<Omit<Hooks, 'placementRules'>> & {
    placementRules?: Partial<Hooks['placementRules']>;
  };
  victoryPoints?(state: GameState, seat: Seat, priv?: PrivateState): VpContribution[];
  invariants?(state: GameState): string[];
}

export interface RegisteredHandler<T> {
  module: ModuleId;
  handler: T;
}

export interface ModuleRegistry {
  modules: readonly GameModule[];
  commands: ReadonlyMap<string, RegisteredHandler<CommandHandler>>;
  systemInputs: ReadonlyMap<string, RegisteredHandler<SystemInputHandler>>;
  phases: ReadonlyMap<string, RegisteredHandler<PhaseHandler>>;
  hooks: HookPipeline;
}

export type HandlerInput = Input;
