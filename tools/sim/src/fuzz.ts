import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashValue, toHex } from '@cp2p/codec';
import { baseModule, createBaseEngine, enumerateCommands, RESOURCES } from '@cp2p/engine';
import type {
  CommandShape,
  Engine,
  GameState,
  Input,
  Pending,
  PrivateState,
  Seat,
} from '@cp2p/engine';
import { makeReplay, writeReplay } from './replay.js';
import { runGame, SimulationFailure } from './run-game.js';
import type { RunGameResult } from './run-game.js';

export interface FuzzOptions {
  seed: number;
  iterations: number;
  failuresDirectory?: string;
}

export interface FuzzResult {
  seed: number;
  iterations: number;
  families: Record<string, number>;
  validLookingChecked: number;
  validLookingAccepted: number;
  validLookingUnchangedSkipped: number;
  validLookingOptionalOmissions: number;
  validLookingZeroCounts: number;
  validLookingCardVariants: number;
  validLookingAcceptedByType: Record<string, number>;
  missingRequiredKeys: Record<string, number>;
  gamesSampled: number;
  deadGamePrefixes: number;
}

const FAMILIES = [
  'unknown-type',
  'wrong-seat-real',
  'wrong-seat-unknown',
  'out-of-range-id',
  'negative-count',
  'huge-count',
  'fractional-count',
  'string-count',
  'unsafe-count',
  'negative-sum-preserving',
  'invalid-dice',
  'invalid-index',
  'extra-field',
  'extra-nested-field',
  'missing-required',
  'system-mismatch',
  'command-during-system',
] as const;
type Family = (typeof FAMILIES)[number];
interface Mutation {
  family: Family | 'stale-duplicate';
  label: string;
  input: Input;
}
const moduleKeys = baseModule();

function freezeTree(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}

function cloneInput(input: Input): Input {
  return structuredClone(input);
}

function pendingMatches(pending: readonly Pending[], input: Input): boolean {
  if (input.kind === 'command')
    return pending.some(
      (item) =>
        item.kind === 'player' &&
        item.seat === input.seat &&
        item.allowed.includes(input.command.type),
    );
  return pending.some(
    (item) =>
      (item.kind === 'random' || item.kind === 'reveal') &&
      item.systemType === input.type &&
      (item.kind !== 'reveal' || item.seat === input.seat),
  );
}

function countSide(input: Input): { field: string; value: object } | null {
  if (input.kind === 'system') return null;
  const field = ['cards', 'give', 'want', 'get'].find((key) => key in input.command);
  const value = field && input.command[field];
  return field && typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { field, value }
    : null;
}

function countMutation(input: Input, value: unknown): Input | null {
  const candidate = cloneInput(input);
  const side = countSide(candidate);
  if (side && candidate.kind === 'command') candidate.command[side.field] = { brick: value };
  else if (candidate.kind === 'system' && 'count' in candidate) candidate.count = value;
  else return null;
  return candidate;
}

function balancedDice(state: GameState): boolean {
  const options = state.config.options.base;
  return (
    typeof options === 'object' &&
    options !== null &&
    Reflect.get(options, 'diceMode') === 'balanced'
  );
}

function requiredFields(input: Input, state: GameState): string[] {
  if (input.kind === 'command') {
    const keys = moduleKeys.commands[input.command.type]?.keys;
    const fields =
      keys?.allowed.filter((key) => !keys.optional?.includes(key) && key in input.command) ?? [];
    if (
      input.command.type === 'PLAY_DEV_CARD' &&
      (input.command.card === 'yearOfPlenty' || input.command.card === 'monopoly') &&
      'params' in input.command
    )
      fields.push('params');
    return fields;
  }
  const keys = moduleKeys.systemInputs[input.type]?.keys;
  const fields = keys?.allowed.filter((key) => !keys.optional?.includes(key) && key in input) ?? [];
  if (
    input.type === 'DICE_RESULT' &&
    balancedDice(state) &&
    'index' in input &&
    !fields.includes('index')
  )
    fields.push('index');
  return fields;
}

