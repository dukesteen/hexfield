import { canonicalDecode, canonicalEncode } from '@cp2p/codec';
import { uniformInt } from '@cp2p/crypto';
import { engineForConfig, failure, success } from '@cp2p/engine';
import type { GameState, Pending, Result, Seat, SystemInput } from '@cp2p/engine';

export type RandomPending = Extract<Pending, { kind: 'random' }>;

export type BeaconOutcome =
  | { kind: 'system'; input: SystemInput }
  | { kind: 'steal-index'; thief: Seat; victim: Seat; handSize: number; index: number };

export interface RandomDerivation {
  readonly type: string;
  validate(this: void, state: GameState, pending: RandomPending): Result<void>;
  derive(
    this: void,
    state: GameState,
    pending: RandomPending,
    seed: Uint8Array,
    context: unknown,
  ): Result<BeaconOutcome>;
}

export const RANDOM_LABELS = Object.freeze({
  dieOne: 'd1',
  dieTwo: 'd2',
  /** The two production dice of a game that also rolls extra dice (Cities and Knights). */
  red: 'red',
  yellow: 'yellow',
  startSeat: 'start-seat',
  balancedDice: 'balanced-dice',
  stealIndex: 'steal-index',
});

const BASE_TYPES = ['startSeat', 'dice', 'stealIndex'] as const;
const MAX_BASE_HAND_SIZE = 5 * 24;
const SYSTEM_REQUEST_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  startSeat: ['max', 'type'],
  dice: ['count', 'mode', 'sides', 'type'],
  stealIndex: ['handSize', 'thief', 'type', 'victim'],
});

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!record(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  const stringKeys = ownKeys.filter((key): key is string => typeof key === 'string');
  if (stringKeys.length !== keys.length || ownKeys.length !== stringKeys.length) return false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
  }
  return stringKeys.every((key) => keys.includes(key));
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function isSeat(state: GameState, value: unknown): value is Seat {
  return integer(value, 0, 5) && state.config.seats.some((seat) => seat === value);
}

function fail(code: string, message: string): Result<never> {
  return failure(code, message);
}

function requestFor(
  state: GameState,
  pending: RandomPending,
  type: string,
): Result<Record<string, unknown>> {
  if (!record(pending) || pending.kind !== 'random' || pending.systemType !== expectedSystem(type))
    return fail('random-pending-mismatch', 'Random request has an unexpected system type');
  if (!exactRecord(pending, ['kind', 'request', 'systemType']))
    return fail('invalid-random-pending', 'Random pending has invalid fields');
  const request = pending.request;
  const declared = SYSTEM_REQUEST_KEYS[type];
  // A dice request may add the extra dice its modules declare (checked by `checkExtraDice`).
  const keys =
    declared && type === 'dice' && record(request) && Object.hasOwn(request, 'extra')
      ? [...declared, 'extra']
      : declared;
  if (!keys || !exactRecord(request, keys) || request.type !== type)
    return fail('invalid-random-request', 'Random request has invalid fields');
  if (!record(state) || !record(state.config) || !Array.isArray(state.config.seats))
    return fail('invalid-random-state', 'Game state has invalid seat configuration');
  return success(request);
}

function expectedSystem(type: string): string {
  switch (type) {
    case 'startSeat':
      return 'START_SEAT';
    case 'dice':
      return 'DICE_RESULT';
    case 'stealIndex':
      return 'STEAL_RESULT';
    default:
      return '';
  }
}

function seatList(state: GameState): readonly Seat[] | null {
  const seats: unknown = state.config.seats;
  if (!Array.isArray(seats) || seats.length < 2 || seats.length > 6) return null;
  if (!Array.isArray(state.seats) || state.seats.length !== seats.length) return null;
  if (!seats.every((seat) => isSeat(state, seat))) return null;
  if (new Set(seats).size !== seats.length) return null;
  if (seats.some((seat, index) => state.seats[index]?.seat !== seat)) return null;
  return seats;
}

function diceIds(state: GameState): readonly number[] | null {
  const base = state.ext.base;
  if (!record(base)) return null;
  const ids: unknown = base.diceDeck;
  if (!Array.isArray(ids) || ids.length < 7 || ids.length > 36) return null;
  if (!ids.every((id) => integer(id, 0, 35)) || new Set(ids).size !== ids.length) return null;
  return ids;
}

