import type { Engine } from '@cp2p/engine';
import { RandomBot } from './random-bot.js';
import { EASY, NORMAL } from './policy/config.js';
import { HeuristicBot } from './policy/heuristic-bot.js';
import type { BotPlugin } from './policy/heuristic-bot.js';
import { knightsPlugin } from './plugins/knights.js';
import { seafaringPlugin } from './plugins/seafaring.js';
import { HardBot } from './search/hard-bot.js';
import type { Bot, BotLevel } from './types.js';

/** The module plugins every heuristic level uses. */
export const PLUGINS: readonly BotPlugin[] = [seafaringPlugin, knightsPlugin];

/** A fresh bot of the given level. One bot plays one seat; it keeps a little memory per game. */
export function createBot(level: BotLevel, engine?: Engine): Bot {
  switch (level) {
    case 'random':
      return new RandomBot(engine);
    case 'easy':
      return new HeuristicBot(EASY, PLUGINS, engine);
    case 'normal':
      return new HeuristicBot(NORMAL, PLUGINS, engine);
    case 'hard':
      return new HardBot(PLUGINS, engine);
    default:
      throw new RangeError(`Unknown bot level ${String(level)}`);
  }
}
