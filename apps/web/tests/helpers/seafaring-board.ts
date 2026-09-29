import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GameState } from '@cp2p/engine';
import type { DevHook } from '../../src/features/devtools/hook.js';
import { waitForRenderer } from './renderer-ready.js';

declare global {
  interface Window {
    __cp2p?: DevHook;
  }
}

/** The renderer's default hex radius in board units. */
export const HEX_SIZE = 54;

export const VIEWPORT_NAMES = ['desktop', 'tablet', 'phone-portrait', 'phone-landscape'] as const;
export type ViewportName = (typeof VIEWPORT_NAMES)[number];
export const VIEWPORTS: Readonly<Record<ViewportName, { width: number; height: number }>> = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 820, height: 1180 },
  'phone-portrait': { width: 390, height: 844 },
  'phone-landscape': { width: 844, height: 390 },
};
export const isPhone = (name: ViewportName): boolean => name.startsWith('phone');

const NEIGHBORS = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
] as const;

/** Every scenery water cell around the board: the ring the renderer draws outside the hexes. */
function ringCells(hexes: readonly { q: number; r: number }[]): { q: number; r: number }[] {
  const occupied = new Set(hexes.map(({ q, r }) => `${q},${r}`));
  const ring = new Map<string, { q: number; r: number }>();
  for (const { q, r } of hexes)
    for (const [dq, dr] of NEIGHBORS) {
      const key = `${q + dq},${r + dr}`;
      if (!occupied.has(key)) ring.set(key, { q: q + dq, r: r + dr });
    }
  return [...ring.values()];
}

/**
 * How many hex corners fall outside what the player can see: the board's hexes and the water
 * ring around them, against the canvas and the browser window (the phone layout lets the canvas
 * run 30px past the screen on each side).
 */
export async function hexCornersOutside(page: Page, state: GameState): Promise<number> {
  const canvas = page.locator('.board-view-canvas canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Board canvas has no box');
  const screen = page.viewportSize();
  if (!screen) throw new Error('No viewport');
  const cells = [
    ...state.board.hexes.map(({ q, r }) => ({ q, r })),
    ...ringCells(state.board.hexes),
  ];
  const corners = await page.evaluate(
    ({ list, size }) => {
      const renderer = window['__cp2p']?.renderer;
      if (!renderer) throw new Error('Renderer is not ready');
      return list.flatMap(({ q, r }) => {
        const center = { x: Math.sqrt(3) * size * (q + r / 2), y: 1.5 * size * r };
        return Array.from({ length: 6 }, (_, index) => {
          const angle = (Math.PI / 180) * (60 * index - 90);
          return renderer.boardToScreen({
            x: center.x + size * 0.95 * Math.cos(angle),
            y: center.y + size * 0.95 * Math.sin(angle),
          });
        });
      });
    },
    { list: cells, size: HEX_SIZE },
  );
  const left = Math.max(box.x, 0);
  const top = Math.max(box.y, 0);
  const right = Math.min(box.x + box.width, screen.width);
  const bottom = Math.min(box.y + box.height, screen.height);
  return corners.filter(
    (point) =>
      point.x < left - 1 || point.x > right + 1 || point.y < top - 1 || point.y > bottom + 1,
  ).length;
}

/** Start a local game from the lobby form: the human at seat 1, bots elsewhere. */
export async function newLocalGame(
  page: Page,
  scenario: string,
  options: { seats?: number } = {},
): Promise<void> {
  await page.goto('/#/local/new');
  const seats = options.seats ?? (scenario.endsWith('-56') ? 5 : 4);
  await page.locator('#player-count').selectOption(String(seats));
  await page.locator('.scenario-picker select').selectOption(scenario);
  await page.getByText('Advanced rules').click();
  await page.getByLabel('Bot pace, milliseconds').fill('0');
  await page.getByRole('button', { name: 'Create game' }).click();
  await expect(page).toHaveURL(/#\/local\/[^/]+$/);
  await waitForRenderer(page);
}

export function gameState(page: Page): Promise<GameState> {
  return page.evaluate(() => {
    const hook = window['__cp2p'];
    if (!hook) throw new Error('No dev hook');
    return structuredClone(hook.session.getState());
  });
}
