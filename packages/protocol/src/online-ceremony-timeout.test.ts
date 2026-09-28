import { expect, test } from 'vitest';
import { ceremonyPhaseTimeoutMs } from './online-ceremony.js';

test('the deck phase budget scales with seats and cards; other phases stay fixed', () => {
  expect(ceremonyPhaseTimeoutMs('deck', 4, 25)).toBe(20_000);
  expect(ceremonyPhaseTimeoutMs('deck', 2, 25)).toBe(20_000);
  expect(ceremonyPhaseTimeoutMs('deck', 6, 34)).toBe(61_200);
  expect(ceremonyPhaseTimeoutMs('deck', 5, 34)).toBe(51_000);
  expect(ceremonyPhaseTimeoutMs('approvals', 6, 34)).toBe(20_000);
  expect(ceremonyPhaseTimeoutMs('seed-reveals', 6, 34)).toBe(20_000);
});
