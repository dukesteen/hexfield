import { describe, expect, test } from 'vitest';
import { array, assert, integer, oneof, property, tuple, type Arbitrary } from 'fast-check';
import {
  addCounts,
  canAfford,
  checkBounds,
  createResourceBounds,
  exactResourceBounds,
  gainHidden,
  gainKnown,
  loseHidden,
  loseKnown,
  isExact,
  normalizeBounds,
  subtractCounts,
  sumCounts,
  zeroCounts,
  revealExact,
  validateCounts,
} from './index.js';
import { RESOURCES } from '../types/resources.js';
import type { Resource, ResourceCounts } from '../types/resources.js';
import type { ResourceBounds } from './bounds.js';
import type { Result } from '../types/result.js';

function countsFromTuple(values: readonly number[]): ResourceCounts {
  return {
    brick: values[0] ?? 0,
    lumber: values[1] ?? 0,
    wool: values[2] ?? 0,
    grain: values[3] ?? 0,
    ore: values[4] ?? 0,
  };
}

function resourceAt(index: number): Resource {
  const resource = RESOURCES[index];
  if (resource === undefined) throw new Error(`No resource at index ${index}.`);
  return resource;
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function normalizeUnknown(value: unknown): Result<ResourceBounds> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise malformed runtime inputs.
  return normalizeBounds(value as ResourceBounds);
}

function coveredByBounds(hand: readonly number[], bounds: ResourceBounds): boolean {
  return RESOURCES.every(
    (resource, index) =>
      (hand[index] ?? -1) >= bounds.min[resource] &&
      (hand[index] ?? Number.MAX_SAFE_INTEGER) <= bounds.max[resource],
  );
}

function enumerateHands(total: number, bounds: ResourceBounds): number[][] {
  const hands: number[][] = [];
  function visit(index: number, remaining: number, prefix: number[]): void {
    if (index === RESOURCES.length - 1) {
      const count = remaining;
      const candidate = [...prefix, count];
      if (
        count >= bounds.min[resourceAt(index)] &&
        count <= bounds.max[resourceAt(index)] &&
        coveredByBounds(candidate, bounds)
      ) {
        hands.push(candidate);
      }
      return;
    }
    const resource = resourceAt(index);
    for (
      let count = bounds.min[resource];
      count <= Math.min(bounds.max[resource], remaining);
      count += 1
    ) {
      visit(index + 1, remaining - count, [...prefix, count]);
    }
  }
  visit(0, total, []);
  return hands;
}

function key(hand: readonly number[]): string {
  return hand.join(',');
}

function liesWithin(hand: ResourceCounts, bounds: ResourceBounds): boolean {
  return RESOURCES.every(
    (resource) => hand[resource] >= bounds.min[resource] && hand[resource] <= bounds.max[resource],
  );
}

function sum(values: readonly number[]): number {
  return values.reduce((total, count) => total + count, 0);
}

type Operation =
  | { type: 'known-gain'; cards: readonly number[] }
  | { type: 'hidden-gain'; cards: readonly number[] }
  | { type: 'known-loss'; cards: readonly number[] }
  | { type: 'hidden-loss'; cards: readonly number[] }
  | { type: 'reveal'; index: number };

function applyOperation(
  bounds: ResourceBounds,
  hand: number[],
  operation: Operation,
): { bounds: ResourceBounds; hand: number[] } {
  switch (operation.type) {
    case 'reveal': {
      const resource = resourceAt(operation.index);
      return {
        bounds: unwrap(revealExact(bounds, resource, hand[operation.index] ?? 0)),
        hand,
      };
    }
    case 'known-gain': {
      const cards = countsFromTuple(operation.cards);
      return {
        bounds: unwrap(gainKnown(bounds, cards)),
        hand: hand.map((count, index) => count + (operation.cards[index] ?? 0)),
      };
    }
    case 'hidden-gain': {
      return {
        bounds: unwrap(gainHidden(bounds, sum(operation.cards))),
        hand: hand.map((count, index) => count + (operation.cards[index] ?? 0)),
      };
    }
    case 'known-loss':
    case 'hidden-loss': {
      const fits = operation.cards.every((count, index) => count <= (hand[index] ?? 0));
      if (!fits) return { bounds, hand };
      const cards = countsFromTuple(operation.cards);
      const nextBounds =
        operation.type === 'known-loss'
          ? loseKnown(bounds, cards)
          : loseHidden(bounds, sum(operation.cards));
      return {
        bounds: unwrap(nextBounds),
        hand: hand.map((count, index) => count - (operation.cards[index] ?? 0)),
      };
    }
    default:
      throw new Error('Unexpected resource operation.');
  }
}

