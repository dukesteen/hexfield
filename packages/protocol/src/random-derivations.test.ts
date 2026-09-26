import { createBaseEngine, success } from '@cp2p/engine';
import type { GameState, Result } from '@cp2p/engine';
import { describe, expect, test } from 'vitest';
import { createRandomDerivations, randomDerivations } from './random-derivations.js';
import type { RandomDerivation, RandomPending } from './random-derivations.js';

const seed = new Uint8Array(32).fill(9);
const context = { game: 'test-game', parent: 4 };
const engine = createBaseEngine();
const state = engine.createGame(
  {
    modules: [{ id: 'base', version: '1.0.0' }],
    seats: [0, 1],
    options: { base: { mapLayout: 'random' } },
  },
  new Uint8Array(32).fill(1),
);
function createBalancedState(): GameState {
  const options = state.config.options.base;
  if (typeof options !== 'object' || options === null || Array.isArray(options))
    throw new Error('Missing base options');
  return {
    ...state,
    config: {
      ...state.config,
      options: { ...state.config.options, base: { ...options, diceMode: 'balanced' } },
    },
  };
}

function pending(
  type: string,
  request: Record<string, unknown>,
  systemType: string,
): RandomPending {
  return { kind: 'random', request: { ...request, type }, systemType };
}

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function randomStateWithHandSize(handSize: number): GameState {
  return {
    ...state,
    seats: state.seats.map((seat) =>
      seat.seat === 1 ? { ...seat, resources: { ...seat.resources, total: handSize } } : seat,
    ),
  };
}

function randomPending(input: unknown): RandomPending {
  // This intentionally feeds a hostile proxy through the public unknown-input edge.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- hostile test fixture
  return input as RandomPending;
}

