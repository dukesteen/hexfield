import type { Point } from '@cp2p/engine/geometry';

/** Derive the numeral size from hex size so the complete token shares the camera scale. */
export function tokenFontSize(hexSize: number): number {
  return hexSize * 0.39;
}

/** Return pip centers in token-local board coordinates. */
export function tokenPips(token: number, hexSize: number): readonly Point[] {
  if (token === 7 || token < 2 || token > 12) return [];
  const count = Math.max(0, 6 - Math.abs(7 - token));
  if (count === 0) return [];
  const spacing = hexSize * 0.085;
  const firstX = -((count - 1) * spacing) / 2;
  return Array.from({ length: count }, (_, index) => ({
    x: firstX + index * spacing,
    y: hexSize * 0.2,
  }));
}

/** Keep pips proportional to the number disc as zoom and hex size change. */
export function tokenPipRadius(hexSize: number): number {
  return hexSize * 0.036;
}
