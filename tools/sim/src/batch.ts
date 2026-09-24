import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBaseEngine } from '@cp2p/engine';
import { makeReplay, writeReplay } from './replay.js';
import { runGame, SimulationFailure } from './run-game.js';
import type { RunGameOptions } from './run-game.js';
import { addGame, emptySummary } from './stats.js';
import type { SimulationSummary } from './stats.js';

export interface BatchOptions extends Omit<RunGameOptions, 'gameIndex'> {
  games: number;
  startIndex?: number;
  stride?: number;
  failuresDirectory?: string;
}

export interface BatchFailure {
  gameIndex: number;
  message: string;
  replayPath: string;
  repro: string;
}

export interface BatchResult {
  summary: SimulationSummary;
  failures: BatchFailure[];
}

function writeFailure(
  error: SimulationFailure,
  seed: number,
  gameIndex: number,
  directory: string,
  options: BatchOptions,
): BatchFailure {
  mkdirSync(directory, { recursive: true });
  const replayPath = join(directory, `${seed}-${gameIndex}.replay.json`);
  const replay = makeReplay(createBaseEngine(), error.config, error.genesisSeed, error.inputs, 25, {
    allowFinalInvariantFailure: true,
  });
  writeReplay(replayPath, replay);
  const repro = `pnpm sim replay ${replayPath}`;
  writeFileSync(
    join(directory, `${seed}-${gameIndex}.failure.json`),
    `${JSON.stringify(
      {
        seed,
        gameIndex,
        source: 'run',
        category: error.category,
        message: error.message,
        attemptedInput: error.attemptedInput ?? null,
        players: options.players ?? 4,
        baseOptions: options.baseOptions ?? {},
        maxTurns: options.maxTurns ?? 500,
        maxInputsWithoutTurn: options.maxInputsWithoutTurn ?? 2_000,
        verify: options.verify !== false,
        repro,
      },
      null,
      2,
    )}\n`,
  );
  return { gameIndex, message: error.message, replayPath, repro };
}

/** Run a stable strided subset; changing worker count does not change game seeds. */
export function runBatch(options: BatchOptions): BatchResult {
  const summary = emptySummary();
  const failures: BatchFailure[] = [];
  const startIndex = options.startIndex ?? 0;
  const stride = options.stride ?? 1;
  if (!Number.isSafeInteger(options.games) || options.games < 1)
    throw new RangeError('Game count must be positive');
  if (!Number.isSafeInteger(startIndex) || startIndex < 0)
    throw new RangeError('Start index must be non-negative');
  if (!Number.isSafeInteger(stride) || stride < 1) throw new RangeError('Stride must be positive');
  for (let gameIndex = startIndex; gameIndex < options.games; gameIndex += stride) {
    try {
      addGame(summary, runGame({ ...options, gameIndex }).stats);
    } catch (error) {
      if (!(error instanceof SimulationFailure)) throw error;
      failures.push(
        writeFailure(
          error,
          options.seed,
          gameIndex,
          options.failuresDirectory ?? 'failures',
          options,
        ),
      );
    }
  }
  return { summary, failures };
}
