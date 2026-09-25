/* eslint-disable no-await-in-loop -- Each browser action depends on the preceding game state. */
import { expect, test } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseLongestRoadLength, type Seat } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { standardFixedBoard } from '@cp2p/maps';
import type { BoardHit } from '@cp2p/renderer';
import type { DevHook } from '../src/features/devtools/hook.js';
import { LocalSession } from '../src/session/local-session.js';
import { saveBeforeGoldenInput } from './golden-save.js';

declare global {
  interface Window {
    __cp2p?: DevHook;
  }
}

interface NewGameOptions {
  players: 3 | 4;
  humans: readonly number[];
  fixedBoard?: boolean;
}

const fixedBoard = standardFixedBoard();
const fixedGraph = buildBoardGraph(fixedBoard.hexes);
function canonicalBoardHit(kind: BoardHit['kind'], id: string): BoardHit {
  switch (kind) {
    case 'hex': {
      const found = fixedGraph.hexIds.find((candidate) => candidate === id);
      if (found) return { kind, id: found };
      break;
    }
    case 'vertex': {
      const found = fixedGraph.vertexIds.find((candidate) => candidate === id);
      if (found) return { kind, id: found };
      break;
    }
    case 'edge': {
      const found = fixedGraph.edgeIds.find((candidate) => candidate === id);
      if (found) return { kind, id: found };
      break;
    }
  }
  throw new Error(`Unknown board location ${kind}:${id}`);
}
const dualResourceSites = fixedGraph.vertexIds.filter((_, index) => {
  const terrain = fixedGraph.vertexHexes[index]?.map(
    (id) => fixedBoard.hexes.find((hex) => hex.id === id)?.terrain,
  );
  return terrain?.includes('hills') && terrain.includes('forest');
});
const dualResourceSiteIds = new Set<string>(dualResourceSites);
const reservedSites = new Set<string>(
  dualResourceSites.flatMap((vertex) => [
    vertex,
    ...(fixedGraph.vertexNeighbors[fixedGraph.vertexIndex[vertex] ?? -1] ?? []),
  ]),
);
const pageErrors = new WeakMap<Page, string[]>();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

async function sourceFingerprint(): Promise<string> {
  const roots = [
    'apps/web/src',
    'apps/web/tests',
    'packages/bots/src',
    'packages/codec/src',
    'packages/engine/src',
    'packages/maps/src',
    'packages/renderer/src',
  ];
  const files: string[] = [join(repoRoot, 'apps/web/playwright.config.ts')];
  const collect = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  for (const root of roots) await collect(join(repoRoot, root));
  const hash = createHash('sha256');
  for (const path of files.toSorted()) {
    hash.update(relative(repoRoot, path));
    hash.update('\0');
    hash.update(await readFile(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function watchBrowserErrors(page: Page): string[] {
  const browserErrors: string[] = [];
  pageErrors.set(page, browserErrors);
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  return browserErrors;
}

async function capturePreview(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = await page.screenshot({ animations: 'disabled' });
  await testInfo.attach(name, { body: screenshot, contentType: 'image/png' });
  const folder = join(repoRoot, 'reports/stage05');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${name}.png`), screenshot);
}

async function expectSettledPrimaryColors(button: Locator): Promise<void> {
  await expect(button).toBeEnabled();
  await expect
    .poll(() =>
      button.evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--accent)';
        probe.style.color = 'var(--accent-text)';
        document.body.append(probe);
        const actual = getComputedStyle(element);
        const target = getComputedStyle(probe);
        const settled =
          actual.backgroundColor === target.backgroundColor && actual.color === target.color;
        probe.remove();
        return settled;
      }),
    )
    .toBe(true);
}

async function createGame(page: Page, options: NewGameOptions): Promise<void> {
  const browserErrors = watchBrowserErrors(page);
  await page.goto('/#/local/new');
  await page.getByLabel('Player count').selectOption(String(options.players));
  for (let seat = 0; seat < options.players; seat++) {
    await page
      .getByLabel(`Player ${seat + 1} control`)
      .selectOption(options.humans.includes(seat) ? 'human' : 'bot');
  }
  if (options.fixedBoard) await page.getByLabel('Map layout').selectOption('standard-fixed');
  await page.getByText('Advanced rules').click();
  await page.getByLabel('Bot pace, milliseconds').fill('0');
  await page.getByRole('button', { name: 'Create game' }).click();
  await expect(page).toHaveURL(/#\/local\/[^/]+$/);
  if (await page.getByRole('heading', { name: "This page couldn't load." }).isVisible())
    throw new Error(`Game route failed: ${browserErrors.join(' | ')}`);
  await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__cp2p')))).toBe(true);
}

async function openGoldenPrefix(
  page: Page,
  stopBefore: number,
  file = 'normal-completion.replay.json',
  options: { humanSeats?: readonly Seat[]; botDelayMs?: number } = {},
): Promise<void> {
  const verified = await saveBeforeGoldenInput(file, stopBefore);
  const save = options.humanSeats
    ? {
        ...verified,
        roles: {
          humanSeats: [...options.humanSeats],
          botSeats: verified.config.seats.filter((seat) => !options.humanSeats?.includes(seat)),
        },
      }
    : verified;
  const id = `golden-prefix-${stopBefore}`;
  const revision =
    save.genesis.length + save.batches.reduce((sum, batch) => sum + 1 + batch.generated.length, 0);
  const colors = ['blue', 'orange', 'green', 'magenta'] as const;
  const shapes = ['circle', 'triangle', 'square', 'diamond'] as const;
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
      botDelayMs: options.botDelayMs ?? 0,
    },
    save,
  };
  watchBrowserErrors(page);
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: `hexfield:save:v1:${id}`,
    value: JSON.stringify(record),
  });
  await page.goto(`/#/local/${id}`);
  await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__cp2p')))).toBe(true);
  await revealIfCovered(page);
  await expect(page.getByRole('heading', { name: "This page couldn't load." })).toBeHidden();
}

async function readPresent<T>(
  page: Page,
  label: string,
  read: () => Promise<T | null>,
): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (value !== null) return value;
    await page.waitForTimeout(20);
  }
  throw new Error(`${label} is unavailable`);
}

async function observedRevision(page: Page): Promise<number> {
  return readPresent(page, 'Game revision', () =>
    page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      return hook?.diagnostics().revision ?? null;
    }),
  );
}

async function revealIfCovered(page: Page, input: 'mouse' | 'touch' = 'mouse'): Promise<void> {
  const reveal = page.getByRole('button', { name: 'Reveal hand' });
  if (await reveal.isVisible()) {
    if (input === 'touch') await reveal.tap();
    else await reveal.click();
  }
}

async function openGameMenu(page: Page): Promise<void> {
  const menu = page.locator('.game-menu');
  if (!(await menu.evaluate((element) => element instanceof HTMLDetailsElement && element.open)))
    await menu.locator(':scope > summary').click();
}

test('four zero-delay bots finish a default ten-point game on the game screen', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'chromium', 'Long local-game acceptance runs in Chromium');
  test.setTimeout(180_000);
  await createGame(page, { players: 4, humans: [] });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
          return hook?.session.getState().result?.winner ?? null;
        }),
      { timeout: 150_000 },
    )
    .not.toBeNull();
  const gameOver = page.getByRole('dialog', { name: /Player \d+ wins/ });
  await expect(gameOver).toBeVisible();
  const winnerSeat = await page.evaluate(() => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    return hook?.session.getState().result?.winner ?? null;
  });
  if (winnerSeat === null) throw new Error('Completed game has no winner');
  await expect(
    gameOver.getByRole('heading', { name: `Player ${winnerSeat + 1} wins` }),
  ).toBeVisible();
  const target = await page.evaluate(() => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    const base = hook?.session.getState().config.options.base;
    return typeof base === 'object' && base !== null && Reflect.get(base, 'vpTarget');
  });
  expect(target).toBe(10);
  expect(pageErrors.get(page)).toEqual([]);
});

test('leaving a rematch prompts from the new game and saves before navigation', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'chromium', 'Local rematch runs in Chromium');
  test.setTimeout(180_000);
  await createGame(page, { players: 4, humans: [] });
  const firstGameUrl = page.url();
  await expect(page.getByRole('dialog', { name: /Player \d+ wins/ })).toBeVisible({
    timeout: 150_000,
  });
  await page.getByRole('button', { name: 'Rematch' }).click();
  await expect(page).toHaveURL(/#\/local\/[^/]+$/);
  await expect.poll(() => page.url()).not.toBe(firstGameUrl);
  await openGameMenu(page);
  await page.getByRole('button', { name: 'Leave game' }).click();
  const prompt = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: 'Leave this game?' }),
  });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Stay' }).click();
  await expect(page).toHaveURL(/#\/local\/[^/]+$/);
  await openGameMenu(page);
  await page.getByRole('button', { name: 'Leave game' }).click();
  await prompt.getByRole('button', { name: 'Save and leave' }).click();
  await expect(page).toHaveURL(/#\/$/);
  expect(pageErrors.get(page)).toEqual([]);
});

