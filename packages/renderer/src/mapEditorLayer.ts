import { Graphics } from 'pixi.js';
import type { Container } from 'pixi.js';
import { edgeToPixel, hexToPixel } from '@cp2p/engine/geometry';
import type { EdgeId, HexCoord } from '@cp2p/engine/geometry';
import type { RenderLayerContext, RenderLayerPlugin } from './types.js';

// Pixi's Graphics#fill takes a style object; it is not Array#fill.
/* oxlint-disable unicorn/no-array-fill-with-reference-type */

/** Plugin id; the editor passes its slice as `RenderModel.layers['map-editor']`. */
export const MAP_EDITOR_LAYER = 'map-editor';

/** What the map editor marks on the board. Hexes are given by coordinate. */
export interface MapEditorOverlay {
  /** Open water cells of the canvas, outlined faintly so the grid reads as paintable. */
  readonly grid?: readonly HexCoord[];
  /** Hexes whose corners allow setup settlements. */
  readonly setup?: readonly HexCoord[];
  /** Hexes and harbor edges named by a validation error. */
  readonly errors?: readonly HexCoord[];
  readonly errorEdges?: readonly EdgeId[];
  /** Hexes named by a validation warning. */
  readonly warnings?: readonly HexCoord[];
}

function corners(center: { x: number; y: number }, size: number): number[] {
  return Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 180) * (60 * index - 90);
    return [center.x + size * Math.cos(angle), center.y + size * Math.sin(angle)];
  }).flat();
}

function isOverlay(value: unknown): value is MapEditorOverlay {
  return typeof value === 'object' && value !== null;
}

function draw(target: Container, slice: unknown, context: RenderLayerContext): void {
  if (!isOverlay(slice)) return;
  const size = context.hexSize;
  const dark = context.theme === 'dark';
  const graphics = new Graphics();
  for (const { q, r } of slice.grid ?? [])
    graphics
      .poly(corners(hexToPixel(q, r, size), size * 0.9), true)
      .stroke({ color: 0xffffff, alpha: dark ? 0.16 : 0.26, width: 1.5 });
  for (const { q, r } of slice.setup ?? [])
    graphics
      .poly(corners(hexToPixel(q, r, size), size * 0.86), true)
      .fill({ color: 0x3fb4a6, alpha: 0.2 })
      .stroke({ color: 0x2f9d91, alpha: 0.95, width: 4 });
  for (const { q, r } of slice.warnings ?? [])
    graphics
      .poly(corners(hexToPixel(q, r, size), size * 0.78), true)
      .stroke({ color: 0xf0b64a, alpha: 0.95, width: 4 });
  for (const { q, r } of slice.errors ?? [])
    graphics
      .poly(corners(hexToPixel(q, r, size), size * 0.92), true)
      .fill({ color: 0xc2493a, alpha: 0.16 })
      .stroke({ color: 0xd8422f, alpha: 1, width: 5 });
  for (const edge of slice.errorEdges ?? []) {
    const { midpoint, angle } = edgeToPixel(edge, size);
    const dx = (Math.cos(angle) * size) / 2;
    const dy = (Math.sin(angle) * size) / 2;
    graphics
      .moveTo(midpoint.x - dx, midpoint.y - dy)
      .lineTo(midpoint.x + dx, midpoint.y + dy)
      .stroke({ color: 0xd8422f, alpha: 1, width: 7, cap: 'round' });
  }
  target.addChild(graphics);
}

/** The map editor's overlay: grid cells, setup areas and validation markers above the board. */
export function createMapEditorLayer(): RenderLayerPlugin {
  return { id: MAP_EDITOR_LAYER, band: 'overlay', zIndex: 0, draw };
}
