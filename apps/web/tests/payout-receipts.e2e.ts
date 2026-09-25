/* eslint-disable no-await-in-loop -- Each receipt assertion depends on the current browser state. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DevHook } from '../src/features/devtools/hook.js';
import { deriveVisualEffects } from '../src/features/game/visual-effects.js';
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
  await page.addInitScript(
    ({ key, value }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    },
    { key: `hexfield:save:v1:${id}`, value: JSON.stringify(record) },
  );
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

test('a real production roll flies public gains from hexes to player panels', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Production flight geometry runs in Chromium');
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
      const beforeEvents = await openBeforeProductionRoll(page, `payout-flight-${device.name}`);
      const before = await page.evaluate(() => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.session.getState() ?? null;
      });
      if (!before) throw new Error('Production fixture has no public state');
      // Hold only the test's visual at midflight so endpoints can be inspected reliably.
      const pauseStyle = await page.addStyleTag({
        content:
          '.resource-flight { animation-delay: -250ms !important; animation-play-state: paused !important; }',
      });
      await rollForProduction(page, beforeEvents);
      const after = await page.evaluate((index) => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook
          ? {
              state: hook.session.getState(),
              events: hook.session.getEvents().slice(index),
              revision: hook.diagnostics().revision,
            }
          : null;
      }, beforeEvents);
      if (!after) throw new Error('Production roll has no public update');
      const cues = deriveVisualEffects(before, after.state, after.events, after.revision).flights;
      expect(cues.length).toBeGreaterThan(0);
      const flightElements = page.locator('.resource-flight');
      await expect(flightElements).toHaveCount(cues.length);
      const expected = await page.evaluate((flights) => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return flights.map((flight) => {
          const from = hook?.pixelPosition({ kind: 'hex', id: flight.fromHex }) ?? null;
          const panel = document.querySelector(`[data-seat-panel="${flight.seat}"]`);
          const box = panel?.getBoundingClientRect();
          return {
            from,
            to: box
              ? {
                  left: box.left,
                  right: box.right,
                  top: box.top,
                  bottom: box.bottom,
                }
              : null,
          };
        });
      }, cues);
      const actual = await flightElements.evaluateAll((elements) =>
        elements.map((element) => {
          if (!(element instanceof HTMLElement)) throw new Error('Flight is not an element');
          const rendered = element.getBoundingClientRect();
          const image = element.querySelector('img');
          return {
            x: Number.parseFloat(element.style.left),
            y: Number.parseFloat(element.style.top),
            dx: Number.parseFloat(element.style.getPropertyValue('--flight-dx')),
            dy: Number.parseFloat(element.style.getPropertyValue('--flight-dy')),
            count: element.querySelector('b')?.textContent,
            icon: image?.getAttribute('src'),
            imageLoaded: (image?.naturalWidth ?? 0) > 0,
            visible: rendered.width > 0 && rendered.height > 0,
            renderedX: rendered.left + rendered.width / 2,
            renderedY: rendered.top + rendered.height / 2,
          };
        }),
      );
      for (const [index, cue] of cues.entries()) {
        const drawn = actual[index];
        const anchors = expected[index];
        if (!drawn || !anchors?.from || !anchors.to)
          throw new Error(`${device.name} flight ${index} has no public anchors`);
        expect(Math.hypot(drawn.x - anchors.from.x, drawn.y - anchors.from.y)).toBeLessThan(2);
        // The receipt enters after launch and can shift the panel center; the endpoint remains
        // inside the intended public seat panel.
        const endX = drawn.x + drawn.dx;
        const endY = drawn.y + drawn.dy;
        expect(endX).toBeGreaterThanOrEqual(anchors.to.left - 2);
        expect(endX).toBeLessThanOrEqual(anchors.to.right + 2);
        expect(endY).toBeGreaterThanOrEqual(anchors.to.top - 2);
        expect(endY).toBeLessThanOrEqual(anchors.to.bottom + 2);
        const axisX = drawn.dx;
        const axisY = drawn.dy;
        const travelX = drawn.renderedX - anchors.from.x;
        const travelY = drawn.renderedY - anchors.from.y;
        const axisLength = Math.hypot(axisX, axisY);
        const progress = (travelX * axisX + travelY * axisY) / (axisLength * axisLength);
        const offPath = Math.abs(travelX * axisY - travelY * axisX) / axisLength;
        expect(progress, `${device.name} flight is not between hex and player`).toBeGreaterThan(
          0.05,
        );
        expect(progress).toBeLessThan(0.95);
        expect(offPath, `${device.name} flight leaves its route`).toBeLessThan(3);
        expect(drawn.visible).toBe(true);
        expect(drawn.renderedX).toBeGreaterThan(0);
        expect(drawn.renderedX).toBeLessThan(device.width);
        expect(drawn.renderedY).toBeGreaterThan(0);
        expect(drawn.renderedY).toBeLessThan(device.height);
        expect(drawn.count).toBe(`+${cue.count}`);
        expect(drawn.imageLoaded).toBe(true);
        expect(new URL(drawn.icon ?? '', page.url()).pathname).toMatch(
          new RegExp(`/${cue.resource}(?:-[^/]+)?\\.svg$`),
        );
      }
      if (device.name === 'desktop') {
        const path = join(repoRoot, 'reports/stage05/production-flight-desktop.png');
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, await page.screenshot({ animations: 'allow' }));
      }
      if (device.name === 'desktop')
        await pauseStyle.evaluate((element) => element.parentNode?.removeChild(element));
      else {
        await page.getByLabel('Open game menu').click();
        await page.getByRole('button', { name: 'Skip animations' }).click();
      }
      await expect(flightElements).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

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
  const lastRoll = page.getByRole('img', { name: 'Last roll: 1 and 5, total 6' });
  await expect(lastRoll).toBeVisible();
  await expectVisibleReceipts(page, bySeat);
  await capture(page, 'payout-desktop-dark.png');

  await page.getByLabel('Open game menu').click();
  await page.getByRole('button', { name: 'Skip animations' }).click();
  await expect(lastRoll).toBeVisible();
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
  await expect(lastRoll).toBeVisible();
  await expect(page.locator('.production-receipt')).toHaveCount(0, { timeout: 12_000 });
  await expect(page.locator('.save-indicator.status-saved')).toHaveText('Saved');
  await page.reload();
  await page.getByRole('button', { name: 'Reveal hand' }).click();
  const restoredEvents = await page.evaluate(() => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    return hook?.session.getEvents().filter((event) => event.type === 'diceRolled') ?? [];
  });
  expect(restoredEvents, 'Saved replay should restore the public roll event').toContainEqual(
    expect.objectContaining({ type: 'diceRolled', dice: [1, 5], roll: 6 }),
  );
  await expect(lastRoll).toBeVisible();
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
  const lastRoll = page.getByRole('img', { name: 'Last roll: 1 and 5, total 6' });
  await expect(lastRoll).toBeVisible();
  const rollBounds = await lastRoll.boundingBox();
  expect(rollBounds).not.toBeNull();
  if (rollBounds) {
    expect(rollBounds.x + rollBounds.width).toBeLessThanOrEqual(390);
    expect(rollBounds.y + rollBounds.height).toBeLessThanOrEqual(844);
  }
  await expectVisibleReceipts(page, bySeat);
  await capture(page, 'payout-phone.png');
  await page.evaluate(
    () =>
      new Promise<void>((finishFrames) =>
        requestAnimationFrame(() => requestAnimationFrame(() => finishFrames())),
      ),
  );
  await expect(page.locator('.resource-flight')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
