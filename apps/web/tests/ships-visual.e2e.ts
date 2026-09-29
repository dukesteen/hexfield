/* eslint-disable no-await-in-loop -- The viewports are photographed one after another. */
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The ship preview board (`/dev/board?layout=ships`): ships on both headings of all three edge
 * lines, each wedged between two buildings, and island bonus chits beside a harbor, a road and
 * ships. The pictures go to `SHIPS_SHOTS` when set, otherwise to the test's output folder.
 */
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone-portrait', width: 390, height: 844 },
] as const;

/** The renderer's default hex radius in board units (BoardView does not override it). */
const HEX_SIZE = 54;

async function shot(
  page: Page,
  testInfo: TestInfo,
  name: string,
  clip?: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const folder = process.env.SHIPS_SHOTS ?? testInfo.outputDir;
  await mkdir(folder, { recursive: true });
  const body = await page.screenshot({
    path: join(folder, `${name}.png`),
    animations: 'disabled',
    ...(clip ? { clip } : {}),
  });
  await testInfo.attach(name, { body, contentType: 'image/png' });
}

/** A square around a board point (in hex sizes), in page coordinates, zoomed onto the point. */
async function around(page: Page, q: number, r: number, hexes: number) {
  return page.evaluate(
    (at) => {
      const board = window['__cp2pBoard'];
      if (!board) throw new Error('Board is not ready');
      const center = board.renderer.boardToScreen({
        x: Math.sqrt(3) * at.size * (at.q + at.r / 2),
        y: 1.5 * at.size * at.r,
      });
      const edge = board.renderer.boardToScreen({
        x: Math.sqrt(3) * at.size * (at.q + at.r / 2) + at.size * at.hexes,
        y: 1.5 * at.size * at.r,
      });
      const half = edge.x - center.x;
      return { x: center.x - half, y: center.y - half, width: half * 2, height: half * 2 };
    },
    { q, r, hexes, size: HEX_SIZE },
  );
}

/** Fit the board, zoom in on a board point with the wheel, and pan it to the canvas centre. */
async function zoomOn(page: Page, q: number, r: number): Promise<void> {
  await page.evaluate(() => window['__cp2pBoard']?.renderer.fitToBoard());
  for (let step = 0; step < 40; step++) {
    const box = await around(page, q, r, 1);
    if (box.width / 2 >= 80) break;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(40);
  }
  const canvas = await page.locator('.board-view-canvas canvas').boundingBox();
  const box = await around(page, q, r, 1);
  if (!canvas) return;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
}

for (const viewport of VIEWPORTS) {
  test.describe(viewport.name, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 2,
    });
    test(`ships sit on their edges and chits clear harbors`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto('/#/dev/board?layout=ships');
      await expect(page.locator('.board-view-canvas canvas')).toBeVisible();
      await expect.poll(() => page.evaluate(() => window['__cp2pBoard'] !== undefined)).toBe(true);
      // The seafaring art loads after the first draw; wait until the layers stop rebuilding.
      let last = -1;
      await expect
        .poll(async () => {
          const rebuilt = await page.evaluate(
            () => window['__cp2pBoard']?.renderer.getDiagnostics().rebuiltLayers ?? 0,
          );
          const settled = rebuilt === last;
          last = rebuilt;
          return settled;
        })
        .toBe(true);
      await page.waitForTimeout(300);
      await page.evaluate(() => window['__cp2pBoard']?.renderer.fitToBoard());
      await page.waitForTimeout(200);
      await page.locator('.board-view-canvas').scrollIntoViewIfNeeded();
      await shot(page, testInfo, `${viewport.name}-board`);
      // The crowded island: six ships around one hex, a building at both ends of each.
      await shot(page, testInfo, `${viewport.name}-ships`, await around(page, 0, 0, 2.2));
      // The harbor island: a bonus chit beside a city, a harbor pier, a road and a ship.
      await shot(page, testInfo, `${viewport.name}-bonus`, await around(page, 3, -1.6, 1.8));
      // Zoomed in the way a player does on a phone, about 80 CSS pixels per hex.
      await zoomOn(page, 0, 0);
      await shot(page, testInfo, `${viewport.name}-zoomed-ships`);
      await zoomOn(page, 3, -1.6);
      await shot(page, testInfo, `${viewport.name}-zoomed-bonus`);
      expect(errors).toEqual([]);
    });
  });
}

/** Every seafaring preview board with its sample ships and chits, to look over the harbors. */
test.describe('seafaring boards', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  for (const layout of ['new-horizons', 'four-isles', 'desert-crossing', 'fogbound', 'open-sea']) {
    test(`${layout} draws without errors`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`/#/dev/board?layout=${layout}`);
      await expect(page.locator('.board-view-canvas canvas')).toBeVisible();
      await expect.poll(() => page.evaluate(() => window['__cp2pBoard'] !== undefined)).toBe(true);
      await page.waitForTimeout(800);
      await page.evaluate(() => window['__cp2pBoard']?.renderer.fitToBoard());
      await page.waitForTimeout(200);
      await shot(page, testInfo, `layout-${layout}`);
      expect(errors).toEqual([]);
    });
  }
});
