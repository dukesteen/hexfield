import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const reportDirectory = fileURLToPath(new URL('../../../reports/stage05/', import.meta.url));

test('game info stays wide and interactive in mobile landscape', async ({ page, browserName }) => {
  test.skip(
    browserName !== 'chromium',
    'This mobile landscape check uses Chromium touch emulation',
  );
  await page.setViewportSize({ width: 844, height: 390 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 844,
    height: 390,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });

  await page.goto('/#/local/new');
  await page.getByLabel('Player count').selectOption('2');
  await page.getByLabel('Player 1 control').selectOption('human');
  await page.getByLabel('Player 2 control').selectOption('bot');
  await page.getByRole('button', { name: 'Create game' }).click();
  await expect(page.getByRole('region', { name: 'Game board' })).toBeVisible();

  const info = page.locator('.game-info');
  const summaryBounds = await info.locator(':scope > summary').boundingBox();
  if (!summaryBounds) throw new Error('Game info summary is not measurable');
  const tap = {
    x: summaryBounds.x + summaryBounds.width / 2,
    y: summaryBounds.y + summaryBounds.height / 2,
  };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tap] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(info).toHaveAttribute('open', '');
  await expect(info.locator('.bank-card')).toHaveCount(5);
  const bounds = await info.boundingBox();
  if (!bounds) throw new Error('Open game info panel is not measurable');
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    join(reportDirectory, 'mobile-landscape-game-info.png'),
    await page.screenshot({ animations: 'disabled' }),
  );
  expect(bounds.width).toBeGreaterThanOrEqual(260);
  expect(bounds.x).toBeGreaterThanOrEqual(-1);
  expect(bounds.y).toBeGreaterThanOrEqual(-1);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(845);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(391);
  await expect(info.locator('.bank-card').first()).toBeVisible();
  const eventLog = info.locator('.event-log');
  const eventSummaryBounds = await eventLog.locator('summary').boundingBox();
  if (!eventSummaryBounds) throw new Error('Event log summary is not measurable');
  const eventTap = {
    x: eventSummaryBounds.x + eventSummaryBounds.width / 2,
    y: eventSummaryBounds.y + eventSummaryBounds.height / 2,
  };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [eventTap] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(eventLog).toHaveAttribute('open', '');
  const closeBounds = await info.locator(':scope > summary').boundingBox();
  if (!closeBounds) throw new Error('Open game info summary is not measurable');
  const closeTap = {
    x: closeBounds.x + closeBounds.width / 2,
    y: closeBounds.y + closeBounds.height / 2,
  };
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [closeTap],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(info).not.toHaveAttribute('open', '');
  await cdp.detach();
});