describe('base beacon random derivations', () => {
  test('chooses from configured seats and is bound to operation context', () => {
    const request = pending('startSeat', { max: 2 }, 'START_SEAT');
    const firstContext = { ...context, parent: 0 };
    const nextContext = { ...context, parent: 1 };
    const result = value(randomDerivations.derive(state, request, seed, firstContext));
    expect(result).toEqual({
      kind: 'system',
      input: { kind: 'system', type: 'START_SEAT', seat: expect.any(Number) },
    });
    if (result.kind !== 'system') throw new Error('Expected system input');
    expect(state.config.seats).toContain(result.input.seat);
    const repeated = value(randomDerivations.derive(state, request, seed, firstContext));
    const anotherOperation = value(randomDerivations.derive(state, request, seed, nextContext));
    expect(repeated).toEqual(result);
    expect(result).toMatchObject({ input: { seat: 0 } });
    expect(anotherOperation).toMatchObject({ input: { seat: 1 } });
  });

  test('derives two separate six-sided dice in the declared system input shape', () => {
    const request = pending('dice', { mode: 'random', sides: 6, count: 2 }, 'DICE_RESULT');
    const result = value(randomDerivations.derive(state, request, seed, context));
    expect(result.kind).toBe('system');
    if (result.kind !== 'system') throw new Error('Expected dice system input');
    expect(result.input).toMatchObject({ kind: 'system', type: 'DICE_RESULT' });
    if (result.input.type !== 'DICE_RESULT') throw new Error('Expected dice result');
    const faces = result.input.dice;
    if (!Array.isArray(faces)) throw new Error('Dice result must include its faces');
    expect(faces).toHaveLength(2);
    expect(
      faces.every(
        (face: unknown) =>
          typeof face === 'number' && Number.isInteger(face) && face >= 1 && face <= 6,
      ),
    ).toBe(true);
    expect(result.input).not.toHaveProperty('index');
  });

  test('samples a balanced deck position and returns its exact faces', () => {
    const balancedState = createBalancedState();
    const request = pending('dice', { mode: 'balanced', remaining: 36 }, 'DICE_RESULT');
    const result = value(randomDerivations.derive(balancedState, request, seed, context));
    expect(result.kind).toBe('system');
    if (result.kind !== 'system' || result.input.type !== 'DICE_RESULT')
      throw new Error('Expected balanced dice result');
    const index = result.input.index;
    expect(Number.isSafeInteger(index)).toBe(true);
    const base = balancedState.ext.base;
    if (typeof base !== 'object' || base === null || !('diceDeck' in base))
      throw new Error('Missing base dice deck');
    const ids = base.diceDeck;
    if (!Array.isArray(ids) || typeof index !== 'number') throw new Error('Invalid deck result');
    const id = ids[index];
    if (typeof id !== 'number') throw new Error('Dice identifier is missing');
    const dice = result.input.dice;
    if (!Array.isArray(dice)) throw new Error('Missing dice faces');
    expect(dice).toEqual([Math.floor(id / 6) + 1, (id % 6) + 1]);
    expect(randomDerivations.validate(balancedState, request).ok).toBe(true);
  });

  test('returns only a hidden steal index, never the selected resource identity', () => {
    const stealState = randomStateWithHandSize(3);
    const request = pending('stealIndex', { thief: 0, victim: 1, handSize: 3 }, 'STEAL_RESULT');
    const result = value(randomDerivations.derive(stealState, request, seed, context));
    expect(result).toMatchObject({ kind: 'steal-index', thief: 0, victim: 1, handSize: 3 });
    if (result.kind !== 'steal-index') throw new Error('Expected private index outcome');
    expect(result.index).toBeGreaterThanOrEqual(0);
    expect(result.index).toBeLessThan(3);
    expect(result).not.toHaveProperty('resource');
  });

  test('rejects malformed bounds, fields, mode/system mismatches, and unsupported deck draws', () => {
    const balancedState = createBalancedState();
    expect(
      randomDerivations.validate(state, pending('startSeat', { max: 3 }, 'START_SEAT')).ok,
    ).toBe(false);
    expect(
      randomDerivations.validate(state, pending('startSeat', { max: 2, extra: true }, 'START_SEAT'))
        .ok,
    ).toBe(false);
    expect(
      randomDerivations.validate(state, pending('startSeat', { max: 2 }, 'DICE_RESULT')).ok,
    ).toBe(false);
    expect(
      randomDerivations.validate(
        state,
        pending('dice', { mode: 'random', sides: 8, count: 2 }, 'DICE_RESULT'),
      ).ok,
    ).toBe(false);
    expect(
      randomDerivations.validate(
        state,
        pending('dice', { mode: 'balanced', remaining: 36 }, 'DICE_RESULT'),
      ).ok,
    ).toBe(false);
    expect(
      randomDerivations.validate(
        balancedState,
        pending('dice', { mode: 'balanced', remaining: 35 }, 'DICE_RESULT'),
      ).ok,
    ).toBe(false);
    const steal = pending('stealIndex', { thief: 0, victim: 1, handSize: 1 }, 'STEAL_RESULT');
    expect(randomDerivations.validate(state, steal).ok).toBe(false);
    const draw = pending(
      'draw',
      { deck: 'dev', seat: 0, slotId: 'dev:1', remaining: 25 },
      'CARD_DEALT',
    );
    expect(randomDerivations.supports(draw)).toBe(false);
    expect(randomDerivations.validate(state, draw).ok).toBe(false);
  });

  test('is total for hostile pending/state/context and invalid seed input', () => {
    const throwsOnRead = new Proxy(
      {},
      {
        get: () => {
          throw new Error('getter');
        },
      },
    );
    expect(randomDerivations.supports(throwsOnRead)).toBe(false);
    const malformed = randomPending(throwsOnRead);
    expect(randomDerivations.validate(state, malformed).ok).toBe(false);
    expect(randomDerivations.derive(state, malformed, seed, context).ok).toBe(false);
    const request = pending('startSeat', { max: 2 }, 'START_SEAT');
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(randomDerivations.derive(state, request, seed, cycle).ok).toBe(false);
    expect(randomDerivations.derive(state, request, new Uint8Array(31), context).ok).toBe(false);
  });

  test('rejects an extension result that answers a different pending system type', () => {
    const registry = createRandomDerivations([
      {
        type: 'extensionChoice',
        validate: () => success(undefined),
        derive: () =>
          success({ kind: 'system', input: { kind: 'system', type: 'DICE_RESULT', dice: [1, 1] } }),
      },
    ]);
    expect(
      registry.derive(state, pending('extensionChoice', {}, 'EXTENSION_RESULT'), seed, context),
    ).toMatchObject({ ok: false, error: { code: 'random-result-type' } });
  });

  test('rejects a hidden steal index for an unrelated module request', () => {
    const registry = createRandomDerivations([
      {
        type: 'extensionChoice',
        validate: () => success(undefined),
        derive: () => success({ kind: 'steal-index', thief: 0, victim: 1, handSize: 1, index: 0 }),
      },
    ]);
    expect(
      registry.derive(state, pending('extensionChoice', {}, 'EXTENSION_RESULT'), seed, context),
    ).toMatchObject({ ok: false, error: { code: 'random-result-type' } });
  });

  test('supports explicit module extensions while rejecting replacement and duplicate types', () => {
    let extensionCalls = 0;
    const extension: RandomDerivation = {
      type: 'extensionChoice',
      validate: () => ({ ok: true, value: undefined }),
      derive: () => {
        extensionCalls += 1;
        return {
          ok: true,
          value: { kind: 'system', input: { kind: 'system', type: 'EXTENSION_RESULT', choice: 7 } },
        };
      },
    };
    const registry = createRandomDerivations([extension]);
    Object.defineProperty(extension, 'type', { value: 'changedAfterRegistration' });
    extension.derive = () => ({
      ok: true,
      value: { kind: 'system', input: { kind: 'system', type: 'MUTATED', choice: 99 } },
    });
    const request = pending('extensionChoice', {}, 'EXTENSION_RESULT');
    expect(registry.supports(request)).toBe(true);
    expect(value(registry.derive(state, request, seed, context))).toEqual({
      kind: 'system',
      input: { kind: 'system', type: 'EXTENSION_RESULT', choice: 7 },
    });
    expect(extensionCalls).toBe(1);
    expect(() =>
      createRandomDerivations([
        {
          type: 'dice',
          validate: () => ({ ok: true, value: undefined }),
          derive: () => ({
            ok: true,
            value: { kind: 'steal-index', thief: 0, victim: 1, handSize: 1, index: 0 },
          }),
        },
      ]),
    ).toThrow(/already registered/);
    expect(() => createRandomDerivations([extension, { ...extension }])).toThrow(
      /already registered/,
    );
  });

  test('a failing extension cannot mutate the certified inputs it inspected', () => {
    const request = pending('extensionChoice', { marker: 'original' }, 'EXTENSION_RESULT');
    const publicState = randomStateWithHandSize(3);
    const operation = { ...context };
    const registry = createRandomDerivations([
      {
        type: 'extensionChoice',
        validate(candidateState, candidatePending) {
          Object.assign(candidateState.config, { seats: [5] });
          Object.assign(candidatePending.request, { marker: 'changed' });
          return { ok: false, error: { code: 'extension-rejected', message: 'Rejected' } };
        },
        derive: () => {
          throw new Error('Derivation must not run');
        },
      },
    ]);
    expect(registry.validate(publicState, request).ok).toBe(false);
    expect(registry.derive(publicState, request, seed, operation).ok).toBe(false);
    expect(publicState.config.seats).toEqual([0, 1]);
    expect(request.request).toEqual({ marker: 'original', type: 'extensionChoice' });
    expect(operation).toEqual(context);
  });

  test('a successful extension receives separate copies and returns a detached outcome', () => {
    const request = pending('extensionChoice', { marker: 'original' }, 'EXTENSION_RESULT');
    const publicState = randomStateWithHandSize(3);
    const operation = { ...context };
    const localSeed = seed.slice();
    const outcome = {
      kind: 'system' as const,
      input: { kind: 'system' as const, type: 'EXTENSION_RESULT' as const, choice: 7 },
    };
    const registry = createRandomDerivations([
      {
        type: 'extensionChoice',
        validate(candidateState, candidatePending) {
          Object.assign(candidateState.config, { seats: [5] });
          Object.assign(candidatePending.request, { marker: 'changed' });
          return { ok: true, value: undefined };
        },
        derive(candidateState, candidatePending, candidateSeed, candidateContext) {
          expect(candidateState.config.seats).toEqual([0, 1]);
          expect(candidatePending.request).toEqual(request.request);
          expect(candidateSeed).toEqual(seed);
          expect(candidateContext).toEqual(context);
          Object.assign(candidateState.config, { seats: [5] });
          Object.assign(candidatePending.request, { marker: 'changed' });
          candidateSeed.fill(0);
          if (typeof candidateContext !== 'object' || candidateContext === null)
            throw new Error('Expected object context');
          Object.assign(candidateContext, { parent: -1 });
          return { ok: true, value: outcome };
        },
      },
    ]);
    const result = value(registry.derive(publicState, request, localSeed, operation));
    outcome.input.choice = 99;
    expect(result).toEqual({
      kind: 'system',
      input: { kind: 'system', type: 'EXTENSION_RESULT', choice: 7 },
    });
    expect(publicState.config.seats).toEqual([0, 1]);
    expect(request.request).toEqual({ marker: 'original', type: 'extensionChoice' });
    expect(localSeed).toEqual(seed);
    expect(operation).toEqual(context);
  });
});
