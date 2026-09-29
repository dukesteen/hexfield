import { fixtureSlotProblem } from '../../core/board/index.js';
import { HEX_DIRECTIONS } from '../../core/geometry/index.js';
import type { BoardShapeSpec, FixtureSlot } from '../../core/modules/index.js';

/**
 * The place for a two-hex board fixture (the barbarian track of Cities and Knights) on a seafaring
 * board. A seafaring board lists every hex including the sea frame, so it has no fixed slot; the
 * fixture goes just outside the perimeter, straight out from a board hex. A spot is valid when
 * `fixtureSlotProblem` accepts it: its anchor touches the board, carries no harbor, and its outer
 * hex lies clear of the board. The first spot in reading order is used (north-most row first,
 * then closest to the middle of the board), so genesis stays a pure function of the board.
 * Returns null when the board has no valid spot.
 */
export function perimeterFixtureSlot(spec: BoardShapeSpec): FixtureSlot | null {
  if (spec.hexes.length === 0) return null;
  const middle = spec.hexes.reduce((sum, hex) => sum + hex.q + hex.r / 2, 0) / spec.hexes.length;
  const candidates: FixtureSlot[] = [];
  const seen = new Set<string>();
  for (const hex of spec.hexes)
    for (const step of HEX_DIRECTIONS) {
      const anchor = { q: hex.q + step.q, r: hex.r + step.r };
      const key = `${anchor.q},${anchor.r},${step.q},${step.r}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const slot = {
        id: 'perimeter',
        anchor,
        outer: { q: anchor.q + step.q, r: anchor.r + step.r },
      };
      if (fixtureSlotProblem(spec, slot) === null) candidates.push(slot);
    }
  const spread = (slot: FixtureSlot): number =>
    Math.abs(slot.anchor.q + slot.anchor.r / 2 - middle);
  return (
    candidates.toSorted(
      (a, b) => a.anchor.r - b.anchor.r || spread(a) - spread(b) || a.anchor.q - b.anchor.q,
    )[0] ?? null
  );
}
