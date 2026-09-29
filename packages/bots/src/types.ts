import type {
  CommandShape,
  GameState,
  Pending,
  PrivateState,
  Seat,
  TradeOffer,
} from '@cp2p/engine';

/**
 * Everything a bot may read: the public state and its own seat's secret state. No other seat's
 * private state has a field here, so reading one is a type error (and `createBotView` builds the
 * object with exactly these three keys, so it is absent at runtime too).
 */
export interface BotView {
  readonly state: GameState;
  readonly priv: PrivateState;
  readonly seat: Seat;
}

/** Independent per-game, per-seat random stream. */
export interface BotRng {
  int(maxExclusive: number): number;
}

/** The difficulty levels, weakest first. */
export const BOT_LEVELS = ['random', 'easy', 'normal', 'hard'] as const;
export type BotLevel = (typeof BOT_LEVELS)[number];

export function isBotLevel(value: unknown): value is BotLevel {
  return typeof value === 'string' && (BOT_LEVELS as readonly string[]).includes(value);
}

/** Extra inputs to one decision; every field is optional so a bare `decide` still works. */
export interface DecideContext {
  /** The seat's legal commands, when the caller already has them (they are recomputed otherwise). */
  legal?: readonly CommandShape[];
  /** Wall-clock budget for a searching bot, in milliseconds. */
  timeBudgetMs?: number;
  /**
   * A fixed number of search iterations instead of a wall-clock budget. Simulations set it, so a
   * searching bot plays the same moves on every machine.
   */
  iterationBudget?: number;
  /** Where a bot reports a decision it has no policy for (it then plays a random legal move). */
  warn?: (message: string) => void;
}

export interface Bot {
  id: string;
  decide(view: BotView, pending: Pending, rng: BotRng, context?: DecideContext): CommandShape;
  respondToTrade?(view: BotView, offer: TradeOffer, rng: BotRng): boolean;
  /** Whether the bot takes `gets` for `gives` from `partner` (used when a host settles trades). */
  wantsTrade?(
    view: BotView,
    gets: Readonly<Record<string, number>>,
    gives: Readonly<Record<string, number>>,
    partner: Seat,
  ): boolean;
}
