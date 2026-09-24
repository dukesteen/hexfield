import { expect, test } from 'vitest';
import { RESOURCES } from '../types/index.js';
import { validateCounts, zeroCounts } from './counts.js';

test('base count validation rechecks mutable records and rejects malformed frozen records', () => {
  const mutable = zeroCounts(RESOURCES);
  expect(validateCounts(mutable, RESOURCES).ok).toBe(true);
  mutable.brick = -1;
  expect(validateCounts(mutable, RESOURCES)).toMatchObject({
    ok: false,
    error: { code: 'invalid-count' },
  });

  const frozen = Object.freeze(zeroCounts(RESOURCES));
  expect(validateCounts(frozen, RESOURCES).ok).toBe(true);
  expect(validateCounts(frozen, RESOURCES).ok).toBe(true);

  const accessor = Object.freeze(
    Object.defineProperty(zeroCounts(RESOURCES), 'brick', {
      get: () => 0,
      enumerable: true,
    }),
  );
  expect(validateCounts(accessor, RESOURCES)).toMatchObject({
    ok: false,
    error: { code: 'invalid-count-map' },
  });

  const extra = Object.freeze({ ...zeroCounts(RESOURCES), extra: 0 });
  expect(validateCounts(extra, RESOURCES)).toMatchObject({
    ok: false,
    error: { code: 'invalid-count-keys' },
  });
});
