import { expect, test } from 'vitest';
import { PACKAGE_NAME } from './index.js';

test('bots package loads', () => {
  expect(PACKAGE_NAME).toBe('@cp2p/bots');
});