/** @internal Real-trace mutations, including every required field present in a handler. */
export function invalidMutations(
  input: Input,
  state: GameState,
  engine: Engine,
  family: Family,
  variation: number,
): Mutation[] {
  const candidate = cloneInput(input);
  const one = (label: string, changed: Input = candidate): Mutation[] => [
    { family, label, input: changed },
  ];
  switch (family) {
    case 'unknown-type':
      if (candidate.kind === 'command') candidate.command.type = `__unknown_command_${variation}__`;
      else candidate.type = `__unknown_system_${variation}__`;
      return one('type');
    case 'wrong-seat-real': {
      if (candidate.kind !== 'command') return [];
      const pending = engine.getPending(state);
      const other = state.config.seats.find(
        (seat) => seat !== candidate.seat && !pendingMatches(pending, { ...candidate, seat }),
      );
      if (other === undefined) return [];
      candidate.seat = other;
      return one(`seat:${other}`);
    }
    case 'wrong-seat-unknown':
      if (candidate.kind === 'system' && !('seat' in candidate)) return [];
      Reflect.set(candidate, 'seat', 6 + (variation % 10_000));
      return one('seat:outside');
    case 'out-of-range-id': {
      if (candidate.kind === 'command') {
        const field = ['edge', 'vertex', 'hex', 'slotId', 'offerId', 'withSeat', 'victim'].find(
          (key) => key in candidate.command,
        );
        if (!field) return [];
        candidate.command[field] =
          typeof candidate.command[field] === 'number'
            ? 1_000_000 + (variation % 1_000_000)
            : `__outside_board_${variation}__`;
      } else if ('slotId' in candidate) candidate.slotId = `__outside_deck_${variation}__`;
      else return [];
      return one('id');
    }
    case 'negative-count':
    case 'huge-count':
    case 'fractional-count':
    case 'string-count':
    case 'unsafe-count': {
      const value =
        family === 'negative-count'
          ? -1 - (variation % 10_000)
          : family === 'huge-count'
            ? 1_000_000_000 + (variation % 1_000_000)
            : family === 'fractional-count'
              ? 0.5
              : family === 'string-count'
                ? '1'
                : Number.MAX_SAFE_INTEGER + 1;
      const changed = countMutation(input, value);
      return changed ? one('count', changed) : [];
    }
    case 'negative-sum-preserving': {
      const side = countSide(candidate);
      if (!side || candidate.kind !== 'command') return [];
      const total = Object.values(side.value).reduce<number>(
        (sum, count) => sum + (typeof count === 'number' ? count : 0),
        0,
      );
      candidate.command[side.field] = { brick: -1, lumber: total + 1 };
      return one(side.field);
    }
    case 'invalid-dice':
      if (candidate.kind !== 'system' || candidate.type !== 'DICE_RESULT') return [];
      candidate.dice = variation % 2 === 0 ? [0, 7] : [1.5, '6'];
      return one('dice');
    case 'invalid-index':
      if (
        candidate.kind !== 'system' ||
        candidate.type !== 'DICE_RESULT' ||
        !('index' in candidate)
      )
        return [];
      candidate.index = variation % 2 === 0 ? -1 : 0.5;
      return one('index');
    case 'extra-field':
      if (candidate.kind === 'command') {
        const key =
          candidate.command.type === 'MARITIME_TRADE'
            ? 'want'
            : candidate.command.type === 'PROPOSE_TRADE'
              ? 'to'
              : 'unexpected';
        candidate.command[key] = key === 'to' ? [0] : variation;
      } else candidate.unexpected = variation;
      return one('extra');
    case 'extra-nested-field':
      if (
        candidate.kind !== 'command' ||
        candidate.command.type !== 'PLAY_DEV_CARD' ||
        typeof candidate.command.params !== 'object' ||
        candidate.command.params === null
      )
        return [];
      Reflect.set(candidate.command.params, `unexpected${variation % 97}`, variation);
      return one('params');
    case 'missing-required':
      return requiredFields(input, state).map((key) => {
        const changed = cloneInput(input);
        if (changed.kind === 'command') delete changed.command[key];
        else delete changed[key];
        return {
          family,
          label: `${input.kind}:${input.kind === 'command' ? input.command.type : input.type}:${key}`,
          input: changed,
        };
      });
    case 'system-mismatch': {
      const pending = engine.getPending(state);
      const seat = state.config.seats[0];
      if (seat === undefined) return [];
      const changed: Input = pending.some(
        (item) => item.kind === 'random' && item.systemType === 'START_SEAT',
      )
        ? {
            kind: 'system',
            type: 'DICE_RESULT',
            dice: [1, 1],
            ...(balancedDice(state) ? { index: 0 } : {}),
          }
        : { kind: 'system', type: 'START_SEAT', seat };
      return pendingMatches(pending, changed) ? [] : one(changed.type, changed);
    }
    case 'command-during-system': {
      const pending = engine.getPending(state);
      if (!pending.some((item) => item.kind === 'random' || item.kind === 'reveal')) return [];
      const changed: Input = {
        kind: 'command',
        seat: state.turn.activeSeat,
        command: { type: 'ROLL_DICE' },
      };
      return pendingMatches(pending, changed) ? [] : one('ROLL_DICE', changed);
    }
  }
  throw new Error('Unhandled mutation family');
}

