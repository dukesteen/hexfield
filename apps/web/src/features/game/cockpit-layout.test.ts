// @vitest-environment happy-dom
import { afterEach, expect, test } from 'vitest';
import { formReturnFocus, inlineDevelopmentCardLimit } from './cockpit-layout.js';

afterEach(() => document.body.replaceChildren());

test('a narrow desktop keeps every development card in the drawer', () => {
  expect(inlineDevelopmentCardLimit(true)).toBe(0);
  expect(inlineDevelopmentCardLimit(false)).toBe(5);
});

test('a closed form returns focus to the tab whose sheet opened it', () => {
  const build = document.createElement('button');
  const trade = document.createElement('button');
  document.body.append(build, trade);
  expect(formReturnFocus(trade, build)).toBe(trade);
});

test('a closed form falls back to the Build tab when no tab handed off or it is gone', () => {
  const build = document.createElement('button');
  document.body.append(build);
  expect(formReturnFocus(null, build)).toBe(build);
  expect(formReturnFocus(document.createElement('button'), build)).toBe(build);
});
