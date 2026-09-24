import type { GameStats } from './run-game.js';

export interface SimulationSummary {
  games: number;
  turns: number;
  inputs: number;
  wins: Record<string, number>;
  dice: number[];
  commands: Record<string, number>;
  awardSwingGames: number;
  applyCount: number;
  applyNanoseconds: number;
  gameNanoseconds: number;
  applyMicrosHistogram: number[];
}

/** Fixed-size aggregate suitable for worker messages and large simulation runs. */
export function emptySummary(): SimulationSummary {
  return {
    games: 0,
    turns: 0,
    inputs: 0,
    wins: {},
    dice: Array<number>(13).fill(0),
    commands: {},
    awardSwingGames: 0,
    applyCount: 0,
    applyNanoseconds: 0,
    gameNanoseconds: 0,
    applyMicrosHistogram: Array<number>(1_001).fill(0),
  };
}

export function addGame(summary: SimulationSummary, game: GameStats): void {
  summary.games++;
  summary.turns += game.turns;
  summary.inputs += game.inputs;
  summary.wins[game.winner] = (summary.wins[game.winner] ?? 0) + 1;
  if (game.awardSwing) summary.awardSwingGames++;
  summary.applyCount += game.applyCount;
  summary.applyNanoseconds += game.applyNanoseconds;
  summary.gameNanoseconds += game.elapsedNanoseconds;
  for (let index = 0; index < summary.dice.length; index++)
    summary.dice[index] = (summary.dice[index] ?? 0) + (game.dice[index] ?? 0);
  for (const [command, count] of Object.entries(game.commands))
    summary.commands[command] = (summary.commands[command] ?? 0) + count;
  for (const duration of game.applyDurationsNanoseconds) {
    const bucket = Math.min(1_000, Math.floor(duration / 1_000));
    summary.applyMicrosHistogram[bucket] = (summary.applyMicrosHistogram[bucket] ?? 0) + 1;
  }
}

export function mergeSummary(target: SimulationSummary, part: SimulationSummary): void {
  target.games += part.games;
  target.turns += part.turns;
  target.inputs += part.inputs;
  target.awardSwingGames += part.awardSwingGames;
  target.applyCount += part.applyCount;
  target.applyNanoseconds += part.applyNanoseconds;
  target.gameNanoseconds += part.gameNanoseconds;
  for (const [seat, count] of Object.entries(part.wins))
    target.wins[seat] = (target.wins[seat] ?? 0) + count;
  for (const [command, count] of Object.entries(part.commands))
    target.commands[command] = (target.commands[command] ?? 0) + count;
  for (let index = 0; index < target.dice.length; index++)
    target.dice[index] = (target.dice[index] ?? 0) + (part.dice[index] ?? 0);
  for (let index = 0; index < target.applyMicrosHistogram.length; index++)
    target.applyMicrosHistogram[index] =
      (target.applyMicrosHistogram[index] ?? 0) + (part.applyMicrosHistogram[index] ?? 0);
}

/** Pearson chi-square against 2d6, with 10 degrees of freedom. */
export function diceChiSquare(dice: readonly number[]): number {
  const weights = [1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1];
  const rolls = dice.reduce((sum, count) => sum + count, 0);
  if (rolls === 0) return 0;
  return weights.reduce((sum, weight, index) => {
    const expected = (rolls * weight) / 36;
    const difference = (dice[index + 2] ?? 0) - expected;
    return sum + (difference * difference) / expected;
  }, 0);
}

/** Survival function for chi-square with 10 degrees of freedom. */
export function dicePValue(dice: readonly number[]): number {
  const half = diceChiSquare(dice) / 2;
  const series = Array.from({ length: 5 }, (_, index) => half ** index / factorial(index));
  return Math.exp(-half) * series.reduce((sum, term) => sum + term, 0);
}

function factorial(value: number): number {
  let product = 1;
  for (let index = 2; index <= value; index++) product *= index;
  return product;
}

export function applyP99Milliseconds(summary: SimulationSummary): number {
  if (summary.applyCount === 0) return 0;
  const target = Math.ceil(summary.applyCount * 0.99);
  let seen = 0;
  for (let index = 0; index < summary.applyMicrosHistogram.length; index++) {
    seen += summary.applyMicrosHistogram[index] ?? 0;
    if (seen >= target) return index / 1_000;
  }
  return 1;
}
