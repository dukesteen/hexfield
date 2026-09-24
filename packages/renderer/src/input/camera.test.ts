import { expect, test } from 'vitest';
import { clampCameraAxis } from './camera.js';

test('centers a board smaller than the viewport', () => {
  expect(clampCameraAxis(-900, -50, 50, 400, 1, 24)).toBe(200);
});

test('clamps a zoomed board to the visible margin at either edge', () => {
  expect(clampCameraAxis(-1000, -100, 100, 400, 2, 24)).toBe(176);
  expect(clampCameraAxis(1000, -100, 100, 400, 2, 24)).toBe(224);
});
