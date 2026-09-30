/* eslint-disable no-await-in-loop -- Each tap depends on the canvas the previous one changed. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import type { BoardHit, BoardRenderer } from '@cp2p/renderer';
import type { DevHook } from '../src/features/devtools/hook.js';
import { waitForRenderer } from './helpers/renderer-ready.js';

const SHOTS = process.env.CP2P_SCREENSHOT_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Tap a canvas hex through the renderer's own geometry. */
async function tapHex(page: Page, q: number, r: number): Promise<void> {
  const hit: BoardHit = { kind: 'hex', id: `h:${q},${r}` };
  const point = await page.evaluate((target) => {
    const editor: { renderer: BoardRenderer } | undefined = Reflect.get(window, '__cp2pMapEditor');
    return editor?.renderer.getPixelPosition(target) ?? null;
  }, hit);
  if (!point) throw new Error('The editor canvas is not ready');
  await page.mouse.click(point.x, point.y);
}

/** A seven-hex flower, one terrain per key: forest, hills, pasture, fields, mountains. */
const FLOWER: readonly (readonly [q: number, r: number, key: string])[] = [
  [0, 0, '1'],
  [1, 0, '2'],
  [1, -1, '3'],
  [0, -1, '4'],
  [-1, 0, '5'],
  [-1, 1, '1'],
  [0, 1, '4'],
];

for (const device of ['desktop', 'phone'] as const) {
  test(`build a small map, fix it, export it and play it against bots (${device})`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext(
      device === 'phone'
        ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
        : { viewport: { width: 1440, height: 900 } },
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto('/#/editor');
      await page.getByLabel('New map from…').selectOption('blank');
      await expect(page.getByText('Paint some land to start a map.').first()).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__cp2pMapEditor'))), {
          timeout: 20_000,
        })
        .toBe(true);
      await page.getByLabel('Map name').fill('Flower');

      // Paint with the number keys, which pick the terrain and the brush.
      for (const [q, r, key] of FLOWER) {
        await page.keyboard.press(key);
        await tapHex(page, q, r);
      }
      const check = page.getByRole('tabpanel');
      await expect(check.getByText('7 land hexes have no number.')).toBeVisible();
      await expect(check.getByText('Place the robber on a land hex.')).toBeVisible();

      // Fix: numbers by the solver, the robber by hand, two players for this small island.
      await page.getByRole('button', { name: 'Balance numbers' }).click();
      await page.getByRole('button', { name: /^Robber/ }).click();
      await tapHex(page, 0, 0);
      await page.getByRole('tab', { name: 'Rules' }).click();
      await page.getByLabel('Most players').selectOption('3');
      await page.getByLabel('Fewest players').selectOption('2');
      await page.getByRole('tab', { name: /Check/ }).click();
      await expect(page.getByRole('heading', { name: 'Ready to play' })).toBeVisible();
      await shot(page, `map-editor-${device}`);

      // Undo brings the robber back off the board, redo restores it.
      await page.keyboard.press('Control+z');
      await page.keyboard.press('Control+z');
      await page.keyboard.press('Control+z');
      await expect(page.getByText('Place the robber on a land hex.')).toBeVisible();
      await page.keyboard.press('Control+Shift+z');
      await page.keyboard.press('Control+Shift+z');
      await page.keyboard.press('Control+Shift+z');
      await expect(page.getByRole('heading', { name: 'Ready to play' })).toBeVisible();

      await page.getByRole('tab', { name: 'Share' }).click();
      await page.getByRole('button', { name: 'Create share string' }).click();
      const text = await page.getByTestId('map-share-string').inputValue();
      expect(text).toMatch(/^HXMAP1\.[A-Za-z0-9_-]+$/);

      await page.getByTestId('map-play').click();
      await expect(page).toHaveURL(/local\/new/);
      await expect(page.locator('.scenario-picker select')).toHaveValue('custom');
      await expect(page.getByText('Flower').first()).toBeVisible();
      await expect(page.getByLabel('Player count')).toHaveValue('3');
      await page.getByRole('button', { name: 'Create game' }).click();
      await expect(page).toHaveURL(/\/local\/[^/]+$/, { timeout: 20_000 });
      await waitForRenderer(page);
      const board = await page.evaluate(() => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        const state = hook?.session.getState();
        return state
          ? {
              hexes: state.board.hexes.length,
              robber: state.board.robberHex,
              layout: Reflect.get(Object(state.config.options.base), 'mapLayout'),
            }
          : null;
      });
      expect(board).toEqual({ hexes: 7, robber: 'h:0,0', layout: 'custom' });
      await page.waitForTimeout(1_500);
      await shot(page, `map-editor-game-${device}`);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test('a map link opens in the editor and a broken one falls back with a notice', async ({
  page,
}) => {
  await page.goto('/#/editor?map=HXMAP1.broken');
  await expect(page.getByText(/could not be read/)).toBeVisible();
  await expect(page.getByLabel('Map name')).toHaveValue('My island');
});
