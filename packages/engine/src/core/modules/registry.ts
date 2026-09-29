import type { CommandShape, Pending } from '../pipeline/types.js';
import type {
  BoardState,
  GameConfig,
  GameState,
  PhaseFrame,
  PrivateState,
} from '../state/types.js';
import { cloneJson } from '../state/json.js';
import type { Seat } from '../types/index.js';
import type {
  Blocker,
  BoardShapeSpec,
  CommandHandler,
  Cost,
  DeckSpec,
  DiceSpec,
  FixtureDeclaration,
  GameModule,
  HookPipeline,
  ModuleHooks,
  ModuleRegistry,
  Production,
  RegisteredHandler,
  RenderHint,
  RouteGraph,
  SeatRange,
  SystemInputHandler,
  PhaseHandler,
  InputKeys,
  TimeoutRequest,
  VpContribution,
} from './types.js';

function copyKeys(keys: InputKeys, reserved: readonly string[]): InputKeys {
  if (
    !Array.isArray(keys.allowed) ||
    (keys.optional !== undefined && !Array.isArray(keys.optional))
  )
    throw new Error('Input keys must be arrays');
  const allowed = [...keys.allowed];
  const optional = [...(keys.optional ?? [])];
  if (
    allowed.some((key) => typeof key !== 'string' || key.length === 0 || reserved.includes(key)) ||
    new Set(allowed).size !== allowed.length
  )
    throw new Error('Input keys contain a duplicate or reserved field');
  if (optional.some((key) => !allowed.includes(key)) || new Set(optional).size !== optional.length)
    throw new Error('Optional input keys must be unique allowed fields');
  return Object.freeze({
    allowed: Object.freeze(allowed),
    ...(keys.optional ? { optional: Object.freeze(optional) } : {}),
  });
}

function copyHandler(handler: CommandHandler, reserved: readonly string[]): CommandHandler;
function copyHandler(handler: SystemInputHandler, reserved: readonly string[]): SystemInputHandler;
function copyHandler(
  handler: CommandHandler | SystemInputHandler,
  reserved: readonly string[],
): CommandHandler | SystemInputHandler {
  // A handler's functions are intentionally retained, while mutable field lists are owned here.
  return Object.freeze({
    ...handler,
    ...(handler.keys ? { keys: copyKeys(handler.keys, reserved) } : {}),
  });
}

function copyModule(module: GameModule): GameModule {
  const commands = Object.fromEntries(
    Object.entries(module.commands).map(([name, handler]) => [
      name,
      copyHandler(handler, ['type']),
    ]),
  );
  const systemInputs = Object.fromEntries(
    Object.entries(module.systemInputs).map(([name, handler]) => [
      name,
      copyHandler(handler, ['kind', 'type']),
    ]),
  );
  const phases = Object.fromEntries(
    Object.entries(module.phases).map(([name, handler]) => [name, Object.freeze({ ...handler })]),
  );
  const hooks = module.hooks
    ? Object.freeze({
        ...module.hooks,
        ...(module.hooks.placement
          ? { placement: Object.freeze({ ...module.hooks.placement }) }
          : {}),
      })
    : undefined;
  return Object.freeze({
    ...module,
    dependsOn: Object.freeze([...module.dependsOn]),
    conflictsWith: Object.freeze([...module.conflictsWith]),
    optionsSchema: Object.freeze(
      module.optionsSchema.map((spec) =>
        Object.freeze({
          ...spec,
          default: cloneJson(spec.default),
          ...(spec.values ? { values: Object.freeze([...spec.values]) } : {}),
        }),
      ),
    ),
    commands: Object.freeze(commands),
    systemInputs: Object.freeze(systemInputs),
    phases: Object.freeze(phases),
    ...(hooks ? { hooks } : {}),
  });
}

