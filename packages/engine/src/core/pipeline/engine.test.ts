import { describe, expect, test } from 'vitest';
import { createEngine } from './engine.js';
import { exactResourceBounds, gainHidden } from '../resources/index.js';
import { LocalGame } from './localGame.js';
import type { LocalRandomAnswer, LocalRandomSource } from './localGame.js';
import type { Input } from './types.js';
import type { Seat } from '../types/index.js';
import { failure } from '../types/index.js';
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

function runtimeSeat(value: unknown): Seat {
  // Runtime validation accepts data from an untrusted serialized input.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Seat;
}

function untrusted(value: unknown): Input {
  // Inputs cross a runtime decoder boundary before reaching the typed engine.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Input;
}

describe('pipeline and local driver', () => {
  test('rejects malformed commands, system values, seats, and input kinds', () => {
    const engine = createEngine([testCounter()]);
    const state = engine.apply(engine.createGame(config, seed), {
      kind: 'system',
      type: 'START_SEAT',
      seat: 0,
    });
    if (!state.ok) throw new Error('Could not start test game');
    const live = state.value.state;
    expect(
      engine.validate(live, untrusted({ kind: 'command', seat: 99, command: { type: 'INC' } })),
    ).toMatchObject({ ok: false, error: { code: 'invalid-seat' } });
    expect(
      engine.validate(live, untrusted({ kind: 'command', seat: 0, command: null })),
    ).toMatchObject({ ok: false, error: { code: 'invalid-command' } });
    expect(
      engine.validate(live, untrusted({ kind: 'command', seat: 0, command: { type: 'MISSING' } })),
    ).toMatchObject({ ok: false, error: { code: 'unknown-command' } });
    expect(engine.validate(live, untrusted({ kind: 'system', type: 0 }))).toMatchObject({
      ok: false,
      error: { code: 'invalid-system-input' },
    });
    expect(engine.validate(live, untrusted({ kind: 'system', type: 'MISSING' }))).toMatchObject({
      ok: false,
      error: { code: 'unknown-system-input' },
    });
    expect(
      engine.validate(
        live,
        untrusted({ kind: 'system', type: 'SEAT_STATUS', seat: 99, status: 'bot' }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-seat' } });
    expect(
      engine.validate(
        live,
        untrusted({ kind: 'system', type: 'SEAT_STATUS', seat: 1, status: 'offline' }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-status' } });
    expect(
      engine.validate(live, untrusted({ kind: 'system', type: 'TIMEOUT', seat: 1, phase: 'turn' })),
    ).toMatchObject({ ok: false, error: { code: 'not-pending' } });
    expect(engine.validate(live, untrusted({ kind: 'unknown' }))).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });
    expect(engine.validate(live, untrusted(null))).toMatchObject({
      ok: false,
      error: { code: 'invalid-input' },
    });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(
      engine.validate(
        live,
        untrusted({ kind: 'system', type: 'SEAT_STATUS', seat: 0, status: 'bot', extra: cyclic }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'invalid-input-json' } });
  });

  test('applies seat status, handles private no-ops, and guards missing phase and seats', () => {
    const engine = createEngine([testCounter()]);
    const started = engine.apply(engine.createGame(config, seed), {
      kind: 'system',
      type: 'START_SEAT',
      seat: 0,
    });
    if (!started.ok) throw new Error('Could not start test game');
    const live = started.value.state;
    const changed = engine.apply(live, {
      kind: 'system',
      type: 'SEAT_STATUS',
      seat: 1,
      status: 'bot',
    });
    if (!changed.ok) throw new Error('Seat status was rejected');
    expect(changed.value.state.seats.find((seat) => seat.seat === 1)?.status).toBe('bot');
    expect(changed.value.state.seats.find((seat) => seat.seat === 0)?.status).toBe('active');
    const privateState = engine.createPrivateState(0);
    expect(
      engine.applyPrivate(privateState, live, {
        kind: 'system',
        type: 'SEAT_STATUS',
        seat: 1,
        status: 'bot',
      }),
    ).toEqual({ ok: true, value: privateState });
    expect(engine.applyPrivate(engine.createPrivateState(runtimeSeat(9)), live, inc)).toMatchObject(
      {
        ok: false,
        error: { code: 'invalid-seat' },
      },
    );
    const noPhase = { ...live, turn: { ...live.turn, phase: [] } };
    expect(() => engine.getPending(noPhase)).toThrow(/no phase/);
    expect(engine.getLegalCommands(noPhase, 0)).toEqual({ commands: [], templates: [] });
    expect(engine.getLegalCommands(live, runtimeSeat(99))).toEqual({ commands: [], templates: [] });
    const allLegal = engine.getLegalCommands(live, 0);
    expect(
      engine.getLegalCommands(live, 0, undefined, (command) => command.type === 'INC'),
    ).toEqual({
      commands: allLegal.commands.filter((command) => command.type === 'INC'),
      templates: allLegal.templates,
    });
    expect(() => engine.computeVictoryPoints(live, runtimeSeat(99))).toThrow(/Unknown seat/);
  });

  test('batch private dispatch validates once and rejects missing or mismatched seats', () => {
    const module = testCounter();
    const incHandler = module.commands?.INC;
    if (!incHandler) throw new Error('Missing increment handler');
    let validations = 0;
    module.commands = {
      ...module.commands,
      INC: {
        ...incHandler,
        validate: (state, input, ctx) => {
          validations++;
          return incHandler.validate(state, input, ctx);
        },
      },
    };
    const engine = createEngine([module]);
    const started = engine.apply(engine.createGame(config, seed), {
      kind: 'system',
      type: 'START_SEAT',
      seat: 0,
    });
    if (!started.ok) throw new Error('Could not start game');
    const before = started.value.state;
    const privates = new Map(config.seats.map((seat) => [seat, engine.createPrivateState(seat)]));
    const private0 = privates.get(0);
    const private1 = privates.get(1);
    if (!private0 || !private1) throw new Error('Missing private fixture');
    expect(engine.applyAllPrivates(privates, before, inc).ok).toBe(true);
    expect(validations).toBe(1);
    expect(engine.applyPrivate(private0, before, inc).ok).toBe(true);
    expect(engine.applyPrivate(private1, before, inc).ok).toBe(true);
    expect(validations).toBe(3);
    const local = LocalGame.create(engine, config, seed, source());
    if (!local.ok) throw new Error('Could not create local game');
    validations = 0;
    expect(local.value.submit(inc).ok).toBe(true);
    expect(validations).toBe(2);
    expect(engine.applyAllPrivates(privates, before, { ...inc, seat: 1 })).toMatchObject({
      ok: false,
      error: { code: 'not-pending' },
    });
    const missing = new Map(privates);
    missing.delete(1);
    expect(engine.applyAllPrivates(missing, before, inc)).toMatchObject({
      ok: false,
      error: { code: 'missing-private-state' },
    });
    const mismatched = new Map(privates);
    mismatched.set(1, private0);
    expect(engine.applyAllPrivates(mismatched, before, inc)).toMatchObject({
      ok: false,
      error: { code: 'private-seat-changed' },
    });
    expect(
      engine.applyAllPrivates(privates, before, {
        kind: 'system',
        type: 'SEAT_STATUS',
        seat: 1,
        status: 'bot',
      }),
    ).toEqual({ ok: true, value: privates });

    const failing = testCounter();
    const failingInc = failing.commands?.INC;
    const failingPrivate = failingInc?.applyPrivate?.bind(failingInc);
    if (!failingInc || !failingPrivate) throw new Error('Missing increment handler');
    failing.commands = {
      ...failing.commands,
      INC: {
        ...failingInc,
        applyPrivate: (priv, state, input, data, ctx) =>
          priv.seat === 1
            ? failure('private-failure', 'Second private handler failed')
            : failingPrivate(priv, state, input, data, ctx),
      },
    };
    const failingEngine = createEngine([failing]);
    const failed = failingEngine.applyAllPrivates(privates, before, inc);
    expect(failed).toMatchObject({ ok: false, error: { code: 'private-failure' } });
    expect(privates.get(0)).toEqual(engine.createPrivateState(0));
  });

  test('reports malformed states and contained module invariant failures', () => {
    const module = testCounter();
    module.invariants = () => {
      throw new Error('public invariant exploded');
    };
    module.privateInvariants = () => {
      throw new Error('private invariant exploded');
    };
    const engine = createEngine([module]);
    const state = engine.createGame(config, seed);
    expect(
      engine.checkInvariants({ ...state, counters: { ...state.counters, inputSeq: -1 } }),
    ).toContain('inputSeq must be a non-negative integer');
    expect(
      engine
        .checkInvariants({ ...state, turn: { ...state.turn, number: 1.5 } })
        .some((item) => item.includes('non-JSON state')),
    ).toBe(true);
    expect(engine.checkInvariants(state)).toContain(
      'module test-counter invariant threw: Error: public invariant exploded',
    );
    expect(engine.checkPrivateInvariants(state, new Map())).toContain(
      'module test-counter private invariant threw: Error: private invariant exploded',
    );
  });

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

  test('passes the composed hook context into private input handlers', () => {
    const module = testCounter();
    const handler = module.commands['INC'];
    const bonus = module.systemInputs['BONUS_RESULT'];
    if (!handler?.applyPrivate) throw new Error('Missing private increment handler');
    if (!bonus) throw new Error('Missing bonus result handler');
    let receivedCommand = false;
    let receivedSystem = false;
    module.commands['INC'] = {
      ...handler,
      applyPrivate: (priv, before, input, data, ctx) => {
        receivedCommand = true;
        expect(ctx.hooks.handLimit(before, input.seat, 7)).toBe(7);
        return (
          handler.applyPrivate?.(priv, before, input, data, ctx) ?? {
            ok: true,
            value: priv,
          }
        );
      },
    };
    module.systemInputs['BONUS_RESULT'] = {
      ...bonus,
      applyPrivate: (priv, before, _input, _data, ctx) => {
        receivedSystem = true;
        expect(ctx.hooks.handLimit(before, 0, 9)).toBe(9);
        return { ok: true, value: priv };
      },
    };
    const engine = createEngine([module]);
    const initial = engine.createGame(config, seed);
    const started = engine.apply(initial, { kind: 'system', type: 'START_SEAT', seat: 0 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const updated = engine.applyPrivate(engine.createPrivateState(0), started.value.state, inc);
    expect(updated.ok).toBe(true);
    expect(receivedCommand).toBe(true);
    const advanced = engine.apply(started.value.state, inc);
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    const privateSystem = engine.applyPrivate(engine.createPrivateState(0), advanced.value.state, {
      kind: 'system',
      type: 'BONUS_RESULT',
      amount: 1,
    });
    expect(privateSystem.ok).toBe(true);
    expect(receivedSystem).toBe(true);
  });

  test('rejects LocalGame inputs that break module private invariants atomically', () => {
    const module = testCounter();
    module.privateInvariants = (state) => {
      const value = state.ext['test-counter'];
      return typeof value === 'object' && value !== null && 'value' in value && value.value === 1
        ? ['counter private invariant failed']
        : [];
    };
    const engine = createEngine([module]);
    const created = LocalGame.create(engine, config, seed, source());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const game = created.value;
    expect(game.submit(inc)).toMatchObject({
      ok: false,
      error: { code: 'private-invariant', message: 'counter private invariant failed' },
    });
    expect(game.state.ext['test-counter']).toMatchObject({ value: 0 });
    expect(game.log).toEqual([{ kind: 'system', type: 'START_SEAT', seat: 0 }]);
    const benchmark = LocalGame.create(engine, config, seed, source(), { verifyInvariants: false });
    if (!benchmark.ok) throw new Error('Could not create benchmark fixture');
    expect(benchmark.value.submit(inc).ok).toBe(true);
    expect(benchmark.value.state.ext['test-counter']).toMatchObject({ value: 3 });
    expect(benchmark.value.log.length).toBeGreaterThan(1);
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

  test('borrows frozen private views while privateState returns an owned copy', () => {
    const engine = createEngine([testCounter()]);
    const created = LocalGame.create(engine, config, seed, source());
    if (!created.ok) throw new Error('Could not create local game');
    const game = created.value;
    const borrowed = game.privateView(0);
    const owned = game.privateState(0);
    if (!borrowed || !owned) throw new Error('Missing private state');
    expect(game.privateView(0)).toBe(borrowed);
    expect(Object.isFrozen(borrowed)).toBe(true);
    expect(Object.isFrozen(borrowed.hand)).toBe(true);
    expect(Reflect.set(borrowed.hand, 'brick', 99)).toBe(false);
    owned.hand.brick = 99;
    expect(game.privateView(0)?.hand.brick).toBe(0);
    expect(game.submit(inc).ok).toBe(true);
    expect(game.privateView(0)).not.toBe(borrowed);
    expect(borrowed.hand.brick).toBe(0);
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

  test('rejects private hands outside public bounds and with the wrong total', () => {
    const outside = testCounter();
    const outsideCommand = outside.commands['INC'];
    if (!outsideCommand) throw new Error('Missing increment command');
    outside.commands['INC'] = {
      ...outsideCommand,
      applyPrivate: (priv) => ({ ok: true, value: { ...priv, hand: { ...priv.hand, brick: 1 } } }),
    };
    const first = LocalGame.create(createEngine([outside]), config, seed, source());
    if (!first.ok) throw new Error('Could not create hand-bounds fixture');
    expect(first.value.submit(inc)).toMatchObject({
      ok: false,
      error: { code: 'private-hand-outside-bounds' },
    });
    expect(first.value.log).toHaveLength(1);

    const mismatch = testCounter();
    const originalCommand = mismatch.commands['INC'];
    const zero = exactResourceBounds({ brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 });
    if (!originalCommand?.apply || !originalCommand.validate || !zero.ok)
      throw new Error('Missing mismatch fixture pieces');
    const uncertain = gainHidden(zero.value, 2);
    if (!uncertain.ok) throw new Error('Could not make uncertain bounds');
    mismatch.commands['INC'] = {
      ...originalCommand,
      apply: (state, input, context) => {
        const transition = originalCommand.apply(state, input, context);
        return {
          ...transition,
          state: {
            ...transition.state,
            seats: transition.state.seats.map((holder) =>
              holder.seat === input.seat ? { ...holder, resources: uncertain.value } : holder,
            ),
          },
        };
      },
      applyPrivate: (priv) => ({ ok: true, value: { ...priv, hand: { ...priv.hand, brick: 1 } } }),
    };
    const second = LocalGame.create(createEngine([mismatch]), config, seed, source());
    if (!second.ok) throw new Error('Could not create hand-total fixture');
    expect(second.value.submit(inc)).toMatchObject({
      ok: false,
      error: { code: 'private-hand-total-mismatch' },
    });
    expect(second.value.log).toHaveLength(1);
    const benchmark = LocalGame.create(createEngine([mismatch]), config, seed, source(), {
      verifyInvariants: false,
    });
    if (!benchmark.ok) throw new Error('Could not create benchmark hand fixture');
    expect(benchmark.value.submit(inc).ok).toBe(true);
  });

  test('rejects private invariants already broken at genesis', () => {
    const module = testCounter();
    module.privateInvariants = () => ['genesis is invalid'];
    expect(LocalGame.create(createEngine([module]), config, seed, source())).toMatchObject({
      ok: false,
      error: { code: 'private-invariant', message: 'genesis is invalid' },
    });
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
    expect(created.value.submit(inc)).toMatchObject({
      ok: false,
      error: { code: 'private-seat-changed' },
    });
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

  test('genesis rejects invalid seat and module selections', () => {
    const engine = createEngine([testCounter()]);
    const invalidSeatLists: Seat[][] = [[], [1, 0]];
    for (const seats of invalidSeatLists) {
      expect(() => engine.createGame({ ...config, seats }, seed)).toThrow(/Game requires|ordered/);
    }
    expect(() =>
      engine.createGame({ ...config, modules: [{ id: 'test-counter', version: '2.0.0' }] }, seed),
    ).toThrow(/version/);
    const companion = {
      id: 'companion',
      version: '1.0.0',
      dependsOn: [],
      conflictsWith: [],
      optionsSchema: [],
      commands: {},
      systemInputs: {},
      phases: {},
    };
    const twoModuleEngine = createEngine([testCounter(), companion]);
    expect(() =>
      twoModuleEngine.createGame(
        {
          ...config,
          modules: [
            { id: 'test-counter', version: '1.0.0' },
            { id: 'test-counter', version: '1.0.0' },
          ],
        },
        seed,
      ),
    ).toThrow(/Duplicate config module/);
    expect(() => engine.createGame({ ...config, options: { unregistered: {} } }, seed)).toThrow(
      /unregistered module/,
    );
    expect(() => engine.createGame({ ...config, options: { 'test-counter': null } }, seed)).toThrow(
      /must be an object/,
    );
    expect(() => engine.createGame({ ...config, options: { 'test-counter': [] } }, seed)).toThrow(
      /must be an object/,
    );
    expect(() =>
      engine.createGame({ ...config, options: { 'test-counter': { auto: 'false' } } }, seed),
    ).toThrow(/Invalid option/);
    expect(() =>
      engine.createGame({ ...config, options: { 'test-counter': { goal: 1.5 } } }, seed),
    ).toThrow(/safe integers/);
  });

  test('genesis validates every option kind and custom validator', () => {
    const module = {
      ...testCounter(),
      id: 'option-fixture',
      optionsSchema: [
        { key: 'text', type: 'string' as const, default: 'ready' },
        { key: 'mode', type: 'enum' as const, default: 'one', values: ['one', 'two'] },
        { key: 'settings', type: 'object' as const, default: null },
        {
          key: 'positive',
          type: 'integer' as const,
          default: 1,
          validate: (value: unknown) => typeof value === 'number' && value > 0,
        },
      ],
      initialPhase: () => ({ id: 'turn', module: 'option-fixture', data: null }),
      phases: {
        turn: { pending: () => [{ kind: 'player' as const, seat: 0 as const, allowed: [] }] },
      },
    };
    const engine = createEngine([module]);
    const cfg = {
      modules: [{ id: 'option-fixture', version: '1.0.0' }],
      seats: [0, 1] as Seat[],
      options: {},
    };
    const state = engine.createGame(cfg, seed);
    expect(state.config.options['option-fixture']).toEqual({
      text: 'ready',
      mode: 'one',
      settings: null,
      positive: 1,
    });

    for (const options of [{ text: 1 }, { mode: 'three' }, { settings: [] }, { positive: 0 }]) {
      expect(() =>
        engine.createGame({ ...cfg, options: { 'option-fixture': options } }, seed),
      ).toThrow(/Invalid option/);
    }
  });
});
