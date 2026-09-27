import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.use(
  process.env.CP2P_CHROMIUM_EXECUTABLE
    ? { launchOptions: { executablePath: process.env.CP2P_CHROMIUM_EXECUTABLE } }
    : { channel: 'chrome' },
);

test('four isolated Chromium contexts authenticate a mesh, transfer bulk data, and reconnect', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const byId = new Map<string, Page>();
  const byPage = new Map<Page, string>();
  const errors: string[] = [];
  try {
    await Promise.all(
      pages.map(async (page) => {
        page.on('pageerror', (error) => errors.push(error.message));
        await page.exposeBinding(
          'cp2pSignalSend',
          async ({ page: source }, to: string, value: unknown) => {
            const from = byPage.get(source);
            const destination = byId.get(to);
            if (!from || !destination) throw new Error('Unregistered browser signaling route');
            await destination.evaluate(
              ({ from: origin, value: payload }) =>
                window.cp2pHarness.receiveSignal(origin, payload),
              { from, value },
            );
          },
        );
        await page.goto('/');
        await page.addScriptTag({ type: 'module', url: '/src/dev/web-rtc-browser-harness.ts' });
        await page.waitForFunction(() => Boolean(window.cp2pHarness));
      }),
    );
    const ids = await Promise.all(
      pages.map((page, index) =>
        page.evaluate((seed) => window.cp2pHarness.identity(seed), index + 1),
      ),
    );
    ids.forEach((id, index) => {
      const page = pages[index];
      if (!page) throw new Error('Missing Chromium page');
      byId.set(id, page);
      byPage.set(page, id);
    });
    await Promise.all(
      pages.map((page, index) =>
        page.evaluate(({ seed, roster }) => window.cp2pHarness.create(seed, roster), {
          seed: index + 1,
          roster: ids,
        }),
      ),
    );
    await Promise.all(pages.map((page) => page.evaluate(() => window.cp2pHarness.begin())));
    await expect
      .poll(
        async () =>
          Promise.all(
            pages.map((page) => page.evaluate(() => window.cp2pHarness.status().peers.length)),
          ),
        { timeout: 20_000 },
      )
      .toEqual([3, 3, 3, 3]);

    const first = pages[0];
    const last = pages[3];
    const firstId = ids[0];
    const lastId = ids[3];
    if (!first || !last || !firstId || !lastId) throw new Error('Incomplete Chromium mesh');
    await first.evaluate((to) => window.cp2pHarness.send(to, false), lastId);
    await first.evaluate((to) => window.cp2pHarness.send(to, true), lastId);
    await expect
      .poll(async () => last.evaluate(() => window.cp2pHarness.status().messages), {
        timeout: 20_000,
      })
      .toEqual([
        { from: firstId, length: 3, first: 7, pattern: false },
        { from: firstId, length: 1_048_576, first: 0, pattern: true },
      ]);

    await Promise.all([
      first.evaluate((peer) => window.cp2pHarness.forceLoss(peer), lastId),
      last.evaluate((peer) => window.cp2pHarness.forceLoss(peer), firstId),
    ]);
    await expect
      .poll(
        async () =>
          Promise.all(
            [first, last].map((page) =>
              page.evaluate(() => window.cp2pHarness.status().peers.length),
            ),
          ),
        { timeout: 20_000 },
      )
      .toEqual([3, 3]);
    const changes = await first.evaluate(() => window.cp2pHarness.status().changes);
    expect(
      changes.filter((change) => change.peer === lastId).map((change) => change.online),
    ).toEqual([true, false, true]);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(
      pages.map((page) => page.evaluate(() => window.cp2pHarness.stop()).catch(() => undefined)),
    );
    await Promise.all(contexts.map((context) => context.close()));
  }
});
