import { describe, expect, test } from 'vitest';
import { createRegistry } from './registry.js';
import type { GameModule } from './types.js';
import { createEngine } from '../pipeline/engine.js';
import { config, seed, testCounter } from '../pipeline/__tests__/testCounter.js';
import { success } from '../types/index.js';

function module(id: string, dependsOn: string[] = []): GameModule {
  return {
    id,
    version: '1.0.0',
    dependsOn,
    conflictsWith: [],
    optionsSchema: [],
    commands: {},
    systemInputs: {},
    phases: {},
  };
}

const noOp = {
  validate: () => success(undefined),
  apply: (state: Parameters<NonNullable<GameModule['commands']['INC']>['apply']>[0]) => ({
    state,
    events: [],
  }),
};

const sampleState = createEngine([testCounter()]).createGame(config, seed);

describe('module registry', () => {
  test('sorts ready modules by id while respecting dependencies', () => {
    const a = module('A', ['Z']);
    const b = module('B');
    const z = module('Z');
    a.hooks = { handLimit: (_state, _seat, limit) => limit * 10 + 1 };
    b.hooks = { handLimit: (_state, _seat, limit) => limit * 10 + 2 };
    z.hooks = { handLimit: (_state, _seat, limit) => limit * 10 + 3 };
    const registry = createRegistry([a, z, b]);
    expect(registry.modules.map((item) => item.id)).toEqual(['B', 'Z', 'A']);
    expect(registry.hooks.handLimit(sampleState, 0, 0)).toBe(231);
  });

  test('rejects missing, conflicting, cyclic and duplicate registrations', () => {
    expect(() => createRegistry([module('A', ['B'])])).toThrow(/missing dependency/);
    expect(() => createRegistry([module('A', ['B']), module('B', ['A'])])).toThrow(/cycle/);
    const conflicting = module('A');
    conflicting.conflictsWith = ['B'];
    expect(() => createRegistry([conflicting, module('B')])).toThrow(/conflict/);
    expect(() => createRegistry([module('A'), module('A')])).toThrow(/Duplicate module/);
    const first = module('A');
    const second = module('B');
    first.commands = { INC: noOp };
    second.commands = { INC: noOp };
    expect(() => createRegistry([first, second])).toThrow(/Duplicate command/);
    first.optionsSchema = [
      { key: 'goal', type: 'integer', default: 1 },
      { key: 'goal', type: 'integer', default: 2 },
    ];
    expect(() => createRegistry([first])).toThrow(/Duplicate option/);
    const reserved = module('reserved');
    reserved.systemInputs = { SEAT_STATUS: noOp };
    expect(() => createRegistry([reserved])).toThrow(/reserved/);
    const slash = module('bad/name');
    expect(() => createRegistry([slash])).toThrow(/slash/);
    const phase = module('phase');
    phase.phases = { 'bad/name': { pending: () => [] } };
    expect(() => createRegistry([phase])).toThrow(/slash/);
  });

  test('snapshots registration maps and metadata without freezing caller objects', () => {
    const original = module('A');
    original.commands = { INC: noOp };
    original.optionsSchema = [{ key: 'goal', type: 'integer', default: 1 }];
    const registry = createRegistry([original]);
    original.commands.INC = {
      ...noOp,
      validate: () => ({ ok: false, error: { code: 'changed', message: 'changed' } }),
    };
    original.dependsOn = ['new-dependency'];
    const goal = original.optionsSchema[0];
    if (!goal) throw new Error('missing option');
    goal.default = 99;
    expect(
      registry.commands
        .get('INC')
        ?.handler.validate(
          sampleState,
          { kind: 'command', seat: 0, command: { type: 'INC' } },
          { hooks: registry.hooks },
        ).ok,
    ).toBe(true);
    expect(registry.modules[0]?.dependsOn).toEqual([]);
    expect(registry.modules[0]?.optionsSchema[0]?.default).toBe(1);
    expect(registry.commands.has('toString')).toBe(false);
  });
});
