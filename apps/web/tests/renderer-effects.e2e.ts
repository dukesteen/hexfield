import { expect, test } from '@playwright/test';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import type { EdgeId, HexId } from '@cp2p/engine/geometry';
import { standardFixedBoard } from '@cp2p/maps';
import type { BoardRenderer, RenderModel } from '@cp2p/renderer';

declare global {
  interface Window {
    __cp2pBoard?: { readonly renderer: BoardRenderer; readonly model: RenderModel };
  }
}

interface RendererDiagnostics {
  readonly renderedFrames: number;
  readonly rebuiltLayers: number;
  readonly activeEffects: number;
  readonly queuedDisposals: number;
}

const board = standardFixedBoard();
const graph = buildBoardGraph(board.hexes);
const harborFitInputs: { readonly edge: EdgeId; readonly landHex: HexId }[] = board.harbors.flatMap(
  (harbor) => {
    const edge = graph.edgeIds.find((id) => id === harbor.edge);
    const edgeIndex = edge === undefined ? undefined : graph.edgeIndex[edge];
    if (edge === undefined || edgeIndex === undefined) return [];
    const landHex = graph.edgeHexes[edgeIndex]?.find(
      (id) => board.hexes.find((hex) => hex.id === id)?.terrain !== 'sea',
    );
    return landHex === undefined ? [] : [{ edge, landHex }];
  },
);

async function expectHarborFit(
  page: import('@playwright/test').Page,
  canvas: import('@playwright/test').Locator,
): Promise<void> {
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Board canvas has no layout bounds');
  const allFit = await page.evaluate((ports) => {
    const preview = window['__cp2pBoard'];
    if (!preview) return false;
    const canvasRect = document
      .querySelector<HTMLCanvasElement>('.board-view-canvas canvas')
      ?.getBoundingClientRect();
    if (!canvasRect) return false;
    return ports.every((port) => {
      const edge = preview.renderer.getPixelPosition({ kind: 'edge', id: port.edge });
      const land = preview.renderer.getPixelPosition({ kind: 'hex', id: port.landHex });
      const deltaX = edge.x - land.x;
      const deltaY = edge.y - land.y;
      const pixelScale = Math.hypot(deltaX, deltaY) / 27;
      const hub = {
        x: land.x + (deltaX * 42.75) / 27,
        y: land.y + (deltaY * 42.75) / 27,
      };
      const radius = 25.92 * pixelScale;
      return (
        hub.x - radius >= canvasRect.left &&
        hub.x + radius <= canvasRect.right &&
        hub.y - radius >= canvasRect.top &&
        hub.y + radius <= canvasRect.bottom
      );
    });
  }, harborFitInputs);
  expect(allFit).toBe(true);
}

function parseDiagnostics(text: string): RendererDiagnostics {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null) throw new Error('Invalid renderer diagnostics');
  const readCounter = (key: keyof RendererDiagnostics): number => {
    const counter: unknown = Reflect.get(value, key);
    if (typeof counter !== 'number' || !Number.isSafeInteger(counter) || counter < 0)
      throw new Error(`Invalid renderer diagnostic ${key}`);
    return counter;
  };
  return {
    renderedFrames: readCounter('renderedFrames'),
    rebuiltLayers: readCounter('rebuiltLayers'),
    activeEffects: readCounter('activeEffects'),
    queuedDisposals: readCounter('queuedDisposals'),
  };
}

