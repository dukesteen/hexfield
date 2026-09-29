import type { ShipVariant } from './shipVariant.js';

/**
 * Where each ship SVG (40×38) is pinned to its edge midpoint, as fractions of the art. A hull
 * seen side on (1, 3, 5, 6) is pinned at its own centre, which differs with the heading, so the
 * hull lies on the edge line. A hull seen end on (2, 4) is foreshortened and its sail stands
 * above it, so the whole silhouette is centred on the midpoint instead: it then keeps clear of
 * the buildings at both ends of the vertical edge.
 */
const ANCHORS: Readonly<Record<ShipVariant, { readonly x: number; readonly y: number }>> = {
  1: { x: 0.475, y: 0.59 },
  2: { x: 0.5, y: 0.45 },
  3: { x: 0.475, y: 0.61 },
  4: { x: 0.5, y: 0.45 },
  5: { x: 0.52, y: 0.59 },
  6: { x: 0.53, y: 0.61 },
};

export function shipAnchor(variant: ShipVariant): { readonly x: number; readonly y: number } {
  return ANCHORS[variant];
}
