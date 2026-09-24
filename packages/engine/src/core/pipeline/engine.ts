import { createRegistry } from '../modules/registry.js';
import type { GameModule, ModuleRegistry, Transition } from '../modules/types.js';
import { checkBounds } from '../resources/index.js';
import { createGame as createGenesis, createPrivateState } from '../state/createGame.js';
import { cloneJson, validateJson } from '../state/json.js';
import type { GameConfig, GameState, PrivateState, PublicView } from '../state/types.js';
import { failure, success } from '../types/index.js';
import type { Result, Seat } from '../types/index.js';
import type {
  CommandInput,
  CommandShape,
  Input,
  LegalCommandSet,
  Pending,
  PrivateInputData,
  SystemInput,
} from './types.js';

export interface Engine {
  /** Build deterministic public genesis using the supplied seed only during setup. */
  createGame(config: GameConfig, genesisSeed: Uint8Array): GameState;
  /** Build one owner's secret state outside the replicated public state. */
  createPrivateState(seat: Seat): PrivateState;
  /** Ask registered modules for an omniscient local input, such as a hidden VP claim. */
  getAutomaticInput(state: GameState, privates: ReadonlyMap<Seat, PrivateState>): Input | null;
  /** Check an input without changing state; malformed values return a rule failure. */
  validate(state: GameState, input: Input): Result<void>;
  /** Apply a valid public input by structural update and derive UI events. */
  apply(state: GameState, input: Input): Result<Transition>;
  /** Update only one owner's private state for an accepted public input. */
  applyPrivate(
    priv: PrivateState,
    before: GameState,
    input: Input,
    privInput?: PrivateInputData,
  ): Result<PrivateState>;
  /** Validate once, then update all configured private seats atomically. */
  applyAllPrivates(
    privates: ReadonlyMap<Seat, PrivateState>,
    before: GameState,
    input: Input,
    privateData?: Partial<Record<Seat, PrivateInputData>>,
  ): Result<Map<Seat, PrivateState>>;
  /** Return the requests represented by the top phase frame. */
  getPending(state: GameState): Pending[];
  /** List fully specified commands and templates. A pure filter may avoid validating discarded concrete commands. */
  getLegalCommands(
    state: GameState,
    seat: Seat,
    priv?: PrivateState,
    filter?: (command: CommandShape) => boolean,
  ): LegalCommandSet;
  /** Return a public spectator or seat view without secret state. */
  project(state: GameState, viewer: Seat | 'spectator'): PublicView;
  /** Include hidden contributions only when the matching private state is supplied. */
  computeVictoryPoints(
    state: GameState,
    seat: Seat,
    priv?: PrivateState,
  ): { public: number; total?: number };
  /** Collect debug invariant failures without changing state. */
  checkInvariants(state: GameState): string[];
  /** Collect optional module invariants over every owner's secret state. */
  checkPrivateInvariants(state: GameState, privates: ReadonlyMap<Seat, PrivateState>): string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function topPhase(state: GameState): { id: string; module: string; data: unknown } | undefined {
  return state.turn.phase.at(-1);
}

function pendingFor(state: GameState, registry: ModuleRegistry): Pending[] {
  if (state.result) return [];
  const top = topPhase(state);
  if (!top) throw new Error('Live game has no phase');
  const phase = registry.phases.get(`${top.module}/${top.id}`);
  if (!phase) throw new Error(`Unregistered phase ${top.module}/${top.id}`);
  return phase.handler.pending(state, top, { hooks: registry.hooks });
}

function validSeat(state: GameState, value: unknown): value is Seat {
  return typeof value === 'number' && state.config.seats.some((seat) => seat === value);
}

function isSeatStatus(value: unknown): value is 'active' | 'departed' | 'bot' {
  return value === 'active' || value === 'departed' || value === 'bot';
}

const COMMAND_ENVELOPE = ['kind', 'seat', 'command'] as const;
const COMMAND_TYPE_KEY = ['type'] as const;
const SYSTEM_ENVELOPE = ['kind', 'type'] as const;
const SEAT_STATUS_KEYS = ['kind', 'type', 'seat', 'status'] as const;

function checkKeys(
  value: object,
  allowed: readonly string[],
  extra: readonly string[] = [],
): Result<void> {
  for (const key of Object.keys(value))
    if (!allowed.includes(key) && !extra.includes(key))
      return failure('unknown-field', `Unknown input field: ${key}`);
  return success(undefined);
}

function checkInputKeys(input: Input, registry: ModuleRegistry): Result<void> {
  if (input.kind === 'command') {
    const envelope = checkKeys(input, COMMAND_ENVELOPE);
    if (!envelope.ok) return envelope;
    if (!isRecord(input.command) || typeof input.command.type !== 'string')
      return failure('invalid-command', 'Command must have a string type');
    const keys = registry.commands.get(input.command.type)?.handler.keys;
    return keys ? checkKeys(input.command, keys.allowed, COMMAND_TYPE_KEY) : success(undefined);
  }
  if (input.kind === 'system') {
    if (typeof input.type !== 'string')
      return failure('invalid-system-input', 'Missing system type');
    if (input.type === 'SEAT_STATUS') return checkKeys(input, SEAT_STATUS_KEYS);
    const keys = registry.systemInputs.get(input.type)?.handler.keys;
    return keys ? checkKeys(input, keys.allowed, SYSTEM_ENVELOPE) : success(undefined);
  }
  return failure('invalid-input', 'Input kind must be command or system');
}

function validateCommand(
  state: GameState,
  input: CommandInput,
  pending: Pending[],
  registry: ModuleRegistry,
): Result<void> {
  if (!validSeat(state, input.seat))
    return failure('invalid-seat', 'Command seat is not in this game');
  if (!isRecord(input.command) || typeof input.command.type !== 'string') {
    return failure('invalid-command', 'Command must have a string type');
  }
  const type = input.command.type;
  const entry = registry.commands.get(type);
  if (!entry) return failure('unknown-command', `Unknown command type: ${type}`);
  const allowed = pending.some(
    (item) => item.kind === 'player' && item.seat === input.seat && item.allowed.includes(type),
  );
  if (!allowed) return failure('not-pending', 'This seat or command is not currently pending');
  return entry.handler.validate(state, input, { hooks: registry.hooks });
}

function validateSystem(
  state: GameState,
  input: SystemInput,
  pending: Pending[],
  registry: ModuleRegistry,
): Result<void> {
  if (typeof input.type !== 'string') return failure('invalid-system-input', 'Missing system type');
  if (input.type === 'SEAT_STATUS') {
    if (!validSeat(state, input.seat)) return failure('invalid-seat', 'Unknown seat status target');
    if (!isSeatStatus(input.status)) {
      return failure('invalid-status', 'Seat status must be active, departed or bot');
    }
    return success(undefined);
  }
  const entry = registry.systemInputs.get(input.type);
  if (!entry) return failure('unknown-system-input', `Unknown system input: ${input.type}`);
  if (input.type === 'TIMEOUT') {
    const top = topPhase(state);
    const timeoutSeat = input.seat;
    if (!validSeat(state, timeoutSeat) || input.phase !== top?.id) {
      return failure('invalid-timeout', 'Timeout seat or phase does not match the active phase');
    }
    if (!pending.some((item) => item.kind === 'player' && item.seat === timeoutSeat)) {
      return failure('not-pending', 'No player input is pending for this timeout');
    }
  } else {
    const matches = pending.some(
      (item) =>
        (item.kind === 'random' || item.kind === 'reveal') &&
        item.systemType === input.type &&
        (item.kind !== 'reveal' || item.seat === input.seat) &&
        (entry.handler.accepts?.(item, input, state) ?? true),
    );
    if (!matches) return failure('not-pending', 'System input does not answer a pending request');
  }
  return entry.handler.validate(state, input, { hooks: registry.hooks });
}

function advance(state: GameState, transition: Transition): Transition {
  return {
    state: {
      ...transition.state,
      counters: { ...transition.state.counters, inputSeq: state.counters.inputSeq + 1 },
    },
    events: transition.events,
  };
}

/** Build a rules engine without process-global mutable module registration. */
export function createEngine(modules: readonly GameModule[]): Engine {
  const registry = createRegistry(modules);

  function getPending(state: GameState): Pending[] {
    return pendingFor(state, registry);
  }

  function getAutomaticInput(
    state: GameState,
    privates: ReadonlyMap<Seat, PrivateState>,
  ): Input | null {
    if (state.result) return null;
    let chosen: Input | null = null;
    for (const module of registry.modules) {
      const candidate = module.autoInput?.(state, privates);
      if (!candidate) continue;
      if (chosen) throw new Error('Multiple modules requested an automatic input');
      chosen = candidate;
    }
    return chosen;
  }

  function validate(state: GameState, input: Input): Result<void> {
    if (state.result) return failure('game-over', 'No input is allowed after the result is set');
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return failure('invalid-input', 'Input must be an object');
    }
    try {
      validateJson(input);
    } catch (error) {
      return failure('invalid-input-json', String(error));
    }
    const keys = checkInputKeys(input, registry);
    if (!keys.ok) return keys;
    const pending = getPending(state);
    if (input.kind === 'command') return validateCommand(state, input, pending, registry);
    if (input.kind === 'system') return validateSystem(state, input, pending, registry);
    return failure('invalid-input', 'Input kind must be command or system');
  }

