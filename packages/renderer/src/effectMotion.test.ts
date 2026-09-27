import { describe, expect, it } from 'vitest';
import {
  DICE_ROLL_DURATION_MS,
  PRODUCTION_TOKEN_PULSE_MS,
  diceMotion,
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

  it('lifts production tokens smoothly, holds them, then settles them', () => {
    expect(productionTokenMotion(0)).toBe(0);
    expect(productionTokenMotion(0.15)).toBeGreaterThan(0.5);
    expect(productionTokenMotion(0.4)).toBe(1);
    expect(productionTokenMotion(0.7)).toBe(1);
    expect(productionTokenMotion(0.85)).toBeCloseTo(0.5);
    expect(productionTokenMotion(1)).toBe(0);
  });

  it('starts the token pulse after the dice and finishes before card flights', () => {
    expect(productionPulseProgress(0)).toBeNull();
    expect(productionPulseProgress(DICE_ROLL_DURATION_MS - 1)).toBeNull();
    expect(productionPulseProgress(DICE_ROLL_DURATION_MS)).toBe(0);
    expect(productionPulseProgress(DICE_ROLL_DURATION_MS + PRODUCTION_TOKEN_PULSE_MS / 2)).toBe(
      0.5,
    );
    expect(productionPulseProgress(DICE_ROLL_DURATION_MS + PRODUCTION_TOKEN_PULSE_MS)).toBe(1);
  });
});
