import { create } from 'zustand';
import type { Seat } from '@cp2p/engine';

/**
 * A count the screen has not caught up with yet: cards still flying into a seat (`delta` > 0,
 * shown once they land) or waiting to leave it (`delta` < 0, dropped as they take off). The
 * displayed count is the true count less every live hold, so releasing all of them always
 * settles on the state. `kind` is null for a card back, which only moves the public total.
 */
export interface CountHold {
  readonly id: string;
  readonly seat: Seat;
  readonly kind: string | null;
  readonly delta: number;
  /** A safety deadline: a hold never outlives its flight by much, whatever happens to it. */
  readonly expiresAt: number;
  /** Waits on the thief turning over a stolen card, not on a flight: new flights keep it. */
  readonly pinned?: boolean;
}

/** The hand a seat's screen shows while cards are still in the air. */
export function heldHand(
  hand: Readonly<Record<string, number>>,
  holds: readonly CountHold[],
  seat: Seat,
): Record<string, number> {
  const shown: Record<string, number> = { ...hand };
  for (const hold of holds)
    if (hold.seat === seat && hold.kind !== null)
      shown[hold.kind] = (shown[hold.kind] ?? 0) - hold.delta;
  for (const kind of Object.keys(shown)) shown[kind] = Math.max(0, shown[kind] ?? 0);
  return shown;
}

/** A seat's public card total while cards are still in the air. */
export function heldTotal(total: number, holds: readonly CountHold[], seat: Seat): number {
  let shown = total;
  for (const hold of holds) if (hold.seat === seat) shown -= hold.delta;
  return Math.max(0, shown);
}

interface CardHoldStore {
  holds: readonly CountHold[];
  add: (holds: readonly CountHold[]) => void;
  release: (ids: readonly string[]) => void;
  /** Drop holds past their deadline. */
  prune: (now: number) => void;
  /** Drop every hold, or all but the pinned ones. */
  clear: (keepPinned?: boolean) => void;
}

const NO_HOLDS: readonly CountHold[] = [];

export const useCardHolds = create<CardHoldStore>((set) => ({
  holds: NO_HOLDS,
  add: (incoming) => {
    if (incoming.length > 0) set((store) => ({ holds: [...store.holds, ...incoming] }));
  },
  release: (ids) => {
    if (ids.length === 0) return;
    const gone = new Set(ids);
    set((store) =>
      store.holds.some((hold) => gone.has(hold.id))
        ? { holds: store.holds.filter((hold) => !gone.has(hold.id)) }
        : store,
    );
  },
  prune: (now) =>
    set((store) =>
      store.holds.some((hold) => hold.expiresAt <= now)
        ? { holds: store.holds.filter((hold) => hold.expiresAt > now) }
        : store,
    ),
  clear: (keepPinned = false) =>
    set((store) => {
      if (store.holds.length === 0) return store;
      if (!keepPinned) return { holds: NO_HOLDS };
      const kept = store.holds.filter((hold) => hold.pinned);
      return kept.length === store.holds.length ? store : { holds: kept };
    }),
}));

/** The hand to draw for a seat: its true counts less the cards still flying. */
export function useHeldHand(
  seat: Seat | null,
  hand: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> | undefined {
  const holds = useCardHolds((store) => store.holds);
  if (!hand || seat === null || holds.length === 0) return hand;
  return heldHand(hand, holds, seat);
}

/** A seat's public card total to draw: its true total less the cards still flying. */
export function useHeldTotal(seat: Seat, total: number): number {
  const holds = useCardHolds((store) => store.holds);
  return holds.length === 0 ? total : heldTotal(total, holds, seat);
}