  function apply(state: GameState, input: Input): Result<Transition> {
    const valid = validate(state, input);
    if (!valid.ok) return valid;
    if (input.kind === 'system' && input.type === 'SEAT_STATUS') {
      const seats = state.seats.map((seat) =>
        seat.seat === input.seat && isSeatStatus(input.status)
          ? { ...seat, status: input.status }
          : seat,
      );
      return success(advance(state, { state: { ...state, seats }, events: [] }));
    }
    if (input.kind === 'command') {
      const handler = registry.commands.get(input.command.type)?.handler;
      if (!handler) return failure('missing-handler', 'Validated command has no handler');
      return success(advance(state, handler.apply(state, input, { hooks: registry.hooks })));
    }
    const handler = registry.systemInputs.get(input.type)?.handler;
    if (!handler) return failure('missing-handler', 'Validated system input has no handler');
    return success(advance(state, handler.apply(state, input, { hooks: registry.hooks })));
  }

  function dispatchPrivate(
    priv: PrivateState,
    before: GameState,
    input: Input,
    privInput?: PrivateInputData,
  ): Result<PrivateState> {
    if (input.kind === 'system' && input.type === 'SEAT_STATUS') return success(priv);
    if (input.kind === 'command') {
      const handler = registry.commands.get(input.command.type)?.handler;
      return handler?.applyPrivate
        ? handler.applyPrivate(priv, before, input, privInput, { hooks: registry.hooks })
        : success(priv);
    }
    const handler = registry.systemInputs.get(input.type)?.handler;
    return handler?.applyPrivate
      ? handler.applyPrivate(priv, before, input, privInput, { hooks: registry.hooks })
      : success(priv);
  }

