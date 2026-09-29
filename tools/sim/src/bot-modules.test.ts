import { describe, expect, test } from 'vitest';
import type { BotLevel } from '@cp2p/bots';
import { scenarioById, scenarioConfig } from '@cp2p/maps';
import type { GameConfig } from '@cp2p/engine';
import { gameConfig, runGame } from './run-game.js';

/** A macrotask between games keeps the test worker responsive during long synchronous sweeps. */
const yieldTask = () => new Promise<void>((resolve) => setImmediate(resolve));

function scenario(id: string, players: number): GameConfig {
  const found = scenarioById(id);
  if (!found) throw new Error(`Unknown scenario ${id}`);
  return scenarioConfig(found, players);
}

/** One table per shipped module set: base, five-six, seafaring, knights, seafaring with knights. */
const TABLES: readonly { name: string; config: () => GameConfig }[] = [
  { name: 'base', config: () => gameConfig(4, {}) },
  { name: 'five-six', config: () => gameConfig(6, {}) },
  { name: 'seafaring (four-isles)', config: () => scenario('four-isles', 4) },
  { name: 'knights', config: () => scenario('knights', 4) },
  {
    name: 'seafaring + knights (four-isles-knights)',
    config: () => scenario('four-isles-knights', 4),
  },
];

describe('bots support every shipped module', () => {
  test.each(['easy', 'normal', 'hard'] as const)(
    'the %s bot finishes a game on every module set with only legal commands',
    async (level: BotLevel) => {
      for (const table of TABLES) {
        const config = table.config();
        const warnings: string[] = [];
        const result = runGame({
          seed: 16,
          gameIndex: 0,
          config,
          bots: config.seats.map(() => level),
          iterationBudget: 4,
          onBotWarning: (_seat, message) => warnings.push(message),
        });
        if (!result.state.result) throw new Error(`${table.name} did not finish`);
        // Fallbacks are allowed (they play a random legal move) but must be reported, never silent.
        for (const warning of warnings) expect(warning).toMatch(/no policy for/);
        // oxlint-disable-next-line no-await-in-loop -- Games run one at a time, yielding in between.
        await yieldTask();
      }
    },
    300_000,
  );
});
