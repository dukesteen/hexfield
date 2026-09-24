import type { Seat } from '../types/index.js';

/** Derived UI descriptions. Events are never included in the replicated log. */
export type GameEvent =
  | { type: 'resourcesProduced'; bySeat: Record<string, Record<string, number>> }
  | { type: 'roadBuilt'; seat: Seat; edge: string }
  | { type: 'phaseChanged'; phase: string }
  | { type: 'gameEnded'; winner: Seat; reason: string }
  | { type: string; [key: string]: unknown };
