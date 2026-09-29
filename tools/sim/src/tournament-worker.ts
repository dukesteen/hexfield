import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { playTournamentGames } from './tournament.js';
import type { TournamentOptions } from './tournament.js';

if (isMainThread || !parentPort) throw new Error('Tournament worker must run in a worker thread');

function isTournamentOptions(value: unknown): value is TournamentOptions {
  return (
    typeof value === 'object' &&
    value !== null &&
    'bots' in value &&
    Array.isArray(value.bots) &&
    'games' in value &&
    typeof value.games === 'number'
  );
}

const options: unknown = workerData;
if (!isTournamentOptions(options)) throw new Error('Malformed tournament worker options');
// Node worker_threads MessagePort has a transfer list, not a target origin.
// oxlint-disable-next-line unicorn/require-post-message-target-origin
parentPort.postMessage(playTournamentGames(options));