function orderedModules(input: readonly GameModule[]): GameModule[] {
  const byId = new Map<string, GameModule>();
  for (const original of input) {
    if (!original.id || byId.has(original.id))
      throw new Error(`Duplicate module id: ${original.id}`);
    if (original.id.includes('/'))
      throw new Error(`Module id cannot contain a slash: ${original.id}`);
    byId.set(original.id, copyModule(original));
  }
  for (const module of byId.values()) {
    if (!module.version) throw new Error(`Module ${module.id} has no version`);
    if (new Set(module.dependsOn).size !== module.dependsOn.length) {
      throw new Error(`Module ${module.id} repeats a dependency`);
    }
    const optionKeys = new Set<string>();
    for (const spec of module.optionsSchema) {
      if (optionKeys.has(spec.key)) throw new Error(`Duplicate option ${module.id}.${spec.key}`);
      optionKeys.add(spec.key);
    }
    for (const dep of module.dependsOn) {
      if (!byId.has(dep)) throw new Error(`Module ${module.id} is missing dependency ${dep}`);
    }
    for (const conflict of module.conflictsWith) {
      if (byId.has(conflict)) throw new Error(`Module conflict: ${module.id} and ${conflict}`);
    }
  }
  const incoming = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const module of byId.values()) {
    incoming.set(module.id, module.dependsOn.length);
    for (const dep of module.dependsOn) {
      const targets = dependents.get(dep) ?? [];
      targets.push(module.id);
      dependents.set(dep, targets);
    }
  }
  let ready = [...byId.keys()].filter((id) => incoming.get(id) === 0).toSorted();
  const sorted: GameModule[] = [];
  while (ready.length) {
    const id = ready.shift();
    if (!id) throw new Error('Missing ready module');
    const module = byId.get(id);
    if (!module) throw new Error(`Missing module ${id}`);
    sorted.push(module);
    for (const dependent of (dependents.get(id) ?? []).toSorted()) {
      const remaining = (incoming.get(dependent) ?? 0) - 1;
      incoming.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready = ready.toSorted();
      }
    }
  }
  if (sorted.length !== byId.size) throw new Error('Module dependency cycle');
  return sorted;
}

/** Compose accumulator hooks: each module receives the previous module's result last. */
function foldAcc<A extends unknown[], T>(
  modules: readonly GameModule[],
  pick: (hooks: ModuleHooks) => ((...args: [...A, T]) => T) | undefined,
): (fixed: A, acc: T) => T {
  const chain = modules.flatMap((module) => {
    const hook = module.hooks ? pick(module.hooks) : undefined;
    return hook ? [hook] : [];
  });
  return (fixed: A, acc: T): T => {
    let next = acc;
    for (const hook of chain) next = hook(...fixed, next);
    return next;
  };
}

/** Compose state hooks: each module receives and returns the whole state. */
function foldState<A extends unknown[]>(
  modules: readonly GameModule[],
  pick: (hooks: ModuleHooks) => ((state: GameState, ...args: A) => GameState) | undefined,
): (state: GameState, ...args: A) => GameState {
  const chain = modules.flatMap((module) => {
    const hook = module.hooks ? pick(module.hooks) : undefined;
    return hook ? [hook] : [];
  });
  return (state: GameState, ...args: A): GameState => {
    let next = state;
    for (const hook of chain) next = hook(next, ...args);
    return next;
  };
}