describe('resource counts and bounds', () => {
  test('rejects malformed count maps with typed failures', () => {
    expect(validateCounts({ ...countsFromTuple([0, 0, 0, 0, 0]), ore: -1 }, RESOURCES).ok).toBe(
      false,
    );
    expect(validateCounts({ brick: 1 }, RESOURCES).ok).toBe(false);
    expect(validateCounts({ ...countsFromTuple([0, 0, 0, 0, 0]), extra: 1 }, RESOURCES).ok).toBe(
      false,
    );
    expect(validateCounts({}, [])).toMatchObject({
      ok: false,
      error: { code: 'invalid-count-kinds' },
    });
    expect(validateCounts({ only: 0 }, ['only', 'only'])).toMatchObject({
      ok: false,
      error: { code: 'invalid-count-kinds' },
    });
    expect(validateCounts({ only: Number.MAX_SAFE_INTEGER + 1 }, ['only']).ok).toBe(false);
    expect(validateCounts({ only: 0.5 }, ['only']).ok).toBe(false);
    const symbolKeyed = { only: 0, [Symbol('extra')]: 0 };
    expect(validateCounts(symbolKeyed, ['only']).ok).toBe(false);
    const accessor = Object.defineProperty({}, 'only', { enumerable: true, get: () => 0 });
    expect(validateCounts(accessor, ['only']).ok).toBe(false);
    const hidden = Object.defineProperty({}, 'only', { value: 0, enumerable: false });
    expect(validateCounts(hidden, ['only']).ok).toBe(false);
    expect(validateCounts([], ['only']).ok).toBe(false);
    expect(
      validateCounts(
        new (class CustomMap {
          readonly extra = 0;
        })(),
        ['only'],
      ).ok,
    ).toBe(false);
    const nullPrototype = Object.setPrototypeOf({ only: 0 }, null);
    expect(validateCounts(nullPrototype, ['only']).ok).toBe(true);
    const customPrototype = Object.setPrototypeOf({ only: 0 }, {});
    expect(validateCounts(customPrototype, ['only']).ok).toBe(false);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately malformed runtime kind list.
    expect(validateCounts({ brick: 0, 1: 0 }, ['brick', 1] as unknown as string[])).toMatchObject({
      ok: false,
      error: { code: 'invalid-count-kinds' },
    });
    expect(addCounts({ a: -1 }, { a: 0 }, ['a'])).toMatchObject({
      ok: false,
      error: { code: 'invalid-count' },
    });
    expect(addCounts({ a: 0 }, { a: -1 }, ['a'])).toMatchObject({
      ok: false,
      error: { code: 'invalid-count' },
    });
    expect(subtractCounts({ a: -1 }, { a: 0 }, ['a'])).toMatchObject({
      ok: false,
      error: { code: 'invalid-count' },
    });
    expect(subtractCounts({ a: 0 }, { a: -1 }, ['a'])).toMatchObject({
      ok: false,
      error: { code: 'invalid-count' },
    });
  });

  test('rejects unsafe count arithmetic and negative subtraction', () => {
    const kinds = ['a', 'b'] as const;
    expect(sumCounts({ a: Number.MAX_SAFE_INTEGER, b: 1 }, kinds)).toMatchObject({
      ok: false,
      error: { code: 'count-overflow' },
    });
    expect(addCounts({ a: Number.MAX_SAFE_INTEGER, b: 0 }, { a: 1, b: 0 }, kinds)).toMatchObject({
      ok: false,
      error: { code: 'count-overflow' },
    });
    expect(subtractCounts({ a: 1, b: 0 }, { a: 2, b: 0 }, kinds)).toMatchObject({
      ok: false,
      error: { code: 'negative-count' },
    });
  });

  test('rejects malformed and non-feasible bounds at operation boundaries', () => {
    const zero = countsFromTuple([0, 0, 0, 0, 0]);
    expect(normalizeBounds({ total: -1, min: zero, max: zero })).toMatchObject({
      ok: false,
      error: { code: 'invalid-bounds-total' },
    });
    const maxWithExtra = Object.assign({}, zero, { extra: 0 });
    expect(normalizeBounds({ total: 0, min: zero, max: maxWithExtra })).toMatchObject({
      ok: false,
      error: { code: 'invalid-count-keys' },
    });
    expect(normalizeBounds({ total: 0, min: { ...zero, brick: 1 }, max: zero })).toMatchObject({
      ok: false,
      error: { code: 'infeasible-bounds' },
    });
    expect(createResourceBounds(Number.MAX_SAFE_INTEGER, zero, zero)).toMatchObject({
      ok: false,
      error: { code: 'infeasible-bounds' },
    });
    expect(normalizeUnknown(null)).toMatchObject({
      ok: false,
      error: { code: 'invalid-bounds' },
    });
    expect(normalizeUnknown([])).toMatchObject({ ok: false, error: { code: 'invalid-bounds' } });
    expect(
      normalizeUnknown(
        new (class CustomBounds {
          readonly extra = 0;
        })(),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-bounds' },
    });
    expect(normalizeUnknown({ total: 0, min: zero, max: zero, extra: true })).toMatchObject({
      ok: false,
      error: { code: 'invalid-bounds' },
    });
    const symbolKeyedBounds = { total: 0, min: zero, max: zero, [Symbol('extra')]: true };
    expect(normalizeUnknown(symbolKeyedBounds)).toMatchObject({
      ok: false,
      error: { code: 'invalid-bounds' },
    });
    const accessorBounds = Object.defineProperty({ min: zero, max: zero }, 'total', {
      enumerable: true,
      get: () => 0,
    });
    expect(normalizeUnknown(accessorBounds)).toMatchObject({
      ok: false,
      error: { code: 'invalid-bounds' },
    });
  });

  test('returns typed failures for illegal bounds operations', () => {
    const bounds = unwrap(
      createResourceBounds(2, countsFromTuple([1, 0, 0, 0, 1]), countsFromTuple([1, 0, 0, 0, 1])),
    );
    expect(gainHidden(bounds, -1).ok).toBe(false);
    expect(gainKnown(bounds, { ...countsFromTuple([0, 0, 0, 0, 0]), ore: -1 }).ok).toBe(false);
    expect(loseHidden(bounds, 3).ok).toBe(false);
    expect(loseHidden(bounds, -1).ok).toBe(false);
    expect(loseKnown(bounds, countsFromTuple([0, 1, 0, 0, 0])).ok).toBe(false);
    expect(revealExact(bounds, 'ore', 0).ok).toBe(false);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Exercise the runtime unknown-kind check.
    expect(revealExact(bounds, 'unknown' as Resource, 0).ok).toBe(false);
    expect(
      createResourceBounds(1, countsFromTuple([1, 1, 0, 0, 0]), countsFromTuple([1, 1, 0, 0, 0]))
        .ok,
    ).toBe(false);
  });

  test('rejects unsafe totals and invalid affordability costs', () => {
    const huge = createResourceBounds(
      Number.MAX_SAFE_INTEGER,
      countsFromTuple([0, 0, 0, 0, 0]),
      countsFromTuple([
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      ]),
    );
    expect(huge.ok).toBe(false);
    const exact = unwrap(
      createResourceBounds(1, countsFromTuple([1, 0, 0, 0, 0]), countsFromTuple([1, 0, 0, 0, 0])),
    );
    expect(canAfford(exact, { ...countsFromTuple([0, 0, 0, 0, 0]), brick: -1 })).toMatchObject({
      ok: false,
      error: { code: 'invalid-count' },
    });
    expect(
      canAfford(
        { total: -1, min: countsFromTuple([0, 0, 0, 0, 0]), max: countsFromTuple([0, 0, 0, 0, 0]) },
        countsFromTuple([0, 0, 0, 0, 0]),
      ),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid-bounds-total' },
    });
    const exactLarge = unwrap(
      exactResourceBounds({
        brick: Number.MAX_SAFE_INTEGER,
        lumber: 0,
        wool: 0,
        grain: 0,
        ore: 0,
      }),
    );
    expect(gainHidden(exactLarge, 1)).toMatchObject({
      ok: false,
      error: { code: 'count-overflow' },
    });
    expect(gainKnown(exactLarge, countsFromTuple([0, 1, 0, 0, 0]))).toMatchObject({
      ok: false,
      error: { code: 'count-overflow' },
    });
    expect(
      exactResourceBounds({
        brick: Number.MAX_SAFE_INTEGER,
        lumber: 1,
        wool: 0,
        grain: 0,
        ore: 0,
      }),
    ).toMatchObject({ ok: false, error: { code: 'count-overflow' } });
    expect(gainHidden(exact, 0.5)).toMatchObject({
      ok: false,
      error: { code: 'invalid-hidden-count' },
    });
  });

  test('normalizes one-kind bounds after tightening its maximum', () => {
    const kinds = ['only'] as const;
    const normalized = normalizeBounds({ total: 3, min: { only: 0 }, max: { only: 5 } }, kinds);
    expect(normalized).toEqual({
      ok: true,
      value: { total: 3, min: { only: 3 }, max: { only: 3 } },
    });
  });

  test('count helpers preserve custom keys including __proto__', () => {
    const kinds = ['__proto__', 'gold'] as const;
    const left = zeroCounts(kinds);
    left.__proto__ = 2;
    left.gold = 1;
    const right = zeroCounts(kinds);
    right.__proto__ = 3;
    right.gold = 4;

    const added = unwrap(addCounts(left, right, kinds));
    expect(added.__proto__).toBe(5);
    expect(added.gold).toBe(5);
    expect(unwrap(sumCounts(added, kinds))).toBe(10);
    const subtracted = unwrap(subtractCounts(added, left, kinds));
    expect(subtracted).toEqual(right);
  });

  test('identifies exact, non-exact, and invalid bounds', () => {
    const exact = createResourceBounds(
      2,
      countsFromTuple([1, 0, 0, 0, 1]),
      countsFromTuple([1, 0, 0, 0, 1]),
    );
    expect(exact.ok && isExact(exact.value)).toEqual({ ok: true, value: true });

    const uncertain = createResourceBounds(
      2,
      countsFromTuple([0, 0, 0, 0, 0]),
      countsFromTuple([2, 2, 2, 2, 2]),
    );
    expect(uncertain.ok && isExact(uncertain.value)).toEqual({ ok: true, value: false });
    expect(
      isExact({
        total: -1,
        min: countsFromTuple([0, 0, 0, 0, 0]),
        max: countsFromTuple([0, 0, 0, 0, 0]),
      }),
    ).toMatchObject({ ok: false });
  });

  test('preserves a six-kind hand through generic resource operations', () => {
    const kinds = ['brick', 'lumber', 'wool', 'grain', 'ore', 'gold'] as const;
    const hand = { brick: 1, lumber: 1, wool: 1, grain: 0, ore: 0, gold: 0 };
    const zero = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0, gold: 0 };
    const max = { brick: 1, lumber: 1, wool: 1, grain: 1, ore: 1, gold: 1 };
    let bounds = unwrap(createResourceBounds(3, zero, max, kinds));
    expect(isExact(bounds, kinds)).toEqual({ ok: true, value: false });

    bounds = unwrap(
      gainKnown(bounds, { brick: 0, lumber: 0, wool: 0, grain: 1, ore: 0, gold: 0 }, kinds),
    );
    hand.grain += 1;
    bounds = unwrap(gainHidden(bounds, 1, kinds));
    hand.gold += 1;
    bounds = unwrap(
      loseKnown(bounds, { brick: 0, lumber: 0, wool: 0, grain: 1, ore: 0, gold: 0 }, kinds),
    );
    hand.grain -= 1;
    bounds = unwrap(revealExact(bounds, 'gold', hand.gold, kinds));

    expect(
      kinds.every((kind) => hand[kind] >= bounds.min[kind] && hand[kind] <= bounds.max[kind]),
    ).toBe(true);
    expect(bounds.total).toBe(Object.values(hand).reduce((total, count) => total + count, 0));
  });

  test('preserves a hidden true hand over 10,000 operation sequences', () => {
    const smallCard = integer({ min: 0, max: 2 });
    const cardsArb = tuple(smallCard, smallCard, smallCard, smallCard, smallCard);
    const operationArb: Arbitrary<Operation> = oneof(
      cardsArb.map((cards) => ({ type: 'known-gain' as const, cards })),
      cardsArb.map((cards) => ({ type: 'hidden-gain' as const, cards })),
      cardsArb.map((cards) => ({ type: 'known-loss' as const, cards })),
      cardsArb.map((cards) => ({ type: 'hidden-loss' as const, cards })),
      integer({ min: 0, max: RESOURCES.length - 1 }).map((index) => ({
        type: 'reveal' as const,
        index,
      })),
    );
    assert(
      property(cardsArb, array(operationArb, { maxLength: 18 }), (initial, operations) => {
        let hand = [...initial];
        let bounds = createResourceBounds(sum(hand), countsFromTuple(hand), countsFromTuple(hand));
        let current = unwrap(bounds);
        expect(liesWithin(countsFromTuple(hand), current)).toBe(true);
        for (const operation of operations) {
          const next = applyOperation(current, hand, operation);
          current = next.bounds;
          hand = next.hand;
          current = unwrap(normalizeBounds(current));
          expect(liesWithin(countsFromTuple(hand), current)).toBe(true);
          expect(current.total).toBe(sum(hand));
          expect(unwrap(checkBounds(current))).toBeUndefined();
        }
      }),
      { numRuns: 10_000 },
    );
  });

  test('matches brute-force affordability and known-loss hand sets', () => {
    const totalArb = integer({ min: 0, max: 6 });
    const caseArb = totalArb.chain((total) =>
      tuple(
        array(integer({ min: 0, max: total }), { minLength: 5, maxLength: 5 }),
        array(integer({ min: 0, max: total }), { minLength: 5, maxLength: 5 }),
        array(integer({ min: 0, max: Math.min(total, 2) }), { minLength: 5, maxLength: 5 }),
      ).map(([mins, maxes, costs]) => ({ total, mins, maxes, costs })),
    );

    assert(
      property(caseArb, ({ total, mins, maxes, costs }) => {
        const raw = {
          total,
          min: countsFromTuple(mins.map((count, i) => Math.min(count, maxes[i] ?? 0))),
          max: countsFromTuple(maxes.map((count, i) => Math.max(count, mins[i] ?? 0))),
        };
        const rawHands = enumerateHands(total, raw);
        if (rawHands.length === 0) return;
        const bounds = unwrap(normalizeBounds(raw));
        const feasibleHands = enumerateHands(total, bounds);
        expect(feasibleHands.map(key).toSorted()).toEqual(rawHands.map(key).toSorted());
        const cost = countsFromTuple(costs);
        const canPay = feasibleHands.some((hand) =>
          costs.every((count, i) => (hand[i] ?? 0) >= count),
        );
        const affordable = canAfford(bounds, cost);
        expect(affordable).toEqual({ ok: true, value: canPay });

        const lost = loseKnown(bounds, cost);
        expect(lost.ok).toBe(canPay);
        const expectedHands = feasibleHands
          .filter((hand) => costs.every((count, i) => (hand[i] ?? 0) >= count))
          .map((hand) => hand.map((count, i) => count - (costs[i] ?? 0)))
          .map(key)
          .toSorted();
        const actualHands = lost.ok
          ? enumerateHands(lost.value.total, lost.value).map(key).toSorted()
          : [];
        expect(actualHands).toEqual(expectedHands);
      }),
      { numRuns: 2_000 },
    );
  });

  test('rejects mixed costs that maxima alone would accept', () => {
    const bounds = createResourceBounds(
      5,
      countsFromTuple([0, 0, 0, 0, 3]),
      countsFromTuple([2, 2, 0, 0, 3]),
    );
    expect(bounds.ok).toBe(true);
    if (!bounds.ok) return;
    const impossibleMixedCost = countsFromTuple([2, 2, 0, 0, 0]);
    expect(canAfford(bounds.value, impossibleMixedCost)).toEqual({ ok: true, value: false });
  });

  test('keeps immutable inputs untouched while applying known and hidden changes', () => {
    const initial = createResourceBounds(
      3,
      countsFromTuple([1, 0, 0, 0, 2]),
      countsFromTuple([1, 0, 0, 0, 2]),
    );
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const before = structuredClone(initial.value);
    const gained = gainHidden(initial.value, 2);
    expect(gained.ok).toBe(true);
    const lost = loseKnown(initial.value, countsFromTuple([1, 0, 0, 0, 1]));
    expect(lost.ok).toBe(true);
    expect(initial.value).toEqual(before);
  });
});
