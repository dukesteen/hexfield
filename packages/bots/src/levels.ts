import type { Engine } from '@cp2p/engine';
import { RandomBot } from './random-bot.js';
import { EASY, HARD, HARD_V2, NORMAL, NORMAL_V2, withOverride } from './policy/config.js';
import type { ConfigOverride, LevelConfig } from './policy/config.js';
import { HeuristicBot } from './policy/heuristic-bot.js';
import type { BotPlugin } from './policy/heuristic-bot.js';
import { knightsPlugin } from './plugins/knights/index.js';
import { knightsPluginV1 } from './plugins/knights-v1.js';
import { seafaringPlugin } from './plugins/seafaring.js';
import { DEFAULT_SEARCH, HARD_SEARCH, HardBot } from './search/hard-bot.js';
import type { SearchSettings } from './search/hard-bot.js';
import { BOT_LEVELS } from './types.js';
import type { Bot, BotLevel } from './types.js';

/** The module plugins Normal and Hard use. */
export const PLUGINS: readonly BotPlugin[] = [seafaringPlugin, knightsPlugin];

/** The stage 16 plugins: Easy keeps them, and so do the `-v1` benchmark levels. */
export const PLUGINS_V1: readonly BotPlugin[] = [seafaringPlugin, knightsPluginV1];

/**
 * Frozen earlier versions of a level, for head-to-head measurement in the simulator only (never
 * offered in a game's setup): `-v1` is stage 16 (its knights policy), `-v2` follow-up A (the
 * knights policy, the stage 16 base heuristic and search).
 */
export const BENCHMARK_LEVELS = ['hard-v1', 'normal-v1', 'hard-v2', 'normal-v2'] as const;
export type BenchmarkLevel = (typeof BENCHMARK_LEVELS)[number];
export type SimBotLevel = BotLevel | BenchmarkLevel;

export function isSimBotLevel(value: unknown): value is SimBotLevel {
  return (
    typeof value === 'string' &&
    ([...BOT_LEVELS, ...BENCHMARK_LEVELS] as readonly string[]).includes(value)
  );
}

/**
 * Parameters a tuning run changes for one level (`pnpm sim tournament --params`): any part of its
 * configuration, and for a searching level its search settings.
 */
export type BotOverride = ConfigOverride & { search?: Partial<SearchSettings> };

function hard(
  config: LevelConfig,
  plugins: readonly BotPlugin[],
  search: SearchSettings,
  engine: Engine | undefined,
  override?: BotOverride,
): Bot {
  const { search: searchOverride, ...rest } = override ?? {};
  return new HardBot(
    plugins,
    engine,
    withOverride(search, searchOverride, 'search'),
    withOverride(config, rest),
  );
}

/** A fresh bot of the given level. One bot plays one seat; it keeps a little memory per game. */
export function createBot(level: SimBotLevel, engine?: Engine, override?: BotOverride): Bot {
  const plain = (config: LevelConfig, plugins: readonly BotPlugin[]): Bot => {
    const { search: _search, ...rest } = override ?? {};
    return new HeuristicBot(withOverride(config, rest), plugins, engine);
  };
  switch (level) {
    case 'random':
      return new RandomBot(engine);
    case 'easy':
      return plain(EASY, PLUGINS_V1);
    case 'normal':
      return plain(NORMAL, PLUGINS);
    case 'hard':
      return hard(HARD, PLUGINS, HARD_SEARCH, engine, override);
    case 'normal-v2':
      return plain(NORMAL_V2, PLUGINS);
    case 'hard-v2':
      return hard(HARD_V2, PLUGINS, DEFAULT_SEARCH, engine, override);
    case 'normal-v1':
      return plain(NORMAL_V2, PLUGINS_V1);
    case 'hard-v1':
      return hard(HARD_V2, PLUGINS_V1, DEFAULT_SEARCH, engine, override);
    default:
      throw new RangeError(`Unknown bot level ${String(level)}`);
  }
}
