import { expect, test } from 'vitest';
import { PACKAGE_NAME } from './index.js';

test('crypto package loads', () => {
  expect(PACKAGE_NAME).toBe('@cp2p/crypto');
});