test('claimed VP cards appear once in fullscreen results, which reopen after dismissal and reload', async ({
  browser,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Results layout is checked in Chromium');
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    const context = await browser.newContext({ viewport });
    try {
      const page = await context.newPage();
      await page.emulateMedia({ colorScheme: 'dark' });
      await openGoldenPrefix(page, 597, 'hidden-vp-win.replay.json');
      const results = page.getByRole('dialog', { name: 'Player 1 wins' });
      await expect(results).toBeVisible();
      await expect(results.locator('.results-hero')).toContainText('10');
      await expect(results.locator('.results-score-parts > div')).toContainText([
        'Buildings6',
        'Awards2',
        'VP cards2',
      ]);
      await expect(results.locator('.results-standing').first()).toContainText('Player 1');
      await expect(results.locator('.results-standing')).toHaveCount(4);
      if (viewport.height >= 720) {
        const body = await results.locator('.results-body').boundingBox();
        const lastStanding = await results.locator('.results-standing').last().boundingBox();
        if (!body || !lastStanding) throw new Error('Initial standings bounds missing');
        expect(lastStanding.y + lastStanding.height).toBeLessThanOrEqual(body.y + body.height + 1);
      }
      await capturePreview(page, testInfo, `${viewport.width}-claimed-vp-results-initial`);
      const stats = results.locator('.results-stats');
      if (
        !(await stats.evaluate((details) => details instanceof HTMLDetailsElement && details.open))
      )
        await stats.getByText('Game statistics').click();
      await results.locator('.results-body').evaluate((body) => {
        body.scrollTop = body.scrollHeight;
      });
      const bounds = await results.evaluate((dialog) => {
        const body = dialog.querySelector('.results-body');
        const footer = dialog.querySelector('.results-footer');
        if (!body || !footer) throw new Error('Results regions missing');
        const box = dialog.getBoundingClientRect();
        const bodyBox = body.getBoundingClientRect();
        const footerBox = footer.getBoundingClientRect();
        return {
          dialog: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
          bodyBottom: bodyBox.bottom,
          footerTop: footerBox.top,
          footerBottom: footerBox.bottom,
          buttons: [...footer.querySelectorAll('button')].map((button) => {
            const rect = button.getBoundingClientRect();
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
          }),
        };
      });
      expect(bounds.dialog.left).toBeGreaterThanOrEqual(-1);
      expect(bounds.dialog.top).toBeGreaterThanOrEqual(-1);
      expect(bounds.dialog.right).toBeLessThanOrEqual(viewport.width + 1);
      expect(bounds.dialog.bottom).toBeLessThanOrEqual(viewport.height + 1);
      expect(bounds.bodyBottom).toBeLessThanOrEqual(bounds.footerTop + 1);
      expect(bounds.footerBottom).toBeLessThanOrEqual(bounds.dialog.bottom + 1);
      for (const button of bounds.buttons) {
        expect(button.left).toBeGreaterThanOrEqual(bounds.dialog.left - 1);
        expect(button.right).toBeLessThanOrEqual(bounds.dialog.right + 1);
        expect(button.top).toBeGreaterThanOrEqual(bounds.footerTop - 1);
        expect(button.bottom).toBeLessThanOrEqual(bounds.dialog.bottom + 1);
      }
      await capturePreview(page, testInfo, `${viewport.width}-claimed-vp-results-expanded`);

      if (viewport.width === 1280) {
        const downloadPromise = page.waitForEvent('download');
        await results.getByRole('button', { name: 'Export replay JSON' }).click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toMatch(/\.replay\.json$/);
      }
      await results.getByRole('button', { name: 'View board' }).click();
      await expect(results).toBeHidden();
      await expect(page.getByRole('region', { name: 'Game board' })).toBeVisible();
      await expect(page.locator('.placement-confirmation')).toHaveCount(0);
      await expect(page.locator('.board-offers button')).toHaveCount(0);
      await page.locator('.game-bottom').getByRole('button', { name: 'Results' }).click();
      await expect(results).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(results).toBeHidden();
      await openGameMenu(page);
      await page.locator('.game-menu-panel').getByRole('button', { name: 'Results' }).click();
      await expect(results).toBeVisible();
      await page.reload();
      await expect(results).toBeVisible();
      expect(pageErrors.get(page)).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

test('a replay-backed bank trade uses the visible multi-resource form', async ({
  page,
}, testInfo) => {
  test.skip(test.info().project.name !== 'chromium', 'Local trade forms run in Chromium');
  await page.emulateMedia({ colorScheme: 'dark' });
  await openGoldenPrefix(page, 102);
  const before = await observedRevision(page);
  await page.getByRole('button', { name: 'Bank trade' }).click();
  const dialog = page.getByRole('dialog', { name: 'Bank trade' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Add Brick to You give' }).click();
  await dialog.getByRole('button', { name: 'Add Grain to Bank gives' }).click();
  await capturePreview(page, testInfo, 'bank-card-trade-selection');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect.poll(() => observedRevision(page)).toBeGreaterThan(before);
  expect(pageErrors.get(page)).toEqual([]);
});

test('a replay-backed trade offer and named confirmations use visible controls', async ({
  page,
}, testInfo) => {
  test.skip(test.info().project.name !== 'chromium', 'Local trade forms run in Chromium');
  await page.emulateMedia({ colorScheme: 'dark' });
  await openGoldenPrefix(page, 22);
  const before = await observedRevision(page);
  await page.getByRole('button', { name: 'Offer trade' }).click();
  const dialog = page.getByRole('dialog', { name: 'Player trade' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Add Lumber to You give' }).click();
  await dialog.getByRole('button', { name: 'Add Ore to You get' }).click();
  await expect(dialog.getByRole('heading', { name: 'Player trade' })).toBeInViewport();
  await expect(dialog.getByRole('group', { name: 'You give' })).toBeVisible();
  await expect(dialog.getByRole('group', { name: 'You get' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Send offer' })).toBeInViewport();
  await expect(dialog.locator('.trade-dialog-preview')).toHaveCount(0);
  await capturePreview(page, testInfo, 'player-card-trade-selection');
  await dialog.getByRole('button', { name: 'Send offer' }).click();
  await expect.poll(() => observedRevision(page)).toBeGreaterThan(before);
  expect(pageErrors.get(page)).toEqual([]);

  const second = await page.context().newPage();
  try {
    await openGoldenPrefix(second, 35);
    const responses = second.getByRole('list', { name: 'Player responses' });
    await expect(
      responses.locator('li[data-status="accepted"]').filter({ hasText: 'Player 1' }),
    ).toBeVisible();
    await expect(
      responses.locator('li[data-status="accepted"]').filter({ hasText: 'Player 2' }),
    ).toBeVisible();
    await expect(
      responses.locator('li[data-status="declined"]').filter({ hasText: 'Player 3' }),
    ).toBeVisible();
    const one = second.getByRole('button', { name: 'Trade with Player 1' });
    const two = second.getByRole('button', { name: 'Trade with Player 2' });
    await expect(one).toBeVisible();
    await expect(two).toBeVisible();
    const revision = await observedRevision(second);
    await two.click();
    await expect.poll(() => observedRevision(second)).toBeGreaterThan(revision);
    expect(pageErrors.get(second)).toEqual([]);
  } finally {
    await second.close();
  }
});

test('mobile Actions hands off bank and player trades to one visible dialog', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Touch trade handoff runs in Chromium');
  for (const trade of [
    { prefix: 102, action: 'Bank trade', dialog: 'Bank trade' },
    { prefix: 22, action: 'Offer trade', dialog: 'Player trade' },
  ]) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      await openGoldenPrefix(page, trade.prefix);
      const revision = await observedRevision(page);
      const trigger = page.locator('.next-step-actions');
      await trigger.tap();
      const actions = page.getByRole('dialog', { name: 'Actions' });
      await expect(actions).toBeVisible();
      await actions.getByRole('button', { name: trade.action }).tap();
      await expect(actions).toBeHidden();
      const form = page.getByRole('dialog', { name: trade.dialog });
      await expect(form).toBeVisible();
      await expect(page.locator('dialog[open]')).toHaveCount(1);
      await form.getByRole('button', { name: 'Cancel' }).tap();
      await expect(form).toBeHidden();
      await expect(trigger).toBeFocused();
      expect(await observedRevision(page)).toBe(revision);
      expect(pageErrors.get(page)).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

test('an incoming replay-backed offer shows the exact viewer-relative card exchange', async ({
  page,
}, testInfo) => {
  test.skip(test.info().project.name !== 'chromium', 'Local offer view runs in Chromium');
  await page.emulateMedia({ colorScheme: 'dark' });
  await openGoldenPrefix(page, 32);
  await page.getByText('Optional trade actions').click();
  await page.getByRole('button', { name: "View Player 1's trade options" }).click();
  await page.getByRole('button', { name: 'Reveal hand' }).click();
  const offers = page.getByRole('region', { name: 'Trade offers' });
  await expect(offers.getByText('Offer from Player 4')).toBeVisible();
  const details = offers.locator('details');
  if (!(await details.evaluate((element) => element instanceof HTMLDetailsElement && element.open)))
    await offers.getByText('Offer from Player 4').click();
  const receive = offers.getByRole('group', { name: 'You get' });
  const give = offers.getByRole('group', { name: 'You give' });
  await expect(receive.getByText('Wool')).toBeVisible();
  await expect(give.getByText('Ore')).toBeVisible();
  await expect(offers.getByRole('button', { name: 'Accept' })).toBeVisible();
  await expect(offers.getByRole('button', { name: 'Decline' })).toBeVisible();
  await capturePreview(page, testInfo, 'incoming-recipient-offer');
  expect(pageErrors.get(page)).toEqual([]);
});

test('trade recipients remain above the modal footer at desktop and phone sizes', async ({
  browser,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Trade modal layout runs in Chromium');
  for (const device of [
    { name: 'desktop-wide', width: 1728, height: 944, mobile: false },
    { name: 'desktop-compact', width: 1280, height: 720, mobile: false },
    { name: 'phone', width: 390, height: 844, mobile: true },
    { name: 'phone-landscape', width: 844, height: 390, mobile: true },
  ] as const) {
    const context = await browser.newContext({
      viewport: { width: device.width, height: device.height },
      colorScheme: 'dark',
      isMobile: device.mobile,
      hasTouch: device.mobile,
    });
    try {
      const page = await context.newPage();
      await openGoldenPrefix(page, 22);
      const offerTrade = await revealActionButton(
        page,
        'Offer trade',
        device.mobile ? 'touch' : 'mouse',
      );
      if (device.mobile) await offerTrade.tap();
      else await offerTrade.click();
      const dialog = page.getByRole('dialog', { name: 'Player trade' });
      await dialog.getByRole('button', { name: 'Add Lumber to You give' }).click();
      await dialog.getByRole('button', { name: 'Add Ore to You get' }).click();
      const brickCard = dialog.getByRole('button', { name: 'Add Brick to You get' });
      const centeredArt = async (button: typeof brickCard, state: string) => {
        const centers = await button.evaluate((element) => {
          const art = element.querySelector('img')?.getBoundingClientRect();
          const target = element.getBoundingClientRect();
          return {
            artX: art ? art.left + art.width / 2 : Infinity,
            targetX: target.left + target.width / 2,
          };
        });
        expect(
          Math.abs(centers.artX - centers.targetX),
          `${device.name} ${state} target shifts from card art`,
        ).toBeLessThanOrEqual(0.5);
      };
      await centeredArt(brickCard, 'idle');
      await centeredArt(dialog.getByRole('button', { name: 'Add Lumber to You give' }), 'selected');
      if (!device.mobile) await brickCard.hover();
      await centeredArt(brickCard, 'hovered');
      const recipients = dialog.locator('.trade-recipients');
      await recipients.scrollIntoViewIfNeeded();
      const geometry = await dialog.evaluate((element) => {
        const heading = element.querySelector('h2')?.getBoundingClientRect();
        const body = element.querySelector('.trade-dialog-body')?.getBoundingClientRect();
        const recipientBounds = element.querySelector('.trade-recipients')?.getBoundingClientRect();
        const footer = element.querySelector('.trade-dialog-footer')?.getBoundingClientRect();
        return {
          headingTop: heading?.top ?? -1,
          bodyBottom: body?.bottom ?? Infinity,
          recipientsTop: recipientBounds?.top ?? -1,
          recipientsBottom: recipientBounds?.bottom ?? Infinity,
          footerTop: footer?.top ?? -1,
          footerBottom: footer?.bottom ?? Infinity,
        };
      });
      expect(geometry.headingTop, `${device.name} trade title is clipped`).toBeGreaterThanOrEqual(
        0,
      );
      expect(
        geometry.recipientsTop,
        `${device.name} recipients start under the header`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        geometry.recipientsBottom,
        `${device.name} recipients are clipped by footer`,
      ).toBeLessThanOrEqual(geometry.footerTop + 1);
      expect(geometry.bodyBottom, `${device.name} body overlaps footer`).toBeLessThanOrEqual(
        geometry.footerTop + 1,
      );
      expect(geometry.footerBottom, `${device.name} footer leaves viewport`).toBeLessThanOrEqual(
        device.height + 2,
      );
      await capturePreview(page, testInfo, `${device.name}-trade-modal`);
      expect(pageErrors.get(page)).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

test('card picker keeps keyboard focus after removing the final card or clearing a side', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'chromium', 'Card picker keyboard focus runs in Chromium');
  await openGoldenPrefix(page, 22);
  await page.getByRole('button', { name: 'Offer trade' }).click();
  const dialog = page.getByRole('dialog', { name: 'Player trade' });
  const addBrick = dialog.getByRole('button', { name: 'Add Brick to You get' });
  await addBrick.click();
  const removeBrick = dialog.getByRole('button', { name: 'Remove Brick from You get' });
  await removeBrick.focus();
  await page.keyboard.press('Enter');
  await expect(removeBrick).toBeHidden();
  await expect(addBrick).toBeFocused();

  const addLumber = dialog.getByRole('button', { name: 'Add Lumber to You get' });
  await addLumber.click();
  const clear = dialog.getByRole('button', { name: 'Clear You get' });
  await clear.focus();
  await page.keyboard.press('Enter');
  await expect(clear).toBeDisabled();
  await expect(addBrick).toBeFocused();
});

test('a replay-backed development card enters the visible robber flow', async ({
  browser,
  page,
}, testInfo) => {
  test.skip(test.info().project.name !== 'chromium', 'Development card flow runs in Chromium');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await openGoldenPrefix(page, 124);
  const before = await page.evaluate(() => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    if (!hook) return null;
    const seat = hook.session.getState().turn.activeSeat;
    return {
      revision: hook.diagnostics().revision,
      hash: hook.diagnostics().hash,
      slots: Object.keys(hook.session.getPrivate(seat)?.slots ?? {}).length,
    };
  });
  expect(before).not.toBeNull();
  if (!before) throw new Error('Knight fixture has no active game');
  const action = page.locator('.action-dock').getByRole('button', { name: 'Play Knight' });
  const knight = page
    .locator('.hand-dock > .development-hand .development-card')
    .filter({ hasText: 'Knight' });
  const cardAction = knight.getByRole('button', { name: 'Knight', exact: true });
  const confirmation = knight.getByRole('group', { name: 'Play Knight?' });
  const assertIntentFits = async (screen: Page, card: Locator, name: string) => {
    const bounds = await card.evaluate((element) => {
      const art = element.querySelector('.development-card-art');
      const image = art?.querySelector('img');
      const label = element.querySelector('strong');
      const hand = element.closest('.development-hand');
      const controls = [...element.querySelectorAll('.knight-card-choice')];
      if (!art || !image || !label || !hand || controls.length !== 2) return null;
      const artRect = art.getBoundingClientRect();
      const imageRect = image.getBoundingClientRect();
      const cardRect = element.getBoundingClientRect();
      const handRect = hand.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      return {
        art: { left: artRect.left, right: artRect.right, top: artRect.top, bottom: artRect.bottom },
        image: { left: imageRect.left, right: imageRect.right, top: imageRect.top },
        hand: { left: handRect.left, right: handRect.right, top: handRect.top },
        card: {
          left: cardRect.left,
          right: cardRect.right,
          top: cardRect.top,
          bottom: cardRect.bottom,
        },
        label: { top: labelRect.top, bottom: labelRect.bottom },
        controls: controls.map((control) => {
          const rect = control.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        }),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    });
    await capturePreview(screen, testInfo, name);
    if (!bounds) throw new Error('Knight art, name, or controls are missing');
    expect(bounds.image.top, `${name} clips selected outline at hand top`).toBeGreaterThanOrEqual(
      bounds.hand.top + 1,
    );
    expect(bounds.image.left, `${name} clips selected outline at hand edge`).toBeGreaterThanOrEqual(
      bounds.hand.left + 1,
    );
    expect(bounds.image.right, `${name} clips selected outline at hand edge`).toBeLessThanOrEqual(
      bounds.hand.right - 1,
    );
    expect(bounds.label.top, `${name} covers the card name`).toBeGreaterThanOrEqual(
      Math.max(...bounds.controls.map((control) => control.bottom)) - 1,
    );
    expect(bounds.label.bottom, `${name} clips the card name`).toBeLessThanOrEqual(
      bounds.viewportHeight,
    );
    for (const control of bounds.controls) {
      expect(control.left, `${name} control leaves card`).toBeGreaterThanOrEqual(
        bounds.card.left - 1,
      );
      expect(control.right, `${name} control leaves card`).toBeLessThanOrEqual(
        bounds.card.right + 1,
      );
      expect(control.top, `${name} control leaves card`).toBeGreaterThanOrEqual(
        bounds.card.top - 1,
      );
      expect(control.bottom, `${name} control leaves card`).toBeLessThanOrEqual(
        bounds.card.bottom + 1,
      );
      expect(
        (control.top + control.bottom) / 2,
        `${name} control misses art bottom`,
      ).toBeGreaterThanOrEqual(bounds.art.bottom - 20);
      expect(
        (control.top + control.bottom) / 2,
        `${name} control misses art bottom`,
      ).toBeLessThanOrEqual(bounds.art.bottom + 1);
      expect(control.left).toBeGreaterThanOrEqual(0);
      expect(control.right).toBeLessThanOrEqual(bounds.viewportWidth);
      expect(control.bottom).toBeLessThanOrEqual(bounds.viewportHeight);
    }
  };
  const assertUncommitted = async () => {
    expect(await observedRevision(page)).toBe(before.revision);
    const after = await page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      if (!hook) return null;
      const seat = hook.session.getState().turn.activeSeat;
      return {
        hash: hook.diagnostics().hash,
        slots: Object.keys(hook.session.getPrivate(seat)?.slots ?? {}).length,
      };
    });
    expect(after).toEqual({ hash: before.hash, slots: before.slots });
  };
  await action.click();
  await expect(confirmation).toBeVisible();
  await assertIntentFits(page, knight, 'desktop-knight-intent');
  await assertUncommitted();
  await confirmation.getByRole('button', { name: 'Cancel Knight' }).click();
  await expect(confirmation).toBeHidden();
  await assertUncommitted();
  await cardAction.click();
  await expect(confirmation).toBeVisible();
  await assertUncommitted();
  await cardAction.click();
  await expect(confirmation).toBeHidden();
  await assertUncommitted();
  await page.setViewportSize({ width: 1024, height: 768 });
  await cardAction.focus();
  await page.keyboard.press('Enter');
  await expect(confirmation).toBeVisible();
  await assertIntentFits(page, knight, 'compact-desktop-knight-intent');
  await page.keyboard.press('Escape');
  await expect(confirmation).toBeHidden();
  await assertUncommitted();
  await cardAction.focus();
  await page.keyboard.press('Space');
  await expect(confirmation).toBeVisible();
  await assertUncommitted();
  await confirmation.getByRole('button', { name: 'Cancel Knight' }).click();
  await expect(confirmation).toBeHidden();
  await assertUncommitted();
  await action.click();
  await action.click();
  await expect(confirmation).toBeHidden();
  await assertUncommitted();
  await action.click();
  await confirmation.getByRole('button', { name: 'Play Knight' }).click();
  await expect.poll(() => observedRevision(page)).toBeGreaterThan(before.revision);
  const afterPlay = await page.evaluate(() => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    if (!hook) return null;
    const seat = hook.session.getState().turn.activeSeat;
    return Object.keys(hook.session.getPrivate(seat)?.slots ?? {}).length;
  });
  expect(afterPlay).toBe(before.slots - 1);
  const target = await readPresent(page, 'Robber target', () =>
    page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      return hook?.diagnostics().actions?.placements.robber[0]?.id ?? null;
    }),
  );
  await chooseBoardPlacement(page, 'hex', target, before.revision + 1);
  expect(pageErrors.get(page)).toEqual([]);

  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const phone = await mobile.newPage();
    await openGoldenPrefix(phone, 124);
    const tapPhoneKnight = async () =>
      (await revealActionButton(phone, 'Play Knight', 'touch')).tap();
    const phoneDialog = phone.getByRole('dialog', { name: 'Development cards: 1' });
    const phoneKnight = phoneDialog.locator('.development-card').filter({ hasText: 'Knight' });
    const phoneConfirmation = phoneKnight.getByRole('group', { name: 'Play Knight?' });
    const initial = await phone.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      return hook ? { revision: hook.diagnostics().revision, hash: hook.diagnostics().hash } : null;
    });
    if (!initial) throw new Error('Phone Knight fixture has no diagnostics');
    const assertPhoneUncommitted = async () => {
      expect(await observedRevision(phone)).toBe(initial.revision);
      expect(
        await phone.evaluate(() => {
          const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
          return hook?.diagnostics().hash ?? null;
        }),
      ).toBe(initial.hash);
    };
    await tapPhoneKnight();
    await expect(phone.getByRole('dialog', { name: 'Actions' })).toBeHidden();
    await expect(phoneDialog).toBeVisible();
    await expect(phoneConfirmation).toBeVisible();
    await assertIntentFits(phone, phoneKnight, 'phone-knight-intent');
    await assertPhoneUncommitted();
    await phoneConfirmation.getByRole('button', { name: 'Cancel Knight' }).tap();
    await expect(phoneDialog).toBeHidden();
    await assertPhoneUncommitted();
    await tapPhoneKnight();
    await expect(phoneDialog).toBeVisible();
    await phone.keyboard.press('Escape');
    await expect(phoneDialog).toBeHidden();
    await assertPhoneUncommitted();
    await tapPhoneKnight();
    await expect(phoneDialog).toBeVisible();
    await phoneDialog.getByRole('button', { name: 'Close cards' }).tap();
    await expect(phoneDialog).toBeHidden();
    await assertPhoneUncommitted();
    await phone.getByRole('button', { name: 'Development cards: 1' }).tap();
    await phoneKnight.getByRole('button', { name: 'Knight', exact: true }).tap();
    await expect(phoneConfirmation).toBeVisible();
    await assertPhoneUncommitted();
    await phoneKnight.getByRole('button', { name: 'Knight', exact: true }).tap();
    await expect(phoneConfirmation).toBeHidden();
    await assertPhoneUncommitted();
    await phoneDialog.getByRole('button', { name: 'Close cards' }).tap();
    await expect(phoneDialog).toBeHidden();
    await tapPhoneKnight();
    await phoneConfirmation.getByRole('button', { name: 'Play Knight' }).tap();
    await expect.poll(() => observedRevision(phone)).toBeGreaterThan(initial.revision);
    expect(pageErrors.get(phone)).toEqual([]);
  } finally {
    await mobile.close();
  }
});

test('replay-backed Year of Plenty and Monopoly use the visible card dialogs', async ({
  page,
}, testInfo) => {
  test.skip(test.info().project.name !== 'chromium', 'Development card flow runs in Chromium');
  await openGoldenPrefix(page, 289, 'all-development-card-types.replay.json');
  const before = await observedRevision(page);
  await page.getByRole('button', { name: 'Play Year of plenty' }).click();
  const plenty = page.getByRole('dialog', { name: 'Year of Plenty' });
  await expect(plenty).toBeVisible();
  const addGrain = plenty.getByRole('button', { name: 'Add Grain to Resources to take' });
  await addGrain.click();
  await addGrain.click();
  await expect(plenty.locator('.trade-card-add img')).toHaveCount(5);
  expect(await observedRevision(page)).toBe(before);
  await plenty.getByRole('button', { name: 'Cancel' }).click();
  await expect(plenty).toBeHidden();
  expect(await observedRevision(page)).toBe(before);
  await page.getByRole('button', { name: 'Play Year of plenty' }).click();
  await expect(plenty).toBeVisible();
  await addGrain.click();
  await addGrain.click();
  await expectSettledPrimaryColors(plenty.getByRole('button', { name: 'Confirm' }));
  await capturePreview(page, testInfo, 'year-of-plenty-cards-desktop');
  await plenty.getByRole('button', { name: 'Confirm' }).click();
  await expect.poll(() => observedRevision(page)).toBeGreaterThan(before);
  expect(pageErrors.get(page)).toEqual([]);

  const monopolyPage = await page.context().newPage();
  try {
    await monopolyPage.setViewportSize({ width: 390, height: 844 });
    await openGoldenPrefix(monopolyPage, 226, 'all-development-card-types.replay.json');
    const revision = await observedRevision(monopolyPage);
    await (await revealActionButton(monopolyPage, 'Play Monopoly', 'mouse')).click();
    const monopoly = monopolyPage.getByRole('dialog', { name: 'Monopoly' });
    await expect(monopoly).toBeVisible();
    await monopoly.getByRole('button', { name: 'Add Brick to Resource to collect' }).click();
    await monopoly.getByRole('button', { name: 'Add Ore to Resource to collect' }).click();
    await expect(monopoly.locator('.trade-card-add img')).toHaveCount(5);
    await expect(monopoly.locator('.trade-card-choice').first()).toHaveAttribute(
      'data-selected',
      'false',
    );
    await expect(monopoly.locator('.trade-card-choice').last()).toHaveAttribute(
      'data-selected',
      'true',
    );
    expect(await observedRevision(monopolyPage)).toBe(revision);
    await expectSettledPrimaryColors(monopoly.getByRole('button', { name: 'Confirm' }));
    await capturePreview(monopolyPage, testInfo, 'monopoly-cards-phone');
    await monopoly.getByRole('button', { name: 'Confirm' }).click();
    await expect.poll(() => observedRevision(monopolyPage)).toBeGreaterThan(revision);
    expect(pageErrors.get(monopolyPage)).toEqual([]);
  } finally {
    await monopolyPage.close();
  }
});

test('a replay-backed Road Building card places a free road on the board', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium', 'Development card flow runs in Chromium');
  await openGoldenPrefix(page, 97, 'all-development-card-types.replay.json');
  const before = await observedRevision(page);
  await page.getByRole('button', { name: 'Play Road building' }).click();
  await expect.poll(() => observedRevision(page)).toBeGreaterThan(before);
  const firstTarget = () =>
    page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      return hook?.diagnostics().actions?.placements.freeRoad[0]?.id ?? null;
    });
  await expect.poll(firstTarget).not.toBeNull();
  const target = await firstTarget();
  expect(target).not.toBeNull();
  if (target) await chooseBoardPlacement(page, 'edge', target, before + 1);
  const afterRoad = await observedRevision(page);
  const skip = page.getByRole('button', { name: 'Skip free road' });
  await expect(skip).toBeVisible();
  await skip.click();
  await expect.poll(() => observedRevision(page)).toBeGreaterThan(afterRoad);
  expect(pageErrors.get(page)).toEqual([]);
});

test('a replay-backed city upgrade previews a legal site before spending resources', async ({
  page,
}, testInfo) => {
  await openGoldenPrefix(page, 42);
  const city = await readPresent(page, 'Legal city upgrade', () =>
    page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      const state = hook?.session.getState();
      const choice = hook?.diagnostics().actions?.placements.city[0];
      const hand = hook?.session.getPrivate(1)?.hand;
      if (!state || !choice || !hand) return null;
      return {
        id: choice.id,
        revision: hook.diagnostics().revision,
        grain: hand.grain ?? 0,
        ore: hand.ore ?? 0,
        cityPieces: state.seats[1]?.piecesLeft.city,
        settlementPieces: state.seats[1]?.piecesLeft.settlement,
      };
    }),
  );
  const cityAction = page
    .getByRole('group', { name: 'Choose a board action' })
    .getByRole('button', { name: 'Upgrade city' });
  await cityAction.click();
  await expect(cityAction).toHaveAttribute('aria-pressed', 'true');
  await cityAction.click();
  await expect(cityAction).toHaveAttribute('aria-pressed', 'false');
  expect(await observedRevision(page)).toBe(city.revision);
  await cityAction.click();
  await capturePreview(page, testInfo, 'city-legal-upgrades');
  await selectBoardPlacement(page, 'vertex', city.id);
  await expect(page.getByRole('button', { name: 'Confirm city' })).toBeVisible();
  expect(await observedRevision(page)).toBe(city.revision);
  await page
    .getByRole('region', { name: 'Game board' })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Confirm city' })).toBeHidden();
  expect(await observedRevision(page)).toBe(city.revision);
  await page
    .getByRole('group', { name: 'Choose a board action' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  await expect(cityAction).toHaveAttribute('aria-pressed', 'false');
  expect(await observedRevision(page)).toBe(city.revision);
  await cityAction.click();
  await selectBoardPlacement(page, 'vertex', city.id);
  await capturePreview(page, testInfo, 'city-preview-confirmation');
  await confirmPlacement(page, 'city', city.revision);
  const after = await page.evaluate((vertex) => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    const state = hook?.session.getState();
    const hand = hook?.session.getPrivate(1)?.hand;
    return {
      kind: state?.board.buildings.find((building) => building.vertex === vertex)?.kind,
      grain: hand?.grain,
      ore: hand?.ore,
      cityPieces: state?.seats[1]?.piecesLeft.city,
      settlementPieces: state?.seats[1]?.piecesLeft.settlement,
    };
  }, city.id);
  expect(after).toEqual({
    kind: 'city',
    grain: city.grain - 2,
    ore: city.ore - 3,
    cityPieces: city.cityPieces === undefined ? undefined : city.cityPieces - 1,
    settlementPieces: city.settlementPieces === undefined ? undefined : city.settlementPieces + 1,
  });
  expect(pageErrors.get(page)).toEqual([]);
});

test('a replay-backed paid settlement commits only after confirmation', async ({ page }) => {
  await openGoldenPrefix(page, 194);
  const before = await readPresent(page, 'Legal settlement target', () =>
    page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      const state = hook?.session.getState();
      const choice = hook?.diagnostics().actions?.placements.settlement[0];
      const hand = hook?.session.getPrivate(0)?.hand;
      if (!state || !choice || !hand) return null;
      return {
        id: choice.id,
        revision: hook.diagnostics().revision,
        buildings: state.board.buildings.length,
        pieces: state.seats[0]?.piecesLeft.settlement,
        hand: {
          brick: hand.brick ?? 0,
          lumber: hand.lumber ?? 0,
          wool: hand.wool ?? 0,
          grain: hand.grain ?? 0,
        },
      };
    }),
  );
  await page
    .getByRole('group', { name: 'Choose a board action' })
    .getByRole('button', { name: 'Build settlement' })
    .click();
  await selectBoardPlacement(page, 'vertex', before.id);
  await expect(page.getByRole('button', { name: 'Confirm settlement' })).toBeVisible();
  expect(await observedRevision(page)).toBe(before.revision);
  await page
    .getByRole('region', { name: 'Game board' })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  expect(await observedRevision(page)).toBe(before.revision);
  await selectBoardPlacement(page, 'vertex', before.id);
  await confirmPlacement(page, 'settlement', before.revision);
  const after = await page.evaluate((vertex) => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    const state = hook?.session.getState();
    const hand = hook?.session.getPrivate(0)?.hand;
    return {
      building: state?.board.buildings.find((piece) => piece.vertex === vertex)?.kind,
      buildings: state?.board.buildings.length,
      pieces: state?.seats[0]?.piecesLeft.settlement,
      hand: {
        brick: hand?.brick ?? 0,
        lumber: hand?.lumber ?? 0,
        wool: hand?.wool ?? 0,
        grain: hand?.grain ?? 0,
      },
    };
  }, before.id);
  expect(after).toEqual({
    building: 'settlement',
    buildings: before.buildings + 1,
    pieces: before.pieces === undefined ? undefined : before.pieces - 1,
    hand: {
      brick: before.hand.brick - 1,
      lumber: before.hand.lumber - 1,
      wool: before.hand.wool - 1,
      grain: before.hand.grain - 1,
    },
  });
  expect(pageErrors.get(page)).toEqual([]);
});

