import { expect, test } from 'vitest';
import { sourceFingerprint } from './provenance.js';

test('source fingerprint is stable across repeated reads of the same tree', () => {
  const first = sourceFingerprint();
  expect(first).toMatch(/^[0-9a-f]{64}$/);
  expect(sourceFingerprint()).toBe(first);
});
