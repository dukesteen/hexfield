import { LOBBY_COLOURS } from '@cp2p/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { PlayerMarker } from './PlayerMarker.js';
import { BOARD_PLAYER_COLORS } from './use-appearance.js';

describe('shared player presentation colors', () => {
  test('maps and renders every lobby color in board presentations', () => {
    expect(Object.keys(BOARD_PLAYER_COLORS).toSorted()).toEqual([...LOBBY_COLOURS].toSorted());

    for (const color of LOBBY_COLOURS) {
      expect(BOARD_PLAYER_COLORS[color]).toBeGreaterThan(0);
      expect(
        renderToStaticMarkup(createElement(PlayerMarker, { shape: 'circle', color })),
      ).toContain(`color-${color}`);
    }
  });
});
