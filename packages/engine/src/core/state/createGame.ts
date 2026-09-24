import { exactResourceBounds, zeroCounts } from '../resources/index.js';
import { createRng } from '../rng/index.js';
import { RESOURCES } from '../types/index.js';
import type { ResourceCounts, Seat } from '../types/index.js';
import type { ModuleRegistry, OptionSpec, SetupCtx } from '../modules/types.js';
import { cloneJson } from './json.js';
import type {
  BoardState,
  GameConfig,
  GameState,
  PhaseFrame,
  PrivateState,
  SeatState,
} from './types.js';

export const ENGINE_VERSION = '0.1.0';

function emptyBoard(): BoardState {
  return { hexes: [], harbors: [], roads: [], buildings: [], robberHex: null };
}

function checkConfig(config: GameConfig, registry: ModuleRegistry): void {
  if (config.seats.length < 2 || config.seats.length > 6) {
    throw new Error('Game requires two to six seats');
  }
  for (let index = 0; index < config.seats.length; index++) {
    if (config.seats[index] !== index) throw new Error('Seats must be ordered from zero');
  }
  if (config.modules.length !== registry.modules.length) {
    throw new Error('Config module list does not match the registered engine');
  }
  const selected = new Map(config.modules.map((module) => [module.id, module.version]));
  if (selected.size !== config.modules.length) throw new Error('Duplicate config module id');
  for (const module of registry.modules) {
    if (selected.get(module.id) !== module.version) {
      throw new Error(`Missing or mismatched module version: ${module.id}`);
    }
  }
}

function validOption(value: unknown, spec: OptionSpec): boolean {
  let valid = false;
  switch (spec.type) {
    case 'boolean':
      valid = typeof value === 'boolean';
      break;
    case 'integer':
      valid =
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        (spec.min === undefined || value >= spec.min) &&
        (spec.max === undefined || value <= spec.max);
      break;
    case 'string':
      valid = typeof value === 'string';
      break;
    case 'enum':
      valid = typeof value === 'string' && (spec.values?.includes(value) ?? false);
      break;
    case 'object':
      valid = value === null || (typeof value === 'object' && !Array.isArray(value));
      break;
  }
  return valid && (spec.validate?.(value) ?? true);
}

function normalizeOptions(config: GameConfig, registry: ModuleRegistry): GameConfig {
  const modules = new Set(registry.modules.map((module) => module.id));
  for (const id of Object.keys(config.options)) {
    if (!modules.has(id)) throw new Error(`Options for unregistered module ${id}`);
  }
  const options = Object.fromEntries(
    registry.modules.map((module) => {
      const supplied: unknown = Object.hasOwn(config.options, module.id)
        ? Reflect.get(config.options, module.id)
        : {};
      if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)) {
        throw new Error(`Options for ${module.id} must be an object`);
      }
      const known = new Set(module.optionsSchema.map((spec) => spec.key));
      for (const key of Object.keys(supplied)) {
        if (!known.has(key)) throw new Error(`Unknown option ${module.id}.${key}`);
      }
      const entries = module.optionsSchema.map((spec) => {
        const value: unknown = Object.hasOwn(supplied, spec.key)
          ? Reflect.get(supplied, spec.key)
          : spec.default;
        if (!validOption(value, spec)) throw new Error(`Invalid option ${module.id}.${spec.key}`);
        return [spec.key, cloneJson(value)] as const;
      });
      return [module.id, Object.fromEntries(entries)] as const;
    }),
  );
  return { ...config, options };
}

function initialSeatStates(seats: readonly Seat[]): SeatState[] {
  return seats.map((seat) => {
    const zeros = zeroCounts(RESOURCES) as ResourceCounts;
    const bounds = exactResourceBounds(zeros);
    if (!bounds.ok) throw new Error(bounds.error.message);
    return {
      seat,
      resources: bounds.value,
      piecesLeft: {},
      cardSlots: [],
      publicVp: 0,
      status: 'active',
    };
  });
}

/** Genesis is the only engine path that can access a seeded RNG. */
export function createGame(
  inputConfig: GameConfig,
  genesisSeed: Uint8Array,
  registry: ModuleRegistry,
): GameState {
  const original = cloneJson(inputConfig);
  checkConfig(original, registry);
  const rng = createRng(genesisSeed);
  let config = original;
  for (const module of registry.modules) {
    if (module.modifyConfig) config = cloneJson(module.modifyConfig(config));
  }
  checkConfig(config, registry);
  config = normalizeOptions(config, registry);
  config = { ...config, modules: registry.modules.map(({ id, version }) => ({ id, version })) };
  const ctx: SetupCtx = { config, rng };
  let board = cloneJson(config.board ?? emptyBoard());
  for (const module of registry.modules) {
    if (module.buildBoard) board = cloneJson(module.buildBoard(ctx, board));
  }
  const ext = Object.fromEntries(
    registry.modules.map((module) => [module.id, cloneJson(module.initState?.(ctx) ?? null)]),
  );
  const roots: PhaseFrame[] = [];
  for (const module of registry.modules) {
    const frame = module.initialPhase?.(ctx);
    if (frame) roots.push(cloneJson(frame));
  }
  if (roots.length !== 1) throw new Error('Exactly one module must provide the initial phase');
  const initial = roots[0];
  if (!initial || !registry.phases.has(`${initial.module}/${initial.id}`)) {
    throw new Error('Initial phase has no registered handler');
  }
  const firstSeat = config.seats[0];
  if (firstSeat === undefined) throw new Error('Game has no first seat');
  let state: GameState = {
    schema: 1,
    engineVersion: ENGINE_VERSION,
    config,
    board,
    seats: initialSeatStates(config.seats),
    bank: {},
    decks: {},
    turn: { number: 0, activeSeat: firstSeat, phase: [initial] },
    awards: {},
    counters: { nextOfferId: 0, nextSlotId: 0, inputSeq: 0 },
    ext,
    result: null,
  };
  for (const module of registry.modules) {
    if (module.initializeState) state = cloneJson(module.initializeState(ctx, state));
  }
  return cloneJson(state);
}

/** Create one private state per seat. These values never enter public genesis. */
export function createPrivateState(seat: Seat, registry: ModuleRegistry): PrivateState {
  const ext = Object.fromEntries(
    registry.modules.map((module) => [module.id, cloneJson(module.initPrivate?.(seat) ?? null)]),
  );
  return cloneJson({ seat, hand: zeroCounts(RESOURCES), slots: {}, ext });
}