test('game cockpit fits desktop, compact, and phone viewports without document scrolling', async ({
  browser,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Cockpit layout acceptance runs in Chromium');
  for (const device of [
    { name: 'desktop-wide', width: 1728, height: 960, mobile: false },
    { name: 'desktop-compact', width: 1280, height: 720, mobile: false },
    { name: 'desktop-1024', width: 1024, height: 768, mobile: false },
    { name: 'desktop-900', width: 900, height: 768, mobile: false },
    { name: 'phone', width: 390, height: 844, mobile: true },
    { name: 'phone-landscape', width: 844, height: 390, mobile: true },
  ] as const) {
    const context = await browser.newContext({
      viewport: { width: device.width, height: device.height },
      deviceScaleFactor: device.mobile ? 3 : 1,
      isMobile: device.mobile,
      hasTouch: device.mobile,
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      if (device.name === 'desktop-wide') await page.emulateMedia({ colorScheme: 'dark' });
      await openGoldenPrefix(page, 42);
      await expect(page.getByRole('region', { name: 'Your hand' })).toBeVisible();
      await expect(page.locator('.resource-hand-card')).toHaveCount(5);
      if (device.mobile) await expect(page.locator('.next-step-actions')).toBeVisible();
      else await expect(page.getByRole('region', { name: 'Actions' })).toBeVisible();
      if (!device.mobile) {
        for (const player of ['Player 1', 'Player 2', 'Player 3', 'Player 4']) {
          const panel = page.locator('.player-panel').filter({ hasText: player });
          await expect(panel).toBeVisible();
          await expect(panel.locator('.player-vp')).toBeVisible();
          const pieceCounts = panel.locator('.player-piece-count');
          await expect(pieceCounts).toHaveCount(3);
          for (const piece of await pieceCounts.all()) {
            await expect(piece.locator('img')).toBeVisible();
            await expect(piece.locator('span')).toHaveText(/^\d+$/);
          }
        }
      }
      const dimensions = await page.evaluate(() => {
        const board = document.querySelector('.game-board')?.getBoundingClientRect();
        const hand = document.querySelector('.hand-dock')?.getBoundingClientRect();
        const dock = document.querySelector('.action-dock')?.getBoundingClientRect();
        const costsTrigger = document
          .querySelector('.action-costs-trigger')
          ?.getBoundingClientRect();
        // Playwright serializes this callback; helpers outside it are unavailable in the page.
        // eslint-disable-next-line unicorn/consistent-function-scoping
        const inside = (rect: DOMRect, bounds: DOMRect): boolean =>
          rect.left >= bounds.left - 2 &&
          rect.right <= bounds.right + 2 &&
          rect.top >= bounds.top - 2 &&
          rect.bottom <= bounds.bottom + 2;
        const viewport = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
        const cards = [...document.querySelectorAll('.resource-hand-card')].map((card) => {
          const face = card.querySelector('img')?.getBoundingClientRect();
          const count = card.querySelector('.resource-card-count')?.getBoundingClientRect();
          const cardBounds = card.getBoundingClientRect();
          return {
            resource: card.querySelector('.resource-card')?.getAttribute('data-resource'),
            inViewport: inside(cardBounds, viewport),
            inHand: hand ? inside(cardBounds, hand) : false,
            faceVisible: face ? inside(face, viewport) : false,
            countVisible: count ? inside(count, viewport) : false,
            faceLeft: face?.left ?? -1,
            badgeRight: count?.right ?? Infinity,
          };
        });
        const visibleActions = [
          ...document.querySelectorAll('.action-dock button:not([disabled])'),
        ].filter((button) => inside(button.getBoundingClientRect(), viewport)).length;
        const contextual = document.querySelector('.action-context')?.getBoundingClientRect();
        const normal = document.querySelector('.action-normal-buttons')?.getBoundingClientRect();
        const normalElements = [
          ...document.querySelectorAll('.action-normal-buttons .action-control'),
        ];
        const normalButtons = normalElements.map((button) => button.getBoundingClientRect());
        const normalContentFits = normalElements.map((button) => {
          const tile = button.getBoundingClientRect();
          const art = button.querySelector('img, svg')?.getBoundingClientRect();
          const caption = button.querySelector('span')?.getBoundingClientRect();
          return Boolean(
            art &&
            caption &&
            art.top >= tile.top + 3 &&
            caption.bottom <= tile.bottom - 3 &&
            Math.abs((art.left + art.right - tile.left - tile.right) / 2) <= 2 &&
            Math.abs((caption.left + caption.right - tile.left - tile.right) / 2) <= 2,
          );
        });
        const contextualButtons = [
          ...document.querySelectorAll('.action-context-buttons .action-control:not([disabled])'),
        ].map((button) => button.getBoundingClientRect());
        const illustratedActions = [...document.querySelectorAll('.action-control')]
          .filter((button) => inside(button.getBoundingClientRect(), viewport))
          .map((button) => {
            const art = button.querySelector('img, svg')?.getBoundingClientRect();
            return {
              label: button.textContent?.trim() ?? '',
              artVisible: art ? inside(art, button.getBoundingClientRect()) : false,
            };
          });
        return {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
          bodyHeight: document.body.scrollHeight,
          boardTop: board?.top ?? -1,
          boardBottom: board?.bottom ?? Infinity,
          dockHeight: dock?.height ?? Infinity,
          costsTriggerVisible: costsTrigger ? inside(costsTrigger, viewport) : false,
          cards,
          visibleActions,
          actionGroups:
            contextual && normal
              ? {
                  contextRight: contextual.right,
                  normalLeft: normal.left,
                  normalButtonTops: normalButtons.map((button) => button.top),
                  normalButtonSizes: normalButtons.map((button) => ({
                    width: button.width,
                    height: button.height,
                  })),
                  normalContentFits,
                }
              : null,
          contextualActions: {
            available: contextualButtons.length,
            visible: contextualButtons.filter((button) => inside(button, viewport)).length,
          },
          illustratedActions,
        };
      });
      expect(
        dimensions.documentWidth,
        `${device.name} has horizontal document overflow`,
      ).toBeLessThanOrEqual(dimensions.viewportWidth + 2);
      expect(
        dimensions.documentHeight,
        `${device.name} has vertical document overflow`,
      ).toBeLessThanOrEqual(dimensions.viewportHeight + 2);
      expect(dimensions.bodyHeight, `${device.name} body exceeds the viewport`).toBeLessThanOrEqual(
        dimensions.viewportHeight + 2,
      );
      expect(dimensions.boardTop).toBeGreaterThanOrEqual(0);
      expect(dimensions.boardBottom).toBeLessThanOrEqual(dimensions.viewportHeight + 2);
      if (!device.mobile)
        expect(
          dimensions.costsTriggerVisible,
          `${device.name} Build costs control is clipped`,
        ).toBe(true);
      if (!device.mobile)
        expect(dimensions.dockHeight, `${device.name} action dock is too tall`).toBeLessThanOrEqual(
          205,
        );
      expect(dimensions.cards).toHaveLength(5);
      for (const card of dimensions.cards) {
        expect(card.inViewport, `${device.name} ${card.resource} card is clipped`).toBe(true);
        expect(card.inHand, `${device.name} ${card.resource} card escapes the hand dock`).toBe(
          true,
        );
        expect(card.faceVisible, `${device.name} ${card.resource} art is clipped`).toBe(true);
        expect(card.countVisible, `${device.name} ${card.resource} count is clipped`).toBe(true);
      }
      if (device.name === 'desktop-900' || device.name === 'desktop-1024')
        for (let index = 0; index < dimensions.cards.length - 1; index++)
          expect(
            dimensions.cards[index]?.badgeRight,
            `${device.name} ${dimensions.cards[index]?.resource} badge overlaps the next card`,
          ).toBeLessThanOrEqual((dimensions.cards[index + 1]?.faceLeft ?? -1) + 1);
      if (!device.mobile) {
        expect(
          dimensions.visibleActions,
          `${device.name} has no visible next action`,
        ).toBeGreaterThan(0);
        expect(
          dimensions.illustratedActions.length,
          `${device.name} has no visible illustrated action`,
        ).toBeGreaterThan(0);
      }
      for (const action of dimensions.illustratedActions) {
        expect(action.label, `${device.name} action has no readable label`).not.toBe('');
        expect(action.artVisible, `${device.name} ${action.label} art is clipped`).toBe(true);
      }
      if (dimensions.contextualActions.available > 0)
        expect(
          dimensions.contextualActions.visible,
          `${device.name} hides all contextual actions below the viewport`,
        ).toBeGreaterThan(0);
      if (!device.mobile) {
        expect(dimensions.actionGroups, `${device.name} is missing a dock group`).not.toBeNull();
        if (dimensions.actionGroups) {
          expect(dimensions.actionGroups.contextRight).toBeLessThanOrEqual(
            dimensions.actionGroups.normalLeft + 2,
          );
          const tops = dimensions.actionGroups.normalButtonTops;
          for (let index = 1; index < tops.length; index++)
            expect(tops[index], `${device.name} normal actions should stack`).toBeGreaterThan(
              tops[index - 1] ?? Infinity,
            );
          for (const tile of dimensions.actionGroups.normalButtonSizes)
            expect(
              Math.abs(tile.width - tile.height),
              `${device.name} normal action tile is not square`,
            ).toBeLessThanOrEqual(2);
          expect(
            dimensions.actionGroups.normalContentFits,
            `${device.name} normal action art or caption touches the tile edge`,
          ).toEqual(Array(dimensions.actionGroups.normalContentFits.length).fill(true));
        }
      }
      await page.evaluate(() => window.scrollTo(0, 10_000));
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await capturePreview(page, testInfo, `${device.name}-cockpit`);
      const revision = await observedRevision(page);
      if (device.mobile) await page.locator('.next-step-actions').tap();
      await page.getByRole('button', { name: 'Build costs' }).click();
      const costs = page.getByRole('dialog', { name: 'Build costs' });
      await expect(costs).toBeVisible();
      const costRows = costs.locator('.build-cost-row');
      await expect(costRows).toHaveCount(4);
      for (const [index, label] of ['Road', 'Settlement', 'City', 'Development card'].entries()) {
        const row = costRows.nth(index);
        await row.scrollIntoViewIfNeeded();
        await expect(row).toBeVisible();
        await expect(row.locator('dt')).toHaveText(label);
        expect(await row.locator('.build-cost-resource').count()).toBeGreaterThan(0);
        const bounds = await row.boundingBox();
        if (!bounds) throw new Error(`${label} cost row has no visible bounds`);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(device.width + 2);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(device.height + 2);
      }
      const dialogBounds = await costs.boundingBox();
      const closeBounds = await costs.getByRole('button', { name: 'Close' }).boundingBox();
      if (!dialogBounds || !closeBounds) throw new Error('Build costs close control has no bounds');
      expect(closeBounds.x).toBeGreaterThanOrEqual(dialogBounds.x);
      expect(closeBounds.y).toBeGreaterThanOrEqual(dialogBounds.y);
      expect(closeBounds.x + closeBounds.width).toBeLessThanOrEqual(
        dialogBounds.x + dialogBounds.width,
      );
      expect(closeBounds.y + closeBounds.height).toBeLessThanOrEqual(
        dialogBounds.y + dialogBounds.height,
      );
      expect(closeBounds.y + closeBounds.height).toBeLessThanOrEqual(device.height + 2);
      await capturePreview(page, testInfo, `${device.name}-build-costs`);
      expect(await observedRevision(page)).toBe(revision);
      await costs.getByRole('button', { name: 'Close' }).click();
      await expect(costs).toBeHidden();
      const gameInfo = page.locator('.game-info');
      if (
        !(await gameInfo.evaluate(
          (element) => element instanceof HTMLDetailsElement && element.open,
        ))
      )
        await gameInfo.locator('summary').first().click();
      await expect(gameInfo.locator('.bank-card')).toHaveCount(5);
      const bankCardsVisible = await gameInfo.locator('.bank-card').evaluateAll((cards) =>
        cards.map((card) => {
          const rect = card.getBoundingClientRect();
          return (
            rect.left >= -2 &&
            rect.top >= -2 &&
            rect.right <= window.innerWidth + 2 &&
            rect.bottom <= window.innerHeight + 2
          );
        }),
      );
      expect(bankCardsVisible, `${device.name} bank card row is clipped`).toEqual(
        Array(5).fill(true),
      );
      expect(pageErrors.get(page)).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

test('compact phone cockpit exposes public player details and reachable Actions without crowding the board', async ({
  browser,
  browserName,
}, testInfo) => {
  test.skip(browserName === 'firefox', 'Compact touch sheets run in Chromium and WebKit');
  const devices =
    browserName === 'webkit'
      ? [{ name: 'webkit-phone', width: 390, height: 844 }]
      : [
          { name: 'phone', width: 390, height: 844 },
          { name: 'small-phone', width: 360, height: 740 },
          { name: 'narrow-phone', width: 320, height: 568 },
          { name: 'phone-landscape', width: 844, height: 390 },
        ];
  for (const device of devices) {
    const context = await browser.newContext({
      viewport: { width: device.width, height: device.height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      if (device.name === 'phone') await page.emulateMedia({ colorScheme: 'dark' });
      await openGoldenPrefix(page, 496, 'hidden-vp-win.replay.json');
      const hand = page.getByRole('region', { name: 'Your hand' });
      const trigger = page.locator('.next-step-actions');
      await expect(hand).toBeVisible();
      await expect(hand.locator('.resource-hand-card')).toHaveCount(5);
      await expect(trigger).toBeVisible();
      await expect(trigger).toHaveAccessibleName(/^Actions, \d+ available$/);
      const geometry = await page.evaluate(() => {
        const board = document.querySelector('.game-board')?.getBoundingClientRect();
        const handBounds = document.querySelector('.hand-dock')?.getBoundingClientRect();
        const triggerBounds = document.querySelector('.next-step-actions')?.getBoundingClientRect();
        const cards = [...document.querySelectorAll('.resource-hand-card')].map((card) => {
          const rect = card.getBoundingClientRect();
          return (
            rect.left >= -1 &&
            rect.right <= window.innerWidth + 1 &&
            rect.top >= -1 &&
            rect.bottom <= window.innerHeight + 1
          );
        });
        const playerTiles = [...document.querySelectorAll('.player-panel')].map((panel) => {
          const bounds = panel.getBoundingClientRect();
          const parts = [
            panel.querySelector('.player-marker'),
            panel.querySelector('.player-panel-heading strong'),
            panel.querySelector('.player-seat-index'),
            panel.querySelector('.player-vp'),
          ];
          return parts.every((part) => {
            if (!part) return false;
            const style = getComputedStyle(part);
            if (style.display === 'none' || style.visibility === 'hidden') return true;
            const rect = part.getBoundingClientRect();
            return (
              rect.left >= bounds.left - 1 &&
              rect.right <= bounds.right + 1 &&
              rect.top >= bounds.top - 1 &&
              rect.bottom <= bounds.bottom + 1
            );
          });
        });
        return {
          boardHeight: board?.height ?? 0,
          handHeight: handBounds?.height ?? 0,
          triggerVisible: Boolean(
            triggerBounds &&
            triggerBounds.left >= -1 &&
            triggerBounds.top >= -1 &&
            triggerBounds.right <= window.innerWidth + 1 &&
            triggerBounds.bottom <= window.innerHeight + 1,
          ),
          cards,
          playerTiles,
          documentWidth: document.documentElement.scrollWidth,
          documentHeight: document.documentElement.scrollHeight,
        };
      });
      expect(geometry.documentWidth).toBeLessThanOrEqual(device.width + 2);
      expect(geometry.documentHeight).toBeLessThanOrEqual(device.height + 2);
      expect(geometry.boardHeight).toBeGreaterThan(device.height * 0.55);
      if (device.width < device.height)
        expect(geometry.handHeight).toBeLessThanOrEqual(device.height * 0.25);
      expect(geometry.triggerVisible).toBe(true);
      expect(geometry.cards).toEqual(Array(5).fill(true));
      expect(geometry.playerTiles).toEqual(Array(4).fill(true));
      await capturePreview(page, testInfo, `${device.name}-compact-cockpit`);

      await trigger.tap();
      const actionsSheet = page.getByRole('dialog', { name: 'Actions' });
      await expect(actionsSheet).toBeVisible();
      await capturePreview(page, testInfo, `${device.name}-actions-sheet`);
      await actionsSheet.getByRole('button', { name: 'Close' }).tap();
      await expect(actionsSheet).toBeHidden();
      await expect(trigger).toBeFocused();
      await trigger.tap();
      await page.keyboard.press('Escape');
      await expect(actionsSheet).toBeHidden();
      await expect(trigger).toBeFocused();

      const publicState = await page.evaluate(() => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        if (!hook) throw new Error('DEV read-only diagnostics unavailable');
        return hook.session.getState();
      });
      const baseExt = publicState.ext.base;
      if (
        typeof baseExt !== 'object' ||
        baseExt === null ||
        !('knightsPlayed' in baseExt) ||
        !Array.isArray(baseExt.knightsPlayed)
      )
        throw new Error('Public knight counts are unavailable');
      for (const seat of publicState.seats) {
        const name = `Player ${seat.seat + 1}`;
        const tile = page.getByRole('button', { name: `Show ${name}'s public details` });
        await expect(page.locator(`[data-seat-panel="${seat.seat}"]`)).toHaveCount(1);
        await tile.tap();
        const details = page.getByRole('dialog', { name });
        await expect(details).toBeVisible();
        await expect(details.locator('.player-vp')).toContainText(String(seat.publicVp));
        const rows = details.locator('.player-details-stats > div');
        await expect(rows.nth(0).locator('dd')).toHaveText(String(seat.resources.total));
        await expect(rows.nth(1).locator('dd')).toHaveText(
          String(seat.cardSlots.filter((slot) => !slot.revealed).length),
        );
        const knightCount: unknown = baseExt.knightsPlayed[seat.seat];
        if (typeof knightCount !== 'number') throw new Error('Public knight count is malformed');
        await expect(rows.nth(2).locator('dd')).toHaveText(String(knightCount));
        await expect(rows.nth(3).locator('dd')).toHaveText(
          String(baseLongestRoadLength(publicState, seat.seat)),
        );
        await expect(details.locator('.player-details-pieces > span')).toHaveCount(3);
        await expect(details.locator('.resource-hand-card, .development-card')).toHaveCount(0);
        await expect(page.locator(`[data-seat-panel="${seat.seat}"]`)).toHaveCount(1);
        if (seat.seat === 0) {
          expect(knightCount).toBeGreaterThanOrEqual(3);
          if (publicState.awards.largestArmy === 0)
            await expect(details).toContainText('Largest army');
          if (device.name === 'phone' || device.name === 'phone-landscape')
            await capturePreview(page, testInfo, `${device.name}-player-details`);
        }
        await details.getByRole('button', { name: 'Close' }).tap();
        await expect(details).toBeHidden();
        await expect(tile).toBeFocused();
      }

      await trigger.tap();
      await actionsSheet.getByRole('button', { name: 'Build costs' }).tap();
      await expect(actionsSheet).toBeHidden();
      const costs = page.getByRole('dialog', { name: 'Build costs' });
      await expect(costs).toBeVisible();
      await costs.getByRole('button', { name: 'Close' }).tap();
      await expect(costs).toBeHidden();
      await expect(trigger).toBeFocused();
      expect(pageErrors.get(page)).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

test('two replay-backed development cards stay readable on desktop and phone', async ({
  browser,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Card visual acceptance runs in Chromium');
  for (const device of [
    { name: 'desktop', width: 1280, height: 720, mobile: false },
    { name: 'compact-desktop', width: 1024, height: 768, mobile: false },
    { name: 'phone', width: 390, height: 844, mobile: true },
  ] as const) {
    const context = await browser.newContext({
      viewport: { width: device.width, height: device.height },
      isMobile: device.mobile,
      hasTouch: device.mobile,
    });
    try {
      const page = await context.newPage();
      await openGoldenPrefix(page, 365, 'normal-game-05.replay.json');
      const openCards = page.getByRole('button', { name: /Development cards:/ });
      if (await openCards.isVisible()) await openCards.click();
      const cards = page.locator('.development-card:visible');
      await expect(cards).toHaveCount(2);
      for (const label of ['Knight', 'Road building']) {
        const card = cards.filter({ hasText: label });
        await expect(card).toBeVisible();
        await expect(card.locator('img')).toBeVisible();
        await expect(card.locator('strong')).toHaveText(label);
        const bounds = await card.boundingBox();
        if (!bounds) throw new Error(`${label} card has no visible bounds`);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(device.width + 2);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(device.height + 2);
        const labelFits = await card.locator('strong').evaluate((element) => {
          const hand = element.closest('.development-hand');
          const labelBounds = element.getBoundingClientRect();
          const handBounds = hand?.getBoundingClientRect();
          return (
            element.scrollWidth <= element.clientWidth + 1 &&
            element.scrollHeight <= element.clientHeight + 1 &&
            handBounds !== undefined &&
            labelBounds.left >= handBounds.left - 1 &&
            labelBounds.right <= handBounds.right + 1 &&
            labelBounds.bottom <= handBounds.bottom + 1
          );
        });
        expect(labelFits, `${label} is clipped`).toBe(true);
      }
      if (!device.mobile) {
        const hand = page.locator('.hand-dock > .development-hand');
        await expect(hand).toBeVisible();
        expect(
          await hand.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
        ).toBe(true);
      }
      await capturePreview(page, testInfo, `${device.name}-two-development-cards`);
      expect(pageErrors.get(page)).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

test('three held development cards fan on desktop and keep the phone drawer', async ({
  browser,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Development hand visuals run in Chromium');
  test.setTimeout(90_000);
  for (const device of [
    { name: 'desktop', width: 1280, height: 720 },
    { name: 'compact-desktop', width: 1024, height: 768 },
    { name: 'narrow-desktop', width: 900, height: 768 },
  ]) {
    const context = await browser.newContext({ viewport: device });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      await page.emulateMedia({ colorScheme: 'dark' });
      await openGoldenPrefix(page, 460, 'hidden-vp-win.replay.json');
      const fan = page.locator('.hand-dock .development-hand.is-fanned');
      const cards = fan.locator('.development-card');
      await expect(cards).toHaveCount(3);
      await expect(page.getByRole('button', { name: 'Development cards: 3' })).toHaveCount(0);
      const revision = await observedRevision(page);
      const geometry = await fan.evaluate((element) => {
        const hand = element.closest('.hand-dock')?.getBoundingClientRect();
        const cardBounds = [...element.querySelectorAll('.development-card')].map((card) => {
          const box = card.getBoundingClientRect();
          const art = card.querySelector('img')?.getBoundingClientRect();
          return {
            left: box.left,
            right: box.right,
            top: box.top,
            artLeft: art?.left ?? -1,
            artRight: art?.right ?? -1,
            artTop: art?.top ?? -1,
          };
        });
        return { handTop: hand?.top ?? Infinity, cards: cardBounds };
      });
      expect(geometry.cards).toHaveLength(3);
      expect(geometry.cards[1]?.left).toBeGreaterThanOrEqual(
        (geometry.cards[0]?.right ?? Infinity) - 1,
      );
      expect(geometry.cards[1]?.artLeft).toBeLessThan(geometry.cards[0]?.artRight ?? -Infinity);
      for (const card of geometry.cards) {
        expect(card.left).toBeGreaterThanOrEqual(0);
        expect(card.right).toBeLessThanOrEqual(device.width);
        expect(card.artTop).toBeGreaterThanOrEqual(geometry.handTop);
      }
      const assertRaised = async (card: Locator, label: string) => {
        await expect
          .poll(() =>
            card.locator('strong').evaluate((caption) => Number(getComputedStyle(caption).opacity)),
          )
          .toBe(1);
        const measured = await card.evaluate((element) => {
          const caption = element.querySelector('strong');
          const art = element.querySelector('img');
          if (!caption || !art) return null;
          const captionBox = caption.getBoundingClientRect();
          const artBox = art.getBoundingClientRect();
          return {
            opacity: Number(getComputedStyle(caption).opacity),
            caption: { left: captionBox.left, right: captionBox.right, bottom: captionBox.bottom },
            artTop: artBox.top,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
          };
        });
        if (!measured) throw new Error(`${label} card art or caption is missing`);
        expect(measured.opacity, `${label} caption is concealed`).toBe(1);
        expect(measured.caption.left, `${label} caption leaves viewport`).toBeGreaterThanOrEqual(0);
        expect(measured.caption.right, `${label} caption leaves viewport`).toBeLessThanOrEqual(
          measured.viewportWidth,
        );
        expect(measured.caption.bottom, `${label} caption leaves viewport`).toBeLessThanOrEqual(
          measured.viewportHeight,
        );
        expect(measured.artTop, `${label} art clips at hand top`).toBeGreaterThanOrEqual(
          geometry.handTop,
        );
      };
      const sweep = async () => {
        for (const index of [0, 1, 2, 1, 0]) {
          const card = cards.nth(index);
          const box = await card.boundingBox();
          const art = await card.locator('img').boundingBox();
          if (!box || !art) throw new Error(`Development card ${index} has no visible face`);
          const point = { x: box.x + box.width / 2, y: art.y + 12 };
          expect(point.x).toBeGreaterThanOrEqual(art.x);
          expect(point.x).toBeLessThanOrEqual(art.x + art.width);
          await page.mouse.move(point.x, point.y);
          await assertRaised(card, `Pointer-sweep card ${index}`);
          for (const other of [0, 1, 2].filter((candidate) => candidate !== index))
            await expect
              .poll(() =>
                cards
                  .nth(other)
                  .locator('strong')
                  .evaluate((caption) => Number(getComputedStyle(caption).opacity)),
              )
              .toBe(0);
        }
        await page.mouse.move(10, 10);
        for (const card of await cards.all())
          await expect
            .poll(() =>
              card
                .locator('strong')
                .evaluate((caption) => Number(getComputedStyle(caption).opacity)),
            )
            .toBe(0);
      };
      await sweep();
      const first = cards.first();
      await first.hover({ position: { x: 4, y: 12 } });
      await expect(first.locator('strong')).toHaveText('Victory point');
      await assertRaised(first, 'Victory point');
      await capturePreview(page, testInfo, `${device.name}-three-dev-hover`);
      const knight = cards.filter({ hasText: 'Knight' }).first();
      const knightButton = knight.getByRole('button', { name: 'Knight', exact: true });
      await knightButton.focus();
      await expect(knight.locator('strong')).toHaveText('Knight');
      await assertRaised(knight, 'Focused Knight');
      const last = cards.last();
      await last.getByRole('button', { name: 'Knight', exact: true }).focus();
      await assertRaised(last, 'Focused last Knight');
      await knightButton.focus();
      const knightBox = await knightButton.boundingBox();
      if (!knightBox) throw new Error('Middle Knight has no visible art');
      await knightButton.click({ position: { x: knightBox.width * 0.25, y: 18 } });
      const confirmation = knight.getByRole('group', { name: 'Play Knight?' });
      await expect(confirmation).toBeVisible();
      await first.hover({ position: { x: 4, y: 12 } });
      await expect
        .poll(() =>
          first.locator('strong').evaluate((caption) => Number(getComputedStyle(caption).opacity)),
        )
        .toBe(0);
      await assertRaised(knight, 'Selected Knight');
      const layers = await fan.evaluate((element) => {
        const selected = element.querySelector('.development-card.has-knight-intent');
        const other = element.querySelector('.development-card:hover:not(.has-knight-intent)');
        const selectedLayer = selected ? Number(getComputedStyle(selected).zIndex) : -1;
        const otherLayer = other ? Number(getComputedStyle(other).zIndex) : -1;
        return { selectedLayer, otherLayer };
      });
      expect(layers.selectedLayer).toBeGreaterThan(layers.otherLayer);
      await expect
        .poll(() =>
          knight
            .locator('.development-card-art')
            .evaluate((element) => new DOMMatrixReadOnly(getComputedStyle(element).transform).m42),
        )
        .toBeLessThan(-6);
      expect(await observedRevision(page)).toBe(revision);
      await capturePreview(page, testInfo, `${device.name}-three-dev-knight-intent`);
      await confirmation.getByRole('button', { name: 'Cancel Knight' }).click();
      await expect(confirmation).toBeHidden();
      expect(await observedRevision(page)).toBe(revision);
      await sweep();
      if (device.name === 'desktop') {
        const dockKnight = page
          .locator('.action-dock')
          .getByRole('button', { name: 'Play Knight', exact: true });
        await expect(dockKnight).toHaveCount(1);
        await last.getByRole('button', { name: 'Knight', exact: true }).click({
          position: { x: 4, y: 12 },
        });
        await expect(last).toHaveClass(/has-knight-intent/);
        await expect(knight).not.toHaveClass(/has-knight-intent/);
        await expect(dockKnight).toHaveAttribute('aria-pressed', 'true');
        expect(await observedRevision(page)).toBe(revision);
        await dockKnight.click();
        await expect(last).not.toHaveClass(/has-knight-intent/);
        await expect(dockKnight).toHaveAttribute('aria-pressed', 'false');
        expect(await observedRevision(page)).toBe(revision);
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await first.hover({ position: { x: 4, y: 12 } });
      await expect(first.locator('strong')).toBeVisible();
      const duration = await first.evaluate(
        (element) => getComputedStyle(element).transitionDuration,
      );
      expect(Number.parseFloat(duration)).toBeLessThan(0.001);

      if (device.width > 1000) {
        // Layout probe only: the saved game still owns exactly three cards. These inert clones
        // exercise the wider five-card CSS without inventing a private hand or game authority.
        await page.evaluate(() => {
          const domFan = document.querySelector('.hand-dock .development-hand.is-fanned');
          if (!(domFan instanceof HTMLElement)) throw new Error('Development fan is missing');
          const originals = [...domFan.querySelectorAll('.development-card')];
          for (const source of originals.slice(0, 2)) {
            const clone = source.cloneNode(true);
            if (!(clone instanceof HTMLElement)) throw new Error('Development clone failed');
            clone.dataset.layoutProbe = 'true';
            domFan.append(clone);
          }
          domFan.dataset.cardCount = '5';
        });
        await expect(fan.locator('.development-card')).toHaveCount(5);
        const probe = await fan.evaluate((element) => {
          const hand = element.closest('.hand-dock')?.getBoundingClientRect();
          const faces = [...element.querySelectorAll('.development-card img')].map((face) => {
            const rect = face.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          });
          return { hand: hand ? { left: hand.left, right: hand.right } : null, faces };
        });
        if (!probe.hand) throw new Error('Five-card layout has no hand bounds');
        for (const face of probe.faces) {
          expect(face.left, 'Five-card face leaves the hand').toBeGreaterThanOrEqual(
            probe.hand.left - 1,
          );
          expect(face.right, 'Five-card face leaves the hand').toBeLessThanOrEqual(
            probe.hand.right + 1,
          );
          expect(face.left).toBeGreaterThanOrEqual(0);
          expect(face.right).toBeLessThanOrEqual(device.width);
          expect(face.top).toBeGreaterThanOrEqual(0);
          expect(face.bottom).toBeLessThanOrEqual(device.height);
        }
        await capturePreview(page, testInfo, `${device.name}-five-dev-layout-only`);
        await page.evaluate(() => {
          const domFan = document.querySelector('.hand-dock .development-hand.is-fanned');
          domFan?.querySelectorAll('[data-layout-probe]').forEach((clone) => clone.remove());
          if (domFan instanceof HTMLElement) domFan.dataset.cardCount = '3';
        });
        await expect(fan.locator('.development-card')).toHaveCount(3);
      }
      expect(pageErrors.get(page)).toEqual([]);
    } finally {
      await context.close();
    }
  }

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await openGoldenPrefix(page, 460, 'hidden-vp-win.replay.json');
    await expect(page.locator('.hand-dock .development-hand.is-fanned')).toHaveCount(0);
    await page.getByRole('button', { name: 'Development cards: 3' }).tap();
    const drawer = page.getByRole('dialog', { name: 'Development cards: 3' });
    await expect(drawer.locator('.development-card')).toHaveCount(3);
    await capturePreview(page, testInfo, 'phone-three-dev-drawer');
    expect(pageErrors.get(page)).toEqual([]);
  } finally {
    await context.close();
  }

  const tablet = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await tablet.newPage();
    await openGoldenPrefix(page, 460, 'hidden-vp-win.replay.json');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await expect(page.locator('.hand-dock .development-hand.is-fanned')).toHaveCount(0);
    await page.getByRole('button', { name: 'Development cards: 3' }).tap();
    await expect(
      page.getByRole('dialog', { name: 'Development cards: 3' }).locator('.development-card'),
    ).toHaveCount(3);
    expect(pageErrors.get(page)).toEqual([]);
  } finally {
    await tablet.close();
  }
});

test('phone development drawer closes after committing a Knight with other cards held', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Phone development-card flow runs in Chromium');
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await openGoldenPrefix(page, 460, 'hidden-vp-win.replay.json');
    const before = await observedRevision(page);
    await page.getByRole('button', { name: 'Development cards: 3' }).tap();
    const drawer = page.getByRole('dialog', { name: 'Development cards: 3' });
    await expect(drawer).toBeVisible();
    const knight = drawer.locator('.development-card').filter({ hasText: 'Knight' }).first();
    await knight.getByRole('button', { name: 'Knight', exact: true }).tap();
    await expect(knight.getByRole('group', { name: 'Play Knight?' })).toBeVisible();
    expect(await observedRevision(page)).toBe(before);
    await knight.getByRole('button', { name: 'Play Knight' }).tap();
    await expect.poll(() => observedRevision(page)).toBeGreaterThan(before);
    await expect(page.locator('.development-dialog[open]')).toHaveCount(0);
    const target = await readPresent(page, 'Robber target after Knight', () =>
      page.evaluate(() => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.diagnostics().actions?.placements.robber[0]?.id ?? null;
      }),
    );
    expect(target).toMatch(/^h:/);
    await expect(page.getByRole('group', { name: 'Game board' })).toBeVisible();
    const targetPoint = await page.evaluate(
      (hit) => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.pixelPosition(hit) ?? null;
      },
      canonicalBoardHit('hex', target),
    );
    expect(targetPoint).not.toBeNull();
    await expect(page.getByRole('button', { name: 'Development cards: 2' })).toBeVisible();
    expect(pageErrors.get(page)).toEqual([]);
  } finally {
    await context.close();
  }
});

test('real steals show only a neutral public card cue in both directions', async ({
  browser,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Steal effects are checked in Chromium');
  test.setTimeout(90_000);
  for (const scenario of [
    {
      name: 'inbound-desktop',
      file: 'normal-game-05.replay.json',
      prefix: 92,
      from: 3,
      to: 0,
      mobile: false,
      pauseForCapture: true,
      reducedMotion: false,
    },
    {
      name: 'outbound-desktop',
      file: 'normal-game-04.replay.json',
      prefix: 65,
      from: 0,
      to: 2,
      mobile: false,
      pauseForCapture: false,
      reducedMotion: false,
    },
    {
      name: 'inbound-phone',
      file: 'normal-game-05.replay.json',
      prefix: 92,
      from: 3,
      to: 0,
      mobile: true,
      pauseForCapture: false,
      reducedMotion: false,
    },
    {
      name: 'outbound-phone',
      file: 'normal-game-04.replay.json',
      prefix: 65,
      from: 0,
      to: 2,
      mobile: true,
      pauseForCapture: false,
      reducedMotion: false,
    },
    {
      name: 'reduced-motion',
      file: 'normal-game-05.replay.json',
      prefix: 92,
      from: 3,
      to: 0,
      mobile: false,
      pauseForCapture: false,
      reducedMotion: true,
    },
  ] as const) {
    const saved = await saveBeforeGoldenInput(scenario.file, scenario.prefix);
    const baseline = LocalSession.restore(saved, {
      entropy: { randomBytes: (target) => target.fill(1) },
    });
    if (!baseline.ok) throw new Error(`Steal prefix failed to restore: ${baseline.error.code}`);
    const baselineHand = baseline.value.getPrivate(0)?.hand;
    if (!baselineHand) throw new Error('Steal fixture has no human private hand');
    const beforeCount = Object.values(baselineHand).reduce((sum, count) => sum + count, 0);
    const beforeEvents = baseline.value
      .getEvents()
      .filter((event) => event.type === 'resourceStolen').length;
    baseline.value.dispose();

    const context = await browser.newContext({
      viewport: scenario.mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 },
      isMobile: scenario.mobile,
      hasTouch: scenario.mobile,
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      if (scenario.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript(
        ({ from, to, pause }) => {
          const records: {
            html: string;
            x: number;
            y: number;
            dx: number;
            dy: number;
            source: { x: number; y: number } | null;
            target: { x: number; y: number } | null;
          }[] = [];
          Reflect.set(window, '__stealCueRecords', records);
          const seen = new WeakSet<Element>();
          // This callback is serialized into the browser, where its DOM globals exist.
          // eslint-disable-next-line unicorn/consistent-function-scoping
          const center = (seat: number) => {
            const hand = seat === 0 ? document.querySelector('.hand-dock .resource-hand') : null;
            const panel = document.querySelector(`[data-seat-panel="${seat}"]`);
            const element = hand ?? panel;
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          };
          const observe = () => {
            for (const node of document.querySelectorAll<HTMLElement>('.steal-card-flight')) {
              if (seen.has(node)) continue;
              seen.add(node);
              if (pause) {
                node.style.animationDelay = '-200ms';
                node.style.animationPlayState = 'paused';
              }
              records.push({
                html: node.outerHTML,
                x: Number.parseFloat(node.style.left),
                y: Number.parseFloat(node.style.top),
                dx: Number.parseFloat(node.style.getPropertyValue('--flight-dx')),
                dy: Number.parseFloat(node.style.getPropertyValue('--flight-dy')),
                source: center(from),
                target: center(to),
              });
            }
          };
          const start = () => {
            new MutationObserver(observe).observe(document.body, {
              childList: true,
              subtree: true,
            });
            observe();
          };
          if (document.readyState === 'loading')
            document.addEventListener('DOMContentLoaded', start, { once: true });
          else start();
        },
        { from: scenario.from, to: scenario.to, pause: scenario.pauseForCapture },
      );
      await openGoldenPrefix(page, scenario.prefix, scenario.file, {
        humanSeats: [0],
        botDelayMs: 800,
      });
      if (scenario.to === 0) {
        const dialog = page.getByRole('dialog', { name: 'Steal a card' });
        await expect(dialog).toBeVisible();
        const victim = dialog.getByRole('button', { name: /Player 4/ });
        if (scenario.mobile) await victim.tap();
        else await victim.click();
      }
      await expect
        .poll(() =>
          page.evaluate((previous) => {
            const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
            return (
              (hook?.session.getEvents().filter((event) => event.type === 'resourceStolen')
                .length ?? 0) > previous
            );
          }, beforeEvents),
        )
        .toBe(true);
      if (scenario.reducedMotion) {
        await page.evaluate(
          () =>
            new Promise<void>((finishFrames) =>
              requestAnimationFrame(() => requestAnimationFrame(() => finishFrames())),
            ),
        );
      }
      await expect
        .poll(() =>
          page.evaluate(() => {
            const values: unknown = Reflect.get(window, '__stealCueRecords');
            return Array.isArray(values) ? values.length : 0;
          }),
        )
        .toBe(scenario.reducedMotion ? 0 : 1);
      const afterCount = await page.evaluate(() => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        const hand = hook?.session.getPrivate(0)?.hand;
        return hand ? Object.values(hand).reduce((sum, count) => sum + count, 0) : null;
      });
      expect(afterCount).toBe(beforeCount + (scenario.to === 0 ? 1 : -1));
      if (!scenario.reducedMotion) {
        const record = await page.evaluate(() => {
          const values: unknown = Reflect.get(window, '__stealCueRecords');
          if (!Array.isArray(values)) return null;
          const first: unknown = values[0];
          if (typeof first !== 'object' || first === null) return null;
          const html: unknown = Reflect.get(first, 'html');
          const x: unknown = Reflect.get(first, 'x');
          const y: unknown = Reflect.get(first, 'y');
          const dx: unknown = Reflect.get(first, 'dx');
          const dy: unknown = Reflect.get(first, 'dy');
          const source: unknown = Reflect.get(first, 'source');
          const target: unknown = Reflect.get(first, 'target');
          if (
            typeof html !== 'string' ||
            typeof x !== 'number' ||
            typeof y !== 'number' ||
            typeof dx !== 'number' ||
            typeof dy !== 'number' ||
            typeof source !== 'object' ||
            source === null ||
            typeof target !== 'object' ||
            target === null
          )
            return null;
          const sourceX: unknown = Reflect.get(source, 'x');
          const sourceY: unknown = Reflect.get(source, 'y');
          const targetX: unknown = Reflect.get(target, 'x');
          const targetY: unknown = Reflect.get(target, 'y');
          if (
            typeof sourceX !== 'number' ||
            typeof sourceY !== 'number' ||
            typeof targetX !== 'number' ||
            typeof targetY !== 'number'
          )
            return null;
          return {
            html,
            x,
            y,
            dx,
            dy,
            source: { x: sourceX, y: sourceY },
            target: { x: targetX, y: targetY },
          };
        });
        if (!record) throw new Error(`${scenario.name} has no steal cue`);
        expect(record.html).toContain('<svg');
        expect(record.html).not.toMatch(/<img|data-resource|brick|lumber|wool|grain|ore/i);
        expect(Math.hypot(record.x - record.source.x, record.y - record.source.y)).toBeLessThan(30);
        expect(
          Math.hypot(
            record.x + record.dx - record.target.x,
            record.y + record.dy - record.target.y,
          ),
        ).toBeLessThan(30);
        if (scenario.pauseForCapture) {
          await expect(page.locator('.steal-card-flight')).toBeVisible();
          const screenshot = await page.screenshot({ animations: 'allow' });
          await testInfo.attach(`${scenario.name}-steal-card`, {
            body: screenshot,
            contentType: 'image/png',
          });
          const folder = join(repoRoot, 'reports/stage05');
          await mkdir(folder, { recursive: true });
          await writeFile(join(folder, `${scenario.name}-steal-card.png`), screenshot);
          await openGameMenu(page);
          await page.getByRole('button', { name: 'Skip animations' }).click();
        }
        await expect(page.locator('.steal-card-flight')).toHaveCount(0);
      } else await expect(page.locator('.steal-card-flight')).toHaveCount(0);
      expect(pageErrors.get(page)).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

async function completeSetup(
  page: Page,
  input: 'mouse' | 'touch',
  testInfo?: TestInfo,
): Promise<void> {
  // The browser hook only reads legal targets and their canvas coordinates.
  for (let placement = 0; placement < 12; placement++) {
    const actor = await readActiveSeat(page);
    const cover = page.locator('dialog.privacy-cover');
    if (await cover.isVisible()) {
      await expect(
        cover.getByRole('heading', { name: `Pass to Player ${actor + 1}` }),
      ).toBeVisible();
      await expect(page.locator('.hand-dock .resource-hand')).toHaveCount(0);
      await revealIfCovered(page, input);
    }
    await expect(cover).toBeHidden();
    await expect(page.locator('.hand-dock .resource-hand')).toBeVisible();
    await expect
      .poll(
        () =>
          page.evaluate((seat) => {
            const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
            const own = hook?.session.getPrivate(seat)?.hand;
            if (!own) return false;
            return (['brick', 'lumber', 'wool', 'grain', 'ore'] as const).every((resource) => {
              const shown = document.querySelector(
                `.hand-dock .resource-hand-card .resource-card[data-resource="${resource}"] .resource-card-count`,
              );
              return shown?.textContent?.trim() === String(own[resource] ?? 0);
            });
          }, actor),
        { message: `Only Player ${actor + 1}'s hand should be visible` },
      )
      .toBe(true);
    if (await page.getByRole('heading', { name: "This page couldn't load." }).isVisible())
      throw new Error(`Game route failed during setup: ${pageErrors.get(page)?.join(' | ')}`);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
          const actions = hook?.diagnostics().actions;
          return Boolean(
            hook?.renderer &&
            ((actions?.placements.settlement.length ?? 0) > 0 ||
              (actions?.placements.road.length ?? 0) > 0),
          );
        }),
      )
      .toBe(true);
    const target = await readPresent(page, 'Setup target', () =>
      page.evaluate(() => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        if (!hook?.renderer) return null;
        const actions = hook.diagnostics().actions;
        const state = hook.session.getState();
        return {
          settlements: actions?.placements.settlement.map((item) => item.id) ?? [],
          road: actions?.placements.road[0]?.id ?? null,
          pieces: state.board.buildings.length + state.board.roads.length,
        };
      }),
    );
    const settlement = target.settlements.length > 0;
    const id = settlement
      ? placement === 10
        ? target.settlements.find((candidate) => dualResourceSiteIds.has(candidate))
        : target.settlements.find((candidate) => !reservedSites.has(candidate))
      : target.road;
    if (!id) throw new Error(`No suitable setup site at placement ${placement}`);
    const point = await readPresent(page, 'Setup board coordinate', () =>
      page.evaluate(
        (hit) => {
          const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
          return hook?.pixelPosition(hit) ?? null;
        },
        canonicalBoardHit(settlement ? 'vertex' : 'edge', id),
      ),
    );
    const revision = await observedRevision(page);
    if (input === 'touch') await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
          const state = hook?.session.getState();
          return state ? state.board.buildings.length + state.board.roads.length : -1;
        }),
      )
      .toBe(target.pieces);
    expect(await observedRevision(page)).toBe(revision);
    if (settlement && placement === 0) {
      if (input === 'mouse') {
        const requiredAction = page
          .getByRole('group', { name: 'Choose a board action' })
          .getByRole('button', { name: 'Build settlement' });
        await expect(
          page
            .getByRole('group', { name: 'Choose a board action' })
            .getByRole('button', { name: 'Cancel' }),
        ).toHaveCount(0);
        await requiredAction.click();
        await expect(page.getByRole('button', { name: 'Confirm settlement' })).toBeHidden();
        await expect(requiredAction).toHaveAttribute('aria-pressed', 'true');
        await page.mouse.click(point.x, point.y);
      } else {
        await expect(page.locator('.next-step-message')).toContainText('Confirm on the board');
      }
      const cancel = page
        .getByRole('region', { name: 'Game board' })
        .getByRole('button', { name: 'Cancel', exact: true });
      if (input === 'touch') await cancel.tap();
      else await cancel.click();
      await expect(page.getByRole('button', { name: 'Confirm settlement' })).toBeHidden();
      expect(await observedRevision(page)).toBe(revision);
      if (input === 'touch') await page.touchscreen.tap(point.x, point.y);
      else await page.mouse.click(point.x, point.y);
    }
    if (testInfo && placement < 2)
      await capturePreview(
        page,
        testInfo,
        `${input}-setup-${settlement ? 'settlement' : 'road'}-preview`,
      );
    await confirmPlacement(page, settlement ? 'settlement' : 'road', revision, input);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
          const state = hook?.session.getState();
          return state ? state.board.buildings.length + state.board.roads.length : -1;
        }),
      )
      .toBeGreaterThan(target.pieces);
    const nextActor = await readActiveSeat(page);
    if (nextActor !== actor) {
      await expect(cover).toBeVisible();
      await expect(page.locator('.hand-dock .resource-hand')).toHaveCount(0);
    } else {
      await expect(cover).toBeHidden();
      await expect(page.locator('.hand-dock .resource-hand')).toBeVisible();
    }
  }
}

async function readActiveSeat(page: Page): Promise<Seat> {
  return readPresent(page, 'Setup actor', () =>
    page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      return hook?.session.getState().turn.activeSeat ?? null;
    }),
  );
}

test('three-human hotseat setup uses board clicks, then rolls and builds a road', async ({
  page,
}, testInfo) => {
  test.skip(test.info().project.name !== 'chromium', 'Interactive acceptance runs in Chromium');
  test.setTimeout(120_000);
  await createGame(page, { players: 3, humans: [0, 1, 2], fixedBoard: true });
  await completeSetup(page, 'mouse', testInfo);
  await rollAndBuildRoad(page, 'mouse', testInfo);
  expect(pageErrors.get(page)).toEqual([]);
});

async function rollAndBuildRoad(
  page: Page,
  input: 'mouse' | 'touch',
  testInfo?: TestInfo,
): Promise<void> {
  await revealIfCovered(page);
  await page.getByRole('button', { name: 'Roll dice' }).click();
  let reachedMain = false;
  for (let step = 0; step < 20; step++) {
    const view = await page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      return {
        phase: hook?.session.getState().turn.phase.at(-1)?.id,
        robber: hook?.diagnostics().actions?.placements.robber[0]?.id,
        steal: hook?.diagnostics().actions?.stealTargets.length ?? 0,
        revision: hook?.diagnostics().revision ?? -1,
      };
    });
    if (view.phase === 'main') {
      reachedMain = true;
      break;
    }
    if (view.robber) {
      await clickLegalPlacement(page, 'hex', view.robber, view.revision, input);
    } else if (view.steal > 0) {
      const victim = page.getByRole('dialog', { name: 'Steal a card' }).getByRole('button').first();
      if (input === 'touch') await victim.tap();
      else await victim.click();
    } else await page.waitForTimeout(20);
  }
  expect(reachedMain, 'Roll and any robber interruption must reach the main phase').toBe(true);
  // The ordinary action dock must offer an affordable road after this setup.
  const roadAction = page
    .getByRole('group', { name: 'Choose a board action' })
    .getByRole('button', { name: 'Build road' });
  if (input === 'touch' && !(await roadAction.isVisible()))
    await revealActionButton(page, 'Build road', input);
  if (await roadAction.isVisible()) {
    if (input === 'touch') await roadAction.tap();
    else await roadAction.click();
  }
  const target = await readPresent(page, 'Legal road coordinate', () =>
    page.evaluate((knownEdges) => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      if (!hook?.renderer) return null;
      const roads = hook.diagnostics().actions?.placements.road ?? [];
      for (const road of roads) {
        const edge = knownEdges.find((candidate) => candidate === road.id);
        if (!edge) continue;
        const point = hook.pixelPosition({ kind: 'edge', id: edge });
        if (
          point &&
          document.elementFromPoint(point.x, point.y) instanceof HTMLCanvasElement &&
          hook.renderer.hitTest(point, 'edge')?.id === road.id
        )
          return { ...point, id: road.id, roads: hook.session.getState().board.roads.length };
      }
      return null;
    }, fixedGraph.edgeIds),
  );
  const revision = await observedRevision(page);
  if (input === 'touch') await page.touchscreen.tap(target.x, target.y);
  else await page.mouse.click(target.x, target.y);
  await expect(page.getByRole('button', { name: 'Confirm road' })).toBeVisible();
  expect(await observedRevision(page)).toBe(revision);
  expect(
    await page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      return hook?.session.getState().board.roads.length ?? -1;
    }),
  ).toBe(target.roads);
  if (input === 'mouse') await assertRoadConfirmationTracksBoard(page, target.id, revision);
  if (testInfo) await capturePreview(page, testInfo, `${input}-paid-road-preview`);
  const cancel = page
    .getByRole('region', { name: 'Game board' })
    .getByRole('button', { name: 'Cancel', exact: true });
  if (input === 'touch') await cancel.tap();
  else await cancel.click();
  await expect(page.getByRole('button', { name: 'Confirm road' })).toBeHidden();
  expect(await observedRevision(page)).toBe(revision);
  if (input === 'touch') await page.touchscreen.tap(target.x, target.y);
  else await page.mouse.click(target.x, target.y);
  await confirmPlacement(page, 'road', revision, input);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.session.getState().board.roads.length ?? -1;
      }),
    )
    .toBeGreaterThan(target.roads);
}