function validateStartSeat(state: GameState, pending: RandomPending): Result<void> {
  const result = requestFor(state, pending, 'startSeat');
  if (!result.ok) return result;
  const seats = seatList(state);
  if (!seats || result.value.max !== seats.length)
    return fail('invalid-start-seat-request', 'Starting seat bound must match configured seats');
  return success(undefined);
}

interface ExtraDie {
  id: string;
  faces: readonly string[];
}

/** The request's extra dice must be exactly the ones the game's modules declare, in order. */
function checkExtraDice(state: GameState, request: Record<string, unknown>): Result<ExtraDie[]> {
  const declared = engineForConfig(state.config).hooks.diceSpec(state, {
    count: 2,
    sides: 6,
    extra: [],
  }).extra;
  const listed = request.extra;
  if (declared.length === 0)
    return Object.hasOwn(request, 'extra')
      ? fail('invalid-dice-request', 'This game has no extra dice')
      : success([]);
  if (
    !Array.isArray(listed) ||
    listed.length !== declared.length ||
    !listed.every(
      (die, index) =>
        exactRecord(die, ['faces', 'id']) &&
        die.id === declared[index]?.id &&
        Array.isArray(die.faces) &&
        die.faces.length === declared[index]?.faces.length &&
        die.faces.every((face, at) => face === declared[index]?.faces[at]),
    )
  )
    return fail('invalid-dice-request', 'Extra dice must match the game’s declared dice');
  return success(declared.map((die) => ({ id: die.id, faces: [...die.faces] })));
}

function validateDice(state: GameState, pending: RandomPending): Result<void> {
  const request = pending.request;
  if (!record(request)) return fail('invalid-random-request', 'Random request has invalid fields');
  const options = state.config.options.base;
  if (!record(options) || (options.diceMode !== 'random' && options.diceMode !== 'balanced'))
    return fail('invalid-random-state', 'Base dice mode is invalid');
  if (request.mode === 'random') {
    if (options.diceMode !== 'random')
      return fail('invalid-dice-request', 'Random request does not match configured dice mode');
    const result = requestFor(state, pending, 'dice');
    if (!result.ok) return result;
    if (result.value.count !== 2 || result.value.sides !== 6)
      return fail('invalid-dice-request', 'Random dice must request two six-sided dice');
    const extra = checkExtraDice(state, result.value);
    return extra.ok ? success(undefined) : extra;
  }
  if (request.mode === 'balanced') {
    if (options.diceMode !== 'balanced')
      return fail('invalid-dice-request', 'Balanced request does not match configured dice mode');
    if (
      !exactRecord(request, [
        'mode',
        'remaining',
        'type',
        ...(Object.hasOwn(request, 'extra') ? ['extra'] : []),
      ]) ||
      request.type !== 'dice'
    )
      return fail('invalid-random-request', 'Balanced dice request has invalid fields');
    const extra = checkExtraDice(state, request);
    if (!extra.ok) return extra;
    if (!record(pending) || pending.kind !== 'random' || pending.systemType !== 'DICE_RESULT')
      return fail('random-pending-mismatch', 'Balanced dice has unexpected system type');
    const ids = diceIds(state);
    return ids && request.remaining === ids.length
      ? success(undefined)
      : fail('invalid-dice-request', 'Balanced dice count must match the remaining deck');
  }
  return fail('invalid-dice-request', 'Dice mode is unsupported');
}

function publicTotal(state: GameState, seat: Seat): number | null {
  const player = state.seats.find((item) => item.seat === seat);
  const total: unknown = player?.resources.total;
  return integer(total, 0, Number.MAX_SAFE_INTEGER) ? total : null;
}

function validateStealIndex(state: GameState, pending: RandomPending): Result<void> {
  const result = requestFor(state, pending, 'stealIndex');
  if (!result.ok) return result;
  const request = result.value;
  if (
    !isSeat(state, request.thief) ||
    !isSeat(state, request.victim) ||
    request.thief === request.victim
  )
    return fail('invalid-steal-request', 'Steal request has invalid seats');
  const total = publicTotal(state, request.victim);
  if (total === null || total < 1 || total > MAX_BASE_HAND_SIZE || request.handSize !== total)
    return fail('invalid-steal-request', 'Steal hand size must match the victim public total');
  return success(undefined);
}

