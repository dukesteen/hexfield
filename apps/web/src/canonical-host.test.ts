import { expect, test } from 'vitest';
import { canonicalUrl } from './canonical-host';

test('a www address moves to the bare domain, keeping path and hash route', () => {
  expect(
    canonicalUrl({
      href: 'https://www.playhexfield.com/#/join?code=abc',
      hostname: 'www.playhexfield.com',
    }),
  ).toBe('https://playhexfield.com/#/join?code=abc');
});

test('the bare domain and local development stay where they are', () => {
  expect(
    canonicalUrl({ href: 'https://playhexfield.com/', hostname: 'playhexfield.com' }),
  ).toBeNull();
  expect(canonicalUrl({ href: 'http://127.0.0.1:5187/', hostname: '127.0.0.1' })).toBeNull();
});
