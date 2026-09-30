import { create } from 'zustand';
import type { Seat } from '@cp2p/engine';

/** A point on screen a revealed card flies from. */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * One steal the thief watches turn over in the steal sheet. `picked` is the face-down card the
 * thief tapped: it is cosmetic only. It never reaches a command, a protocol message or the game
 * state; the card stolen is the one the fair random draw produced (`face`, known once the result
 * reached this client), shown on whichever back was tapped.
 */
export interface StealReveal {
  readonly id: string;
  readonly thief: Seat;
  readonly victim: Seat;
  /** The victim's public card total before the steal: how many backs to draw. */
  readonly handSize: number;
  readonly picked: number | null;
  /** The stolen kind, or null until the fair result arrives. */
  readonly face: string | null;
  /** Fly the revealed card from the sheet into the hand; null point means no flight. */
  readonly launch: ((from: ScreenPoint | null) => void) | null;
}

/** A fair steal result the visual effects hand to the sheet instead of flying it at once. */
export interface StealOffer {
  readonly thief: Seat;
  readonly victim: Seat;
  readonly handSize: number;
  readonly face: string;
  readonly launch: (from: ScreenPoint | null) => void;
}

interface StealRevealStore {
  /** The steal the sheet shows now. */
  active: StealReveal | null;
  /** Results that arrived while another was on show (a Bishop robs several seats), in order. */
  queue: readonly StealReveal[];
  /** The last steal into this hand that no sheet showed, for the screen-reader announcement. */
  announced: { readonly id: string; readonly victim: Seat; readonly face: string } | null;
  /** Show the victim's backs before the steal is submitted (the robber or pirate). */
  open: (thief: Seat, victim: Seat, handSize: number) => void;
  /** Tap a back. Only the sheet's own animation reads the index. */
  pick: (index: number) => void;
  /** Undo a tap whose steal could not be submitted, so the thief may tap again. */
  unpick: () => void;
  /**
   * Take a fair result for the sheet: it fills the open steal of that victim, or, when `queue` is
   * set (the thief picks cards), waits its turn. False means no sheet shows it: it flies at once.
   */
  offer: (offer: StealOffer, queue: boolean) => boolean;
  /** Close the shown steal and return it; the next queued one opens. */
  finish: () => StealReveal | null;
  announce: (id: string, victim: Seat, face: string) => void;
  reset: () => void;
}

let nextId = 0;
const newId = () => `steal-reveal-${++nextId}`;

export const useStealReveal = create<StealRevealStore>((set, get) => ({
  active: null,
  queue: [],
  announced: null,
  open: (thief, victim, handSize) =>
    set({
      active: { id: newId(), thief, victim, handSize, picked: null, face: null, launch: null },
    }),
  pick: (index) => {
    const active = get().active;
    if (!active || active.picked !== null) return;
    if (!Number.isSafeInteger(index) || index < 0 || index >= active.handSize) return;
    set({ active: { ...active, picked: index } });
  },
  unpick: () => {
    const active = get().active;
    if (active && active.face === null && active.picked !== null)
      set({ active: { ...active, picked: null } });
  },
  offer: (offer, queue) => {
    const { active } = get();
    if (
      active &&
      active.face === null &&
      active.thief === offer.thief &&
      active.victim === offer.victim
    ) {
      set({ active: { ...active, face: offer.face, launch: offer.launch } });
      return true;
    }
    if (!queue) return false;
    const reveal: StealReveal = {
      id: newId(),
      thief: offer.thief,
      victim: offer.victim,
      handSize: Math.max(1, offer.handSize),
      picked: null,
      face: offer.face,
      launch: offer.launch,
    };
    set((store) =>
      store.active ? { queue: [...store.queue, reveal] } : { active: reveal, queue: store.queue },
    );
    return true;
  },
  finish: () => {
    const { active, queue } = get();
    const [next, ...rest] = queue;
    set({ active: next ?? null, queue: rest });
    return active;
  },
  announce: (id, victim, face) => set({ announced: { id, victim, face } }),
  reset: () => {
    const { active, queue } = get();
    // Anything still on show lands at once, so no count stays held back.
    for (const reveal of [active, ...queue]) reveal?.launch?.(null);
    set({ active: null, queue: [] });
  },
}));

/** The most backs the sheet fans out; a bigger hand shows the rest as a count. */
export const STEAL_FAN_MAX = 12;
