import type { GameState } from '../state/types.js';
import { cloneJson } from '../state/json.js';
import type { Seat } from '../types/index.js';
import type {
  CommandHandler,
  Cost,
  GameModule,
  HookPipeline,
  ModuleRegistry,
  Production,
  RegisteredHandler,
  SystemInputHandler,
  PhaseHandler,
  InputKeys,
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
        ...(module.hooks.placementRules
          ? { placementRules: Object.freeze({ ...module.hooks.placementRules }) }
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

function composeHooks(modules: readonly GameModule[]): HookPipeline {
  return Object.freeze({
    afterDiceRolled(state: GameState, dice: readonly [number, number]): GameState {
      let next = state;
      for (const module of modules) {
        if (module.hooks?.afterDiceRolled) next = module.hooks.afterDiceRolled(next, dice);
      }
      return next;
    },
    computeProduction(state: GameState, roll: number, acc: Production): Production {
      let next = acc;
      for (const module of modules) {
        if (module.hooks?.computeProduction)
          next = module.hooks.computeProduction(state, roll, next);
      }
      return next;
    },
    placementRules: Object.freeze({
      settlement(state: GameState, seat: Seat, loc: string, verdict: boolean): boolean {
        let next = verdict;
        for (const module of modules) {
          if (module.hooks?.placementRules?.settlement)
            next = module.hooks.placementRules.settlement(state, seat, loc, next);
        }
        return next;
      },
      road(state: GameState, seat: Seat, loc: string, verdict: boolean): boolean {
        let next = verdict;
        for (const module of modules) {
          if (module.hooks?.placementRules?.road)
            next = module.hooks.placementRules.road(state, seat, loc, next);
        }
        return next;
      },
      city(state: GameState, seat: Seat, loc: string, verdict: boolean): boolean {
        let next = verdict;
        for (const module of modules) {
          if (module.hooks?.placementRules?.city)
            next = module.hooks.placementRules.city(state, seat, loc, next);
        }
        return next;
      },
    }),
    costOf(state: GameState, buildType: string, cost: Cost): Cost {
      let next = cost;
      for (const module of modules) {
        if (module.hooks?.costOf) next = module.hooks.costOf(state, buildType, next);
      }
      return next;
    },
    afterBuild(state: GameState, seat: Seat, buildType: string, loc: string): GameState {
      let next = state;
      for (const module of modules) {
        if (module.hooks?.afterBuild) next = module.hooks.afterBuild(next, seat, buildType, loc);
      }
      return next;
    },
    onTurnStart(state: GameState, seat: Seat): GameState {
      let next = state;
      for (const module of modules) {
        if (module.hooks?.onTurnStart) next = module.hooks.onTurnStart(next, seat);
      }
      return next;
    },
    onTurnEnd(state: GameState, seat: Seat): GameState {
      let next = state;
      for (const module of modules) {
        if (module.hooks?.onTurnEnd) next = module.hooks.onTurnEnd(next, seat);
      }
      return next;
    },
    robberTargets(state: GameState, seat: Seat, hex: string, targets: Seat[]): Seat[] {
      let next = targets;
      for (const module of modules) {
        if (module.hooks?.robberTargets) next = module.hooks.robberTargets(state, seat, hex, next);
      }
      return next;
    },
    handLimit(state: GameState, seat: Seat, limit: number): number {
      let next = limit;
      for (const module of modules) {
        if (module.hooks?.handLimit) next = module.hooks.handLimit(state, seat, next);
      }
      return next;
    },
  });
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