async function assertRoadConfirmationTracksBoard(
  page: Page,
  edge: string,
  revision: number,
): Promise<void> {
  const position = async () =>
    page.evaluate(
      (hit) => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        const popup = document.querySelector('.game-board .placement-confirmation');
        const point = hook?.pixelPosition(hit);
        if (!point || !popup) return null;
        const rect = popup.getBoundingClientRect();
        return {
          point,
          gap: Math.hypot(
            Math.max(rect.left - point.x, point.x - rect.right, 0),
            Math.max(rect.top - point.y, point.y - rect.bottom, 0),
          ),
        };
      },
      canonicalBoardHit('edge', edge),
    );
  await expect.poll(async () => (await position())?.gap ?? Infinity).toBeLessThan(80);
  const before = await position();
  const canvas = page.locator('.board-view-canvas canvas');
  const box = await canvas.boundingBox();
  if (!box || !before) throw new Error('Road preview has no board anchor');
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 60, start.y + 20, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const after = await position();
      return after ? Math.hypot(after.point.x - before.point.x, after.point.y - before.point.y) : 0;
    })
    .toBeGreaterThan(10);
  await expect.poll(async () => (await position())?.gap ?? Infinity).toBeLessThan(80);
  expect(await observedRevision(page)).toBe(revision);
}

