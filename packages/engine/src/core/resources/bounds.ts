import { failure, success } from '../types/result.js';
import { RESOURCES } from '../types/resources.js';
import type { CountMap, Resource, ResourceCounts, Result } from '../types/index.js';
import { addCounts, sumCounts, validateCounts, zeroCounts } from './counts.js';

/** Public knowledge about the exact size and possible composition of a hand. */
export interface ResourceBounds<K extends string = Resource> {
  /** Exact number of cards in the hand. */
  readonly total: number;
  /** Cards guaranteed to be present. */
  readonly min: CountMap<K>;
  /** Maximum possible count for each kind. */
  readonly max: CountMap<K>;
}

type MutableBounds<K extends string> = {
  total: number;
  min: Record<K, number>;
  max: Record<K, number>;
};

// Expansion callers pass their own kinds. The default applies only to the base-game K=Resource API.
function defaultResourceKinds<K extends string>(kinds?: readonly K[]): readonly K[] {
  if (kinds) return kinds;
  // The default generic is Resource; extension kinds must be passed explicitly.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return RESOURCES as unknown as readonly K[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copyCounts<K extends string>(counts: CountMap<K>, kinds: readonly K[]): Record<K, number> {
  const copy = zeroCounts(kinds);
  for (const kind of kinds) copy[kind] = counts[kind];
  return copy;
}

function readBounds<K extends string>(
  bounds: ResourceBounds<K>,
  kinds: readonly K[],
): Result<MutableBounds<K>> {
  if (!isPlainRecord(bounds)) return failure('invalid-bounds', 'Bounds must be a plain record.');
  const keys = Reflect.ownKeys(bounds);
  if (
    keys.length !== 3 ||
    !keys.includes('total') ||
    !keys.includes('min') ||
    !keys.includes('max')
  ) {
    return failure('invalid-bounds', 'Bounds must contain exactly total, min and max.');
  }
  const totalDescriptor = Object.getOwnPropertyDescriptor(bounds, 'total');
  const minDescriptor = Object.getOwnPropertyDescriptor(bounds, 'min');
  const maxDescriptor = Object.getOwnPropertyDescriptor(bounds, 'max');
  if (
    !totalDescriptor ||
    !('value' in totalDescriptor) ||
    !totalDescriptor.enumerable ||
    !minDescriptor ||
    !('value' in minDescriptor) ||
    !minDescriptor.enumerable ||
    !maxDescriptor ||
    !('value' in maxDescriptor) ||
    !maxDescriptor.enumerable
  ) {
    return failure('invalid-bounds', 'Bounds must contain enumerable data properties.');
  }
  const total = totalDescriptor.value;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
    return failure('invalid-bounds-total', 'Bounds total must be a non-negative safe integer.');
  }
  const min = minDescriptor.value;
  const max = maxDescriptor.value;
  const minValid = validateCounts(min, kinds);
  if (!minValid.ok) return minValid;
  const maxValid = validateCounts(max, kinds);
  if (!maxValid.ok) return maxValid;

  const minCounts = copyCounts(min, kinds);
  const maxCounts = copyCounts(max, kinds);
  for (const kind of kinds) {
    if (minCounts[kind] > maxCounts[kind]) {
      return failure('infeasible-bounds', `Minimum ${kind} exceeds its maximum.`, { kind });
    }
  }
  const minTotal = sumCounts(minCounts, kinds);
  const maxTotal = sumCounts(maxCounts, kinds);
  if (!minTotal.ok) return minTotal;
  if (!maxTotal.ok) return maxTotal;
  if (minTotal.value > total || maxTotal.value < total) {
    return failure('infeasible-bounds', 'Bounds do not contain a hand with the declared total.', {
      total,
      minimumTotal: minTotal.value,
      maximumTotal: maxTotal.value,
    });
  }
  return success({ total, min: minCounts, max: maxCounts });
}

