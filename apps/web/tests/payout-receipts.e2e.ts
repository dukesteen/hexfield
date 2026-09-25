/* eslint-disable no-await-in-loop -- Each receipt assertion depends on the current browser state. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DevHook } from '../src/features/devtools/hook.js';
import { saveBeforeGoldenInput } from './golden-save.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const colors = ['blue', 'orange', 'green', 'magenta'] as const;
const shapes = ['circle', 'triangle', 'square', 'diamond'] as const;

function countsBySeat(value: unknown): value is Record<string, Record<string, number>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (counts) =>
        typeof counts === 'object' &&
        counts !== null &&
        !Array.isArray(counts) &&
        Object.values(counts).every((count) => typeof count === 'number'),
    )
  );
}

async function openBeforeProductionRoll(page: Page, id: string): Promise<number> {
  const save = await saveBeforeGoldenInput('normal-completion.replay.json', 17);
  const revision =
    save.genesis.length + save.batches.reduce((sum, batch) => sum + 1 + batch.generated.length, 0);
  const record = {
    v: 1,
    id,
    revision,
    updatedAt: Date.now(),
    presentation: {
      players: save.config.seats.map((seat, index) => ({
        seat,
        name: `Player ${seat + 1}`,
        color: colors[index] ?? 'blue',
        shape: shapes[index] ?? 'circle',
      })),
      botDelayMs: 0,
    },
    save,
  };
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: `hexfield:save:v1:${id}`,
    value: JSON.stringify(record),
  });
  await page.goto(`/#/local/${id}`);
  await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__cp2p')))).toBe(true);
  const reveal = page.getByRole('button', { name: 'Reveal hand' });
  if (await reveal.isVisible()) await reveal.click();
  await expect(page.getByRole('button', { name: 'Roll dice' })).toBeVisible();
  return page.evaluate(() => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    return hook?.session.getEvents().length ?? -1;
  });
}

async function rollForProduction(page: Page, beforeEvents: number) {
  await page.getByLabel('Open game menu').click();
  const drawer = page.getByTestId('dev-drawer');
  await drawer.locator('summary').first().click();
  await drawer.getByLabel('First die').selectOption('1');
  await drawer.getByLabel('Second die').selectOption('5');
  await drawer.getByRole('button', { name: 'Force next dice' }).click();
  await expect(drawer).toContainText('The next random dice result is set.');
  await page.getByLabel('Open game menu').click();
  await page.getByRole('button', { name: 'Roll dice' }).click();
  await expect
    .poll(() =>
      page.evaluate((index) => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.session
          .getEvents()
          .slice(index)
          .some((event) => event.type === 'resourcesProduced');
      }, beforeEvents),
    )
    .toBe(true);
  const produced = await page.evaluate((index) => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    const event = hook?.session
      .getEvents()
      .slice(index)
      .find((item) => item.type === 'resourcesProduced');
    return event?.type === 'resourcesProduced' ? event.bySeat : null;
  }, beforeEvents);
  if (!countsBySeat(produced)) throw new Error('The visible roll produced no public payout event');
  return produced;
}

async function expectVisibleReceipts(
  page: Page,
  bySeat: Record<string, Record<string, number>>,
): Promise<void> {
  const paidSeats = Object.entries(bySeat).filter(([, gains]) =>
    Object.values(gains).some((count) => count > 0),
  );
  expect(paidSeats.length).toBeGreaterThan(0);
  for (const [seat, gains] of paidSeats) {
    const panel = page.locator(`[data-seat-panel="${seat}"]`);
    const receipt = panel.locator('.production-receipt');
    await expect(receipt).toBeVisible();
    await expect(receipt).toContainText('Recent gains');
    for (const [resource, count] of Object.entries(gains)) {
      if (count <= 0) continue;
      const name = resource[0]?.toUpperCase() + resource.slice(1);
      await expect(receipt.getByLabel(`+${count} ${name}`)).toBeVisible();
    }
    const box = await receipt.boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport) throw new Error('Receipt is not in a visible viewport');
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  }
}

async function capture(page: Page, name: string): Promise<void> {
  const path = join(repoRoot, 'reports/stage05', name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, await page.screenshot());
}

test('visible production receipts survive Skip animations and the next turn, then expire', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'chromium', 'Production UI runs in Chromium');
  test.setTimeout(45_000);
  await page.emulateMedia({ colorScheme: 'dark' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const beforeEvents = await openBeforeProductionRoll(page, 'payout-desktop');
  const bySeat = await rollForProduction(page, beforeEvents);
  await expectVisibleReceipts(page, bySeat);
  await capture(page, 'payout-desktop-dark.png');

  await page.getByLabel('Open game menu').click();
  await page.getByRole('button', { name: 'Skip animations' }).click();
  await expectVisibleReceipts(page, bySeat);
  await page.getByLabel('Open game menu').click();

  const activeBefore = await page.evaluate(() => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    return hook?.session.getState().turn.activeSeat;
  });
  await page.getByRole('button', { name: 'End turn' }).click();
  const reveal = page.getByRole('button', { name: 'Reveal hand' });
  if (await reveal.isVisible()) await reveal.click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.session.getState().turn.activeSeat;
      }),
    )
    .not.toBe(activeBefore);
  await expectVisibleReceipts(page, bySeat);
  await expect(page.locator('.production-receipt')).toHaveCount(0, { timeout: 12_000 });
  expect(errors).toEqual([]);
});

test('reduced-motion phone keeps public payout receipts beside all paid seats', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'chromium', 'Production UI runs in Chromium');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const beforeEvents = await openBeforeProductionRoll(page, 'payout-phone');
  const bySeat = await rollForProduction(page, beforeEvents);
  await expectVisibleReceipts(page, bySeat);
  await capture(page, 'payout-phone.png');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