  function applyPrivate(
    priv: PrivateState,
    before: GameState,
    input: Input,
    privInput?: PrivateInputData,
  ): Result<PrivateState> {
    if (!validSeat(before, priv.seat))
      return failure('invalid-seat', 'Private state has no game seat');
    const valid = validate(before, input);
    return valid.ok ? dispatchPrivate(priv, before, input, privInput) : valid;
  }

  function applyAllPrivates(
    privates: ReadonlyMap<Seat, PrivateState>,
    before: GameState,
    input: Input,
    privateData?: Partial<Record<Seat, PrivateInputData>>,
  ): Result<Map<Seat, PrivateState>> {
    const valid = validate(before, input);
    if (!valid.ok) return valid;
    const next = new Map<Seat, PrivateState>();
    for (const seat of before.config.seats) {
      const prior = privates.get(seat);
      if (!prior) return failure('missing-private-state', `Missing private state for seat ${seat}`);
      if (prior.seat !== seat)
        return failure('private-seat-changed', `Private state for seat ${seat} changed ownership`);
      const updated = dispatchPrivate(prior, before, input, privateData?.[seat]);
      if (!updated.ok) return updated;
      if (updated.value.seat !== seat)
        return failure('private-seat-changed', `Private state for seat ${seat} changed ownership`);
      next.set(seat, updated.value);
    }
    return success(next);
  }

