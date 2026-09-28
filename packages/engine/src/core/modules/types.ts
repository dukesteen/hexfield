import type { GameEvent } from '../events/index.js';
import type { EngineEffect } from '../effects/index.js';
import type { HexCoord } from '../geometry/index.js';
import type {
  CommandInput,
  CommandShape,
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
  hooks: HookPipeline;
}

export interface OptionSpec {
  key: string;
  type: 'boolean' | 'integer' | 'string' | 'enum' | 'object' | 'array';
  default: unknown;
  /** Also accept `null`, whatever the type. */
  nullable?: boolean;
  values?: readonly string[];
  min?: number;
  max?: number;
  validate?(value: unknown): boolean;
}

export type Production = Record<string, Record<string, number>>;
export type Cost = Record<string, number>;
export type PlacementKind = 'settlement' | 'road' | 'city';

/** Inclusive seat-count range allowed by the selected modules. */
export interface SeatRange {
  min: number;
  max: number;
}

/** A fixed place for a board fixture: a harbor-free sea-frame anchor and its outward neighbour. */
export interface FixtureSlot {
  id: string;
  anchor: HexCoord;
  outer: HexCoord;
}

/**
 * One board shape: land positions plus the tile, token and harbor bags that fill it.
 * Harbor slots are coastal edges in perimeter order; fixture slots never share a harbor's frame hex.
 */
export interface BoardShapeSpec {
  id: string;
  hexes: readonly HexCoord[];
  terrains: readonly string[];
  tokens: readonly number[];
  harbors: readonly string[];
  harborSlots: readonly string[];
  fixtureSlots: readonly FixtureSlot[];
  /** Strict-balance cap on the summed token pips of each terrain. */
  pipCaps: Readonly<Record<string, number>>;
  /**
   * Set by a seafaring module. `hexes` then lists every board hex including sea, and a fixed board
   * may use `sea`, `gold` and `fog` terrains. Sea and fog hexes carry no token, harbors need only be
   * coastal, and the robber may start on any land hex or off the board. Only fixed boards are accepted.
   */
  seafaring?: boolean;
}

/** A module's request for a fixture. Genesis assigns declarations to slots in order. */
export interface FixtureDeclaration {
  id: string;
  module: ModuleId;
  size: 2;
  art: string;
}

/** The dice a roll requests. Extra dice are module-defined (for example an event die). */
export interface DiceSpec {
  count: number;
  sides: number;
  extra: readonly { id: string; faces: readonly string[] }[];
}

/** A movable blocker such as the robber or a pirate, with the hexes it may move to. */
export interface Blocker {
  id: string;
  hex: string | null;
  legalHexes: readonly string[];
}

/**
 * Undirected route edges and the vertices that interrupt a route for longest-route awards.
 * An edge may carry a `kind` (for example `road` or `ship`). Edges of the same kind always join at
 * a shared vertex; edges of different kinds join only at a vertex listed in `transitions`
 * (for example the seat's own settlements). Base edges have no kind, so they always join.
 */
export interface RouteGraph {
  edges: readonly { id: string; vertices: readonly [string, string]; kind?: string }[];
  blocked: readonly string[];
  transitions?: readonly string[];
}

/** The public request that a TIMEOUT answers. */
export interface TimeoutRequest {
  seat: Seat;
  phase: string;
}

/** How a draw from a deck is revealed: to the drawer alone, or to every seat. */
export type DeckReveal = 'private' | 'public';

/**
 * A module-declared physical deck. `cards` counts each card type; physical identities are
 * `${type}#${n}` in insertion order. Order and counts are game rules.
 */
export interface DeckSpec {
  cards: Readonly<Record<string, number>>;
  reveal: DeckReveal;
}

/** UI-only description of module overlays and fixture state. Never used by rules. */
export interface RenderHint {
  module: ModuleId;
  kind: string;
  [key: string]: unknown;
}

/**
 * The final hook catalogue. Every hook is composed in dependency order, then module id order.
 * Hooks return new values and never mutate their arguments. Accumulator hooks receive the
 * previous module's result as their last argument; state hooks receive and return state.
 * Call sites are listed in docs/rules/hooks.md.
 */