test('phone touch controls complete hotseat setup, roll, and road placement', async ({
  browser,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Touch acceptance runs in mobile Chromium');
  test.setTimeout(120_000);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await createGame(page, { players: 3, humans: [0, 1, 2], fixedBoard: true });
    await completeSetup(page, 'touch', testInfo);
    await rollAndBuildRoad(page, 'touch', testInfo);
    expect(pageErrors.get(page)).toEqual([]);
  } finally {
    await context.close();
  }
});

test('four zero-delay bots finish a default ten-point game on a phone viewport', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Mobile completion runs in Chromium');
  test.setTimeout(180_000);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await createGame(page, { players: 4, humans: [] });
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
            return hook?.session.getState().result?.winner ?? null;
          }),
        { timeout: 150_000 },
      )
      .not.toBeNull();
    await expect(page.getByRole('dialog', { name: /Player \d+ wins/ })).toBeVisible();
    expect(pageErrors.get(page)).toEqual([]);
  } finally {
    await context.close();
  }
});

async function clickLegalPlacement(
  page: Page,
  kind: 'vertex' | 'edge' | 'hex',
  id: string,
  revision: number,
  input: 'mouse' | 'touch' = 'mouse',
): Promise<void> {
  const point = await readPresent(page, 'Board coordinate', () =>
    page.evaluate(
      (hit) => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.pixelPosition(hit) ?? null;
      },
      canonicalBoardHit(kind, id),
    ),
  );
  await expect
    .poll(() =>
      page.evaluate(({ x, y }) => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.renderer?.hitTest({ x, y })?.id ?? null;
      }, point),
    )
    .toBe(id);
  if (input === 'touch') await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.diagnostics().revision ?? -1;
      }),
    )
    .toBeGreaterThan(revision);
}

