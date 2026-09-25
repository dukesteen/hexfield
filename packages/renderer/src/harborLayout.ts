import type { Point } from '@cp2p/engine/geometry';

export interface HarborLayout {
  readonly midpoint: Point;
  readonly angle: number;
  readonly scale: number;
  readonly verticalFlip: 1 | -1;
  readonly hub: Point;
}

/** Align the jetty's SVG shoreline points exactly with a board edge's endpoints. */
export function harborLayout(first: Point, second: Point, landCenter: Point): HarborLayout | null {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const edgeLength = Math.hypot(dx, dy);
  if (edgeLength === 0) return null;
  const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  const landNormal = { x: midpoint.x - landCenter.x, y: midpoint.y - landCenter.y };
  const normalLength = Math.hypot(landNormal.x, landNormal.y);
  if (normalLength === 0) return null;
  const scale = edgeLength / 96;
  const angle = Math.atan2(dy, dx);
  const outward = { x: landNormal.x / normalLength, y: landNormal.y / normalLength };
  const sourceNormal = { x: Math.sin(angle), y: -Math.cos(angle) };
  const verticalFlip = sourceNormal.x * outward.x + sourceNormal.y * outward.y >= 0 ? 1 : -1;
  return {
    midpoint,
    angle,
    scale,
    verticalFlip,
    hub: {
      x: midpoint.x + outward.x * 76 * scale,
      y: midpoint.y + outward.y * 76 * scale,
    },
  };
}

/** Transform a point from the authored 128×112 jetty SVG into board pixels. */
export function harborPoint(layout: HarborLayout, x: number, y: number): Point {
  const localX = (x - 64) * layout.scale;
  const localY = (y - 104) * layout.scale * layout.verticalFlip;
  return {
    x: layout.midpoint.x + localX * Math.cos(layout.angle) - localY * Math.sin(layout.angle),
    y: layout.midpoint.y + localX * Math.sin(layout.angle) + localY * Math.cos(layout.angle),
  };
}
