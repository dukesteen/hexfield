import { DEFAULT_PLAN, DEFAULT_TRADE_POLICY } from '../eval/index.js';
import type { PlanWeights, TradePolicy } from '../eval/index.js';

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
}

export const EASY: LevelConfig = {
  id: 'easy',
  placement: 'pips',
  plan: { ...DEFAULT_PLAN, city: 1.15, settlement: 1, devCard: 0.7, maxRoads: 2 },
  trade: { threshold: 0, dangerMargin: 0, dangerThreshold: 0 },
  offers: false,
  robber: 'simple',
  devCardTactics: false,
  bankTrades: 'goal',
  commodityValue: 0.15,
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
};

export const HARD: LevelConfig = { ...NORMAL, id: 'hard' };