async function revealActionButton(
  page: Page,
  name: string,
  input: 'mouse' | 'touch',
): Promise<Locator> {
  const button = page.getByRole('button', { name, exact: true }).first();
  if (!(await button.isVisible())) {
    const trigger = page.locator('.next-step-actions');
    if (await trigger.isVisible()) {
      if (input === 'touch') await trigger.tap();
      else await trigger.click();
      await expect(page.getByRole('dialog', { name: 'Actions' })).toBeVisible();
    }
  }
  await expect(button).toBeVisible();
  return button;
}

async function clickAction(
  page: Page,
  name: string,
  revision: number,
  input: 'mouse' | 'touch' = 'mouse',
): Promise<void> {
  const button = await revealActionButton(page, name, input);
  if (input === 'touch') await button.tap();
  else await button.click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.diagnostics().revision ?? -1;
      }),
    )
    .toBeGreaterThan(revision);
}

async function confirmPlacement(
  page: Page,
  piece: 'road' | 'settlement' | 'city',
  revision: number,
  input: 'mouse' | 'touch' = 'mouse',
): Promise<void> {
  const confirm = page.getByRole('button', { name: `Confirm ${piece}` });
  await expect(confirm).toBeVisible();
  expect(await observedRevision(page)).toBe(revision);
  if (input === 'touch') await confirm.tap();
  else await confirm.click();
  await expect.poll(() => observedRevision(page)).toBeGreaterThan(revision);
}