function composeHooks(modules: readonly GameModule[]): HookPipeline {
  const seatRange = foldAcc<[GameConfig], SeatRange>(modules, (hooks) => hooks.seatRange);
  const boardSpec = foldAcc<[GameConfig], BoardShapeSpec | null>(
    modules,
    (hooks) => hooks.boardSpec,
  );
  const boardFixtures = foldAcc<[GameConfig, BoardState], readonly FixtureDeclaration[]>(
    modules,
    (hooks) => hooks.boardFixtures,
  );
  const cardKinds = foldAcc<[], readonly string[]>(modules, (hooks) => hooks.cardKinds);
  const bankInit = foldAcc<[GameConfig], Readonly<Record<string, number>>>(
    modules,
    (hooks) => hooks.bankInit,
  );
  const pieceLimits = foldAcc<[GameConfig], Readonly<Record<string, number>>>(
    modules,
    (hooks) => hooks.pieceLimits,
  );
  const devDeck = foldAcc<[GameConfig], Readonly<Record<string, number>>>(
    modules,
    (hooks) => hooks.devDeck,
  );
  const decks = foldAcc<[GameConfig], Readonly<Record<string, DeckSpec>>>(
    modules,
    (hooks) => hooks.decks,
  );
  const costs = foldAcc<[GameConfig], Readonly<Record<string, Cost>>>(
    modules,
    (hooks) => hooks.costs,
  );
  const costOf = foldAcc<[GameState, string], Cost>(modules, (hooks) => hooks.costOf);
  const diceSpec = foldAcc<[GameState], DiceSpec>(modules, (hooks) => hooks.diceSpec);
  const production = foldAcc<[GameState, number], Production>(modules, (hooks) => hooks.production);
  const settlement = foldAcc<[GameState, Seat, string], boolean>(
    modules,
    (hooks) => hooks.placement?.settlement,
  );
  const road = foldAcc<[GameState, Seat, string], boolean>(
    modules,
    (hooks) => hooks.placement?.road,
  );
  const city = foldAcc<[GameState, Seat, string], boolean>(
    modules,
    (hooks) => hooks.placement?.city,
  );
  const freePieces = foldAcc<[GameState, Seat], readonly CommandShape[]>(
    modules,
    (hooks) => hooks.freePieces,
  );
  const connectivity = foldAcc<[GameState, Seat], readonly string[]>(
    modules,
    (hooks) => hooks.connectivity,
  );
  const routeGraph = foldAcc<[GameState, Seat], RouteGraph>(modules, (hooks) => hooks.routeGraph);
  const robberLike = foldAcc<[GameState], readonly Blocker[]>(modules, (hooks) => hooks.robberLike);
  const stealTargets = foldAcc<[GameState, Seat, string, string], readonly Seat[]>(
    modules,
    (hooks) => hooks.stealTargets,
  );
  const handLimit = foldAcc<[GameState, Seat], number>(modules, (hooks) => hooks.handLimit);
  const afterDrawChain = modules.flatMap((module) =>
    module.hooks?.afterDraw ? [module.hooks.afterDraw] : [],
  );
  const bankRate = foldAcc<[GameState, Seat, string], number>(modules, (hooks) => hooks.bankRate);
  const turnFlow = foldAcc<[GameState], readonly PhaseFrame[]>(modules, (hooks) => hooks.turnFlow);
  const pending = foldAcc<[GameState], readonly Pending[]>(modules, (hooks) => hooks.pending);
  const victoryPoints = foldAcc<
    [GameState, Seat, PrivateState | undefined],
    readonly VpContribution[]
  >(modules, (hooks) => hooks.victoryPoints);
  const vpTarget = foldAcc<[GameConfig], number>(modules, (hooks) => hooks.vpTarget);
  const legalChain = modules.flatMap((module) =>
    module.hooks?.legalCommands ? [module.hooks.legalCommands] : [],
  );
  const timeoutAction = foldAcc<[GameState, TimeoutRequest], CommandShape | null>(
    modules,
    (hooks) => hooks.timeoutAction,
  );
  const renderHints = foldAcc<[GameState], readonly RenderHint[]>(
    modules,
    (hooks) => hooks.renderHints,
  );
  return Object.freeze({
    seatRange: (config, acc) => seatRange([config], acc),
    boardSpec: (config, acc) => boardSpec([config], acc),
    boardFixtures: (config, board, acc) => boardFixtures([config, board], acc),
    cardKinds: (acc) => cardKinds([], acc),
    bankInit: (config, acc) => ({ ...bankInit([config], acc) }),
    pieceLimits: (config, acc) => ({ ...pieceLimits([config], acc) }),
    devDeck: (config, acc) => ({ ...devDeck([config], acc) }),
    // The `dev` deck is base's; its composition is the `devDeck` result, before module `decks`.
    decks: (config, acc) => {
      const dev = acc.dev;
      const seeded = dev
        ? { ...acc, dev: { ...dev, cards: { ...devDeck([config], dev.cards) } } }
        : acc;
      return { ...decks([config], seeded) };
    },
    costs: (config, acc) => ({ ...costs([config], acc) }),
    costOf: (state, buildType, cost) => costOf([state, buildType], cost),
    diceSpec: (state, acc) => diceSpec([state], acc),
    onDiceResult: foldState<[readonly [number, number], Readonly<Record<string, string>>]>(
      modules,
      (hooks) => hooks.onDiceResult,
    ),
    production: (state, roll, acc) => production([state, roll], acc),
    afterProduction: foldState<[number]>(modules, (hooks) => hooks.afterProduction),
    onNoProduction: foldState<[Seat]>(modules, (hooks) => hooks.onNoProduction),
    placement: Object.freeze({
      settlement: (state: GameState, seat: Seat, loc: string, verdict: boolean) =>
        settlement([state, seat, loc], verdict),
      road: (state: GameState, seat: Seat, loc: string, verdict: boolean) =>
        road([state, seat, loc], verdict),
      city: (state: GameState, seat: Seat, loc: string, verdict: boolean) =>
        city([state, seat, loc], verdict),
    }),
    connectivity: (state, seat, acc) => connectivity([state, seat], acc),
    freePieces: (state, seat, acc) => freePieces([state, seat], acc),
    routeGraph: (state, seat, acc) => routeGraph([state, seat], acc),
    robberLike: (state, acc) => robberLike([state], acc),
    stealTargets: (state, seat, blocker, hex, targets) =>
      stealTargets([state, seat, blocker, hex], targets),
    handLimit: (state, seat, limit) => handLimit([state, seat], limit),
    bankRate: (state, seat, kind, rate) => bankRate([state, seat, kind], rate),
    afterDraw: (draw, acc, ctx) =>
      afterDrawChain.reduce((next, hook) => hook(draw, next, ctx), acc),
    afterBuild: foldState<[Seat, string, string]>(modules, (hooks) => hooks.afterBuild),
    afterInput: foldState<[]>(modules, (hooks) => hooks.afterInput),
    onTurnStart: foldState<[Seat]>(modules, (hooks) => hooks.onTurnStart),
    onTurnEnd: foldState<[Seat]>(modules, (hooks) => hooks.onTurnEnd),
    turnFlow: (state, acc) => turnFlow([state], acc),
    pending: (state, acc) => pending([state], acc),
    victoryPoints: (state, seat, priv, acc) => victoryPoints([state, seat, priv], acc),
    vpTarget: (config, acc) => vpTarget([config], acc),
    legalCommands: (state, seat, priv, acc, ctx) =>
      legalChain.reduce((next, hook) => hook(state, seat, priv, next, ctx), acc),
    timeoutAction: (state, request, acc) => timeoutAction([state, request], acc),
    renderHints: (state, acc) => renderHints([state], acc),
  } satisfies HookPipeline);
}