const DIRECT_ALTERNATIVES = new Set([
  'PLACE_SETTLEMENT',
  'PLACE_ROAD',
  'PLACE_FREE_ROAD',
  'BUILD_SETTLEMENT',
  'BUILD_ROAD',
  'BUILD_CITY',
  'MOVE_ROBBER',
  'STEAL',
  'RESPOND_TRADE',
]);
const EXPANDED_ALTERNATIVES = new Set([
  'DISCARD',
  'MARITIME_TRADE',
  'OFFER_TRADE',
  'PROPOSE_TRADE',
]);

function alternativeCommand(
  input: Extract<Input, { kind: 'command' }>,
  state: GameState,
  index: number,
  engine: Engine,
  privates: ReadonlyMap<Seat, PrivateState>,
): Input | null {
  const own = privates.get(input.seat);
  if (!own) return null;
  const type = input.command.type;
  const commands: CommandShape[] = DIRECT_ALTERNATIVES.has(type)
    ? engine.getLegalCommands(state, input.seat, own).commands
    : EXPANDED_ALTERNATIVES.has(type)
      ? enumerateCommands(engine, state, input.seat, own, {
          sampleIndex: (max) => index % max,
        })
      : [];
  const alternatives = commands.filter(
    (command) => command.type === type && JSON.stringify(command) !== JSON.stringify(input.command),
  );
  const selected = alternatives[index % alternatives.length];
  return selected ? { kind: 'command', seat: input.seat, command: selected } : null;
}

function validLooking(
  input: Input,
  state: GameState,
  index: number,
  engine: Engine,
  privates: ReadonlyMap<Seat, PrivateState>,
): Input | null {
  const candidate = cloneInput(input);
  if (candidate.kind === 'command') {
    if (candidate.command.type !== 'OFFER_TRADE' || index % 2 === 0) {
      const alternate = alternativeCommand(candidate, state, index, engine, privates);
      if (alternate) return alternate;
    }
    const side = ['cards', 'give', 'want', 'get'].find((field) => field in candidate.command);
    if (side) {
      const value = candidate.command[side];
      const resource = RESOURCES[index % RESOURCES.length];
      if (
        typeof value === 'object' &&
        value !== null &&
        resource &&
        Reflect.get(value, resource) === undefined
      )
        Reflect.set(value, resource, 0);
    }
    if (candidate.command.type === 'OFFER_TRADE') {
      if (index % 3 === 0)
        candidate.command.to = state.config.seats.filter((seat) => seat !== candidate.seat);
      else delete candidate.command.to;
    }
    if (
      candidate.command.type === 'PLAY_DEV_CARD' &&
      typeof candidate.command.params === 'object' &&
      candidate.command.params !== null
    ) {
      if (candidate.command.card === 'monopoly')
        Reflect.set(candidate.command.params, 'resource', RESOURCES[index % RESOURCES.length]);
      if (candidate.command.card === 'yearOfPlenty')
        Reflect.set(candidate.command.params, 'resources', {
          [RESOURCES[index % RESOURCES.length] ?? 'brick']: 1,
          [RESOURCES[(index + 1) % RESOURCES.length] ?? 'lumber']: 1,
        });
    }
  } else if (candidate.type === 'DICE_RESULT' && Array.isArray(candidate.dice)) {
    if (balancedDice(state)) {
      const base = state.ext.base;
      const deck = typeof base === 'object' && base !== null ? Reflect.get(base, 'diceDeck') : null;
      if (Array.isArray(deck) && deck.length > 1 && typeof candidate.index === 'number') {
        const selected = (candidate.index + 1 + (index % (deck.length - 1))) % deck.length;
        const card = deck[selected];
        if (typeof card === 'number' && Number.isSafeInteger(card) && card >= 0 && card < 36) {
          candidate.index = selected;
          candidate.dice = [Math.floor(card / 6) + 1, (card % 6) + 1];
        }
      }
    } else candidate.dice = [(index % 6) + 1, (Math.floor(index / 6) % 6) + 1];
  } else if (candidate.type === 'CARD_DEALT') {
    // The public slot may omit the identity; the owner's original deal remains the private fact.
    delete candidate.card;
  } else if (candidate.type === 'START_SEAT') {
    candidate.seat = state.config.seats[index % state.config.seats.length];
  }
  if (JSON.stringify(candidate) !== JSON.stringify(input)) return candidate;
  return null;
}

