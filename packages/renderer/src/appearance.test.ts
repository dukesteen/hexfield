import { describe, expect, it } from 'vitest';
import { sameAppearance } from './appearance.js';
import type { BoardAppearance } from './types.js';

const firstPlayer = { seat: 0, color: 0x0072b2, marker: 'circle' } as const;
const secondPlayer = { seat: 1, color: 0xd55e00, marker: 'triangle' } as const;
const base: BoardAppearance = {
  theme: 'light',
  players: [firstPlayer, secondPlayer],
};

describe('sameAppearance', () => {
  it('treats freshly-created but equivalent appearances as equal', () => {
    expect(sameAppearance(base, structuredClone(base))).toBe(true);
  });

  it('detects theme, color, marker, and seat changes', () => {
    expect(sameAppearance(base, { ...base, theme: 'dark' })).toBe(false);
    expect(
      sameAppearance(base, {
        ...base,
        players: [{ ...firstPlayer, color: 0 }, secondPlayer],
      }),
    ).toBe(false);
    expect(
      sameAppearance(base, {
        ...base,
        players: [{ ...firstPlayer, marker: 'diamond' }, secondPlayer],
      }),
    ).toBe(false);
    expect(
      sameAppearance(base, {
        ...base,
        players: [{ ...firstPlayer, seat: 1 }, secondPlayer],
      }),
    ).toBe(false);
  });
});