/** Resolve dependencies once and snapshot module registration data. */
export function createRegistry(input: readonly GameModule[]): ModuleRegistry {
  const modules = Object.freeze(orderedModules(input));
  const commands = new Map<string, RegisteredHandler<CommandHandler>>();
  const systemInputs = new Map<string, RegisteredHandler<SystemInputHandler>>();
  const phases = new Map<string, RegisteredHandler<PhaseHandler>>();
  for (const module of modules) {
    for (const [type, handler] of Object.entries(module.commands).toSorted(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      if (commands.has(type)) throw new Error(`Duplicate command type: ${type}`);
      commands.set(type, { module: module.id, handler });
    }
    for (const [type, handler] of Object.entries(module.systemInputs).toSorted(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      if (type === 'SEAT_STATUS') throw new Error('SEAT_STATUS is reserved by the engine');
      if (
        type === 'TIMEOUT' &&
        handler.keys &&
        (!handler.keys.allowed.includes('seat') || !handler.keys.allowed.includes('phase'))
      )
        throw new Error('TIMEOUT input keys must include seat and phase');
      if (systemInputs.has(type)) throw new Error(`Duplicate system input type: ${type}`);
      systemInputs.set(type, { module: module.id, handler });
    }
    for (const [id, handler] of Object.entries(module.phases)) {
      if (id.includes('/')) throw new Error(`Phase id cannot contain a slash: ${id}`);
      phases.set(`${module.id}/${id}`, { module: module.id, handler });
    }
  }
  return Object.freeze({ modules, commands, systemInputs, phases, hooks: composeHooks(modules) });
}
