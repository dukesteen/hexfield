/* eslint-disable no-await-in-loop -- Browser steps depend on the preceding page state. */
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The production build that `vite preview` serves (built by the config's web server). */
export const DIST = fileURLToPath(new URL('../../dist/', import.meta.url));

/** Every URL the generated service worker precaches. */
export function precacheUrls(dist = DIST): string[] {
  const sw = readFileSync(`${dist}sw.js`, 'utf8');
  return [...sw.matchAll(/url:"([^"]+)"/g)].map((match) => match[1] ?? '');
}

/** Page errors, console errors, failed requests and HTTP errors, collected for one page. */
export function watchProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', (request) =>
    problems.push(`failed: ${request.url()} ${request.failure()?.errorText ?? ''}`),
  );
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`http ${response.status()}: ${response.url()}`);
  });
  return problems;
}

/** Waits until the service worker controls the page and has stored every precache entry. */
export async function waitForPrecache(page: Page, expected: number): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), {
      timeout: 30_000,
    })
    .toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          let stored = 0;
          for (const name of await caches.keys()) {
            if (!name.includes('precache')) continue;
            stored += (await (await caches.open(name)).keys()).length;
          }
          return stored;
        }),
      { timeout: 120_000, intervals: [500] },
    )
    .toBe(expected);
}

/** Leaves a local game from its menu (save and leave), then opens `hash` from home. */
export async function leaveGameTo(page: Page, hash: string): Promise<void> {
  const menu = page.locator('.game-menu');
  if (!(await menu.evaluate((element) => element instanceof HTMLDetailsElement && element.open)))
    await menu.locator(':scope > summary').click();
  await page.getByRole('button', { name: 'Leave game', exact: true }).click();
  await page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: 'Leave this game?' }) })
    .getByRole('button', { name: 'Save and leave' })
    .click();
  await expect(page).toHaveURL(/#\/$/);
  if (hash !== '#/')
    await page.evaluate((next) => {
      window.location.hash = next;
    }, hash);
  await expect(page).toHaveURL(new RegExp(`${hash.replace(/[/#]/g, '\\$&')}$`));
}

/**
 * Creates an all-bot local game (zero pace by default) from the setup screen and waits until the bots
 * have rolled `rolls` times on the game screen.
 */
export async function playBotGame(
  page: Page,
  {
    scenario,
    rolls = 6,
    origin = '',
    pace = 0,
  }: { scenario?: string; rolls?: number; origin?: string; pace?: number } = {},
): Promise<void> {
  if (!page.url().endsWith('#/local/new')) await page.goto(`${origin}/#/local/new`);
  await expect(page.getByRole('heading', { name: 'New local game' })).toBeVisible();
  for (let seat = 1; seat <= 4; seat++)
    await page.getByLabel(`Player ${seat} control`).selectOption('bot');
  if (scenario)
    await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption(scenario);
  await page.getByText('Advanced rules').click();
  await page.getByLabel('Bot pace, milliseconds').fill(String(pace));
  await page.getByRole('button', { name: 'Create game' }).click();
  await expect(page).toHaveURL(/#\/local\/[^/]+$/);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.locator('.event-log-message', { hasText: /Rolled/ }).count(), {
      timeout: 90_000,
      intervals: [500],
    })
    .toBeGreaterThanOrEqual(rolls);
}
