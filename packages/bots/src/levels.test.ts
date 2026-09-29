import { describe, expect, it } from 'vitest';
import { BENCHMARK_LEVELS, createBot, isSimBotLevel } from './levels.js';
import { HARD_V2, NORMAL_V2, withOverride } from './policy/config.js';
import { HeuristicBot } from './policy/heuristic-bot.js';
import type { Bot } from './types.js';

function configOf(bot: Bot) {
  if (!(bot instanceof HeuristicBot)) throw new Error('Expected a heuristic bot');
  return bot.config;
}

describe('levels and tuning overrides', () => {
  it('offers the frozen benchmark levels to the simulator only', () => {
    expect(BENCHMARK_LEVELS).toEqual(['hard-v1', 'normal-v1', 'hard-v2', 'normal-v2']);
    for (const level of BENCHMARK_LEVELS) expect(isSimBotLevel(level)).toBe(true);
    expect(configOf(createBot('normal-v2'))).toBe(NORMAL_V2);
    expect(configOf(createBot('hard-v2'))).toBe(HARD_V2);
  });

  it('merges an override key by key and refuses unknown or mistyped parameters', () => {
    const tuned = withOverride(HARD_V2, { plan: { production: 0.09 }, hand: { risky: 0.3 } });
    expect(tuned.plan).toEqual({ ...HARD_V2.plan, production: 0.09 });
    expect(tuned.hand.risky).toBe(0.3);
    expect(tuned.trade).toBe(HARD_V2.trade);
    expect(withOverride(HARD_V2, { vertex: { expansion: 0.5 } }).vertex).toEqual({
      expansion: 0.5,
    });
    expect(() => withOverride(HARD_V2, { plan: { producton: 0.09 } })).toThrow(/producton/);
    expect(() => withOverride(HARD_V2, { plan: { production: '0.09' } })).toThrow(/number/);
    const bot = createBot('hard', undefined, { search: { iterations: 2 }, devAppetite: 1 });
    expect(configOf(bot).devAppetite).toBe(1);
    expect(() => createBot('hard', undefined, JSON.parse('{"search":{"iteration":2}}'))).toThrow(
      /search\.iteration/,
    );
  });
});