async function selectBoardPlacement(
  page: Page,
  kind: 'vertex' | 'edge' | 'hex',
  id: string,
  input: 'mouse' | 'touch' = 'mouse',
): Promise<void> {
  // The session hook is available before the asynchronous renderer has loaded its assets.
  await expect(page.locator('.board-view-canvas')).toHaveAttribute('aria-hidden', 'false');
  const point = await page.evaluate(
    (hit) => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      return hook?.pixelPosition(hit) ?? null;
    },
    canonicalBoardHit(kind, id),
  );
  if (!point) throw new Error(`No visible board point for ${kind}:${id}`);
  const board = page.locator('.board-view-canvas canvas');
  const bounds = await board.boundingBox();
  if (
    !bounds ||
    point.x < bounds.x ||
    point.x > bounds.x + bounds.width ||
    point.y < bounds.y ||
    point.y > bounds.y + bounds.height
  )
    throw new Error(`Board point for ${kind}:${id} is outside the visible canvas`);
  const unobscured = await board.evaluate(
    (canvas, position) => document.elementFromPoint(position.x, position.y) === canvas,
    point,
  );
  if (!unobscured) throw new Error(`Board point for ${kind}:${id} is covered`);
  if (input === 'touch') await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

async function chooseBoardPlacement(
  page: Page,
  kind: 'vertex' | 'edge' | 'hex',
  id: string,
  revision: number,
  input: 'mouse' | 'touch' = 'mouse',
  piece?: 'settlement' | 'city',
): Promise<void> {
  await selectBoardPlacement(page, kind, id, input);
  if (kind === 'edge') await confirmPlacement(page, 'road', revision, input);
  if (kind === 'vertex') {
    if (!piece) throw new Error('Vertex placement needs a building kind');
    await confirmPlacement(page, piece, revision, input);
  }
  try {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
          return hook?.diagnostics().revision ?? -1;
        }),
      )
      .toBeGreaterThan(revision);
  } catch (error) {
    const screen = await page.locator('body').innerText();
    throw new Error(
      `Keyboard ${kind}:${id} at revision ${revision} failed: ${String(error)}; browser errors: ${pageErrors.get(page)?.join(' | ')}; screen: ${screen.slice(0, 1000)}`,
      { cause: error },
    );
  }
}

