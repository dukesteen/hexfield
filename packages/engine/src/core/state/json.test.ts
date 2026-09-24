import { describe, expect, test } from 'vitest';
import { cloneJson } from './json.js';

describe('public JSON copying', () => {
  test('preserves own prototype-looking keys without changing prototypes', () => {
    const input: unknown = JSON.parse('{"__proto__":{"x":1},"toString":2}');
    const copy = cloneJson(input);
    if (typeof copy !== 'object' || copy === null) throw new Error('Expected object');
    expect(Object.keys(copy)).toEqual(['__proto__', 'toString']);
    expect(Reflect.get(copy, '__proto__')).toEqual({ x: 1 });
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(({} as { x?: number }).x).toBeUndefined();
  });

  test('accepts shared references but rejects actual cycles and sparse arrays', () => {
    const child = { value: 1 };
    expect(cloneJson({ a: child, b: child })).toEqual({ a: { value: 1 }, b: { value: 1 } });
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(() => cloneJson(cycle)).toThrow(/cycle/);
    const sparse: number[] = [0, 1];
    Reflect.deleteProperty(sparse, '0');
    sparse[1] = 1;
    expect(() => cloneJson(sparse)).toThrow(/sparse/);
  });

  test('rejects ambiguous non-JSON values', () => {
    expect(() => cloneJson({ x: undefined })).toThrow(/non-JSON/);
    expect(() => cloneJson({ x: 0.5 })).toThrow(/safe integers/);
    expect(() =>
      cloneJson(
        new (class HasPrototype {
          value = 1;
        })(),
      ),
    ).toThrow(/plain JSON/);
    expect(() => cloneJson({ $b: 'AA' })).toThrow(/reserved byte-tag/);
    const symbol = Symbol('hidden');
    expect(() => cloneJson({ [symbol]: 1 })).toThrow(/symbol/);
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get: () => 1 });
    expect(() => cloneJson(getter)).toThrow(/data properties/);
  });
});
