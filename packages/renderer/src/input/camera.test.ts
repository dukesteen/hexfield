import { expect, test } from 'vitest';
import { cameraPositionAtAnchor, clampCameraAxis } from './camera.js';

test('centers a board smaller than the viewport', () => {
  expect(clampCameraAxis(-900, -50, 50, 400, 1, 24)).toBe(200);
});

test('clamps a zoomed board to the visible margin at either edge', () => {
  expect(clampCameraAxis(-1000, -100, 100, 400, 2, 24)).toBe(176);
  expect(clampCameraAxis(1000, -100, 100, 400, 2, 24)).toBe(224);
});

test('keeps the world point under the previous pinch center under the new center', () => {
  const previousCamera = { x: -40, y: 20 };
  const previousZoom = 1.5;
  const previousCenter = { x: 120, y: 90 };
  const worldAnchor = {
    x: (previousCenter.x - previousCamera.x) / previousZoom,
    y: (previousCenter.y - previousCamera.y) / previousZoom,
  };
  const nextCenter = { x: 150, y: 110 };
  const nextCamera = cameraPositionAtAnchor(worldAnchor, nextCenter, 2.25);

  expect(nextCamera.x + worldAnchor.x * 2.25).toBe(nextCenter.x);
  expect(nextCamera.y + worldAnchor.y * 2.25).toBe(nextCenter.y);
});
