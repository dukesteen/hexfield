import { failure, success } from '../types/result.js';
import type { CountMap, Result } from '../types/index.js';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateKinds(kinds: readonly string[]): Result<void> {
  if (kinds.length === 0)
    return failure('invalid-count-kinds', 'At least one count kind is required.');
  if (new Set(kinds).size !== kinds.length) {
    return failure('invalid-count-kinds', 'Count keys must be unique.');
  }
  if (kinds.some((kind) => typeof kind !== 'string')) {
    return failure('invalid-count-kinds', 'Count keys must be strings.');
  }
  return success(undefined);
}

/** Creates a zero-filled count map for the supplied stable kind order. */
export function zeroCounts<K extends string>(kinds: readonly K[]): Record<K, number> {
  const counts: Record<string, number> = {};
  for (const kind of kinds) {
    Object.defineProperty(counts, kind, {
      value: 0,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return counts;
}

/** Checks that a count map has exactly the expected keys and safe non-negative integers. */
export function validateCounts(counts: unknown, kinds: readonly string[]): Result<void> {
  const kindResult = validateKinds(kinds);
  if (!kindResult.ok) return kindResult;
  if (!isPlainRecord(counts)) return failure('invalid-count-map', 'Counts must be a plain record.');

  const expected = new Set<string>(kinds);
  const ownKeys = Reflect.ownKeys(counts);
  if (
    ownKeys.length !== kinds.length ||
    ownKeys.some((key) => typeof key !== 'string' || !expected.has(key))
  ) {
    return failure('invalid-count-keys', 'Counts must contain exactly the expected keys.');
  }
  for (const kind of kinds) {
    const descriptor = Object.getOwnPropertyDescriptor(counts, kind);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      return failure(
        'invalid-count-map',
        `Count for ${kind} must be an enumerable data property.`,
        { kind },
      );
    }
    const count = descriptor.value;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      return failure('invalid-count', `Count for ${kind} must be a non-negative safe integer.`, {
        kind,
        value: count,
      });
    }
  }
  return success(undefined);
}

/** Sums an exact count map, rejecting malformed counts or unsafe totals. */
export function sumCounts<K extends string>(
  counts: CountMap<K>,
  kinds: readonly K[],
): Result<number> {
  const valid = validateCounts(counts, kinds);
  if (!valid.ok) return valid;
  let total = 0;
  for (const kind of kinds) {
    total += counts[kind];
    if (!Number.isSafeInteger(total)) {
      return failure('count-overflow', 'Count total exceeds the safe integer range.');
    }
  }
  return success(total);
}

/** Adds two count maps without changing either input. */
export function addCounts<K extends string>(
  left: CountMap<K>,
  right: CountMap<K>,
  kinds: readonly K[],
): Result<CountMap<K>> {
  const leftValid = validateCounts(left, kinds);
  if (!leftValid.ok) return leftValid;
  const rightValid = validateCounts(right, kinds);
  if (!rightValid.ok) return rightValid;

  const result = zeroCounts(kinds);
  for (const kind of kinds) {
    const value = left[kind] + right[kind];
    if (!Number.isSafeInteger(value)) {
      return failure('count-overflow', `Count for ${kind} exceeds the safe integer range.`, {
        kind,
      });
    }
    result[kind] = value;
  }
  return success(result);
}

/** Subtracts counts when every result remains non-negative. */
export function subtractCounts<K extends string>(
  left: CountMap<K>,
  right: CountMap<K>,
  kinds: readonly K[],
): Result<CountMap<K>> {
  const leftValid = validateCounts(left, kinds);
  if (!leftValid.ok) return leftValid;
  const rightValid = validateCounts(right, kinds);
  if (!rightValid.ok) return rightValid;

  const result = zeroCounts(kinds);
  for (const kind of kinds) {
    if (left[kind] < right[kind]) {
      return failure('negative-count', `Cannot subtract more ${kind} than are available.`, {
        kind,
      });
    }
    result[kind] = left[kind] - right[kind];
  }
  return success(result);
}
