import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  canonicalDecode,
  canonicalEncode,
  fromBase64Url,
  hashValue,
  toBase64Url,
  toHex,
} from '@cp2p/codec';
import type { Engine, Input } from '@cp2p/engine';
import type { GameConfig, GameState } from '@cp2p/engine';
import * as v from 'valibot';

export const REPLAY_FORMAT = 'cp2p-replay';
export const REPLAY_VERSION = 1;
export const DEFAULT_CHECKPOINT_INTERVAL = 25;

const safeInteger = v.pipe(v.number(), v.safeInteger());
const commandSchema = v.objectWithRest({ type: v.string() }, v.unknown());
const configSchema = v.strictObject({
  modules: v.array(v.strictObject({ id: v.string(), version: v.string() })),
  seats: v.array(safeInteger),
  options: v.record(v.string(), v.unknown()),
  board: v.optional(v.record(v.string(), v.unknown())),
});
const inputSchema = v.union([
  v.strictObject({ kind: v.literal('command'), seat: safeInteger, command: commandSchema }),
  v.objectWithRest({ kind: v.literal('system'), type: v.string() }, v.unknown()),
]);
const replaySchema = v.strictObject({
  format: v.literal(REPLAY_FORMAT),
  version: v.literal(REPLAY_VERSION),
  engineVersion: v.string(),
  config: configSchema,
  genesisSeed: v.string(),
  inputs: v.array(inputSchema),
  checkpoints: v.array(
    v.strictObject({
      index: safeInteger,
      stateHash: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
    }),
  ),
});

export interface ReplayCheckpoint {
  index: number;
  stateHash: string;
}

/** Durable public input log with periodic hashes over public state. */
export interface ReplayFile {
  format: typeof REPLAY_FORMAT;
  version: typeof REPLAY_VERSION;
  engineVersion: string;
  config: GameConfig;
  genesisSeed: string;
  inputs: Input[];
  checkpoints: ReplayCheckpoint[];
}

export interface ReplayBuildOptions {
  /** Allow only the final accepted transition to fail invariants, for failure repros. */
  allowFinalInvariantFailure?: boolean;
}

export type ReplayErrorCode =
  | 'invalid-replay'
  | 'unsupported-replay-version'
  | 'invalid-replay-seed'
  | 'invalid-replay-checkpoints'
  | 'engine-version-mismatch'
  | 'replay-input-rejected'
  | 'replay-invariant-failed'
  | 'replay-checkpoint-mismatch';

/** Failure while parsing or verifying a replay, with a stable machine-readable code. */
export class ReplayError extends Error {
  constructor(
    readonly code: ReplayErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ReplayError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) return false;
  return Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(
    Boolean,
  );
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value).toSorted();
  return keys.length === required.length && keys.every((key, index) => key === required[index]);
}

function cloneCanonical(value: unknown): unknown {
  return canonicalDecode(canonicalEncode(value));
}

function validConfig(value: unknown): value is GameConfig {
  if (!isRecord(value) || !isDenseArray(value.modules) || !isDenseArray(value.seats)) return false;
  if (!isRecord(value.options)) return false;
  if (
    !value.modules.every(
      (item) => isRecord(item) && typeof item.id === 'string' && typeof item.version === 'string',
    ) ||
    !value.seats.every((seat) => typeof seat === 'number' && Number.isSafeInteger(seat))
  )
    return false;
  return value.board === undefined || isRecord(value.board);
}

function validInput(value: unknown): value is Input {
  if (!isRecord(value)) return false;
  if (value.kind === 'command') {
    return (
      typeof value.seat === 'number' &&
      Number.isSafeInteger(value.seat) &&
      isRecord(value.command) &&
      typeof value.command.type === 'string'
    );
  }
  return value.kind === 'system' && typeof value.type === 'string';
}

