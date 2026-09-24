import { describe, expect, test } from 'vitest';
import { createEngine } from './engine.js';
import { LocalGame } from './localGame.js';
import type { LocalRandomAnswer, LocalRandomSource } from './localGame.js';
import type { Input } from './types.js';
import { config, privateObserved, seed, testCounter } from './__tests__/testCounter.js';

function frozen<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function source(seen: string[] = []): LocalRandomSource {
  return {
    resolve: (pending, state) => {
      const ext = state.ext['test-counter'];
      if (
        typeof ext !== 'object' ||
        ext === null ||
        !('value' in ext) ||
        typeof ext.value !== 'number'
      ) {
        throw new Error('Invalid counter state');
      }
      seen.push(`${pending.kind}:${ext.value}`);
      if (pending.systemType === 'START_SEAT')
        return { input: { kind: 'system', type: 'START_SEAT', seat: 0 } };
      if (pending.systemType === 'BONUS_RESULT')
        return { input: { kind: 'system', type: 'BONUS_RESULT', amount: 1 } };
      if (pending.systemType === 'REVEAL_RESULT')
        return {
          input: {
            kind: 'system',
            type: 'REVEAL_RESULT',
            seat: pending.kind === 'reveal' ? pending.seat : -1,
            count: 1,
          },
        };
      throw new Error('unexpected pending');
    },
  };
}

const inc = { kind: 'command', seat: 0, command: { type: 'INC', amount: 1 } } as const;