function advancePrivates(
  engine: Engine,
  before: GameState,
  input: Input,
  privates: ReadonlyMap<Seat, PrivateState>,
  original?: Input,
): { states: Map<Seat, PrivateState> } | { rejected: string } | { threw: string } {
  const states = new Map<Seat, PrivateState>();
  const privateCard =
    input.kind === 'system' &&
    input.type === 'CARD_DEALT' &&
    input.card === undefined &&
    original?.kind === 'system' &&
    original.type === 'CARD_DEALT'
      ? original.card
      : undefined;
  for (const seat of before.config.seats) {
    const prior = privates.get(seat);
    if (!prior) return { rejected: `Missing private state for seat ${seat}` };
    let next: ReturnType<Engine['applyPrivate']>;
    try {
      next = engine.applyPrivate(
        prior,
        before,
        input,
        privateCard === undefined ? undefined : { card: privateCard },
      );
    } catch (error) {
      return { threw: String(error) };
    }
    if (!next.ok) return { rejected: `${next.error.code}: ${next.error.message}` };
    states.set(seat, next.value);
  }
  return { states };
}

function privateProblems(
  engine: Engine,
  state: GameState,
  privates: ReadonlyMap<Seat, PrivateState>,
): string[] {
  const problems: string[] = [];
  for (const holder of state.seats) {
    const priv = privates.get(holder.seat);
    if (!priv) {
      problems.push(`Missing private state for seat ${holder.seat}`);
      continue;
    }
    let total = 0;
    for (const resource of RESOURCES) {
      const count = priv.hand[resource];
      if (
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < holder.resources.min[resource] ||
        count > holder.resources.max[resource]
      )
        problems.push(`Seat ${holder.seat} ${resource} is outside public bounds`);
      total += count ?? 0;
    }
    if (total !== holder.resources.total)
      problems.push(`Seat ${holder.seat} hand total differs from public total`);
  }
  return [...problems, ...engine.checkPrivateInvariants(state, privates)];
}

function saveFailure(
  options: FuzzOptions,
  iteration: number,
  gameIndex: number,
  trace: RunGameResult | SimulationFailure,
  prefix: readonly Input[],
  state: GameState,
  original: Input,
  mutated: Input,
  family: string,
  message: string,
): never {
  const directory = options.failuresDirectory ?? 'failures';
  mkdirSync(directory, { recursive: true });
  const stem = `fuzz-${options.seed}-${gameIndex}-${iteration}`;
  const replayPath = join(directory, `${stem}.replay.json`);
  const sidecarPath = join(directory, `${stem}.failure.json`);
  const categories = [
    ['Invalid mutation was accepted', 'accepted-invalid'],
    ['validate threw', 'validate-throw'],
    ['Plausible input threw', 'plausible-throw'],
    ['Plausible private input threw', 'plausible-private-throw'],
    ['Invariant check threw', 'invariant-throw'],
    ['Accepted plausible input broke private invariants', 'private-invariant-violation'],
    ['Accepted plausible input broke invariants', 'invariant-violation'],
    ['Accepted plausible input was rejected privately', 'plausible-private-rejected'],
    ['Recorded private input was rejected', 'trace-private-rejected'],
    ['Recorded private input threw', 'trace-private-throw'],
    ['Recorded input broke private invariants', 'trace-private-violation'],
    ['Recorded input broke public invariants', 'trace-public-violation'],
    ['Recorded invariant check threw', 'trace-invariant-throw'],
    ['Validated plausible input was rejected', 'apply-rejected'],
    ['Recorded input threw', 'trace-throw'],
    ['Recorded input was rejected', 'trace-rejected'],
  ] as const;
  const category = categories.find(([start]) => message.startsWith(start))?.[1] ?? 'state-mutation';
  writeReplay(replayPath, makeReplay(createBaseEngine(), trace.config, trace.genesisSeed, prefix));
  writeFileSync(
    sidecarPath,
    `${JSON.stringify(
      {
        seed: options.seed,
        gameIndex,
        iteration,
        source: 'fuzz',
        category,
        family,
        message,
        stateHash: toHex(hashValue(state)),
        originalInput: original,
        attemptedInput: mutated,
        repro: `pnpm sim replay ${replayPath}`,
      },
      null,
      2,
    )}\n`,
  );
  throw new Error(`${message}; reproduce with pnpm sim replay ${replayPath}`);
}

