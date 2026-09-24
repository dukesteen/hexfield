import { expect, test } from 'vitest';
import { PACKAGE_NAME } from './index.js';

test('maps package loads', () => {
  expect(PACKAGE_NAME).toBe('@cp2p/maps');
});
