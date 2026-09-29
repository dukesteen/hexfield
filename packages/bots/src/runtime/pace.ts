import type { BotLevel, BotRng } from '../types.js';
import type { PlayerPending } from './messages.js';

/** How much thought a request deserves, as a multiple of the table's bot pace. */
export function decisionImportance(pending: PlayerPending): number {
  const allowed = new Set(pending.allowed);
  if (allowed.has('PLACE_SETTLEMENT')) return 1.8;
  if (allowed.has('MOVE_ROBBER') || allowed.has('MOVE_PIRATE')) return 1.5;
  if (allowed.has('DISCARD') || allowed.has('STEAL')) return 1.2;
  if (allowed.has('PLACE_ROAD') || allowed.has('PLACE_FREE_ROAD')) return 1.1;
  if (allowed.has('ROLL_DICE')) return 0.7;
  return 1;
}

/** True when the request is only an answer to someone else's trade offer. */
export function isTradeReply(pending: PlayerPending, activeSeat: number): boolean {
  return pending.seat !== activeSeat && pending.allowed.includes('RESPOND_TRADE');
}

/**
 * A humanlike delay before a bot acts: the table's pace scaled by how important the decision is,
 * with ±25% jitter (so a series of moves does not tick like a clock). A reply to a trade offer
 * always takes 1–3 s. Zero pace (tests, fast tables) stays zero.
 */
export function humanlikeDelay(
  paceMs: number,
  pending: PlayerPending,
  activeSeat: number,
  rng: BotRng,
  level: BotLevel = 'normal',
): number {
  if (paceMs <= 0) return 0;
  if (isTradeReply(pending, activeSeat)) return 1000 + rng.int(2001);
  // A searching bot is expected to think a little longer.
  const levelFactor = level === 'hard' ? 1.15 : 1;
  const jitter = 0.75 + rng.int(501) / 1000;
  return Math.round(paceMs * decisionImportance(pending) * levelFactor * jitter);
}