function safeDerive(
  label: string,
  bound: number,
  seed: Uint8Array,
  context: unknown,
  request: Readonly<Record<string, unknown>>,
): Result<number> {
  try {
    return success(uniformInt(seed, label, bound, { operation: context, request }));
  } catch {
    return fail('random-derivation-failed', 'Beacon value could not be derived');
  }
}

/** One face per extra die, each derived under the die's own label (for example `event`). */
function deriveExtraDice(
  request: Readonly<Record<string, unknown>>,
  seed: Uint8Array,
  context: unknown,
): Result<Record<string, string>> {
  const listed: unknown = request.extra;
  const faces: Record<string, string> = {};
  if (!Array.isArray(listed)) return success(faces);
  for (const die of listed) {
    if (
      !exactRecord(die, ['faces', 'id']) ||
      typeof die.id !== 'string' ||
      !Array.isArray(die.faces)
    )
      return fail('invalid-dice-request', 'Extra die is malformed');
    const face = safeDerive(die.id, die.faces.length, seed, context, request);
    if (!face.ok) return face;
    const chosen: unknown = die.faces[face.value];
    if (typeof chosen !== 'string') return fail('invalid-dice-request', 'Extra die has no faces');
    faces[die.id] = chosen;
  }
  return success(faces);
}

function baseDerivation(type: string): RandomDerivation {
  switch (type) {
    case 'startSeat':
      return Object.freeze<RandomDerivation>({
        type,
        validate: validateStartSeat,
        derive(state, pending, seed, context) {
          const seats = seatList(state);
          if (!seats) return fail('invalid-random-state', 'Game has invalid configured seats');
          const selected = safeDerive(
            RANDOM_LABELS.startSeat,
            seats.length,
            seed,
            context,
            pending.request,
          );
          if (!selected.ok) return selected;
          const seat = seats[selected.value];
          return seat === undefined
            ? fail('invalid-random-state', 'Selected starting seat is missing')
            : success({ kind: 'system', input: { kind: 'system', type: 'START_SEAT', seat } });
        },
      });
    case 'dice':
      return Object.freeze<RandomDerivation>({
        type,
        validate: validateDice,
        derive(state, pending, seed, context) {
          if (pending.request.mode === 'balanced') {
            const ids = diceIds(state);
            if (!ids) return fail('invalid-random-state', 'Balanced dice deck is invalid');
            const selected = safeDerive(
              RANDOM_LABELS.balancedDice,
              ids.length,
              seed,
              context,
              pending.request,
            );
            if (!selected.ok) return selected;
            const index = selected.value;
            const id = ids[index];
            if (id === undefined) return fail('invalid-random-state', 'Dice deck index is invalid');
            const extra = deriveExtraDice(pending.request, seed, context);
            if (!extra.ok) return extra;
            return success({
              kind: 'system',
              input: {
                kind: 'system',
                type: 'DICE_RESULT',
                index,
                dice: [Math.floor(id / 6) + 1, (id % 6) + 1],
                ...(Object.keys(extra.value).length ? { extra: extra.value } : {}),
              },
            });
          }
          // A game with extra dice labels its production dice red and yellow, so every die of a
          // roll has a name of its own; base games keep d1 and d2.
          const withExtra = Object.hasOwn(pending.request, 'extra');
          const first = safeDerive(
            withExtra ? RANDOM_LABELS.red : RANDOM_LABELS.dieOne,
            6,
            seed,
            context,
            pending.request,
          );
          if (!first.ok) return first;
          const second = safeDerive(
            withExtra ? RANDOM_LABELS.yellow : RANDOM_LABELS.dieTwo,
            6,
            seed,
            context,
            pending.request,
          );
          if (!second.ok) return second;
          const extra = deriveExtraDice(pending.request, seed, context);
          if (!extra.ok) return extra;
          return success({
            kind: 'system',
            input: {
              kind: 'system',
              type: 'DICE_RESULT',
              dice: [first.value + 1, second.value + 1],
              ...(Object.keys(extra.value).length ? { extra: extra.value } : {}),
            },
          });
        },
      });
    case 'stealIndex':
      return Object.freeze<RandomDerivation>({
        type,
        validate: validateStealIndex,
        derive(state, pending, seed, context) {
          const request = pending.request;
          if (!isSeat(state, request.thief) || !isSeat(state, request.victim))
            return fail('invalid-steal-request', 'Steal request has invalid seats');
          if (!integer(request.handSize, 1, Number.MAX_SAFE_INTEGER))
            return fail('invalid-steal-request', 'Steal hand size is invalid');
          const thief = request.thief;
          const victim = request.victim;
          const handSize = request.handSize;
          const index = safeDerive(RANDOM_LABELS.stealIndex, handSize, seed, context, request);
          return index.ok
            ? success({ kind: 'steal-index', thief, victim, handSize, index: index.value })
            : index;
        },
      });
    default:
      throw new Error(`Unknown base random derivation: ${type}`);
  }
}