/** Validate the versioned replay shape before the engine sees config or inputs. */
export function parseReplay(value: unknown): ReplayFile {
  if (!isRecord(value)) throw new ReplayError('invalid-replay', 'Replay must be an object');
  if (value.format !== REPLAY_FORMAT)
    throw new ReplayError('invalid-replay', 'Replay format identifier is invalid');
  if (value.version !== REPLAY_VERSION)
    throw new ReplayError(
      'unsupported-replay-version',
      `Replay version ${String(value.version)} is not supported`,
    );
  const parsed = v.safeParse(replaySchema, value);
  if (!parsed.success)
    throw new ReplayError('invalid-replay', 'Replay fields have invalid shapes', {
      cause: parsed.issues,
    });
  try {
    canonicalEncode(value);
  } catch (error) {
    throw new ReplayError('invalid-replay', 'Replay must contain only canonical JSON values', {
      cause: error,
    });
  }
  if (
    !hasExactKeys(value, [
      'checkpoints',
      'config',
      'engineVersion',
      'format',
      'genesisSeed',
      'inputs',
      'version',
    ]) ||
    typeof value.engineVersion !== 'string' ||
    value.engineVersion.length === 0 ||
    !validConfig(value.config) ||
    typeof value.genesisSeed !== 'string' ||
    !isDenseArray(value.inputs) ||
    !value.inputs.every(validInput) ||
    !isDenseArray(value.checkpoints)
  )
    throw new ReplayError('invalid-replay', 'Replay fields have invalid shapes');

  let seed: Uint8Array;
  try {
    seed = fromBase64Url(value.genesisSeed);
  } catch (error) {
    throw new ReplayError('invalid-replay-seed', 'Genesis seed must use canonical base64url', {
      cause: error,
    });
  }
  if (seed.length !== 32 || toBase64Url(seed) !== value.genesisSeed)
    throw new ReplayError('invalid-replay-seed', 'Genesis seed must encode exactly 32 bytes');

  const checkpoints: ReplayCheckpoint[] = [];
  let previous = -1;
  for (const checkpoint of value.checkpoints) {
    if (
      !isRecord(checkpoint) ||
      !hasExactKeys(checkpoint, ['index', 'stateHash']) ||
      typeof checkpoint.index !== 'number' ||
      !Number.isSafeInteger(checkpoint.index) ||
      checkpoint.index < 0 ||
      checkpoint.index <= previous ||
      checkpoint.index > value.inputs.length ||
      typeof checkpoint.stateHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(checkpoint.stateHash)
    )
      throw new ReplayError('invalid-replay-checkpoints', 'Checkpoint list is malformed');
    checkpoints.push({ index: checkpoint.index, stateHash: checkpoint.stateHash });
    previous = checkpoint.index;
  }
  if (
    checkpoints.length === 0 ||
    checkpoints[0]?.index !== 0 ||
    checkpoints.at(-1)?.index !== value.inputs.length
  )
    throw new ReplayError(
      'invalid-replay-checkpoints',
      'Checkpoints must include genesis and the final input count',
    );

  return {
    format: REPLAY_FORMAT,
    version: REPLAY_VERSION,
    engineVersion: value.engineVersion,
    config: value.config,
    genesisSeed: value.genesisSeed,
    inputs: value.inputs,
    checkpoints,
  };
}

/** SHA-256 of the canonical public state. */
export function hashState(state: GameState): string {
  return toHex(hashValue(state));
}

function assertState(engine: Engine, state: GameState, index: number): void {
  const violations = engine.checkInvariants(state);
  if (violations.length)
    throw new ReplayError(
      'replay-invariant-failed',
      `State after ${index} inputs failed invariants: ${violations.join('; ')}`,
    );
  if (!state.result && engine.getPending(state).length === 0)
    throw new ReplayError(
      'replay-invariant-failed',
      `State after ${index} inputs has no pending input and no result`,
    );
}

function foldReplay(
  engine: Engine,
  genesis: GameState,
  inputs: readonly Input[],
  checkpointIndexes: ReadonlySet<number>,
  checkpoints?: ReadonlyMap<number, string>,
  allowFinalInvariantFailure = false,
): { state: GameState; generated: ReplayCheckpoint[] } {
  let state = genesis;
  assertState(engine, state, 0);
  const generated: ReplayCheckpoint[] = [];
  const check = (index: number): void => {
    if (!checkpointIndexes.has(index)) return;
    const stateHash = hashState(state);
    const expected = checkpoints?.get(index);
    if (expected !== undefined && stateHash !== expected)
      throw new ReplayError(
        'replay-checkpoint-mismatch',
        `Checkpoint ${index} differs: expected ${expected}, got ${stateHash}`,
      );
    generated.push({ index, stateHash });
  };
  check(0);
  for (let index = 0; index < inputs.length; index += 1) {
    const input = inputs[index];
    if (!input) throw new ReplayError('invalid-replay', `Missing input at index ${index}`);
    const applied = engine.apply(state, input);
    if (!applied.ok)
      throw new ReplayError(
        'replay-input-rejected',
        `Input ${index} was rejected: ${applied.error.code}: ${applied.error.message}`,
      );
    state = applied.value.state;
    if (!(allowFinalInvariantFailure && index === inputs.length - 1))
      assertState(engine, state, index + 1);
    check(index + 1);
  }
  return { state, generated };
}

