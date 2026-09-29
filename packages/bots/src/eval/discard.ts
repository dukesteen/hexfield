import { handScore } from './trade.js';
import type { HandContext } from './trade.js';

type Counts = Readonly<Record<string, number>>;

/**
 * Choose `count` cards to give up, keeping the ones closest to completing the goal: one card at a
 * time, drop the card whose loss costs the hand least. Returns counts over every kind in the hand.
 */
export function chooseDiscard(
  hand: Counts,
  count: number,
  context: HandContext,
): Record<string, number> {
  const kinds = Object.keys(hand).toSorted();
  const left: Record<string, number> = { ...hand };
  const dropped: Record<string, number> = Object.fromEntries(kinds.map((kind) => [kind, 0]));
  // Discarding leaves the hand below the seven limit, so the discard risk no longer applies.
  const scoring: HandContext = { ...context, safeCards: Infinity };
  for (let n = 0; n < count; n++) {
    const base = handScore(left, scoring);
    let best: string | null = null;
    let bestLoss = Infinity;
    for (const kind of kinds) {
      const held = left[kind] ?? 0;
      if (held === 0) continue;
      const loss = base - handScore({ ...left, [kind]: held - 1 }, scoring);
      // Ties keep the rarer card: give up the kind held most.
      if (
        loss < bestLoss - 1e-9 ||
        (Math.abs(loss - bestLoss) <= 1e-9 && best !== null && held > (left[best] ?? 0))
      ) {
        best = kind;
        bestLoss = loss;
      }
    }
    if (best === null) break;
    left[best] = (left[best] ?? 0) - 1;
    dropped[best] = (dropped[best] ?? 0) + 1;
  }
  return dropped;
}