async function playVisibleHumanStep(
  page: Page,
  input: 'mouse' | 'touch' = 'mouse',
): Promise<'complete' | 'acted' | 'waiting'> {
  if (await page.getByRole('heading', { name: "This page couldn't load." }).isVisible())
    throw new Error(`Game route failed: ${pageErrors.get(page)?.join(' | ')}`);
  await revealIfCovered(page, input);
  const view = await page.evaluate(() => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    if (!hook) return null;
    const state = hook.session.getState();
    const human = hook.session.controllableSeats()[0];
    return {
      result: state.result,
      phase: state.turn.phase.at(-1)?.id,
      actions: hook.diagnostics().actions,
      revision: hook.diagnostics().revision,
      hand: human === undefined ? null : hook.session.getPrivate(human)?.hand,
      rejectionCount: hook.diagnostics().rejectionCount,
    };
  });
  if (!view) return 'waiting';
  if (view.rejectionCount !== 0)
    throw new Error(`Ordinary UI rejected ${view.rejectionCount} inputs`);
  if (view.result) return 'complete';
  const actions = view.actions;
  if (!actions) return 'waiting';
  if (view.phase === 'setup') {
    const settlement = actions.placements.settlement[0];
    const road = actions.placements.road[0];
    const choice = settlement ?? road;
    if (!choice) return 'waiting';
    await chooseBoardPlacement(
      page,
      settlement ? 'vertex' : 'edge',
      choice.id,
      view.revision,
      input,
      settlement ? 'settlement' : undefined,
    );
    return 'acted';
  }
  const discard = actions.templates.find((group) => group.type === 'DISCARD')?.templates[0];
  if (discard && typeof discard.count === 'number' && view.hand) {
    let remaining = discard.count;
    for (const resource of ['brick', 'lumber', 'wool', 'grain', 'ore'] as const) {
      const count = Math.min(remaining, view.hand[resource] ?? 0);
      if (count > 0) {
        const name = `${resource[0]?.toUpperCase()}${resource.slice(1)}`;
        const addCard = page.getByRole('button', { name: `Add ${name} to Cards to discard` });
        for (let card = 0; card < count; card++) await addCard.click();
        remaining -= count;
      }
    }
    if (remaining !== 0) throw new Error('Could not compose the required discard');
    await clickAction(page, 'Confirm', view.revision, input);
    return 'acted';
  }
  if (actions.placements.robber[0]) {
    await chooseBoardPlacement(page, 'hex', actions.placements.robber[0].id, view.revision, input);
    return 'acted';
  }
  if (actions.stealTargets.length > 0) {
    const victim = page.getByRole('dialog', { name: 'Steal a card' }).getByRole('button').first();
    if (input === 'touch') await victim.tap();
    else await victim.click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
          return hook?.diagnostics().revision ?? -1;
        }),
      )
      .toBeGreaterThan(view.revision);
    return 'acted';
  }
  if (actions.primary.some((group) => group.type === 'RESPOND_TRADE')) {
    await clickAction(page, 'Decline', view.revision, input);
    return 'acted';
  }
  if (actions.primary.some((group) => group.type === 'ROLL_DICE')) {
    await clickAction(page, 'Roll dice', view.revision, input);
    return 'acted';
  }
  if (view.phase === 'main') {
    for (const [kind, label] of [
      ['city', 'Upgrade city'],
      ['settlement', 'Build settlement'],
    ] as const) {
      const choice = actions.placements[kind][0];
      if (!choice) continue;
      const chooser = page
        .getByRole('group', { name: 'Choose a board action' })
        .getByRole('button', { name: label });
      if (!(await chooser.isVisible())) await revealActionButton(page, label, input);
      if (await chooser.isVisible()) {
        if (input === 'touch') await chooser.tap();
        else await chooser.click();
      }
      await chooseBoardPlacement(page, 'vertex', choice.id, view.revision, input, kind);
      return 'acted';
    }
    if (actions.primary.some((group) => group.type === 'BUY_DEV_CARD')) {
      await clickAction(page, 'Buy development card', view.revision, input);
      return 'acted';
    }
  }
  if (actions.primary.some((group) => group.type === 'END_TURN')) {
    await clickAction(page, 'End turn', view.revision, input);
    return 'acted';
  }
  if (actions.primary.some((group) => group.type === 'CLAIM_VICTORY')) {
    await clickAction(page, 'Claim victory', view.revision, input);
    return 'acted';
  }
  return 'waiting';
}

async function completeVisibleGame(page: Page, input: 'mouse' | 'touch'): Promise<void> {
  let lastRevision = -1;
  let unchangedSince = Date.now();
  const started = Date.now();
  const diagnosticAfterMs = process.env.PHONE_DIAGNOSTIC === '1' ? 30_000 : null;
  let lastAction = 'none';
  for (let step = 0; step < 2_000; step++) {
    if (diagnosticAfterMs !== null && Date.now() - started > diagnosticAfterMs)
      throw new Error(`Visible phone diagnostic reached ${step} steps after ${lastAction}`);
    const result = await playVisibleHumanStep(page, input);
    lastAction = result;
    if (result === 'complete') return;
    if (result === 'acted') {
      unchangedSince = Date.now();
      continue;
    }
    const snapshot = await page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      const state = hook?.session.getState();
      return {
        revision: hook?.diagnostics().revision ?? -1,
        turn: state?.turn.number,
        phase: state?.turn.phase.at(-1)?.id,
        pending: hook?.diagnostics().pending,
        availableTypes: hook?.diagnostics().actions?.availableTypes,
      };
    });
    if (snapshot.revision !== lastRevision) {
      lastRevision = snapshot.revision;
      unchangedSince = Date.now();
    }
    if (
      Date.now() - unchangedSince > 10_000 ||
      (diagnosticAfterMs !== null && Date.now() - started > diagnosticAfterMs)
    )
      throw new Error(
        `Visible UI stalled after ${step} steps (${lastAction}): ${JSON.stringify(snapshot)}; browser errors: ${pageErrors.get(page)?.join(' | ')}`,
      );
    await page.waitForTimeout(20);
  }
  throw new Error(`Game did not complete; browser errors: ${pageErrors.get(page)?.join(' | ')}`);
}

async function completedGameSummary(page: Page) {
  return page.evaluate(() => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    if (!hook) throw new Error('Developer diagnostics disappeared after completion');
    const state = hook.session.getState();
    const save: unknown = hook.session.exportSave();
    const batches: unknown[] =
      typeof save === 'object' && save !== null && Array.isArray(Reflect.get(save, 'batches'))
        ? Reflect.get(save, 'batches')
        : [];
    const humanActions: Record<string, number> = {};
    for (const batch of batches) {
      if (typeof batch !== 'object' || batch === null) continue;
      const submitted: unknown = Reflect.get(batch, 'submitted');
      if (typeof submitted !== 'object' || submitted === null) continue;
      if (Reflect.get(submitted, 'kind') !== 'command' || Reflect.get(submitted, 'seat') !== 0)
        continue;
      const command: unknown = Reflect.get(submitted, 'command');
      if (typeof command !== 'object' || command === null) continue;
      const type: unknown = Reflect.get(command, 'type');
      if (typeof type === 'string') humanActions[type] = (humanActions[type] ?? 0) + 1;
    }
    const base = state.config.options.base;
    return {
      vpTarget: typeof base === 'object' && base !== null ? Reflect.get(base, 'vpTarget') : null,
      result: state.result,
      turns: state.turn.number,
      revision: hook.diagnostics().revision,
      humanActions,
      rejectionCount: hook.diagnostics().rejectionCount,
    };
  });
}

test('a human completes a default ten-point game against three bots on a phone', async ({
  browser,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Full phone play uses mobile Chromium');
  test.setTimeout(process.env.PHONE_DIAGNOSTIC === '1' ? 60_000 : 300_000);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    await createGame(page, { players: 4, humans: [0] });
    await completeVisibleGame(page, 'touch');
    await expect(page.getByRole('dialog', { name: /Player \d+ wins/ })).toBeVisible();
    const summary = await completedGameSummary(page);
    expect(summary.vpTarget).toBe(10);
    expect(summary.result?.winner).not.toBeNull();
    expect(summary.rejectionCount).toBe(0);
    expect(pageErrors.get(page)).toEqual([]);
    await testInfo.attach('full-phone-game', {
      body: JSON.stringify(summary, null, 2),
      contentType: 'application/json',
    });
  } finally {
    await context.close();
  }
});

test('twenty complete ten-point games use only offered visible controls without rejected inputs', async ({
  browser,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'The full UI acceptance run uses Chromium');
  // Hosted runners completed 18 games in 30 minutes; retain all twenty games.
  test.setTimeout(process.env.CI ? 3_600_000 : 1_800_000);
  const sourceBefore = await sourceFingerprint();
  const games: { game: number; summary: Awaited<ReturnType<typeof completedGameSummary>> }[] = [];
  try {
    for (let game = 0; game < 20; game++) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await createGame(page, { players: 4, humans: [0] });
        await completeVisibleGame(page, 'mouse');
        await expect(page.getByRole('dialog', { name: /Player \d+ wins/ })).toBeVisible();
        expect(pageErrors.get(page), `Game ${game + 1} had browser errors`).toEqual([]);
        const summary = await completedGameSummary(page);
        expect(summary.vpTarget).toBe(10);
        expect(summary.result?.winner).not.toBeNull();
        expect(summary.rejectionCount).toBe(0);
        games.push({ game: game + 1, summary });
        process.stdout.write(
          `Completed visible UI game ${game + 1}/20: ${summary.turns} turns, ${summary.revision} inputs, ${summary.rejectionCount} rejected\n`,
        );
      } finally {
        await context.close();
      }
    }
  } finally {
    const evidence = { sourceBefore, sourceAfter: await sourceFingerprint(), games };
    const body = JSON.stringify(evidence, null, 2);
    await testInfo.attach('full20-game-evidence', { body, contentType: 'application/json' });
    const folder = join(repoRoot, 'reports/stage05');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'ui-full20.json'), body);
  }
  expect(games).toHaveLength(20);
  expect(await sourceFingerprint()).toBe(sourceBefore);
});
