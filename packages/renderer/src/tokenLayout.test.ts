import { describe, expect, it } from 'vitest';
import { tokenFontSize, tokenPipRadius, tokenPips } from './tokenLayout.js';

describe('token layout', () => {
  it('scales every token mark with the board-space hex size', () => {
    expect(tokenFontSize(54)).toBeCloseTo(21.06);
    expect(tokenFontSize(54) / tokenFontSize(54)).toBe(1);
    expect(tokenFontSize(54 * 2) / tokenFontSize(54)).toBe(2);
  });

  it('places the correct pip count in a centered row below the numeral', () => {
    for (const token of [2, 3, 4, 5, 6, 8, 9, 10, 11, 12]) {
      const pips = tokenPips(token, 54);
      expect(pips).toHaveLength(6 - Math.abs(7 - token));
      expect(pips.every((pip) => pip.y === 54 * 0.2)).toBe(true);
      for (let index = 0; index < pips.length; index += 1) {
        expect(pips[index]?.x).toBeCloseTo(-(pips.at(-index - 1)?.x ?? 0));
      }
    }
    expect(tokenPips(7, 54)).toHaveLength(0);
  });

  it('keeps every pip inside the number disc at all supported token values', () => {
    const hexSize = 54;
    const innerDiscRadius = hexSize * 0.82 * (31.5 / 80);
    for (const token of [2, 3, 4, 5, 6, 8, 9, 10, 11, 12]) {
      for (const pip of tokenPips(token, hexSize)) {
        expect(Math.hypot(pip.x, pip.y) + tokenPipRadius(hexSize)).toBeLessThan(innerDiscRadius);
      }
    }
  });
});
