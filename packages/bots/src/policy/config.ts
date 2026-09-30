import { DEFAULT_HAND, DEFAULT_PLAN, DEFAULT_ROBBER, DEFAULT_TRADE_POLICY } from '../eval/index.js';
import type {
  HandWeights,
  PlanWeights,
  RobberWeights,
  TradePolicy,
  VertexScoreOptions,
} from '../eval/index.js';

/** Thresholds of the base main phase's trades. */
export interface TradeTuning {
  /** Least hand gain a bank trade toward the goal must bring. */
  bankGain: number;
  /** Least hand gain (usually a loss) of a bank trade that spends down a large hand. */
  dumpGain: number;
  /** How much more the wanted card must be worth than the spare one to offer a 1:1 trade. */
  offerMargin: number;
}

export const DEFAULT_TRADE_TUNING: TradeTuning = {
  bankGain: 0.15,
  dumpGain: -0.6,
  offerMargin: 0.2,
};

/** Values and thresholds of the Cities & Knights policy (follow-up A). */
export interface KnightsParams {
  /** Multiplier on what keeping each progress card is worth. */
  holdScale: number;
  /** Share of a card's keep value a play must beat with three and with four cards held. */
  slack3: number;
  slack4: number;
  /** Activate knights once the attack is this likely before the bot's next action phase. */
  activateAt: number;
  /** Recruit once the attack is this likely within three rounds (activate within two). */
  recruitAt: number;
  /** Most bank trades a metropolis purchase may take in one turn. */
  rushTrades: number;
  /** A commodity's base worth in resource cards, and the extra for a winnable metropolis race. */
  commodityBase: number;
  commodityRace: number;
  /** One victory point in resource cards. */
  vp: number;
}

export const DEFAULT_KNIGHTS: KnightsParams = {
  holdScale: 1,
  slack3: 0.6,
  slack4: 0.2,
  activateAt: 0.25,
  recruitAt: 0.3,
  rushTrades: 2,
  commodityBase: 0.7,
  commodityRace: 0.8,
  vp: 6,
};

/** The knobs that separate the heuristic levels. */
export interface LevelConfig {
  id: 'easy' | 'normal' | 'hard';
  /** Setup placement: raw pips (easy) or the full vertex score. */
  placement: 'pips' | 'score';
  plan: PlanWeights;
  trade: TradePolicy;
  /** Whether the bot proposes trades to other seats. */
  offers: boolean;
  /** Robber: the richest opponent hex (easy) or the threat-weighted choice. */
  robber: 'simple' | 'smart';
  robberWeights: RobberWeights;
  /** Whether development cards are played for their timing (monopoly, road building, army). */
  devCardTactics: boolean;
  /** Whether it trades with the bank toward its goal, or only to pay for a build right now. */
  bankTrades: 'goal' | 'immediate';
  tradeTuning: TradeTuning;
  /** Coefficients of the hand score. */
  hand: HandWeights;
  /** Value of a card that is not a base resource (a commodity), in hand-score units. */
  commodityValue: number;
  /** Missing cards a development purchase may add to the current goal (0: only spare cards). */
  devAppetite: number;
  /** Knights: only against the robber and for the army ('defensive'), or whenever held ('eager'). */
  knights: 'defensive' | 'eager';
  /** Build roads for the longest road award when it is within reach and the goal can spare them. */
  longestRoad: boolean;
  /** Bonuses in the vertex score used for placement ('score' placement only). */
  vertex: VertexScoreOptions;
  /** Before ending a turn above seven cards, spend some (a card, a road, a bank trade). */
  dumpHand: boolean;
  /** The Cities & Knights policy's values (the stage 16 policy ignores them). */
  knightsPolicy: KnightsParams;
}

/** The stage 16 values every level started from. */
const STAGE16 = {
  robberWeights: DEFAULT_ROBBER,
  tradeTuning: DEFAULT_TRADE_TUNING,
  hand: DEFAULT_HAND,
  knightsPolicy: DEFAULT_KNIGHTS,
} as const;

export const EASY: LevelConfig = {
  ...STAGE16,
  id: 'easy',
  placement: 'pips',
  plan: { ...DEFAULT_PLAN, city: 1.15, settlement: 1, devCard: 0.7, maxRoads: 1 },
  trade: { threshold: 0, dangerMargin: 0, dangerThreshold: 0 },
  offers: false,
  robber: 'simple',
  devCardTactics: false,
  bankTrades: 'goal',
  commodityValue: 0.15,
  devAppetite: 0,
  knights: 'defensive',
  dumpHand: false,
  longestRoad: false,
  vertex: {},
};

/** Normal as of follow-up A: frozen as the `normal-v2` benchmark level. */
export const NORMAL_V2: LevelConfig = {
  ...STAGE16,
  id: 'normal',
  placement: 'score',
  plan: DEFAULT_PLAN,
  trade: DEFAULT_TRADE_POLICY,
  offers: true,
  robber: 'smart',
  devCardTactics: true,
  bankTrades: 'goal',
  commodityValue: 0.3,
  devAppetite: 0,
  knights: 'defensive',
  dumpHand: false,
  longestRoad: false,
  vertex: {},
};

/**
 * Hard as of follow-up A (frozen as `hard-v2`): the Normal heuristic with the refinements that
 * measured stronger in tournaments (see docs/verification/stage16): development cards bought
 * whenever affordable, a hand spent down before a seven can halve it, roads toward the longest
 * road, and knights played early.
 */
export const HARD_V2: LevelConfig = {
  ...NORMAL_V2,
  id: 'hard',
  devAppetite: 3,
  dumpHand: true,
  longestRoad: true,
  knights: 'eager',
};

export const NORMAL: LevelConfig = NORMAL_V2;

export const HARD: LevelConfig = HARD_V2;

type Override<T> = { [K in keyof T]?: T[K] extends object | null ? Override<T[K]> : T[K] };

/** A partial level configuration, for tuning runs (`pnpm sim tournament --params`). */
export type ConfigOverride = Override<LevelConfig>;

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Optional keys an override may add where the base leaves them out. */
const OPTIONAL: Readonly<Record<string, readonly string[]>> = {
  vertex: ['diversity', 'expansion', 'harbor'],
  search: ['expansions'],
};

/**
 * Apply an override to a value: plain objects merge key by key, anything else replaces (a null
 * base takes the whole override). Unknown keys and changed types throw, so a mistyped tuning
 * parameter never goes unnoticed.
 */
export function withOverride<T>(base: T, override: unknown, path = 'config'): T {
  if (override === undefined) return base;
  if (!isPlain(override) || !isPlain(base)) {
    if (base !== null && base !== undefined && typeof base !== typeof override)
      throw new TypeError(`${path} must be a ${typeof base}`);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked against base above
    return override as T;
  }
  if (!Object.keys(override).length) return base;
  const optional = OPTIONAL[path.split('.').at(-1) ?? ''] ?? [];
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (!Object.hasOwn(base, key) && !optional.includes(key))
      throw new RangeError(`Unknown parameter ${path}.${key}`);
    next[key] = withOverride(base[key], value, `${path}.${key}`);
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the base's keys, merged
  return next as T;
}
