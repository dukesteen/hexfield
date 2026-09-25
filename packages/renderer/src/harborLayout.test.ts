import { describe, expect, it } from 'vitest';
import { harborLayout, harborPoint } from './harborLayout.js';

describe('harbor jetty layout', () => {
  it('connects the authored jetty endpoints exactly to edge vertices', () => {
    const first = { x: -23.4, y: 27 };
    const second = { x: 23.4, y: 27 };
    const layout = harborLayout(first, second, { x: 0, y: 0 });
    expect(layout).not.toBeNull();
    if (!layout) throw new Error('Expected valid harbor layout');
    expect(harborPoint(layout, 16, 104)).toEqual(first);
    expect(harborPoint(layout, 112, 104)).toEqual(second);
    expect(layout.hub.x).toBeCloseTo(0);
    expect(layout.hub.y).toBeGreaterThan(27);
  });

  it('orients the hub offshore for a rotated edge and rejects degenerate edges', () => {
    const first = { x: 0, y: -27 };
    const second = { x: 23.4, y: -13.5 };
    const landCenter = { x: 0, y: 0 };
    const layout = harborLayout(first, second, landCenter);
    expect(layout).not.toBeNull();
    if (!layout) throw new Error('Expected valid harbor layout');
    expect(harborPoint(layout, 16, 104).x).toBeCloseTo(first.x);
    expect(harborPoint(layout, 16, 104).y).toBeCloseTo(first.y);
    expect(harborPoint(layout, 112, 104).x).toBeCloseTo(second.x);
    expect(harborPoint(layout, 112, 104).y).toBeCloseTo(second.y);
    expect(layout.hub.y).toBeLessThan(first.y);
    expect(harborLayout(first, first, landCenter)).toBeNull();
  });

  it('keeps the authored hub at the offshore junction for all six coast directions and endpoint orders', () => {
    for (let direction = 0; direction < 6; direction += 1) {
      const angle = (direction * Math.PI) / 3;
      const tangent = { x: Math.cos(angle), y: Math.sin(angle) };
      const outward = { x: Math.sin(angle), y: -Math.cos(angle) };
      const midpoint = { x: 14 * direction, y: -9 * direction };
      const halfLength = 27;
      const first = {
        x: midpoint.x - tangent.x * halfLength,
        y: midpoint.y - tangent.y * halfLength,
      };
      const second = {
        x: midpoint.x + tangent.x * halfLength,
        y: midpoint.y + tangent.y * halfLength,
      };
      const landCenter = {
        x: midpoint.x - outward.x * 54,
        y: midpoint.y - outward.y * 54,
      };

      for (const [start, end] of [
        [first, second],
        [second, first],
      ] as const) {
        const layout = harborLayout(start, end, landCenter);
        expect(layout).not.toBeNull();
        if (!layout) throw new Error('Expected valid harbor layout');

        expect(harborPoint(layout, 16, 104).x).toBeCloseTo(start.x);
        expect(harborPoint(layout, 16, 104).y).toBeCloseTo(start.y);
        expect(harborPoint(layout, 112, 104).x).toBeCloseTo(end.x);
        expect(harborPoint(layout, 112, 104).y).toBeCloseTo(end.y);
        expect(harborPoint(layout, 64, 28).x).toBeCloseTo(layout.hub.x);
        expect(harborPoint(layout, 64, 28).y).toBeCloseTo(layout.hub.y);
        expect(
          (layout.hub.x - midpoint.x) * outward.x + (layout.hub.y - midpoint.y) * outward.y,
        ).toBeGreaterThan(0);
        const markerScale = (54 * 0.96) / 64;
        for (const [x, y] of [
          [51, 48.2],
          [76.8, 48.2],
        ] as const) {
          const armEnd = harborPoint(layout, x, y);
          const localX = armEnd.x - layout.hub.x;
          const localY = armEnd.y - layout.hub.y;
          expect(Math.abs(localX)).toBeLessThan(21 * markerScale);
          expect(localY).toBeGreaterThan(-23 * markerScale);
          expect(localY).toBeLessThan(15 * markerScale);
        }
      }
    }
  });
});