export interface Hooks {
  seatRange(config: GameConfig, acc: SeatRange): SeatRange;
  boardSpec(config: GameConfig, acc: BoardShapeSpec | null): BoardShapeSpec | null;
  boardFixtures(
    config: GameConfig,
    board: BoardState,
    acc: readonly FixtureDeclaration[],
  ): readonly FixtureDeclaration[];
  cardKinds(acc: readonly string[]): readonly string[];
  bankInit(config: GameConfig, acc: Readonly<Record<string, number>>): Record<string, number>;
  pieceLimits(config: GameConfig, acc: Readonly<Record<string, number>>): Record<string, number>;
  devDeck(config: GameConfig, acc: Readonly<Record<string, number>>): Record<string, number>;
  decks(config: GameConfig, acc: Readonly<Record<string, DeckSpec>>): Record<string, DeckSpec>;
  costs(config: GameConfig, acc: Readonly<Record<string, Cost>>): Record<string, Cost>;
  costOf(state: GameState, buildType: string, cost: Cost): Cost;
  diceSpec(state: GameState, acc: DiceSpec): DiceSpec;
  onDiceResult(state: GameState, dice: readonly [number, number]): GameState;
  production(state: GameState, roll: number, acc: Production): Production;
  /** After production is paid on a non-7 roll and the `main` phase is set. May push a frame. */
  afterProduction(state: GameState, roll: number): GameState;
  onNoProduction(state: GameState, seat: Seat): GameState;
  placement: {
    settlement(state: GameState, seat: Seat, loc: string, verdict: boolean): boolean;
    road(state: GameState, seat: Seat, loc: string, verdict: boolean): boolean;
    city(state: GameState, seat: Seat, loc: string, verdict: boolean): boolean;
  };
  connectivity(state: GameState, seat: Seat, acc: readonly string[]): readonly string[];
  /** Free placements (Road Building) that are legal now. Base starts with the free-road commands. */
  freePieces(state: GameState, seat: Seat, acc: readonly CommandShape[]): readonly CommandShape[];
  routeGraph(state: GameState, seat: Seat, acc: RouteGraph): RouteGraph;
  robberLike(state: GameState, acc: readonly Blocker[]): readonly Blocker[];
  stealTargets(
    state: GameState,
    seat: Seat,
    blocker: string,
    hex: string,
    targets: readonly Seat[],
  ): readonly Seat[];
  handLimit(state: GameState, seat: Seat, limit: number): number;
  afterBuild(state: GameState, seat: Seat, buildType: string, loc: string): GameState;
  onTurnStart(state: GameState, seat: Seat): GameState;
  onTurnEnd(state: GameState, seat: Seat): GameState;
  turnFlow(state: GameState, acc: readonly PhaseFrame[]): readonly PhaseFrame[];
  pending(state: GameState, acc: readonly Pending[]): readonly Pending[];
  victoryPoints(
    state: GameState,
    seat: Seat,
    priv: PrivateState | undefined,
    acc: readonly VpContribution[],
  ): readonly VpContribution[];
  vpTarget(config: GameConfig, acc: number): number;
  legalCommands(
    state: GameState,
    seat: Seat,
    priv: PrivateState | undefined,
    acc: LegalCommandSet,
    /** Supplied by the engine, so a hook can price builds through the cost hooks. */
    ctx?: HandlerContext,
  ): LegalCommandSet;
  timeoutAction(
    state: GameState,
    request: TimeoutRequest,
    acc: CommandShape | null,
  ): CommandShape | null;
  renderHints(state: GameState, acc: readonly RenderHint[]): readonly RenderHint[];
}

export type HookName = keyof Hooks;

/** Hooks execute in dependency order, then module id order. */
export interface HookPipeline extends Hooks {}

export type ModuleHooks = Partial<Omit<Hooks, 'placement'>> & {
  placement?: Partial<Hooks['placement']>;
};

export interface HandlerContext {
  hooks: HookPipeline;
  /**
   * Validate and apply a registered command outside the pending check. Used by automatic
   * actions such as timeouts that resolve a module-owned phase.
   */
  dispatch?(state: GameState, input: CommandInput): Result<Transition>;
  /** The private half of dispatch, for owners affected by an automatically applied command. */
  dispatchPrivate?(
    priv: PrivateState,
    before: GameState,
    input: CommandInput,
    data: PrivateInputData | undefined,
  ): Result<PrivateState>;
}

export interface Transition {
  state: GameState;
  events: GameEvent[];
  effects: EngineEffect[];
}

/** Declared payload fields. Missing fields remain the handler's validation concern. */
export interface InputKeys {
  allowed: readonly string[];
  optional?: readonly string[];
}

export interface CommandHandler {
  keys?: InputKeys;
  validate(state: GameState, input: CommandInput, ctx: HandlerContext): Result<void>;
  apply(state: GameState, input: CommandInput, ctx: HandlerContext): Transition;
  applyPrivate?(
    priv: PrivateState,
    before: GameState,
    input: CommandInput,
    data: PrivateInputData | undefined,
    ctx: HandlerContext,
  ): Result<PrivateState>;
}

export interface SystemInputHandler {
  keys?: InputKeys;
  validate(state: GameState, input: SystemInput, ctx: HandlerContext): Result<void>;
  apply(state: GameState, input: SystemInput, ctx: HandlerContext): Transition;
  accepts?(pending: Pending, input: SystemInput, state: GameState): boolean;
  applyPrivate?(
    priv: PrivateState,
    before: GameState,
    input: SystemInput,
    data: PrivateInputData | undefined,
    ctx: HandlerContext,
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
  /**
   * A public contribution that base folds into `seat.publicVp` after every input, so the
   * victory checks, claims and scoreboards see it. `computeVictoryPoints` does not add it again.
   */
  stored?: boolean;
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
  autoInput?(
    state: GameState,
    privates: ReadonlyMap<Seat, PrivateState>,
    ctx: HandlerContext,
  ): Input | null;
  commands: Record<string, CommandHandler>;
  systemInputs: Record<string, SystemInputHandler>;
  phases: Record<string, PhaseHandler>;
  hooks?: ModuleHooks;
  invariants?(state: GameState, ctx: HandlerContext): string[];
  /** Omniscient checks that require all private states; never used by public replay. */
  privateInvariants?(
    state: GameState,
    privates: ReadonlyMap<Seat, PrivateState>,
    ctx: HandlerContext,
  ): string[];
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
