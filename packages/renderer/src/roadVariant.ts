import type { EdgeId } from '@cp2p/engine/geometry';

/** Authored road SVGs follow the engine's NE, W, and NW edge directions. */
export function roadVariantForEdge(id: EdgeId): 0 | 1 | 2 {
  if (id.endsWith(',NE')) return 0;
  if (id.endsWith(',W')) return 1;
  return 2;
}
