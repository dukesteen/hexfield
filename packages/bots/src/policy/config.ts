import { DEFAULT_PLAN, DEFAULT_TRADE_POLICY } from '../eval/index.js';
import type { PlanWeights, TradePolicy, VertexScoreOptions } from '../eval/index.js';

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
  /** Whether development cards are played for their timing (monopoly, road building, army). */
  devCardTactics: boolean;
  /** Whether it trades with the bank toward its goal, or only to pay for a build right now. */
  bankTrades: 'goal' | 'immediate';
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
}

export const EASY: LevelConfig = {
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

export const NORMAL: LevelConfig = {
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
 * Hard plays the Normal heuristic with the refinements that measured stronger in tournaments
 * (see docs/verification/stage16): development cards bought whenever affordable, a hand spent
 * down before a seven can halve it, roads toward the longest road, and knights played early.
 */
export const HARD: LevelConfig = {
  ...NORMAL,
  id: 'hard',
  devAppetite: 3,
  dumpHand: true,
  longestRoad: true,
  knights: 'eager',
};
