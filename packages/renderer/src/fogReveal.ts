/**
 * One fog tile's flip over `t` from 0 to 1: it waits a beat, turns edge-on, and a ring glows out.
 * Before `t` reaches 0 nothing has started, so the fog still covers the hex.
 */
export function fogRevealShape(t: number): {
  flip: number;
  lift: number;
  rise: number;
  glow: number;
  glowScale: number;
} {
  const clamped = Math.min(1, Math.max(0, t));
  const turn = Math.min(1, Math.max(0, (clamped - 0.12) / 0.43));
  const eased = turn * turn * (3 - 2 * turn);
  const flip = Math.cos((eased * Math.PI) / 2);
  const ring = Math.min(1, Math.max(0, (clamped - 0.5) / 0.5));
  return {
    flip,
    lift: 1 + Math.sin(eased * Math.PI) * 0.06,
    rise: Math.sin(eased * Math.PI) * 0.05,
    glow: Math.sin(ring * Math.PI) * 0.9,
    glowScale: 1 + ring * 0.12,
  };
}
