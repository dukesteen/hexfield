import type { Point } from '@cp2p/engine/geometry';

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
  const tumble = t < 0.68 ? Math.sin(t * 9 * Math.PI) * (1 - t / 0.68) : 0;
  return {
    alpha: Math.min(fadeIn, fadeOut),
    rotation: tumble * 0.2,
    scale: 0.9 + t * 0.1,
  };
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
