import { expect, test } from '@playwright/test';
import type { CDPSession, Locator } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const reportDirectory = fileURLToPath(new URL('../../../reports/stage05/', import.meta.url));

/** Waits for a sheet's slide-in animation so its measured bounds are final. */
async function settled(sheet: Locator): Promise<void> {
  await expect(sheet).toBeVisible();
  await expect
    .poll(() => sheet.evaluate((element) => element.getAnimations({ subtree: true }).length))
    .toBe(0);
}

/** Taps the centre of a control with a real touch sequence. */
async function touch(cdp: CDPSession, target: Locator, label: string): Promise<void> {
  const bounds = await target.boundingBox();
  if (!bounds) throw new Error(`${label} is not measurable`);
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

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

  // The compact cockpit keeps the bank in the Trade sheet and the event log in the Log sheet.
  const tabs = page.getByRole('navigation', { name: 'Actions' });
  await touch(cdp, tabs.getByRole('button', { name: 'Trade' }), 'Trade tab');
  const trade = page.getByRole('dialog', { name: 'Trade', exact: true });
  await settled(trade);
  const bank = trade.getByRole('region', { name: 'Bank' });
  await expect(bank.locator('.bank-card')).toHaveCount(6);
  const bounds = await trade.boundingBox();
  if (!bounds) throw new Error('Open Trade sheet is not measurable');
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
  await bank.locator('.bank-card').first().scrollIntoViewIfNeeded();
  await expect(bank.locator('.bank-card').first()).toBeInViewport();
  await touch(cdp, trade.getByRole('button', { name: 'Close' }), 'Trade sheet close');
  await expect(trade).toBeHidden();

  await touch(cdp, tabs.getByRole('button', { name: 'Log' }), 'Log tab');
  const log = page.getByRole('dialog', { name: 'Event log' });
  await settled(log);
  const eventLog = log.locator('.event-log');
  await expect(eventLog).toHaveAttribute('open', '');
  const logBounds = await log.boundingBox();
  if (!logBounds) throw new Error('Open event log is not measurable');
  expect(logBounds.width).toBeGreaterThanOrEqual(260);
  expect(logBounds.y + logBounds.height).toBeLessThanOrEqual(391);
  // The sheet title names the log, so its entries show without a disclosure summary.
  await expect(eventLog.locator('summary')).toBeHidden();
  // A fresh game has no entries yet, so the log shows its empty message.
  await expect(eventLog.locator('ol, p.muted').first()).toBeInViewport();
  await touch(cdp, log.getByRole('button', { name: 'Close' }), 'Event log close');
  await expect(log).toBeHidden();
  await cdp.detach();
});