  function getLegalCommands(
    state: GameState,
    seat: Seat,
    priv?: PrivateState,
    filter?: (command: CommandShape) => boolean,
  ): LegalCommandSet {
    if (priv && priv.seat !== seat) throw new Error('Private state belongs to another seat');
    if (state.result || !validSeat(state, seat)) return { commands: [], templates: [] };
    const top = topPhase(state);
    if (!top) return { commands: [], templates: [] };
    const handler = registry.phases.get(`${top.module}/${top.id}`)?.handler;
    if (handler?.legalCommands) {
      const listed = handler.legalCommands(state, top, seat, priv, { hooks: registry.hooks });
      return {
        commands: listed.commands.filter(
          (command) =>
            (filter?.(command) ?? true) && validate(state, { kind: 'command', seat, command }).ok,
        ),
        templates: listed.templates,
      };
    }
    const allowed = getPending(state)
      .filter((item) => item.kind === 'player' && item.seat === seat)
      .flatMap((item) => (item.kind === 'player' ? item.allowed : []));
    return { commands: [], templates: [...new Set(allowed)].toSorted().map((type) => ({ type })) };
  }

  function computeVictoryPoints(
    state: GameState,
    seat: Seat,
    priv?: PrivateState,
  ): { public: number; total?: number } {
    if (priv && priv.seat !== seat) throw new Error('Private state belongs to another seat');
    const ownSeat = state.seats.find((item) => item.seat === seat);
    if (!ownSeat) throw new Error('Unknown seat');
    let publicPoints = ownSeat.publicVp;
    let hiddenPoints = 0;
    for (const module of registry.modules) {
      for (const contribution of module.victoryPoints?.(state, seat, priv) ?? []) {
        if (contribution.public) publicPoints += contribution.points;
        else if (priv) hiddenPoints += contribution.points;
      }
    }
    return priv
      ? { public: publicPoints, total: publicPoints + hiddenPoints }
      : { public: publicPoints };
  }

  function checkInvariants(state: GameState): string[] {
    const violations: string[] = [];
    if (state.schema !== 1) violations.push('schema must be 1');
    if (!Number.isSafeInteger(state.counters.inputSeq) || state.counters.inputSeq < 0)
      violations.push('inputSeq must be a non-negative integer');
    if (!state.result && state.turn.phase.length === 0) violations.push('live game has no phase');
    if (!state.result && state.turn.phase.length > 0) {
      try {
        if (getPending(state).length === 0) violations.push('live game has no pending input');
      } catch (error) {
        violations.push(`invalid pending phase: ${String(error)}`);
      }
    }
    for (const seat of state.seats) {
      const bounds = checkBounds(seat.resources);
      if (!bounds.ok) violations.push(`seat ${seat.seat}: ${bounds.error.code}`);
    }
    for (const module of registry.modules) {
      try {
        violations.push(...(module.invariants?.(state) ?? []));
      } catch (error) {
        violations.push(`module ${module.id} invariant threw: ${String(error)}`);
      }
    }
    try {
      validateJson(state);
    } catch (error) {
      violations.push(`non-JSON state: ${String(error)}`);
    }
    return violations;
  }

  function checkPrivateInvariants(
    state: GameState,
    privates: ReadonlyMap<Seat, PrivateState>,
  ): string[] {
    const violations: string[] = [];
    for (const module of registry.modules) {
      try {
        violations.push(...(module.privateInvariants?.(state, privates) ?? []));
      } catch (error) {
        violations.push(`module ${module.id} private invariant threw: ${String(error)}`);
      }
    }
    return violations;
  }

  return Object.freeze({
    createGame: (config: GameConfig, seed: Uint8Array) => createGenesis(config, seed, registry),
    createPrivateState: (seat: Seat) => createPrivateState(seat, registry),
    getAutomaticInput,
    validate,
    apply,
    applyPrivate,
    applyAllPrivates,
    getPending,
    getLegalCommands,
    project: (state: GameState, viewer: Seat | 'spectator') => ({
      viewer,
      state: cloneJson(state),
    }),
    computeVictoryPoints,
    checkInvariants,
    checkPrivateInvariants,
  });
}
