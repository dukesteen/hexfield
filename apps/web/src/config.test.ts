// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import { APP_NAME, APP_VERSION } from './config';

test('web app exposes its placeholder identity', () => {
  expect(APP_NAME).toBe('Hexfield');
  expect(APP_VERSION).toBe('0.0.0');
});
