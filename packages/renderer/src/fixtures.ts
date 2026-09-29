import { Graphics } from 'pixi.js';
import type { Point } from '@cp2p/engine/geometry';
import { hexToPixel } from '@cp2p/engine/geometry';
import { hexUnionLoops } from './boardShape.js';
import type { RenderFixture } from './types.js';

// Pixi Graphics.fill() is a drawing method; this rule's Array.fill suggestion is a false positive.
/* oxlint-disable unicorn/no-array-fill-with-reference-type */

/** The pale edge line drawn around every board tile. */
export const TILE_EDGE = 0xf5f8f5;

/** Pixel centres of a fixture's footprint cells, anchor first. */
export function fixtureCenters(fixture: RenderFixture, hexSize: number): Point[] {
  return fixture.footprint.map(({ q, r }) => hexToPixel(q, r, hexSize));
}

/** Axis-aligned world bounds that contain every fixture cell. */
export function fixtureBounds(
  fixtures: readonly RenderFixture[],
  hexSize: number,
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  const centers = fixtures.flatMap((fixture) => fixtureCenters(fixture, hexSize));
  if (centers.length === 0) return null;
  return {
    minX: Math.min(...centers.map((point) => point.x)) - hexSize,
    maxX: Math.max(...centers.map((point) => point.x)) + hexSize,
    minY: Math.min(...centers.map((point) => point.y)) - hexSize,
    maxY: Math.max(...centers.map((point) => point.y)) + hexSize,
  };
}

function insideHex(point: Point, center: Point, size: number): boolean {
  const x = Math.abs(point.x - center.x);
  const y = Math.abs(point.y - center.y);
  return x <= (Math.sqrt(3) * size) / 2 && y <= size && x + Math.sqrt(3) * y <= Math.sqrt(3) * size;
}

/** The id of the fixture whose footprint contains the world point, if any. */
export function hitTestFixture(
  point: Point,
  fixtures: readonly RenderFixture[],
  hexSize: number,
): string | null {
  for (const fixture of fixtures)
    if (fixtureCenters(fixture, hexSize).some((center) => insideHex(point, center, hexSize)))
      return fixture.id;
  return null;
}

/** Hex ids covered by fixture art. No sea tile is drawn on them, so the art shows. */
export function fixtureCellIds(fixtures: readonly RenderFixture[]): Set<string> {
  return new Set(fixtures.flatMap((fixture) => fixture.footprint.map(({ q, r }) => `h:${q},${r}`)));
}

function hexCorners(center: Point, size: number): number[] {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 180) * (60 * index - 90);
    return [center.x + size * Math.cos(angle), center.y + size * Math.sin(angle)];
  }).flat();
}

/**
 * Generic original art for a two-hex fixture: a timber track across both cells with a
 * printed path from the outer end to the anchor. Modules may register their own art.
 */
export function drawDefaultFixture(
  fixture: RenderFixture,
  hexSize: number,
  theme: 'light' | 'dark',
): Graphics {
  const graphics = new Graphics();
  const centers = fixtureCenters(fixture, hexSize);
  const board = theme === 'dark' ? 0x6b5236 : 0x9c7a4f;
  const edge = theme === 'dark' ? 0x3b2c1c : 0x5d4630;
  for (const center of centers)
    graphics
      .poly(hexCorners(center, hexSize * 0.97), true)
      .fill({ color: board })
      .stroke({ color: edge, width: hexSize * 0.05 });
  const outer = centers.at(-1);
  const anchor = centers[0];
  if (outer && anchor) {
    const steps = 7;
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const x = outer.x + (anchor.x - outer.x) * t;
      const y = outer.y + (anchor.y - outer.y) * t;
      graphics
        .circle(x, y, hexSize * (step === steps ? 0.16 : 0.09))
        .fill({ color: step === steps ? 0xc2493a : 0xf2ebd8 })
        .stroke({ color: edge, width: hexSize * 0.025 });
    }
  }
  return graphics;
}

/**
 * The outline of a fixture's footprint in the pale line every board tile has, so the fixture
 * reads as tiles of the board. The line runs around the whole footprint, not between its cells.
 */
export function drawFixtureOutline(fixture: RenderFixture, hexSize: number): Graphics {
  const graphics = new Graphics();
  for (const loop of hexUnionLoops(fixture.footprint, hexSize)) graphics.poly(loop, true);
  return graphics.stroke({ color: TILE_EDGE, width: 1.5 });
}
