import { describe, expect, it } from 'vitest';
import { diceMotion, robberPosition } from './effectMotion.js';

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
});
