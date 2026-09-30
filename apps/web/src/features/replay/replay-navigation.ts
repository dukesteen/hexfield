import type { ReplayTimeline } from './replay-analysis.js';

/** The position right after the next 7 rolled after `position`, or null. */
export function nextSeven(timeline: ReplayTimeline, position: number): number | null {
  return timeline.sevens.find((seven) => seven > position) ?? null;
}

/** The first position of turn `turn`, or of the first later turn; null past the end. */
export function turnPosition(timeline: ReplayTimeline, turn: number): number | null {
  return timeline.turnStarts.find((start) => start.turn >= turn)?.position ?? null;
}

export function nextTurnStart(timeline: ReplayTimeline, position: number): number | null {
  return timeline.turnStarts.find((start) => start.position > position)?.position ?? null;
}

/** The start of the current turn, or of the previous one when already at a turn's start. */
export function previousTurnStart(timeline: ReplayTimeline, position: number): number {
  return timeline.turnStarts.findLast((start) => start.position < position)?.position ?? 0;
}

export function lastTurn(timeline: ReplayTimeline): number {
  return timeline.turnStarts.at(-1)?.turn ?? 0;
}