function readType(pending: unknown): string | null {
  try {
    if (!record(pending) || pending.kind !== 'random' || !record(pending.request)) return null;
    return typeof pending.request.type === 'string' ? pending.request.type : null;
  } catch {
    return null;
  }
}

function detached<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Canonical round-trip preserves the JSON protocol value's shape.
  return canonicalDecode(canonicalEncode(value)) as T;
}

/** Creates a closed registry; extension handlers cannot replace a base request type. */
export function createRandomDerivations(additional: readonly RandomDerivation[] = []): {
  supports(pending: unknown): boolean;
  validate(state: GameState, pending: RandomPending): Result<void>;
  derive(
    state: GameState,
    pending: RandomPending,
    seed: Uint8Array,
    context: unknown,
  ): Result<BeaconOutcome>;
} {
  const entries = new Map<string, RandomDerivation>();
  const extensions = new Set<string>();
  for (const type of BASE_TYPES) entries.set(type, baseDerivation(type));
  for (const candidate of additional) {
    if (
      !candidate ||
      typeof candidate.type !== 'string' ||
      candidate.type.length === 0 ||
      typeof candidate.validate !== 'function' ||
      typeof candidate.derive !== 'function' ||
      entries.has(candidate.type)
    )
      throw new TypeError('Random derivation type is invalid or already registered');
    const type = candidate.type;
    const validate = candidate.validate;
    const derive = candidate.derive;
    const registered: RandomDerivation = {
      type,
      validate,
      derive,
    };
    entries.set(type, Object.freeze(registered));
    extensions.add(type);
  }
  const registry = new Map(entries);
  return Object.freeze({
    supports(pending: unknown): boolean {
      try {
        const type = readType(pending);
        return type !== null && registry.has(type);
      } catch {
        return false;
      }
    },
    validate(state: GameState, pending: RandomPending): Result<void> {
      try {
        const type = readType(pending);
        const entry = type === null ? undefined : registry.get(type);
        if (!entry)
          return fail('unsupported-random-request', 'Random request type is not registered');
        return type !== null && extensions.has(type)
          ? entry.validate(detached(state), detached(pending))
          : entry.validate(state, pending);
      } catch {
        return fail('invalid-random-request', 'Random request could not be validated');
      }
    },
    derive(state: GameState, pending: RandomPending, seed: Uint8Array, context: unknown) {
      try {
        const type = readType(pending);
        const entry = type === null ? undefined : registry.get(type);
        if (!entry)
          return fail('unsupported-random-request', 'Random request type is not registered');
        if (type === null || !extensions.has(type)) {
          const valid = entry.validate(state, pending);
          return valid.ok ? entry.derive(state, pending, seed, context) : valid;
        }
        if (!(seed instanceof Uint8Array) || seed.length !== 32)
          return fail('random-derivation-failed', 'Beacon seed must be exactly 32 bytes');
        const valid = entry.validate(detached(state), detached(pending));
        if (!valid.ok) return valid;
        const result = entry.derive(
          detached(state),
          detached(pending),
          seed.slice(),
          detached(context),
        );
        if (!result.ok) return result;
        const outcome = detached(result.value);
        const systemType = outcome.kind === 'system' ? outcome.input.type : 'STEAL_RESULT';
        if (systemType !== pending.systemType)
          return fail(
            'random-result-type',
            'Random result must answer the frozen pending system type',
          );
        return success(outcome);
      } catch {
        return fail('random-derivation-failed', 'Random request could not be derived');
      }
    },
  });
}

/** Base-game beacon derivations; module extensions must be explicitly registered per game. */
export const randomDerivations = createRandomDerivations();
