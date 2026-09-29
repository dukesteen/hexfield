import type { Engine } from '@cp2p/engine';
import { HARD } from '../policy/config.js';
import { HeuristicBot } from '../policy/heuristic-bot.js';
import type { BotPlugin } from '../policy/heuristic-bot.js';

/** The searching bot; until the search lands it plays the Normal heuristic. */
export class HardBot extends HeuristicBot {
  constructor(plugins: readonly BotPlugin[], engine?: Engine) {
    super(HARD, plugins, engine);
  }
}