/** Build a replay from accepted inputs and hash genesis, periodic states, and the final state. */
export function makeReplay(
  engine: Engine,
  config: GameConfig,
  genesisSeed: Uint8Array,
  inputs: readonly Input[],
  checkpointInterval = DEFAULT_CHECKPOINT_INTERVAL,
  options: ReplayBuildOptions = {},
): ReplayFile {
  if (!Number.isSafeInteger(checkpointInterval) || checkpointInterval < 1)
    throw new ReplayError('invalid-replay-checkpoints', 'Checkpoint interval must be positive');
  if (genesisSeed.length !== 32)
    throw new ReplayError('invalid-replay-seed', 'Genesis seed must contain exactly 32 bytes');
  const state = engine.createGame(config, genesisSeed);
  const indexes = new Set<number>([0, inputs.length]);
  for (let index = checkpointInterval; index < inputs.length; index += checkpointInterval)
    indexes.add(index);
  const { generated } = foldReplay(
    engine,
    state,
    inputs,
    indexes,
    undefined,
    options.allowFinalInvariantFailure ?? false,
  );
  const replayConfig = cloneCanonical(state.config);
  const replayInputs = cloneCanonical([...inputs]);
  return parseReplay({
    format: REPLAY_FORMAT,
    version: REPLAY_VERSION,
    engineVersion: state.engineVersion,
    config: replayConfig,
    genesisSeed: toBase64Url(genesisSeed),
    inputs: replayInputs,
    checkpoints: generated,
  });
}

/** Replay all entries, validating engine version, invariants, and each stored checkpoint. */
export function verifyReplay(
  engine: Engine,
  source: unknown,
  options: ReplayBuildOptions = {},
): GameState {
  const replay = parseReplay(source);
  const genesisSeed = fromBase64Url(replay.genesisSeed);
  let initial: GameState;
  try {
    initial = engine.createGame(replay.config, genesisSeed);
  } catch (error) {
    throw new ReplayError('invalid-replay', `Replay genesis is invalid: ${String(error)}`, {
      cause: error,
    });
  }
  if (initial.engineVersion !== replay.engineVersion)
    throw new ReplayError(
      'engine-version-mismatch',
      `Replay requires engine ${replay.engineVersion}, current engine is ${initial.engineVersion}`,
    );
  const checkpoints = new Map(replay.checkpoints.map(({ index, stateHash }) => [index, stateHash]));
  const indexes = new Set(checkpoints.keys());
  return foldReplay(
    engine,
    initial,
    replay.inputs,
    indexes,
    checkpoints,
    options.allowFinalInvariantFailure ?? false,
  ).state;
}

/** Load and structurally validate a replay JSON file. */
export function readReplay(path: string): ReplayFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new ReplayError('invalid-replay', `Could not read replay ${path}: ${String(error)}`, {
      cause: error,
    });
  }
  return parseReplay(parsed);
}

let nextTempFile = 0;

/** Write a replay atomically, replacing the destination only after a full write. */
export function writeReplay(path: string, source: unknown): void {
  const replay = parseReplay(source);
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${nextTempFile++}.${basename(path)}.tmp`);
  let created = false;
  try {
    writeFileSync(tempPath, `${JSON.stringify(replay, null, 2)}\n`, { flag: 'wx' });
    created = true;
    renameSync(tempPath, path);
    created = false;
  } catch (error) {
    if (created) {
      try {
        rmSync(tempPath);
      } catch {
        // Keep the original write error; a failed cleanup is recoverable by the caller.
      }
    }
    throw new ReplayError('invalid-replay', `Could not write replay ${path}: ${String(error)}`, {
      cause: error,
    });
  }
}
