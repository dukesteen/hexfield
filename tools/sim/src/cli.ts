import { existsSync, readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { fromBase64Url, hashValue, toHex } from '@cp2p/codec';
import { createBaseEngine, RESOURCES } from '@cp2p/engine';
import type { GameState, Input, PrivateState, Seat } from '@cp2p/engine';
import { runBatch } from './batch.js';
import type { BatchOptions, BatchResult } from './batch.js';
import { runGame, SimulationFailure } from './run-game.js';
import { fuzz } from './fuzz.js';
import { updateGoldens } from './golden.js';
import { readReplay, verifyReplay } from './replay.js';
import type { ReplayFile } from './replay.js';
import { sourceFingerprint } from './provenance.js';
import {
  applyP99Milliseconds,
  diceChiSquare,
  dicePValue,
  emptySummary,
  mergeSummary,
} from './stats.js';

type ParsedArgs = Record<string, string | boolean>;

function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (let index = 0; index < args.length; index++) {
    const part = args[index];
    if (!part?.startsWith('--')) throw new Error(`Unexpected argument ${String(part)}`);
    const key = part.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) parsed[key] = true;
    else {
      parsed[key] = next;
      index++;
    }
  }
  return parsed;
}

function integer(value: string | boolean | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`--${name} needs an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`--${name} needs a safe integer`);
  return number;
}

function parseBaseOptions(value: string | boolean | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'string') throw new Error('--options needs a JSON object');
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('--options needs a JSON object');
  return Object.fromEntries(Object.entries(parsed));
}

function runOptions(args: ParsedArgs, verify: boolean): BatchOptions & { parallel: number } {
  if (args.modules !== undefined && args.modules !== 'base')
    throw new Error('Only --modules base is available in Stage04');
  if (
    args.bots !== undefined &&
    (typeof args.bots !== 'string' || args.bots.split(',').some((bot) => bot !== 'random'))
  )
    throw new Error('Only random bots are available in Stage04');
  return {
    games: integer(args.games, 1, 'games'),
    players: integer(args.players, 4, 'players'),
    seed: integer(args.seed, 42, 'seed'),
    parallel: integer(args.parallel, 1, 'parallel'),
    baseOptions: parseBaseOptions(args.options),
    verify,
  };
}

function workerBatch(batchOptions: BatchOptions): Promise<BatchResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), {
      workerData: batchOptions,
    });
    let settled = false;
    worker.once('message', (message: BatchResult) => {
      settled = true;
      resolve(message);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`Simulation worker exited with code ${code}`));
    });
  });
}

async function runCommand(args: ParsedArgs, bench: boolean): Promise<void> {
  const { parallel, ...batch } = runOptions(args, !bench);
  if (!Number.isSafeInteger(batch.games) || batch.games < 1)
    throw new Error('--games must be positive');
  if (!Number.isSafeInteger(parallel) || parallel < 1)
    throw new Error('--parallel must be positive');
  if (bench && parallel !== 1) throw new Error('Benchmark requires --parallel 1');
  const fingerprint = sourceFingerprint();
  const warmupGames = bench ? 5 : 0;
  if (warmupGames) {
    const warmup = runBatch({
      ...batch,
      games: batch.games + warmupGames,
      startIndex: batch.games,
    });
    if (warmup.failures.length) {
      console.log(
        JSON.stringify({
          mode: 'bench',
          seed: batch.seed,
          players: batch.players,
          requestedGames: batch.games,
          warmupGames,
          warmupFailures: warmup.failures,
          sourceFingerprint: fingerprint,
          sourceUnchanged: sourceFingerprint() === fingerprint,
        }),
      );
      process.exitCode = 1;
      return;
    }
  }
  const started = performance.now();
  const parts =
    parallel === 1
      ? [runBatch(batch)]
      : await Promise.all(
          Array.from({ length: Math.min(parallel, batch.games) }, (_, index) =>
            workerBatch({ ...batch, startIndex: index, stride: Math.min(parallel, batch.games) }),
          ),
        );
  const summary = emptySummary();
  const failures = parts
    .flatMap((part) => part.failures)
    .toSorted((a, b) => a.gameIndex - b.gameIndex);
  for (const part of parts) mergeSummary(summary, part.summary);
  const output = {
    mode: bench ? 'bench' : 'run',
    seed: batch.seed,
    players: batch.players,
    baseOptions: batch.baseOptions,
    requestedGames: batch.games,
    parallel,
    warmupGames,
    verifyInvariants: batch.verify !== false,
    completedGames: summary.games,
    failedGames: failures.length,
    averageTurns: summary.games ? summary.turns / summary.games : null,
    averageInputs: summary.games ? summary.inputs / summary.games : null,
    wins: summary.wins,
    dice: summary.dice,
    diceChiSquare: diceChiSquare(summary.dice),
    dicePValue: dicePValue(summary.dice),
    commands: summary.commands,
    awardSwingPercent: summary.games ? (100 * summary.awardSwingGames) / summary.games : null,
    averageApplyMillisecondsPerGame: summary.games
      ? summary.applyNanoseconds / 1e6 / summary.games
      : null,
    averageGameMilliseconds: summary.games ? summary.gameNanoseconds / 1e6 / summary.games : null,
    applyP99Milliseconds: applyP99Milliseconds(summary),
    elapsedMilliseconds: performance.now() - started,
    sourceFingerprint: fingerprint,
    sourceUnchanged: sourceFingerprint() === fingerprint,
    failures,
  };
  console.log(JSON.stringify(output));
  if (failures.length) process.exitCode = 1;
}

export function failureMatches(category: string, observed: string): boolean {
  if (category === 'accepted-invalid') return observed === 'validated';
  if (category === 'dead-turn' || category === 'dead-stall') return observed === category;
  if (category === 'public-invariant') return observed === 'public-invariant';
  if (category === 'private-failure') return observed === 'private-failure';
  if (category === 'input-rejected') return observed === 'input-rejected';
  if (category === 'driver-failure') return observed === 'driver-failure';
  if (category === 'apply-rejected') return observed === 'apply-rejected';
  if (category === 'invariant-violation' || category === 'trace-public-violation')
    return observed === 'invariant-violation';
  if (category === 'state-mutation') return observed === 'state-mutation';
  if (category === 'private-invariant-violation' || category === 'trace-private-violation')
    return observed === 'private-invariant-violation';
  if (category === 'plausible-private-rejected' || category === 'trace-private-rejected')
    return observed === 'private-rejected';
  if (category === 'plausible-private-throw' || category === 'trace-private-throw')
    return observed === 'private-throw';
  if (category === 'validate-throw') return observed === 'validate-throw';
  if (category === 'plausible-throw' || category === 'trace-throw')
    return observed === 'apply-throw';
  if (category === 'invariant-throw' || category === 'trace-invariant-throw')
    return observed === 'invariant-throw';
  if (category === 'trace-rejected') return observed === 'rejected';
  return false;
}

function replayPrivates(
  engine: ReturnType<typeof createBaseEngine>,
  replay: ReplayFile,
): Map<Seat, PrivateState> {
  let before = engine.createGame(replay.config, fromBase64Url(replay.genesisSeed));
  let privates = new Map(
    before.config.seats.map((seat) => [seat, engine.createPrivateState(seat)]),
  );
  for (const input of replay.inputs) {
    const applied = engine.apply(before, input);
    if (!applied.ok) throw new Error(`Replay prefix rejected ${applied.error.code}`);
    const next = new Map<Seat, PrivateState>();
    for (const seat of before.config.seats) {
      const prior = privates.get(seat);
      if (!prior) throw new Error(`Replay prefix missing seat ${seat}`);
      const updated = engine.applyPrivate(prior, before, input);
      if (!updated.ok) throw new Error(`Replay prefix private reject ${updated.error.code}`);
      next.set(seat, updated.value);
    }
    privates = next;
    before = applied.value.state;
  }
  return privates;
}

function observePrivateAttempt(
  engine: ReturnType<typeof createBaseEngine>,
  before: GameState,
  after: GameState,
  input: Input,
  original: unknown,
  privates: ReadonlyMap<Seat, PrivateState>,
): string {
  const originalCard =
    typeof original === 'object' &&
    original !== null &&
    'type' in original &&
    original.type === 'CARD_DEALT' &&
    'card' in original &&
    typeof original.card === 'string'
      ? original.card
      : undefined;
  const privateData =
    input.kind === 'system' &&
    input.type === 'CARD_DEALT' &&
    input.card === undefined &&
    originalCard !== undefined
      ? { card: originalCard }
      : undefined;
  const next = new Map<Seat, PrivateState>();
  for (const seat of before.config.seats) {
    const prior = privates.get(seat);
    if (!prior) return 'private-rejected';
    let updated: ReturnType<typeof engine.applyPrivate>;
    try {
      updated = engine.applyPrivate(prior, before, input, privateData);
    } catch {
      return 'private-throw';
    }
    if (!updated.ok) return 'private-rejected';
    next.set(seat, updated.value);
  }
  for (const holder of after.seats) {
    const priv = next.get(holder.seat);
    if (!priv) return 'private-invariant-violation';
    let total = 0;
    for (const resource of RESOURCES) {
      const count = priv.hand[resource];
      if (
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < holder.resources.min[resource] ||
        count > holder.resources.max[resource]
      )
        return 'private-invariant-violation';
      total += count;
    }
    if (total !== holder.resources.total) return 'private-invariant-violation';
  }
  try {
    return engine.checkPrivateInvariants(after, next).length
      ? 'private-invariant-violation'
      : 'accepted-valid';
  } catch {
    return 'private-throw';
  }
}

function observeAttempt(
  engine: ReturnType<typeof createBaseEngine>,
  state: ReturnType<typeof verifyReplay>,
  attempted: unknown,
  category: string,
  original: unknown,
  privates: ReadonlyMap<Seat, PrivateState>,
): string {
  // Fuzz failure payloads deliberately contain malformed inputs.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const input = attempted as Input;
  const beforeHash = toHex(hashValue(state));
  let valid: ReturnType<typeof engine.validate>;
  try {
    valid = engine.validate(state, input);
  } catch {
    return 'validate-throw';
  }
  if (toHex(hashValue(state)) !== beforeHash) return 'state-mutation';
  if (!valid.ok) return 'rejected';
  if (category === 'accepted-invalid') return 'validated';
  let applied: ReturnType<typeof engine.apply>;
  try {
    applied = engine.apply(state, input);
  } catch {
    return 'apply-throw';
  }
  if (toHex(hashValue(state)) !== beforeHash) return 'state-mutation';
  if (!applied.ok) return 'apply-rejected';
  try {
    if (engine.checkInvariants(applied.value.state).length) return 'invariant-violation';
  } catch {
    return 'invariant-throw';
  }
  return observePrivateAttempt(engine, state, applied.value.state, input, original, privates);
}

/** Replay a valid prefix and compare the observed failure with its recorded category. */
export function replayCommand(path: string): Record<string, unknown> {
  const replay = readReplay(path);
  const sidecar = path.replace(/\.replay\.json$/, '.failure.json');
  const hasFailure = existsSync(sidecar);
  const engine = createBaseEngine();
  const state = verifyReplay(engine, replay, { allowFinalInvariantFailure: hasFailure });
  if (!hasFailure) {
    return { path, inputs: replay.inputs.length, turn: state.turn.number, result: state.result };
  }
  const sidecarData: unknown = JSON.parse(readFileSync(sidecar, 'utf8'));
  if (typeof sidecarData !== 'object' || sidecarData === null)
    throw new Error('Failure sidecar is malformed');
  const failure = Object.fromEntries(Object.entries(sidecarData));
  if (typeof failure.category !== 'string' || typeof failure.source !== 'string')
    throw new Error('Failure sidecar lacks source or category');
  let observed: string;
  if (failure.source === 'run') {
    if (
      typeof failure.seed !== 'number' ||
      typeof failure.gameIndex !== 'number' ||
      typeof failure.players !== 'number' ||
      typeof failure.maxTurns !== 'number' ||
      typeof failure.maxInputsWithoutTurn !== 'number' ||
      typeof failure.baseOptions !== 'object' ||
      failure.baseOptions === null
    )
      throw new Error('Run failure sidecar is malformed');
    try {
      runGame({
        seed: failure.seed,
        gameIndex: failure.gameIndex,
        players: failure.players,
        maxTurns: failure.maxTurns,
        maxInputsWithoutTurn: failure.maxInputsWithoutTurn,
        // The recorded run may have used the benchmark's diagnostic setting.
        verify: failure.verify !== false,
        // Checked above; the JSON sidecar uses only base option fields.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        baseOptions: failure.baseOptions as Record<string, unknown>,
      });
      observed = 'completed';
    } catch (error) {
      if (error instanceof SimulationFailure) {
        observed =
          toHex(hashValue(error.inputs)) === toHex(hashValue(replay.inputs)) &&
          toHex(hashValue(error.attemptedInput ?? null)) ===
            toHex(hashValue(failure.attemptedInput ?? null))
            ? error.category
            : 'different-prefix';
      } else observed = 'driver-throw';
    }
  } else if (failure.source === 'fuzz') {
    if (typeof failure.stateHash !== 'string')
      throw new Error('Fuzz failure sidecar lacks state hash');
    if (toHex(hashValue(state)) !== failure.stateHash) observed = 'different-state';
    else {
      try {
        const privates = replayPrivates(engine, replay);
        observed = observeAttempt(
          engine,
          state,
          failure.attemptedInput,
          failure.category,
          failure.originalInput,
          privates,
        );
      } catch {
        observed = 'prefix-private-failure';
      }
    }
  } else throw new Error(`Unknown failure source ${failure.source}`);
  return {
    path,
    inputs: replay.inputs.length,
    turn: state.turn.number,
    result: state.result,
    recordedFailure: failure.message,
    category: failure.category,
    observed,
    reproduced: failureMatches(failure.category, observed),
  };
}

/** Entry point for `pnpm sim`. Output is one machine-readable JSON line. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  if (command === 'run' || command === 'bench')
    return runCommand(parseArgs(rest), command === 'bench');
  if (command === 'replay') {
    const path = rest[0];
    if (!path || rest.length !== 1) throw new Error('Usage: pnpm sim replay <file>');
    const result = replayCommand(path);
    console.log(JSON.stringify(result));
    if (result.reproduced === false) process.exitCode = 1;
    return;
  }
  if (command === 'golden') {
    if (rest.length !== 1 || rest[0] !== '--update')
      throw new Error('Golden fixtures can only be regenerated with --update');
    console.log(JSON.stringify(updateGoldens({ update: true })));
    return;
  }
  if (command === 'fuzz') {
    const args = parseArgs(rest);
    const fingerprint = sourceFingerprint();
    console.log(
      JSON.stringify({
        ...fuzz({
          seed: integer(args.seed, 42, 'seed'),
          iterations: integer(args.iterations, 50_000, 'iterations'),
        }),
        sourceFingerprint: fingerprint,
        sourceUnchanged: sourceFingerprint() === fingerprint,
      }),
    );
    return;
  }
  throw new Error('Usage: pnpm sim <run|bench|fuzz|replay|golden> [options]');
}
