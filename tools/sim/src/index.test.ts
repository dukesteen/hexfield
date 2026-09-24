import { expect, test } from 'vitest';
import { SIM_PLACEHOLDER } from './index.js';

test('simulation placeholder loads', () => {
  expect(SIM_PLACEHOLDER).toContain('pending');
});
