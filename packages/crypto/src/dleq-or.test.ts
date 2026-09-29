import { describe, expect, test } from 'vitest';
import { G, encodePoint, hashToPoint, scalePoint } from './group.js';
import { proveDleqOr, verifyDleqOr } from './dleq-or.js';
import type { DleqOrStatement } from './dleq-or.js';

const SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 9);
const CONTEXT = { game: 'g', parent: 'p', seat: 2 };
const LOCK = 123456789n;

/** Card points P_j; the lock behind `B` locks the point at `index` into Z = b·P_index. */
function statement(index: number, count = 5, lock = LOCK): DleqOrStatement {
  const points = Array.from({ length: count }, (_, at) => hashToPoint('card', { at }));
  const z = scalePoint(points[index] ?? G, lock);
  const b = scalePoint(G, lock);
  return {
    branches: points.map((point) => ({
      base1: encodePoint(point),
      point1: encodePoint(z),
      base2: encodePoint(G),
      point2: encodePoint(b),
    })),
  };
}

describe('DLEQ OR', () => {
  test('proves and verifies every branch without revealing which one', () => {
    for (let known = 0; known < 5; known += 1) {
      const proof = proveDleqOr(statement(known), known, LOCK, SEED, CONTEXT);
      expect(verifyDleqOr(statement(known), proof, CONTEXT)).toBe(true);
      expect(proof.branches).toHaveLength(5);
    }
  });

  test('one branch is a plain Chaum-Pedersen proof', () => {
    const single = statement(0, 1);
    expect(verifyDleqOr(single, proveDleqOr(single, 0, LOCK, SEED, CONTEXT), CONTEXT)).toBe(true);
  });

  test('is deterministic for the same statement and seed', () => {
    const one = proveDleqOr(statement(2), 2, LOCK, SEED, CONTEXT);
    const two = proveDleqOr(statement(2), 2, LOCK, SEED, CONTEXT);
    expect(one).toEqual(two);
  });

  test('cannot be proven when no branch holds', () => {
    // Z is locked with another key than B, so no branch is a true equality.
    const wrong = statement(1);
    const forged: DleqOrStatement = {
      branches: wrong.branches.map((branch) => ({
        ...branch,
        point2: encodePoint(scalePoint(G, LOCK + 1n)),
      })),
    };
    for (let known = 0; known < 5; known += 1)
      expect(() => proveDleqOr(forged, known, LOCK, SEED, CONTEXT)).toThrow(/witness/);
  });

  test('rejects another context, statement, or altered proof', () => {
    const proof = proveDleqOr(statement(3), 3, LOCK, SEED, CONTEXT);
    expect(verifyDleqOr(statement(3), proof, { ...CONTEXT, seat: 3 })).toBe(false);
    expect(verifyDleqOr(statement(3, 5, LOCK + 1n), proof, CONTEXT)).toBe(false);
    const swapped = { branches: statement(3).branches.toReversed() };
    expect(verifyDleqOr(swapped, proof, CONTEXT)).toBe(false);
    const altered = {
      branches: proof.branches.map((branch, index) =>
        index === 0
          ? { ...branch, response: proof.branches[1]?.response ?? branch.response }
          : branch,
      ),
    };
    expect(verifyDleqOr(statement(3), altered, CONTEXT)).toBe(false);
    expect(verifyDleqOr(statement(3), { branches: proof.branches.slice(1) }, CONTEXT)).toBe(false);
    expect(verifyDleqOr(statement(3), { branches: [], extra: 1 }, CONTEXT)).toBe(false);
  });

  test('a lock that opens to a card outside the branch set has no valid proof', () => {
    // Z opens to card 3, but the statement only lists cards 0, 1 and 2.
    const inside = statement(3, 5);
    const outside: DleqOrStatement = { branches: inside.branches.slice(0, 3) };
    for (let known = 0; known < 3; known += 1)
      expect(() => proveDleqOr(outside, known, LOCK, SEED, CONTEXT)).toThrow(/witness/);
  });

  test('rejects an empty branch list', () => {
    expect(() => proveDleqOr({ branches: [] }, 0, LOCK, SEED, CONTEXT)).toThrow(/branches/);
    expect(verifyDleqOr({ branches: [] }, { branches: [] }, CONTEXT)).toBe(false);
  });
});