/** Tightens feasible bounds to a fixpoint without excluding any possible hand. */
export function normalizeBounds<K extends string = Resource>(
  bounds: ResourceBounds<K>,
  kinds: readonly K[] = defaultResourceKinds<K>(),
): Result<ResourceBounds<K>> {
  const read = readBounds(bounds, kinds);
  if (!read.ok) return read;
  const { total } = read.value;
  let { min, max } = read.value;

  for (let round = 0; round <= kinds.length; round += 1) {
    const minTotalResult = sumCounts(min, kinds);
    const maxTotalResult = sumCounts(max, kinds);
    if (!minTotalResult.ok) return minTotalResult;
    if (!maxTotalResult.ok) return maxTotalResult;
    const minTotal = minTotalResult.value;
    const maxTotal = maxTotalResult.value;
    const nextMin = copyCounts(min, kinds);
    const nextMax = copyCounts(max, kinds);

    for (const kind of kinds) {
      nextMax[kind] = Math.min(max[kind], total - (minTotal - min[kind]));
      nextMin[kind] = Math.max(min[kind], total - (maxTotal - max[kind]));
      if (nextMin[kind] > nextMax[kind]) {
        return failure('infeasible-bounds', `Bounds for ${kind} are infeasible.`, { kind, total });
      }
    }

    const stable = kinds.every(
      (kind) => nextMin[kind] === min[kind] && nextMax[kind] === max[kind],
    );
    min = nextMin;
    max = nextMax;
    if (stable) return success({ total, min, max });
  }

  return failure('bounds-did-not-converge', 'Bounds normalization did not reach a fixpoint.');
}

/** Checks that bounds are feasible and already normalized. */
export function checkBounds<K extends string = Resource>(
  bounds: ResourceBounds<K>,
  kinds: readonly K[] = defaultResourceKinds<K>(),
): Result<void> {
  const normalized = normalizeBounds(bounds, kinds);
  if (!normalized.ok) return normalized;
  const current = readBounds(bounds, kinds);
  if (!current.ok) return current;
  if (
    !kinds.every(
      (kind) =>
        normalized.value.min[kind] === current.value.min[kind] &&
        normalized.value.max[kind] === current.value.max[kind],
    )
  ) {
    return failure('unnormalized-bounds', 'Bounds must be normalized.');
  }
  return success(undefined);
}

/** Validates and normalizes a new hand-bounds value. */
export function createResourceBounds<K extends string = Resource>(
  total: number,
  min: CountMap<K>,
  max: CountMap<K>,
  kinds: readonly K[] = defaultResourceKinds<K>(),
): Result<ResourceBounds<K>> {
  return normalizeBounds({ total, min, max }, kinds);
}

/** Adds public knowledge that an exact set of cards entered the hand. */
export function gainKnown<K extends string = Resource>(
  bounds: ResourceBounds<K>,
  counts: CountMap<K>,
  kinds: readonly K[] = defaultResourceKinds<K>(),
): Result<ResourceBounds<K>> {
  const normalized = normalizeBounds(bounds, kinds);
  if (!normalized.ok) return normalized;
  const countTotal = sumCounts(counts, kinds);
  if (!countTotal.ok) return countTotal;
  const min = addCounts(normalized.value.min, counts, kinds);
  if (!min.ok) return min;
  const max = addCounts(normalized.value.max, counts, kinds);
  if (!max.ok) return max;
  const total = normalized.value.total + countTotal.value;
  if (!Number.isSafeInteger(total))
    return failure('count-overflow', 'Hand total exceeds the safe integer range.');
  return normalizeBounds({ total, min: min.value, max: max.value }, kinds);
}

/** Removes publicly known cards when at least one feasible hand can pay the cost. */
export function loseKnown<K extends string = Resource>(
  bounds: ResourceBounds<K>,
  counts: CountMap<K>,
  kinds: readonly K[] = defaultResourceKinds<K>(),
): Result<ResourceBounds<K>> {
  const normalized = normalizeBounds(bounds, kinds);
  if (!normalized.ok) return normalized;
  const affordable = canAfford(normalized.value, counts, kinds);
  if (!affordable.ok) return affordable;
  if (!affordable.value)
    return failure('insufficient-resources', 'No feasible hand can pay these counts.');
  const countTotal = sumCounts(counts, kinds);
  if (!countTotal.ok) return countTotal;
  const min = zeroCounts(kinds);
  const max = zeroCounts(kinds);
  for (const kind of kinds) {
    min[kind] = Math.max(0, normalized.value.min[kind] - counts[kind]);
    max[kind] = normalized.value.max[kind] - counts[kind];
  }
  return normalizeBounds({ total: normalized.value.total - countTotal.value, min, max }, kinds);
}

