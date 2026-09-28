import type { EngineEffect } from '../../../core/effects/index.js';
import type { PrivateState } from '../../../core/state/index.js';
import { failure, success } from '../../../core/types/index.js';
import type { CardCounts, Result } from '../../../core/types/index.js';
import { privateExchange } from '../../base/shared.js';

/**
 * Apply the publicly known card movements of a transition (`resource-transfer` effects) to one
 * seat's private hand. Every handler whose only hand changes are known payments, bank takings or
 * explicit seat-to-seat transfers uses this, so its private side cannot drift from its effects.
 */
export function creditKnown(
  priv: PrivateState,
  effects: readonly EngineEffect[],
): Result<PrivateState> {
  let next = priv;
  for (const effect of effects) {
    if (effect.type !== 'resource-transfer') continue;
    const gained = effect.to.kind === 'seat' && effect.to.seat === priv.seat;
    const lost = effect.from.kind === 'seat' && effect.from.seat === priv.seat;
    if (gained === lost) continue;
    const moved = privateExchange(next, { [effect.resource]: effect.count }, gained);
    if (!moved.ok) return moved;
    next = moved.value;
  }
  return success(next);
}

/** Cards named by private data: `{ [kind]: count }`, or undefined when the data lacks them. */
export function privateCards(value: unknown, kinds: readonly string[]): Result<CardCounts> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return failure('missing-private-cards', 'Owner must know which cards moved');
  const counts: Record<string, number> = {};
  for (const [kind, count] of Object.entries(value)) {
    if (
      !kinds.includes(kind) ||
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 0
    )
      return failure('invalid-private-cards', 'Private cards must be non-negative kind counts');
    counts[kind] = count;
  }
  return success(counts);
}
