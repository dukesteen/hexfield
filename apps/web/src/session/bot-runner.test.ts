import type { Seat } from '@cp2p/engine';
import { expect, test } from 'vitest';
import { hostedBotSeed } from './bot-runner.js';

test('a bot activated after opening gets one fresh seed and keeps it', () => {
  const opened = new Uint8Array(32).fill(7);
  const seeds = new Map<Seat, Uint8Array>([[1, opened]]);
  let calls = 0;
  const entropy = {
    randomBytes(target: Uint8Array) {
      calls += 1;
      target.fill(calls);
    },
  };
  expect(hostedBotSeed(seeds, 1, entropy)).toBe(opened);
  expect(calls).toBe(0);
  const recovered = hostedBotSeed(seeds, 0, entropy);
  expect(recovered).toHaveLength(32);
  expect(calls).toBe(1);
  expect(hostedBotSeed(seeds, 0, entropy)).toBe(recovered);
  expect(calls).toBe(1);
});