test('board effects animate, skip, respect reduced motion, and release retired objects', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const desktopViewport = { width: 1280, height: 800 };
  await page.setViewportSize(desktopViewport);
  await page.goto('/#/dev/board');
  const canvas = page.locator('.board-view-canvas canvas');
  await expect(canvas).toBeVisible();
  await expect
    .poll(async () => page.evaluate(() => window['__cp2pBoard'] !== undefined))
    .toBe(true);
  await expectHarborFit(page, canvas);
  await page.waitForTimeout(160);
  const fitFrame = await page.screenshot({ path: testInfo.outputPath('ports-desktop-fit.png') });
  await testInfo.attach('ports-desktop-fit', { body: fitFrame, contentType: 'image/png' });
  const desktopBounds = await canvas.boundingBox();
  if (!desktopBounds) throw new Error('Board canvas has no layout bounds');
  await page.mouse.move(
    desktopBounds.x + desktopBounds.width / 2,
    desktopBounds.y + desktopBounds.height / 2,
  );
  await page.mouse.wheel(0, 10000);
  await page.waitForTimeout(120);
  const minZoomFrame = await page.screenshot({
    path: testInfo.outputPath('ports-desktop-min.png'),
  });
  await testInfo.attach('ports-desktop-min', { body: minZoomFrame, contentType: 'image/png' });
  const firstHarbor = harborFitInputs[0];
  if (!firstHarbor) throw new Error('The development board has no harbor anchor');
  const portAnchor = await page.evaluate((port) => {
    const renderer = window['__cp2pBoard']?.renderer;
    if (!renderer) return null;
    const edge = renderer.getPixelPosition({ kind: 'edge', id: port.edge });
    const land = renderer.getPixelPosition({ kind: 'hex', id: port.landHex });
    const deltaX = edge.x - land.x;
    const deltaY = edge.y - land.y;
    return {
      x: land.x + (deltaX * 42.75) / 27,
      y: land.y + (deltaY * 42.75) / 27,
    };
  }, firstHarbor);
  if (!portAnchor) throw new Error('The development board has no harbor anchor');
  await page.mouse.move(portAnchor.x, portAnchor.y);
  await page.mouse.wheel(0, -10000);
  await page.waitForTimeout(120);
  const maxZoomFrame = await page.screenshot({
    path: testInfo.outputPath('ports-desktop-max.png'),
  });
  await testInfo.attach('ports-desktop-max', { body: maxZoomFrame, contentType: 'image/png' });
  const phonePage = await page.context().newPage();
  await phonePage.setViewportSize({ width: 390, height: 844 });
  await phonePage.goto('/#/dev/board');
  const phoneCanvas = phonePage.locator('.board-view-canvas canvas');
  await expect(phoneCanvas).toBeVisible();
  await expect
    .poll(async () => phonePage.evaluate(() => window['__cp2pBoard'] !== undefined))
    .toBe(true);
  await expectHarborFit(phonePage, phoneCanvas);
  await phonePage.waitForTimeout(160);
  const phoneFrame = await phonePage.screenshot({
    path: testInfo.outputPath('ports-phone-fit.png'),
  });
  await testInfo.attach('ports-phone-fit', { body: phoneFrame, contentType: 'image/png' });
  await phonePage.getByRole('button', { name: 'Play dice roll' }).click();
  await phonePage.waitForTimeout(180);
  await phonePage.evaluate(() => window.scrollTo(0, 0));
  await phonePage.waitForTimeout(80);
  const phoneDiceFrame = await phonePage.screenshot({
    path: testInfo.outputPath('dice-phone-midpoint.png'),
  });
  await testInfo.attach('dice-phone-midpoint', {
    body: phoneDiceFrame,
    contentType: 'image/png',
  });
  await phonePage.getByRole('button', { name: 'Skip animations' }).click();
  await phonePage.close();

  const diagnostics = page.getByTestId('renderer-diagnostics');
  const readDiagnostics = async (): Promise<RendererDiagnostics> =>
    parseDiagnostics(await diagnostics.innerText());
  const expectNoRetiredObjects = async (): Promise<void> => {
    await expect
      .poll(async () => {
        const current = await readDiagnostics();
        return [current.activeEffects, current.queuedDisposals];
      })
      .toEqual([0, 0]);
  };

  await page.getByRole('button', { name: 'Play dice roll' }).click();
  await expect.poll(async () => (await readDiagnostics()).activeEffects).toBe(1);
  await page.waitForTimeout(180);
  const diceFrame = await page.screenshot({
    path: testInfo.outputPath('dice-settle-midpoint.png'),
  });
  await testInfo.attach('dice-settle-midpoint', {
    body: diceFrame,
    contentType: 'image/png',
  });
  await expectNoRetiredObjects();

  await page.getByRole('button', { name: 'Pop settlement' }).click();
  await expect.poll(async () => (await readDiagnostics()).activeEffects).toBe(1);
  await page.waitForTimeout(120);
  const pieceFrame = await page.screenshot({ path: testInfo.outputPath('piece-pop-midpoint.png') });
  await testInfo.attach('piece-pop-midpoint', {
    body: pieceFrame,
    contentType: 'image/png',
  });
  await expectNoRetiredObjects();

  await page.getByRole('button', { name: 'Move robber' }).click();
  await expect.poll(async () => (await readDiagnostics()).activeEffects).toBe(1);
  await page.waitForTimeout(120);
  const robberFrame = await page.screenshot({
    path: testInfo.outputPath('robber-motion-midpoint.png'),
  });
  await testInfo.attach('robber-motion-midpoint', {
    body: robberFrame,
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: 'Skip animations' }).click();
  await expectNoRetiredObjects();

  const beforeCamera = await readDiagnostics();
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error('Board canvas has no layout bounds');
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.wheel(0, -160);
  await page.waitForTimeout(120);
  expect((await readDiagnostics()).rebuiltLayers).toBe(beforeCamera.rebuiltLayers);

  await page.getByLabel('Reduced motion').check();
  await page.getByRole('button', { name: 'Play dice roll' }).click();
  await page.getByRole('button', { name: 'Pop settlement' }).click();
  await page.getByRole('button', { name: 'Move robber' }).click();
  await expectNoRetiredObjects();
  expect(errors).toEqual([]);
  await page.waitForTimeout(120);
  const idleFrameCount = (await readDiagnostics()).renderedFrames;
  await page.waitForTimeout(220);
  expect((await readDiagnostics()).renderedFrames).toBe(idleFrameCount);
});
