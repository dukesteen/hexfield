import type { Seat } from '@cp2p/engine';

/** expiresAt uses the injected scheduler's local millisecond clock; null means paused. */
export interface SessionTimer {
  key: string;
  seat: Seat;
  phase: string;
  remainingMs: number;
  expiresAt: number | null;
  paused: boolean;
}
