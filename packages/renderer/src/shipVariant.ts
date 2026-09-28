import type { EdgeId } from '@cp2p/engine/geometry';

/**
 * The six authored ship SVGs are hull headings in the art's dimetric view:
 * 1 southeast, 2 north, 3 northeast, 4 south, 5 southwest, 6 northwest.
 * An edge runs along one of three lines, so it can carry two headings. Canonical `NE` edges
 * descend to the right, `W` edges are vertical and `NW` edges rise to the right.
 */
const HEADINGS = {
  NE: [1, 6],
  W: [4, 2],
  NW: [3, 5],
} as const;

export type ShipVariant = 1 | 2 | 3 | 4 | 5 | 6;

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1)
    result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return result >>> 0;
}

/** The hull variant for a ship on an edge: its own line, with a stable choice of heading. */
export function shipVariantForEdge(id: EdgeId): ShipVariant {
  const headings = id.endsWith(',NE') ? HEADINGS.NE : id.endsWith(',W') ? HEADINGS.W : HEADINGS.NW;
  return headings[(hash(id) >>> 7) & 1] ?? headings[0];
}
