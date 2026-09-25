import { expect, test } from 'vitest';
import { placePlacementConfirmation } from './placement-confirmation-layout';

test('placement confirmation stays near a target and inside the visible board after pan', () => {
  const desktop = { left: 100, top: 50, width: 900, height: 500 };
  expect(
    placePlacementConfirmation(
      desktop,
      { x: 450, y: 300 },
      { width: 220, height: 120 },
      { width: 1440, height: 900 },
    ),
  ).toEqual({ x: 364, y: 190 });
  const phone = { left: 0, top: 80, width: 390, height: 360 };
  const popup = { width: 220, height: 150 };
  const placed = placePlacementConfirmation(phone, { x: 195, y: 250 }, popup, {
    width: 390,
    height: 844,
  });
  expect(placed.x).toBeGreaterThanOrEqual(8);
  expect(placed.x + popup.width).toBeLessThanOrEqual(phone.width - 8);
  expect(placed.y).toBeGreaterThanOrEqual(8);
  expect(placed.y + popup.height).toBeLessThanOrEqual(phone.height - 8);
  expect(placed).toEqual({ x: 85, y: 184 });
  const scrolledBoard = { left: 80, top: 200, width: 800, height: 900 };
  const nearViewportBottom = placePlacementConfirmation(
    scrolledBoard,
    { x: 400, y: 640 },
    { width: 220, height: 120 },
    { width: 1280, height: 700 },
  );
  expect(nearViewportBottom.y).toBe(372);
  expect(scrolledBoard.top + nearViewportBottom.y + 120).toBeLessThanOrEqual(700 - 8);
  const square = { left: 0, top: 0, width: 500, height: 500 };
  const size = { width: 200, height: 100 };
  const viewport = { width: 500, height: 500 };
  expect(placePlacementConfirmation(square, { x: -100, y: 200 }, size, viewport).x).toBe(8);
  expect(placePlacementConfirmation(square, { x: 600, y: 200 }, size, viewport).x).toBe(292);
  expect(
    placePlacementConfirmation(
      desktop,
      { x: 450, y: 300 },
      { width: 220, height: 120 },
      { width: 1440, height: 900 },
      64,
    ).x,
  ).toBe(414);
});
