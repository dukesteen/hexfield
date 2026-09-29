import { Container, Graphics } from 'pixi.js';
import type { Point } from '@cp2p/engine/geometry';
import { clipSegmentToLoops, growLoop, hexUnionLoops, loopArea } from './boardShape.js';

// Pixi Graphics.fill() is a drawing method; this rule's Array.fill suggestion is a false positive.
/* oxlint-disable unicorn/no-array-fill-with-reference-type */

/**
 * The wooden frame is the drawn hexes grown to 1.2 times their radius, as in the authored
 * standard-board frame (hexes of radius 96 around tiles of radius 80).
 */
export const FRAME_GROWTH = 0.2;
const FRAME_WOOD = 0x8a5f3f;
const FRAME_GRAIN = 0x7c5436;
const FRAME_SHADOW = 0x3b2a2e;
/** The authored frame's measurements, in its units of an 80-unit hex radius. */
const ART_HEX = 80;
const SHADOW_OFFSET = { x: 3, y: 5 } as const;
const GRAIN_SPACING = 18;
const GRAIN_SLOPE = 60 / 1400;
const GRAIN_PHASE = 12;
const GRAIN_WIDTH = 1.2;

/** The frame's outer outlines: the loops around the hexes, pushed out to the frame edge. */
export function boardFrameLoops(
  cells: readonly { readonly q: number; readonly r: number }[],
  hexSize: number,
): Point[][] {
  const distance = FRAME_GROWTH * hexSize * (Math.sqrt(3) / 2);
  return hexUnionLoops(cells, hexSize).map((loop) => growLoop(loop, distance));
}

function insideLoop(point: Point, loop: readonly Point[]): boolean {
  let inside = false;
  for (const [index, a] of loop.entries()) {
    const b = loop[(index + 1) % loop.length] ?? a;
    if (a.y > point.y !== b.y > point.y) {
      const x = a.x + ((point.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (x > point.x) inside = !inside;
    }
  }
  return inside;
}

/** Fills clockwise loops and cuts the anticlockwise ones inside them out as holes. */
function fillLoops(
  graphics: Graphics,
  loops: readonly (readonly Point[])[],
  style: { color: number; alpha?: number },
): void {
  const holes = loops.filter((loop) => loopArea(loop) < 0);
  for (const outer of loops) {
    if (loopArea(outer) <= 0) continue;
    graphics.poly([...outer], true).fill(style);
    for (const hole of holes) {
      const probe = hole[0];
      if (probe && insideLoop(probe, outer)) graphics.poly([...hole], true).cut();
    }
  }
}

/**
 * A wooden frame around any set of hexes: its drop shadow, the wood and its grain. The hexes
 * are drawn over it, so only the band outside them shows.
 */
export function drawBoardFrame(
  cells: readonly { readonly q: number; readonly r: number }[],
  hexSize: number,
): Container {
  const frame = new Container();
  frame.label = 'board-frame';
  const loops = boardFrameLoops(cells, hexSize);
  if (loops.length === 0) return frame;
  const unit = hexSize / ART_HEX;
  const shadow = new Graphics();
  fillLoops(shadow, loops, { color: FRAME_SHADOW, alpha: 0.25 });
  shadow.position.set(SHADOW_OFFSET.x * unit, SHADOW_OFFSET.y * unit);
  const wood = new Graphics();
  fillLoops(wood, loops, { color: FRAME_WOOD });

  const points = loops.flat();
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const spacing = GRAIN_SPACING * unit;
  const phase = GRAIN_PHASE * unit;
  // Grain lines sit on a lattice fixed to the board origin, like the authored art.
  const first = Math.floor((minY - phase - Math.max(minX, maxX) * GRAIN_SLOPE) / spacing);
  const last = Math.ceil((maxY - phase - Math.min(minX, maxX) * GRAIN_SLOPE) / spacing);
  const grain = new Graphics();
  for (let line = first; line <= last; line += 1) {
    const from = { x: minX, y: line * spacing + phase + minX * GRAIN_SLOPE };
    const to = { x: maxX, y: line * spacing + phase + maxX * GRAIN_SLOPE };
    for (const [start, end] of clipSegmentToLoops(from, to, loops))
      grain.moveTo(start.x, start.y).lineTo(end.x, end.y);
  }
  grain.stroke({ color: FRAME_GRAIN, width: GRAIN_WIDTH * unit, alpha: 0.6 });
  frame.addChild(shadow, wood, grain);
  return frame;
}
