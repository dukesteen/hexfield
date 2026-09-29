import { describe, expect, it } from 'vitest';
import {
  DICE_ROLL_DURATION_MS,
  DICE_SETTLE_MS,
  PRODUCTION_PULSE_START_MS,
  PRODUCTION_TOKEN_PULSE_MS,
  diceMotion,
  effectChannel,
  productionPulseProgress,
  productionTokenMotion,
  robberPosition,
} from './effectMotion.js';

describe('board effect motion', () => {
  it('settles the dice on the final face before fading out', () => {
    expect(diceMotion(0).alpha).toBe(0);
    expect(diceMotion(0.75).alpha).toBe(1);
    expect(diceMotion(0.75).rotation).toBe(0);
    expect(diceMotion(1).alpha).toBe(0);
  });

  it('reaches both robber endpoints with a raised midpoint trajectory', () => {
    const start = { x: 3, y: 5 };
    const end = { x: 27, y: 45 };
    expect(robberPosition(start, end, 0, 9)).toEqual(start);
    expect(robberPosition(start, end, 1, 9)).toEqual(end);
    const middle = robberPosition(start, end, 0.5, 9);
    expect(middle.x).toBe(15);
    expect(middle.y).toBe(16);
  });

  it('grows production tokens smoothly, holds them, then shrinks them', () => {
    expect(productionTokenMotion(0)).toBe(0);
    expect(productionTokenMotion(0.15)).toBeGreaterThan(0.5);
    expect(productionTokenMotion(0.4)).toBe(1);
    expect(productionTokenMotion(0.7)).toBe(1);
    expect(productionTokenMotion(0.85)).toBeCloseTo(0.5);
    expect(productionTokenMotion(1)).toBe(0);
  });

  it('starts the token pulse during the last tumble and lets it read', () => {
    expect(PRODUCTION_PULSE_START_MS).toBeLessThan(DICE_SETTLE_MS);
    expect(productionPulseProgress(0)).toBeNull();
    expect(productionPulseProgress(PRODUCTION_PULSE_START_MS - 1)).toBeNull();
    expect(productionPulseProgress(PRODUCTION_PULSE_START_MS)).toBe(0);
    expect(productionPulseProgress(PRODUCTION_PULSE_START_MS + PRODUCTION_TOKEN_PULSE_MS / 2)).toBe(
      0.5,
    );
    expect(productionPulseProgress(PRODUCTION_PULSE_START_MS + PRODUCTION_TOKEN_PULSE_MS)).toBe(1);
    // The tokens are at their largest a little after the dice settle, as the cards take off.
    const peak = PRODUCTION_PULSE_START_MS + PRODUCTION_TOKEN_PULSE_MS * 0.25;
    expect(peak).toBeGreaterThan(DICE_SETTLE_MS);
    expect(PRODUCTION_TOKEN_PULSE_MS).toBeGreaterThanOrEqual(1000);
  });

  it('shows the final faces, still, from the settle point on', () => {
    const settled = DICE_SETTLE_MS / DICE_ROLL_DURATION_MS;
    expect(diceMotion(settled / 2).rotation).not.toBe(0);
    expect(diceMotion(settled).rotation).toBe(0);
    expect(diceMotion(settled).alpha).toBe(1);
    expect(diceMotion(settled).scale).toBe(1);
  });

  it('runs one effect per channel: dice, pulse, robber, pirate, and the barbarian ship', () => {
    expect(effectChannel('dice-roll')).toBe('dice');
    expect(effectChannel('production-pulse')).toBe('production');
    expect(effectChannel('barbarian-sail')).toBe('barbarian');
    expect(effectChannel('barbarian-attack')).toBe('barbarian');
    expect(effectChannel('robber-move')).toBe('robber');
    expect(effectChannel('pirate-move')).toBe('pirate');
    expect(effectChannel('piece-pop')).toBeNull();
  });
});