/** Adds an unknown card count, allowing each kind's upper bound to increase by that count. */
export function gainHidden<K extends string = Resource>(
  bounds: ResourceBounds<K>,
  count: number,
  kinds: readonly K[] = defaultResourceKinds<K>(),
): Result<ResourceBounds<K>> {
  const normalized = normalizeBounds(bounds, kinds);
  if (!normalized.ok) return normalized;
  if (!Number.isSafeInteger(count) || count < 0) {
    return failure('invalid-hidden-count', 'Hidden gain must be a non-negative safe integer.');
  }
  const total = normalized.value.total + count;
  if (!Number.isSafeInteger(total))
    return failure('count-overflow', 'Hand total exceeds the safe integer range.');
  const max = zeroCounts(kinds);
  for (const kind of kinds) {
    max[kind] = normalized.value.max[kind] + count;
    if (!Number.isSafeInteger(max[kind])) {
      return failure('count-overflow', `Maximum for ${kind} exceeds the safe integer range.`, {
        kind,
      });
    }
  }
  return normalizeBounds({ total, min: normalized.value.min, max }, kinds);
}

/** Removes an unknown count from the hand while preserving sound bounds. */
export function loseHidden<K extends string = Resource>(
  bounds: ResourceBounds<K>,
  count: number,
  kinds: readonly K[] = defaultResourceKinds<K>(),
): Result<ResourceBounds<K>> {
  const normalized = normalizeBounds(bounds, kinds);
  if (!normalized.ok) return normalized;
  if (!Number.isSafeInteger(count) || count < 0 || count > normalized.value.total) {
    return failure('invalid-hidden-loss', 'Hidden loss must be between zero and the hand total.');
  }
  const total = normalized.value.total - count;
  const min = zeroCounts(kinds);
  for (const kind of kinds) min[kind] = Math.max(0, normalized.value.min[kind] - count);
  return normalizeBounds({ total, min, max: normalized.value.max }, kinds);
}

/** Fixes one resource count when its exact value is revealed. */
export function revealExact<K extends string = Resource>(
  bounds: ResourceBounds<K>,
  resource: K,
  count: number,
  kinds: readonly K[] = defaultResourceKinds<K>(),
): Result<ResourceBounds<K>> {
  const normalized = normalizeBounds(bounds, kinds);
  if (!normalized.ok) return normalized;
  if (!kinds.includes(resource))
    return failure('unknown-resource', `Unknown resource kind ${resource}.`);
  if (
    !Number.isSafeInteger(count) ||
    count < normalized.value.min[resource] ||
    count > normalized.value.max[resource]
  ) {
    return failure(
      'reveal-out-of-bounds',
      `Revealed ${resource} count is outside its public bounds.`,
      {
        resource,
        count,
        min: normalized.value.min[resource],
        max: normalized.value.max[resource],
      },
    );
  }
  const min = copyCounts(normalized.value.min, kinds);
  const max = copyCounts(normalized.value.max, kinds);
  min[resource] = count;
  max[resource] = count;
  return normalizeBounds({ total: normalized.value.total, min, max }, kinds);
}

/** Reports whether every card-kind count is exact. */
export function isExact<K extends string = Resource>(
  bounds: ResourceBounds<K>,
  kinds: readonly K[] = defaultResourceKinds<K>(),
): Result<boolean> {
  const normalized = normalizeBounds(bounds, kinds);
  if (!normalized.ok) return normalized;
  return success(kinds.every((kind) => normalized.value.min[kind] === normalized.value.max[kind]));
}

/** Checks whether any hand consistent with the bounds can pay the requested cost. */
export function canAfford<K extends string = Resource>(
  bounds: ResourceBounds<K>,
  cost: CountMap<K>,
  kinds: readonly K[] = defaultResourceKinds<K>(),
): Result<boolean> {
  const feasible = readBounds(bounds, kinds);
  if (!feasible.ok) return feasible;
  const costTotal = sumCounts(cost, kinds);
  if (!costTotal.ok) return costTotal;
  let leastPossibleTotal = 0;
  for (const kind of kinds) {
    if (feasible.value.max[kind] < cost[kind]) return success(false);
    leastPossibleTotal += Math.max(feasible.value.min[kind], cost[kind]);
    if (!Number.isSafeInteger(leastPossibleTotal)) {
      return failure('count-overflow', 'Affordability total exceeds the safe integer range.');
    }
  }
  return success(leastPossibleTotal <= feasible.value.total);
}

/** Builds exact bounds from a known base-game hand. */
export function exactResourceBounds(counts: ResourceCounts): Result<ResourceBounds> {
  const total = sumCounts(counts, RESOURCES);
  if (!total.ok) return total;
  return createResourceBounds(total.value, counts, counts, RESOURCES);
}
