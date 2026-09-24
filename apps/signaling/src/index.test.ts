import { expect, test } from 'vitest';
import { SIGNALING_PLACEHOLDER } from './index.js';

test('signaling placeholder loads', () => {
  expect(SIGNALING_PLACEHOLDER).toContain('pending');
});