describe('pipeline and local driver', () => {
  test('rejects mismatched system inputs, wrong seats and malformed commands', () => {
    const engine = createEngine([testCounter()]);
    const genesis = engine.createGame(config, seed);
    expect(engine.validate(genesis, { kind: 'system', type: 'BONUS_RESULT', amount: 1 }).ok).toBe(
      false,
    );
    expect(engine.validate(genesis, { kind: 'system', type: 'START_SEAT', seat: 0 }).ok).toBe(true);
    const started = engine.apply(genesis, { kind: 'system', type: 'START_SEAT', seat: 0 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(engine.validate(started.value.state, { ...inc, seat: 1 }).ok).toBe(false);
    expect(
      engine.validate(started.value.state, {
        kind: 'command',
        seat: 0,
        command: { type: 'INC', amount: 2 },
      }).ok,
    ).toBe(false);
    expect(
      engine.validate(started.value.state, {
        kind: 'system',
        type: 'TIMEOUT',
        seat: 0,
        phase: 'wrong',
      }).ok,
    ).toBe(false);
    expect(
      engine.validate(started.value.state, {
        kind: 'system',
        type: 'SEAT_STATUS',
        seat: 1,
        status: 'bot',
      }).ok,
    ).toBe(true);
    // Runtime decoders can pass malformed values despite the static Input type.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect(engine.validate(started.value.state, null as unknown as Input).ok).toBe(false);
    const invalidJson = { ...inc, command: { ...inc.command, note: undefined } };
    expect(engine.validate(started.value.state, invalidJson)).toMatchObject({
      ok: false,
      error: { code: 'invalid-input-json' },
    });
    expect(engine.apply(started.value.state, invalidJson).ok).toBe(false);
  });

  test('applies without mutating frozen state and checks private ownership', () => {
    const engine = createEngine([testCounter()]);
    const genesis = frozen(engine.createGame(config, seed));
    const started = engine.apply(genesis, { kind: 'system', type: 'START_SEAT', seat: 0 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const state = frozen(started.value.state);
    const applied = engine.apply(state, inc);
    expect(applied.ok).toBe(true);
    expect(state.ext['test-counter']).toMatchObject({ value: 0 });
    if (!applied.ok) return;
    expect(applied.value.state.turn.phase.map((phase) => phase.id)).toEqual(['turn', 'bonus']);
    expect(engine.checkInvariants(applied.value.state)).toEqual([]);
    expect(engine.checkInvariants({ ...state, turn: { ...state.turn, phase: [] } })).toContain(
      'live game has no phase',
    );
    expect(
      engine
        .checkInvariants({
          ...state,
          turn: { ...state.turn, phase: [{ id: 'absent', module: 'test-counter', data: null }] },
        })
        .some((item) => item.includes('invalid pending phase')),
    ).toBe(true);
    const other = engine.createPrivateState(1);
    expect(() => engine.getLegalCommands(state, 0, other)).toThrow(/another seat/);
    expect(() => engine.computeVictoryPoints(state, 0, other)).toThrow(/another seat/);
  });

  test('logs random and reveal inputs, nested phases and private updates through completion', () => {
    const engine = createEngine([testCounter()]);
    const created = LocalGame.create(engine, config, seed, source());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const game = created.value;
    expect(
      game.log.map((input) => (input.kind === 'system' ? input.type : input.command.type)),
    ).toEqual(['START_SEAT']);
    expect(game.state.bank['tokens']).toBe(7);
    expect(game.state.seats[0]?.piecesLeft['counters']).toBe(3);
    expect(game.state.config.options['test-counter']).toEqual({ auto: false, goal: 3 });
    expect(engine.getLegalCommands(game.snapshot(), 0).commands).toContainEqual({
      type: 'INC',
      amount: 1,
    });
    const played = game.submit(inc);
    expect(played.ok).toBe(true);
    if (!played.ok) return;
    expect(game.state.result).toEqual({ winner: 0, reason: 'counter', atTurn: 0 });
    expect(
      game.log.map((input) => (input.kind === 'system' ? input.type : input.command.type)),
    ).toEqual(['START_SEAT', 'INC', 'BONUS_RESULT', 'REVEAL_RESULT']);
    const firstPrivate = game.privateState(0);
    const secondPrivate = game.privateState(1);
    if (!firstPrivate || !secondPrivate) throw new Error('missing private state');
    expect(privateObserved(firstPrivate)).toBe(1);
    expect(privateObserved(secondPrivate)).toBe(0);
    expect(engine.computeVictoryPoints(game.snapshot(), 0)).toEqual({ public: 3 });
    expect(engine.checkInvariants(game.snapshot())).toEqual([]);
    expect(game.submit(inc).ok).toBe(false);
  });

  test('automatic inputs precede source resolution and are logged', () => {
    const seen: string[] = [];
    const engine = createEngine([testCounter()]);
    const autoConfig = { ...config, options: { 'test-counter': { auto: true, goal: 3 } } };
    const created = LocalGame.create(engine, autoConfig, seed, source(seen));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.state.result?.winner).toBe(0);
    expect(
      created.value.log.map((input) => (input.kind === 'system' ? input.type : input.command.type)),
    ).toEqual(['START_SEAT', 'INC', 'BONUS_RESULT', 'REVEAL_RESULT']);
    expect(seen).toEqual(['random:0', 'random:1', 'reveal:2']);
  });

  test('source failure is terminal and cannot silently retry consumed randomness', () => {
    const engine = createEngine([testCounter()]);
    let calls = 0;
    const bad: LocalRandomSource = {
      resolve: (pending) => {
        calls++;
        return pending.systemType === 'START_SEAT'
          ? { input: { kind: 'system', type: 'START_SEAT', seat: 0 } }
          : { input: { kind: 'system', type: 'BONUS_RESULT', amount: 99 } };
      },
    };
    const created = LocalGame.create(engine, config, seed, bad);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const game = created.value;
    const result = game.submit(inc);
    expect(result.ok).toBe(false);
    expect(game.state.counters.inputSeq).toBe(1);
    expect(game.log).toHaveLength(1);
    expect(calls).toBe(2);
    expect(game.submit(inc)).toMatchObject({ ok: false, error: { code: 'driver-terminal' } });
    expect(calls).toBe(2);
  });

  test('source mutation and malformed answers cannot change committed state', () => {
    const engine = createEngine([testCounter()]);
    let calls = 0;
    const sourceWithMalformedAnswer: LocalRandomSource = {
      resolve: (pending, state) => {
        calls++;
        if (pending.systemType === 'START_SEAT')
          return { input: { kind: 'system', type: 'START_SEAT', seat: 0 } };
        expect(Reflect.set(state.turn, 'number', 99)).toBe(false);
        // Exercise a misbehaving external source after it has consumed a draw.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return null as unknown as LocalRandomAnswer;
      },
    };
    const created = LocalGame.create(engine, config, seed, sourceWithMalformedAnswer);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const game = created.value;
    expect(game.submit(inc)).toMatchObject({ ok: false, error: { code: 'driver-error' } });
    expect(game.state.turn.number).toBe(0);
    expect(game.log).toHaveLength(1);
    expect(game.submit(inc)).toMatchObject({ ok: false, error: { code: 'driver-terminal' } });
    expect(calls).toBe(2);
  });

  test('normal validation failure leaves driver usable', () => {
    const engine = createEngine([testCounter()]);
    const created = LocalGame.create(engine, config, seed, source());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const game = created.value;
    expect(game.submit({ ...inc, seat: 1 }).ok).toBe(false);
    expect(game.submit(inc).ok).toBe(true);
  });

  test('rejects a handler that changes private-state ownership', () => {
    const module = testCounter();
    const increment = module.commands['INC'];
    if (!increment) throw new Error('Missing increment handler');
    module.commands['INC'] = {
      ...increment,
      applyPrivate: (privateState) => ({ ok: true, value: { ...privateState, seat: 1 } }),
    };
    const created = LocalGame.create(createEngine([module]), config, seed, source());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.submit(inc)).toMatchObject({ ok: false, error: { code: 'private-seat-changed' } });
    expect(created.value.state.counters.inputSeq).toBe(1);
    expect(created.value.log).toHaveLength(1);
  });

  test('genesis validates options and owns its config snapshot', () => {
    const engine = createEngine([testCounter()]);
    expect(() =>
      engine.createGame({ ...config, options: { 'test-counter': { goal: 0 } } }, seed),
    ).toThrow(/Invalid option/);
    expect(() =>
      engine.createGame({ ...config, options: { 'test-counter': { surprise: true } } }, seed),
    ).toThrow(/Unknown option/);
    expect(() => engine.createGame({ ...config, modules: [] }, seed)).toThrow(/module list/);
    const mutable = { ...config, options: { 'test-counter': { goal: 5 } } };
    const state = engine.createGame(mutable, seed);
    mutable.options['test-counter'].goal = 2;
    expect(state.config.options['test-counter']).toEqual({ auto: false, goal: 5 });

    const prototypeNamed = {
      ...testCounter(),
      id: 'toString',
      initialPhase: () => ({ id: 'turn', module: 'toString', data: null }),
    };
    const unusual = createEngine([prototypeNamed]).createGame(
      { modules: [{ id: 'toString', version: '1.0.0' }], seats: [0, 1], options: {} },
      seed,
    );
    expect(Object.hasOwn(unusual.config.options, 'toString')).toBe(true);
    expect(Reflect.get(unusual.config.options, 'toString')).toEqual({ auto: false, goal: 3 });
  });
});
