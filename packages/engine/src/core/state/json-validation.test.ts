import { expect, test } from 'vitest';
import { cloneJson, validateJson } from './json.js';

function errorMessage(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return String(error);
  }
}

test('validation-only JSON walk matches copying on valid and malformed values', () => {
  const child = { value: 1 };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse = [0, 1];
  Reflect.deleteProperty(sparse, '0');
  const extraArray = Object.assign([1], { extra: 2 });
  const arrayAccessor = Object.defineProperty([1], '0', { enumerable: true, get: () => 1 });
  const objectAccessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 });
  const nullPrototype = Object.assign(Object.create(null), { brick: 1 });
  const values: unknown[] = [
    null,
    true,
    42,
    { left: child, right: child },
    JSON.parse('{"__proto__":{"x":1},"toString":2}'),
    nullPrototype,
    cycle,
    sparse,
    extraArray,
    arrayAccessor,
    objectAccessor,
    { bad: undefined },
    { bad: 0.5 },
    { bad: Number.MAX_SAFE_INTEGER + 1 },
    { bad: Symbol('value') },
    { bad: () => 1 },
    {
      bad: new (class NonPlain {
        value = 1;
      })(),
    },
    { $b: 'AA' },
    { [Symbol('key')]: 1 },
  ];
  for (const value of values) {
    const expected = errorMessage(() => cloneJson(value));
    expect(errorMessage(() => validateJson(value))).toBe(expected);
  }
});
