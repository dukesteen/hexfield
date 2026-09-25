import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const reportDirectory = fileURLToPath(new URL('../../../reports/stage05/', import.meta.url));

async function usePhoneTouch(page: Page): Promise<CDPSession> {
  await page.setViewportSize({ width: 390, height: 844 });
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  return client;
}

async function createGame(page: Page, playerTwo: 'human' | 'bot'): Promise<void> {
  await page.goto('/#/local/new');
  await page.getByLabel('Player count').selectOption('2');
  await page.getByLabel('Player 1 control').selectOption('human');
  await page.getByLabel('Player 2 control').selectOption(playerTwo);
  await page.getByRole('button', { name: 'Create game' }).click();
  await expect(page).toHaveURL(/#\/local\/[^/]+$/);
  await expect(page.getByRole('region', { name: 'Game board' })).toBeVisible();
}

async function touchSwipe(
  client: CDPSession,
  start: { readonly x: number; readonly y: number },
  delta: { readonly x: number; readonly y: number },
): Promise<void> {
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [start],
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: start.x + delta.x, y: start.y + delta.y }],
  });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

test('phone player details dismiss by downward touch without breaking other swipes', async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'CDP touch input is used for this phone gesture check');
  const touch = await usePhoneTouch(page);
  await createGame(page, 'human');
  const revealHand = page.getByRole('button', { name: 'Reveal hand' });
  if (await revealHand.isVisible()) await revealHand.click();

  await expect(page.getByRole('button', { name: 'Hide hand' })).toBeVisible();
  const trigger = page.getByRole('button', { name: "Show Player 2's public details" });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Player 2' });
  await expect(dialog).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1),
  ).toBe(true);

  const body = dialog.locator('.cockpit-sheet-body');
  const bodyBounds = await body.boundingBox();
  if (!bodyBounds) throw new Error('Player detail sheet body is not measurable');
  const bodyStart = { x: bodyBounds.x + bodyBounds.width / 2, y: bodyBounds.y + 32 };

  await touchSwipe(touch, bodyStart, { x: 0, y: 35 });
  await expect(dialog).toBeVisible();
  await touchSwipe(touch, bodyStart, { x: 100, y: 90 });
  await expect(dialog).toBeVisible();
  await mkdir(reportDirectory, { recursive: true });
  const screenshotPath = join(reportDirectory, 'phone-player-details-sheet.png');
  const screenshot = await page.screenshot({ animations: 'disabled' });
  await writeFile(screenshotPath, screenshot);
  await testInfo.attach('phone-player-details-sheet', {
    body: screenshot,
    contentType: 'image/png',
  });

  await page.setViewportSize({ width: 390, height: 390 });
  const scrollableBounds = await body.boundingBox();
  if (!scrollableBounds) throw new Error('Short phone detail sheet body is not measurable');
  const scrollStart = {
    x: scrollableBounds.x + scrollableBounds.width / 2,
    y: scrollableBounds.y + Math.min(72, scrollableBounds.height / 2),
  };
  await touchSwipe(touch, scrollStart, { x: 0, y: -100 });
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await touchSwipe(touch, scrollStart, { x: 0, y: 110 });
  await expect(dialog).toBeVisible();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(0);

  const topBodyBounds = await body.boundingBox();
  if (!topBodyBounds) throw new Error('Player detail sheet body is not measurable after scroll');
  await touchSwipe(
    touch,
    { x: topBodyBounds.x + topBodyBounds.width / 2, y: topBodyBounds.y + 32 },
    { x: 0, y: 110 },
  );
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(dialog).toBeVisible();
  const headerBounds = await dialog.locator('.cockpit-sheet-header').boundingBox();
  if (!headerBounds) throw new Error('Player detail sheet header is not measurable');
  await touchSwipe(
    touch,
    { x: headerBounds.x + headerBounds.width / 2, y: headerBounds.y + headerBounds.height / 2 },
    { x: 0, y: 110 },
  );
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await touch.detach();
});

test('single-human game omits manual hide-hand control', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'This paired hand-visibility check runs in Chromium');
  await usePhoneTouch(page);
  await createGame(page, 'bot');
  await expect(page.getByRole('region', { name: 'Your hand' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide hand' })).toHaveCount(0);
  await expect(page.locator('.resource-hand-card')).toHaveCount(5);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Your hand' })).toBeVisible();
  await expect(page.locator('.resource-hand-card')).toHaveCount(5);
});
