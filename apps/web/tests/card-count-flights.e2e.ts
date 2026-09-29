/* eslint-disable no-await-in-loop -- Each device runs its roll after the previous one. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Seat } from '@cp2p/engine';
import type { DevHook } from '../src/features/devtools/hook.js';
import { openBeforeRoll } from './helpers/roll-fixture.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const shots = process.env.CP2P_ANIM_SHOTS ?? join(repoRoot, 'reports/card-flights');
/** The counts the hand dock and the human's panel draw right now. */
function drawnCounts(page: Page, seat: Seat, kinds: readonly string[]) {
  return page.evaluate(
    ({ seat: panelSeat, kinds: wanted }) => {
      const slots: Record<string, number> = {};
      for (const kind of wanted) {
        const text = document.querySelector(
          `.hand-dock [data-resource="${kind}"] .resource-card-count`,
        )?.textContent;
        slots[kind] = Number(text);
      }
      const total = document.querySelector('.hand-dock .hand-total')?.textContent ?? '';
      const panel = document.querySelector(
        `[data-seat-panel="${panelSeat}"] .player-panel-stats dd`,
      );
      return {
        slots,
        total: Number.parseInt(total, 10),
        panel: panel ? Number(panel.textContent) : null,
      };
    },
    { seat, kinds },
  );
}

test('hand counts wait for produced cards to land, then settle on the state', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Card flight timing is checked in Chromium');
  test.setTimeout(60_000);
  await mkdir(shots, { recursive: true });
  for (const device of [
    { name: 'desktop', mobile: false, width: 1280, height: 720 },
    { name: 'phone', mobile: true, width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({
      viewport: { width: device.width, height: device.height },
      isMobile: device.mobile,
      hasTouch: device.mobile,
    });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const { human, hand, roll } = await openBeforeRoll(page, `card-counts-${device.name}`);
      const kinds = Object.keys(roll.gains);
      expect(kinds.length, 'the fixture has a paying roll for the human').toBeGreaterThan(0);
      const handTotal = Object.values(hand).reduce((sum, count) => sum + count, 0);
      const gained = Object.values(roll.gains).reduce((sum, count) => sum + count, 0);

      const first = Math.min(6, roll.total - 1);
      await page.getByLabel('Open game menu').click();
      const drawer = page.getByTestId('dev-drawer');
      await drawer.locator('summary').first().click();
      await drawer.getByLabel('First die').selectOption(String(first));
      await drawer.getByLabel('Second die').selectOption(String(roll.total - first));
      await drawer.getByRole('button', { name: 'Force next dice' }).click();
      await page.getByLabel('Open game menu').click();
      await page.getByRole('button', { name: 'Roll dice' }).click();

      // The state already holds the new cards while the dice tumble...
      await expect
        .poll(() =>
          page.evaluate((seat) => {
            const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
            const now = hook?.session.getPrivate(seat)?.hand;
            return now ? Object.values(now).reduce((sum, count) => sum + count, 0) : 0;
          }, human),
        )
        .toBe(handTotal + gained);
      // ...but the hand shows the old counts until a card reaches its slot.
      const beforeLaunch = await drawnCounts(page, human, kinds);
      for (const kind of kinds) expect(beforeLaunch.slots[kind]).toBe(hand[kind] ?? 0);
      expect(beforeLaunch.total).toBe(handTotal);
      await expect(page.locator('.resource-flight').first()).toBeVisible({ timeout: 5_000 });
      const midFlight = await drawnCounts(page, human, kinds);
      await writeFile(
        join(shots, `production-${device.name}-mid-flight.png`),
        await page.screenshot({ animations: 'allow' }),
      );
      // The first card is in the air: at least one kind still shows its old count.
      expect(kinds.some((kind) => midFlight.slots[kind] === (hand[kind] ?? 0))).toBe(true);
      expect(midFlight.total).toBeLessThan(handTotal + gained);

      await expect(page.locator('.resource-flight')).toHaveCount(0, { timeout: 10_000 });
      const landed = await drawnCounts(page, human, kinds);
      await writeFile(
        join(shots, `production-${device.name}-landed.png`),
        await page.screenshot({ animations: 'allow' }),
      );
      for (const kind of kinds)
        expect(landed.slots[kind]).toBe((hand[kind] ?? 0) + (roll.gains[kind] ?? 0));
      expect(landed.total).toBe(handTotal + gained);
      if (landed.panel !== null) expect(landed.panel).toBe(handTotal + gained);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

test('reduced motion shows produced cards in the hand at once', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Card flight timing is checked in Chromium');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { human, hand, roll } = await openBeforeRoll(page, 'card-counts-reduced');
  const kinds = Object.keys(roll.gains);
  const first = Math.min(6, roll.total - 1);
  await page.getByLabel('Open game menu').click();
  const drawer = page.getByTestId('dev-drawer');
  await drawer.locator('summary').first().click();
  await drawer.getByLabel('First die').selectOption(String(first));
  await drawer.getByLabel('Second die').selectOption(String(roll.total - first));
  await drawer.getByRole('button', { name: 'Force next dice' }).click();
  await page.getByLabel('Open game menu').click();
  await page.getByRole('button', { name: 'Roll dice' }).click();
  for (const kind of kinds)
    await expect(
      page.locator(`.hand-dock [data-resource="${kind}"] .resource-card-count`),
    ).toHaveText(String((hand[kind] ?? 0) + (roll.gains[kind] ?? 0)), { timeout: 1_000 });
  await expect(page.locator('.resource-flight')).toHaveCount(0);
  expect(human).toBeGreaterThanOrEqual(0);
});
