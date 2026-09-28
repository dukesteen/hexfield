import { expect, test } from '@playwright/test';

/** The renderer's default hex radius in board units (BoardView does not override it). */
const HEX_SIZE = 54;

for (const viewport of [
  { name: 'phone-portrait', width: 390, height: 844 },
  { name: 'phone-landscape', width: 844, height: 390 },
]) {
  test(`the 30-hex board and its fixture fit a ${viewport.name} screen`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/#/dev/board?layout=five-six');
    const canvas = page.locator('.board-view-canvas canvas');
    await expect(canvas).toBeVisible();
    await expect
      .poll(async () => page.evaluate(() => window['__cp2pBoard'] !== undefined))
      .toBe(true);
    await page.evaluate(() => window['__cp2pBoard']?.renderer.fitToBoard());
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Board canvas has no box');
    const points = await page.evaluate((size) => {
      const board = window['__cp2pBoard'];
      if (!board) throw new Error('Board is not ready');
      const pixel = (q: number, r: number) => ({
        x: Math.sqrt(3) * size * (q + r / 2),
        y: 1.5 * size * r,
      });
      const corners = (q: number, r: number) => {
        const center = pixel(q, r);
        return Array.from({ length: 6 }, (_, index) => {
          const angle = (Math.PI / 180) * (60 * index - 90);
          return board.renderer.boardToScreen({
            x: center.x + size * 0.9 * Math.cos(angle),
            y: center.y + size * 0.9 * Math.sin(angle),
          });
        });
      };
      return {
        land: board.model.hexes.flatMap((hex) => corners(hex.q, hex.r)),
        fixture: (board.model.fixtures ?? []).flatMap((fixture) =>
          fixture.footprint.flatMap(({ q, r }) => corners(q, r)),
        ),
        hexes: board.model.hexes.length,
        fixtures: board.model.fixtures?.length ?? 0,
      };
    }, HEX_SIZE);
    expect(points.hexes).toBe(30);
    expect(points.fixtures).toBe(1);
    const inside = (point: { x: number; y: number }) =>
      point.x >= box.x - 1 &&
      point.x <= box.x + box.width + 1 &&
      point.y >= box.y - 1 &&
      point.y <= box.y + box.height + 1;
    expect(points.land.filter((point) => !inside(point))).toEqual([]);
    expect(points.fixture.filter((point) => !inside(point))).toEqual([]);
    const shot = await page.screenshot({ path: testInfo.outputPath(`${viewport.name}.png`) });
    await testInfo.attach(viewport.name, { body: shot, contentType: 'image/png' });
  });
}