/** Mutate real in-game inputs and require every invalid family to be rejected without a throw. */
export function fuzz(options: FuzzOptions): FuzzResult {
  if (!Number.isSafeInteger(options.iterations) || options.iterations < 1)
    throw new RangeError('Fuzz iterations must be positive');
  const engine = createBaseEngine();
  const families: Record<string, number> = {};
  let iterations = 0;
  let validLookingChecked = 0;
  let validLookingAccepted = 0;
  let validLookingUnchangedSkipped = 0;
  let validLookingOptionalOmissions = 0;
  let validLookingZeroCounts = 0;
  let validLookingCardVariants = 0;
  const validLookingAcceptedByType: Record<string, number> = {};
  const missingRequiredKeys: Record<string, number> = {};
  let gamesSampled = 0;
  let deadGamePrefixes = 0;
  while (iterations < options.iterations) {
    let trace: ReturnType<typeof runGame> | SimulationFailure;
    try {
      trace = runGame({
        seed: options.seed,
        gameIndex: gamesSampled,
        verify: false,
        ...(gamesSampled % 4 === 1 ? { baseOptions: { diceMode: 'balanced' } } : {}),
      });
    } catch (error) {
      if (!(error instanceof SimulationFailure) || !error.message.includes('Dead game'))
        throw error;
      trace = error;
      deadGamePrefixes++;
    }
    gamesSampled++;
    const log = trace.inputs;
    let state = engine.createGame(trace.config, trace.genesisSeed);
    let privates = new Map(
      trace.config.seats.map((seat) => [seat, engine.createPrivateState(seat)]),
    );
    const prefix: Input[] = [];
    for (const original of log) {
      const fail = (candidate: Input, family: string, message: string): never =>
        saveFailure(
          options,
          iterations,
          gamesSampled - 1,
          trace,
          prefix,
          state,
          original,
          candidate,
          family,
          message,
        );
      freezeTree(state);
      const beforeHash = iterations % 100 === 0 ? toHex(hashValue(state)) : null;
      for (const family of FAMILIES) {
        if (iterations >= options.iterations) break;
        const variation = (options.seed ^ Math.imul(iterations + 1, 0x9e37_79b9)) >>> 0;
        for (const mutation of invalidMutations(original, state, engine, family, variation)) {
          if (iterations >= options.iterations) break;
          let accepted = false;
          try {
            accepted = engine.validate(state, mutation.input).ok;
          } catch (error) {
            fail(mutation.input, family, `validate threw ${String(error)}`);
          }
          if (accepted) fail(mutation.input, family, 'Invalid mutation was accepted');
          families[family] = (families[family] ?? 0) + 1;
          if (family === 'missing-required')
            missingRequiredKeys[mutation.label] = (missingRequiredKeys[mutation.label] ?? 0) + 1;
          iterations++;
        }
      }
      if (beforeHash !== null && toHex(hashValue(state)) !== beforeHash)
        fail(original, 'state-mutation', 'Validation mutated state');
      const plausible = validLooking(original, state, iterations + options.seed, engine, privates);
      if (plausible) {
        validLookingChecked++;
        if (original.kind === 'command' && plausible.kind === 'command') {
          if (plausible.command.type === 'OFFER_TRADE' && !('to' in plausible.command))
            validLookingOptionalOmissions++;
          for (const side of ['cards', 'give', 'want', 'get']) {
            const before = original.command[side];
            const after = plausible.command[side];
            if (
              typeof before === 'object' &&
              before !== null &&
              typeof after === 'object' &&
              after !== null &&
              RESOURCES.some(
                (resource) =>
                  Reflect.get(before, resource) === undefined && Reflect.get(after, resource) === 0,
              )
            )
              validLookingZeroCounts++;
          }
          if (
            original.command.type === 'PLAY_DEV_CARD' &&
            JSON.stringify(original.command.params) !== JSON.stringify(plausible.command.params)
          )
            validLookingCardVariants++;
        } else if (
          original.kind === 'system' &&
          original.type === 'CARD_DEALT' &&
          plausible.kind === 'system' &&
          plausible.card !== original.card
        )
          validLookingCardVariants++;
        const valid = (() => {
          try {
            return engine.validate(state, plausible);
          } catch (error) {
            return fail(plausible, 'valid-looking', `Plausible input threw ${String(error)}`);
          }
        })();
        if (valid.ok) {
          validLookingAccepted++;
          const acceptedType =
            original.kind === 'command'
              ? `command:${original.command.type}`
              : `system:${original.type}`;
          validLookingAcceptedByType[acceptedType] =
            (validLookingAcceptedByType[acceptedType] ?? 0) + 1;
          const applied = (() => {
            try {
              return engine.apply(state, plausible);
            } catch (error) {
              return fail(plausible, 'valid-looking', `Plausible input threw ${String(error)}`);
            }
          })();
          if (applied.ok) {
            const violations = (() => {
              try {
                return engine.checkInvariants(applied.value.state);
              } catch (error) {
                return fail(plausible, 'valid-looking', `Invariant check threw ${String(error)}`);
              }
            })();
            if (violations.length)
              fail(
                plausible,
                'valid-looking',
                `Accepted plausible input broke invariants: ${violations.join('; ')}`,
              );
            const privateNext = advancePrivates(engine, state, plausible, privates, original);
            if ('states' in privateNext) {
              const problems = privateProblems(engine, applied.value.state, privateNext.states);
              if (problems.length)
                fail(
                  plausible,
                  'valid-looking',
                  `Accepted plausible input broke private invariants: ${problems.join('; ')}`,
                );
            } else if ('threw' in privateNext)
              fail(
                plausible,
                'valid-looking',
                `Plausible private input threw ${privateNext.threw}`,
              );
            else
              fail(
                plausible,
                'valid-looking',
                `Accepted plausible input was rejected privately: ${privateNext.rejected}`,
              );
          } else {
            fail(plausible, 'valid-looking', 'Validated plausible input was rejected by apply');
          }
        }
      } else {
        validLookingUnchangedSkipped++;
      }
      const advanced = (() => {
        try {
          return engine.apply(state, original);
        } catch (error) {
          return fail(original, 'trace', `Recorded input threw ${String(error)}`);
        }
      })();
      if (advanced.ok) {
        const publicProblems = (() => {
          try {
            return engine.checkInvariants(advanced.value.state);
          } catch (error) {
            return fail(original, 'trace', `Recorded invariant check threw ${String(error)}`);
          }
        })();
        if (publicProblems.length)
          fail(
            original,
            'trace',
            `Recorded input broke public invariants: ${publicProblems.join('; ')}`,
          );
        const privateNext = advancePrivates(engine, state, original, privates);
        if ('states' in privateNext) {
          const problems = privateProblems(engine, advanced.value.state, privateNext.states);
          if (problems.length)
            fail(
              original,
              'trace',
              `Recorded input broke private invariants: ${problems.join('; ')}`,
            );
          privates = privateNext.states;
        } else if ('threw' in privateNext)
          fail(original, 'trace', `Recorded private input threw ${privateNext.threw}`);
        else
          fail(original, 'trace', `Recorded private input was rejected: ${privateNext.rejected}`);
        if (
          iterations < options.iterations &&
          !pendingMatches(engine.getPending(advanced.value.state), original)
        ) {
          const family = 'stale-duplicate';
          let duplicateAccepted = false;
          try {
            duplicateAccepted = engine.validate(advanced.value.state, original).ok;
          } catch (error) {
            saveFailure(
              options,
              iterations,
              gamesSampled - 1,
              trace,
              [...prefix, original],
              advanced.value.state,
              original,
              original,
              family,
              `validate threw ${String(error)}`,
            );
          }
          if (duplicateAccepted)
            saveFailure(
              options,
              iterations,
              gamesSampled - 1,
              trace,
              [...prefix, original],
              advanced.value.state,
              original,
              original,
              family,
              'Invalid mutation was accepted',
            );
          families[family] = (families[family] ?? 0) + 1;
          iterations++;
        }
        prefix.push(original);
        state = advanced.value.state;
      } else {
        fail(original, 'trace', 'Recorded input was rejected');
      }
      if (iterations >= options.iterations) break;
    }
  }
  return {
    seed: options.seed,
    iterations,
    families,
    validLookingChecked,
    validLookingAccepted,
    validLookingUnchangedSkipped,
    validLookingOptionalOmissions,
    validLookingZeroCounts,
    validLookingCardVariants,
    validLookingAcceptedByType,
    missingRequiredKeys,
    gamesSampled,
    deadGamePrefixes,
  };
}
