import { fileURLToPath } from 'node:url';
import { main } from './cli.js';

export { runGame, SimulationFailure } from './run-game.js';
export type { RunGameOptions, RunGameResult, GameStats } from './run-game.js';
export { deriveSeed, createLocalRandomSource } from './random-source.js';
export { makeReplay, verifyReplay, readReplay, writeReplay } from './replay.js';
export type { ReplayFile } from './replay.js';
export { updateGoldens } from './golden.js';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
