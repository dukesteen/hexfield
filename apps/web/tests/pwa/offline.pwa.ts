/* eslint-disable no-await-in-loop -- Each icon is fetched and checked in manifest order. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  DIST,
  leaveGameTo,
  playBotGame,
  precacheUrls,
  waitForPrecache,
  watchProblems,
} from './helpers.js';

test.use({ serviceWorkers: 'allow' });

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  theme_color: string;
  background_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
}

/** PNG width and height from the IHDR chunk. */
function pngSize(bytes: Buffer): string {
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

test('the manifest is valid, its icons exist at their sizes, and Chromium finds the app installable', async ({
  page,
  request,
}) => {
  const response = await request.get('/manifest.webmanifest');
  expect(response.ok()).toBe(true);
  const manifest: Manifest = await response.json();
  expect(manifest).toMatchObject({
    name: 'Hexfield',
    short_name: 'Hexfield',
    start_url: './',
    scope: './',
    display: 'standalone',
    orientation: 'any',
    theme_color: '#29252a',
    background_color: '#29252a',
  });
  const sizes = new Map<string, string[]>();
  for (const icon of manifest.icons) {
    const file = await request.get(`/${icon.src}`);
    expect(file.ok(), icon.src).toBe(true);
    expect(file.headers()['content-type']).toContain('image/png');
    expect(pngSize(await file.body()), icon.src).toBe(icon.sizes);
    sizes.set(icon.purpose ?? 'any', [...(sizes.get(icon.purpose ?? 'any') ?? []), icon.sizes]);
  }
  expect(sizes.get('any')).toEqual(['192x192', '512x512']);
  expect(sizes.get('maskable')).toEqual(['512x512']);

  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // Chromium's own installability check (the same one behind its install prompt).
  const cdp = await page.context().newCDPSession(page);
  await expect
    .poll(
      async () => {
        const result = await cdp.send('Page.getInstallabilityErrors');
        return result.installabilityErrors.map((error) => error.errorId);
      },
      { timeout: 30_000 },
    )
    .toEqual([]);
  const { url, errors } = await cdp.send('Page.getAppManifest');
  expect(url).toMatch(/\/manifest\.webmanifest$/);
  expect(errors).toEqual([]);
});

test('offline after the first visit: reload, bot games of every module, and settings', async ({
  page,
  context,
}) => {
  test.setTimeout(420_000);
  const urls = precacheUrls();
  // The share images are the only built files left out; everything else ships offline.
  expect(urls).toContain('index.html');
  expect(urls.some((url) => /bot-worker-.*\.js$/.test(url))).toBe(true);
  expect(urls.some((url) => url.endsWith('.ttf'))).toBe(true);
  expect(urls).not.toContain('og.png');
  expect(readFileSync(`${DIST}sw.js`, 'utf8')).toContain('healthz');

  const problems = watchProblems(page);
  await page.goto('/');
  await waitForPrecache(page, urls.length);
  expect(problems).toEqual([]);

  await context.setOffline(true);
  const report = () => (problems.length ? `\n${problems.join('\n')}` : '');
  try {
    await offlineTour(page);
  } catch (error) {
    throw new Error(`${String(error)}${report()}`, { cause: error });
  }
  expect(problems).toEqual([]);
});

async function offlineTour(page: Page): Promise<void> {
  await page.reload();
  await expect(page.getByRole('heading', { name: 'A table ready when you are' })).toBeVisible();

  // Base game: four zero-pace bots play several turns (bots run in their own Web Worker).
  await playBotGame(page, { rolls: 8 });
  await leaveGameTo(page, '#/local/new');
  // Seafaring and Cities & Knights boards, pieces and art all come from the precache.
  await playBotGame(page, { scenario: 'new-horizons', rolls: 4 });
  await leaveGameTo(page, '#/local/new');
  await playBotGame(page, { scenario: 'knights', rolls: 4 });
  await leaveGameTo(page, '#/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  // A cold navigation to any other path while offline falls back to the cached app shell.
  await page.goto('/some/deep/link#/local/new');
  await expect(page.getByRole('heading', { name: 'New local game' })).toBeVisible();
}
