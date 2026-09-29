import type { Point } from '@cp2p/engine/geometry';
import type { BoardEffect } from './types.js';

export const DICE_ROLL_DURATION_MS = 1400;
/** The dice stop tumbling and show their final faces: the production cards take off here. */
export const DICE_SETTLE_MS = 450;
/** The producing number tokens start to grow during the last tumble, so nothing waits on the dice. */
export const PRODUCTION_PULSE_START_MS = 300;
export const PRODUCTION_TOKEN_PULSE_MS = 1200;

/** Pulse progress, from the last tumble of the dice; null before it starts. */
export function productionPulseProgress(elapsedMs: number): number | null {
  if (elapsedMs < PRODUCTION_PULSE_START_MS) return null;
  return Math.min(1, (elapsedMs - PRODUCTION_PULSE_START_MS) / PRODUCTION_TOKEN_PULSE_MS);
}

export interface DiceMotion {
  readonly alpha: number;
  readonly rotation: number;
  readonly scale: number;
}

const DICE_SETTLE = DICE_SETTLE_MS / DICE_ROLL_DURATION_MS;

/** A short tumble that settles on a readable final face at `DICE_SETTLE_MS`, then fades. */
export function diceMotion(progress: number): DiceMotion {
  const t = Math.max(0, Math.min(1, progress));
  const fadeIn = Math.min(1, t / 0.12);
  const fadeOut = Math.min(1, (1 - t) / 0.12);
  // A wobble and a half that die away as the dice settle.
  const tumble =
    t < DICE_SETTLE ? Math.sin((t / DICE_SETTLE) * 3 * Math.PI) * (1 - t / DICE_SETTLE) : 0;
  return {
    alpha: Math.min(fadeIn, fadeOut),
    rotation: tumble * 0.2,
    scale: 0.9 + Math.min(1, t / DICE_SETTLE) * 0.1,
  };
}

/** Grow, hold, and shrink a number token around its center. */
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

export type EffectChannel = 'dice' | 'production' | 'robber' | 'pirate' | 'barbarian';

/** Effects that show one thing on the board: only the newest of a channel runs. */
export function effectChannel(kind: BoardEffect['kind']): EffectChannel | null {
  if (kind === 'dice-roll') return 'dice';
  if (kind === 'production-pulse') return 'production';
  if (kind === 'robber-move') return 'robber';
  if (kind === 'pirate-move') return 'pirate';
  if (kind === 'barbarian-sail' || kind === 'barbarian-attack') return 'barbarian';
  return null;
}
