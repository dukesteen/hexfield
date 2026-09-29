import { expect, test } from 'vitest';
import { scrollDeltaToReveal } from './player-rail-scroll';

const view = { left: 0, top: 0, right: 300, bottom: 400 };

test('a panel already in view needs no scroll', () => {
  expect(scrollDeltaToReveal(view, { left: 0, top: 100, right: 300, bottom: 200 })).toBeNull();
});

test('a panel below the sidebar scrolls down just far enough', () => {
  expect(scrollDeltaToReveal(view, { left: 0, top: 350, right: 300, bottom: 470 })).toEqual({
    x: 0,
    y: 70,
  });
});

test('a panel above the sidebar scrolls up to its top', () => {
  expect(scrollDeltaToReveal(view, { left: 0, top: -90, right: 300, bottom: 30 })).toEqual({
    x: 0,
    y: -90,
  });
});

test('a panel off the right of the phone strip scrolls sideways', () => {
  const strip = { left: 0, top: 0, right: 390, bottom: 80 };
  expect(scrollDeltaToReveal(strip, { left: 420, top: 0, right: 560, bottom: 80 })).toEqual({
    x: 170,
    y: 0,
  });
});

test('a panel wider than the strip aligns to its start', () => {
  const strip = { left: 0, top: 0, right: 100, bottom: 80 };
  expect(scrollDeltaToReveal(strip, { left: 40, top: 0, right: 180, bottom: 80 })).toEqual({
    x: 40,
    y: 0,
  });
});
