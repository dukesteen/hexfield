import { expect, test } from 'vitest';
import { PACKAGE_NAME } from './index.js';

test('p2p package loads', () => {
  expect(PACKAGE_NAME).toBe('@cp2p/p2p');
});
