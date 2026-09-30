import { expect, test } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIST, leaveGameTo, playBotGame, precacheUrls, waitForPrecache } from './helpers.js';
import { startStaticServer } from './static-server.js';

test.use({ serviceWorkers: 'allow' });

const NEXT_MARKER = '<meta name="hexfield-build" content="next" />';

/** A copy of the build with a changed index.html, as the next deploy would ship it. */
async function nextBuild(): Promise<string> {
  const next = await mkdtemp(join(tmpdir(), 'hexfield-next-'));
  await cp(DIST, next, { recursive: true });
  const index = join(next, 'index.html');
  await writeFile(
    index,
    (await readFile(index, 'utf8')).replace('</head>', `${NEXT_MARKER}</head>`),
  );
  const swPath = join(next, 'sw.js');
  const sw = await readFile(swPath, 'utf8');
  const updated = sw.replace(/(\{url:"index\.html",revision:")[^"]+(")/, '$1next-build$2');
  expect(updated).not.toBe(sw);
  await writeFile(swPath, updated);
  return next;
}

test('a new version waits during a game and reloads only after the player confirms', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const next = await nextBuild();
  const server = await startStaticServer(DIST);
  try {
    await page.goto(`${server.origin}/`);
    await waitForPrecache(page, precacheUrls().length);

    await playBotGame(page, { origin: server.origin, rolls: 2, pace: 150 });
    // A same-document marker: any reload of the page clears it.
    await page.evaluate(() => Reflect.set(window, '__pwaMarker', 'still here'));

    // Deploy the next build and let the browser find it.
    server.setRoot(next);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration?.update();
    });
    await expect
      .poll(
        () =>
          page.evaluate(async () =>
            Boolean((await navigator.serviceWorker.getRegistration())?.waiting),
          ),
        { timeout: 60_000 },
      )
      .toBe(true);

    // Mid-game: no prompt, no reload, and the bots keep playing.
    const prompt = page.getByRole('status', { name: 'Update available' });
    const rolled = await page.locator('.event-log-message', { hasText: /Rolled/ }).count();
    await page.waitForTimeout(3000);
    await expect(prompt).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, '__pwaMarker'))).toBe('still here');
    expect(
      await page.locator('.event-log-message', { hasText: /Rolled/ }).count(),
    ).toBeGreaterThanOrEqual(rolled);

    // Back home, the prompt appears; still nothing reloads until "Reload" is pressed.
    await leaveGameTo(page, '#/');
    await expect(prompt).toBeVisible();
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => Reflect.get(window, '__pwaMarker'))).toBe('still here');

    await Promise.all([
      page.waitForEvent('load'),
      prompt.getByRole('button', { name: 'Reload' }).click(),
    ]);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, '__pwaMarker')))
      .toBeUndefined();
    await expect(page.locator('meta[name="hexfield-build"]')).toHaveAttribute('content', 'next');
    await expect(prompt).toHaveCount(0);
  } finally {
    await server.close();
    await rm(next, { recursive: true, force: true });
  }
});
