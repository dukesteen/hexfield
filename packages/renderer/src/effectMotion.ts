import type { Point } from '@cp2p/engine/geometry';

export const DICE_ROLL_DURATION_MS = 1400;
export const PRODUCTION_TOKEN_PULSE_MS = 1200;

/** Pulse progress begins only after the dice have finished. */
export function productionPulseProgress(elapsedMs: number): number | null {
  if (elapsedMs < DICE_ROLL_DURATION_MS) return null;
  return Math.min(1, (elapsedMs - DICE_ROLL_DURATION_MS) / PRODUCTION_TOKEN_PULSE_MS);
}

export interface DiceMotion {
  readonly alpha: number;
  readonly rotation: number;
  readonly scale: number;
}

/** A short settle animation with a readable final face. */
export function diceMotion(progress: number): DiceMotion {
  const t = Math.max(0, Math.min(1, progress));
  const fadeIn = Math.min(1, t / 0.12);
  const fadeOut = Math.min(1, (1 - t) / 0.12);
  const tumble = t < 0.55 ? Math.sin(t * 9 * Math.PI) * (1 - t / 0.55) : 0;
  return {
    alpha: Math.min(fadeIn, fadeOut),
    rotation: tumble * 0.2,
    scale: 0.9 + t * 0.1,
  };
}

/** Lift, hold, and settle a producing number token without changing its ground position. */
export function productionTokenMotion(progress: number): number {
  const t = Math.max(0, Math.min(1, progress));
  if (t < 0.25) {
    const rise = t / 0.25;
    return 1 - (1 - rise) ** 3;
  }
  if (t < 0.7) return 1;
  const fall = (t - 0.7) / 0.3;
  return 1 - fall * fall * (3 - 2 * fall);
}

/** Cubic-eased, shallow arc used by the robber token. */
export function robberPosition(start: Point, end: Point, progress: number, arc: number): Point {
  const t = Math.max(0, Math.min(1, progress));
  const eased = t * t * (3 - 2 * t);
  return {
    x: start.x + (end.x - start.x) * eased,
    y: start.y + (end.y - start.y) * eased - Math.sin(Math.PI * t) * arc,
  };
}
