import type { Engine } from '@cp2p/engine';
import { RandomBot } from './random-bot.js';
import { EASY, NORMAL } from './policy/config.js';
import { HeuristicBot } from './policy/heuristic-bot.js';
import type { BotPlugin } from './policy/heuristic-bot.js';
import { knightsPlugin } from './plugins/knights/index.js';
import { knightsPluginV1 } from './plugins/knights-v1.js';
import { seafaringPlugin } from './plugins/seafaring.js';
import { HardBot } from './search/hard-bot.js';
import { BOT_LEVELS } from './types.js';
import type { Bot, BotLevel } from './types.js';

/** The module plugins Normal and Hard use. */
export const PLUGINS: readonly BotPlugin[] = [seafaringPlugin, knightsPlugin];

/** The stage 16 plugins: Easy keeps them, and so do the frozen benchmark levels. */
export const PLUGINS_V1: readonly BotPlugin[] = [seafaringPlugin, knightsPluginV1];

/**
 * Frozen earlier versions of a level, for head-to-head measurement in the simulator only (never
 * offered in a game's setup): `hard-v1` and `normal-v1` play the stage 16 knights policy.
 */
export const BENCHMARK_LEVELS = ['hard-v1', 'normal-v1'] as const;
export type BenchmarkLevel = (typeof BENCHMARK_LEVELS)[number];
export type SimBotLevel = BotLevel | BenchmarkLevel;

export function isSimBotLevel(value: unknown): value is SimBotLevel {
  return (
    typeof value === 'string' &&
    ([...BOT_LEVELS, ...BENCHMARK_LEVELS] as readonly string[]).includes(value)
  );
}

/** A fresh bot of the given level. One bot plays one seat; it keeps a little memory per game. */
export function createBot(level: SimBotLevel, engine?: Engine): Bot {
  switch (level) {
    case 'random':
      return new RandomBot(engine);
    case 'easy':
      return new HeuristicBot(EASY, PLUGINS_V1, engine);
    case 'normal':
      return new HeuristicBot(NORMAL, PLUGINS, engine);
    case 'hard':
      return new HardBot(PLUGINS, engine);
    case 'normal-v1':
      return new HeuristicBot(NORMAL, PLUGINS_V1, engine);
    case 'hard-v1':
      return new HardBot(PLUGINS_V1, engine);
    default:
      throw new RangeError(`Unknown bot level ${String(level)}`);
  }
}
