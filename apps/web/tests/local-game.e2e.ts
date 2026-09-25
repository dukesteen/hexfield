/* eslint-disable no-await-in-loop -- Each browser action depends on the preceding game state. */
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Seat } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { standardFixedBoard } from '@cp2p/maps';
import type { DevHook } from '../src/features/devtools/hook.js';
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
  const screenshot = await page.screenshot();
  await testInfo.attach(name, { body: screenshot, contentType: 'image/png' });
  const folder = join(repoRoot, 'reports/stage05');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${name}.png`), screenshot);
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
): Promise<void> {
  const save = await saveBeforeGoldenInput(file, stopBefore);
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
      botDelayMs: 0,
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

async function observedRevision(page: Page): Promise<number> {
  return page.evaluate(() => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    return hook?.diagnostics().revision ?? -1;
  });
}

async function revealIfCovered(page: Page, input: 'mouse' | 'touch' = 'mouse'): Promise<void> {
  const reveal = page.getByRole('button', { name: 'Reveal hand' });
  if (await reveal.isVisible()) {
    if (input === 'touch') await reveal.tap();
    else await reveal.click();
  }
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
  await expect(page.getByRole('heading', { name: /wins/ })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: /wins/ })).toBeVisible({ timeout: 150_000 });
  await page.getByRole('button', { name: 'Rematch' }).click();
  await expect(page).toHaveURL(/#\/local\/[^/]+$/);
  await expect.poll(() => page.url()).not.toBe(firstGameUrl);
  await page.getByRole('link', { name: 'Leave game' }).click();
  const prompt = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: 'Leave this game?' }),
  });
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Stay' }).click();
  await expect(page).toHaveURL(/#\/local\/[^/]+$/);
  await page.getByRole('link', { name: 'Leave game' }).click();
  await prompt.getByRole('button', { name: 'Save and leave' }).click();
  await expect(page).toHaveURL(/#\/$/);
  expect(pageErrors.get(page)).toEqual([]);
});

test('a replay-backed bank trade uses the visible multi-resource form', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium', 'Local trade forms run in Chromium');
  await openGoldenPrefix(page, 102);
  const before = await observedRevision(page);
  await page.getByRole('button', { name: 'Trade with bank' }).click();
  const dialog = page.getByRole('dialog', { name: 'Bank trade' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('spinbutton', { name: 'You give: Brick' }).fill('4');
  await dialog.getByRole('spinbutton', { name: 'Bank gives: Grain' }).fill('1');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect.poll(() => observedRevision(page)).toBeGreaterThan(before);
  expect(pageErrors.get(page)).toEqual([]);
});

test('a replay-backed trade offer and named confirmations use visible controls', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'chromium', 'Local trade forms run in Chromium');
  await openGoldenPrefix(page, 22);
  const before = await observedRevision(page);
  await page.getByRole('button', { name: 'Offer a trade' }).click();
  const dialog = page.getByRole('dialog', { name: 'Player trade' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('spinbutton', { name: 'You give: Lumber' }).fill('1');
  await dialog.getByRole('spinbutton', { name: 'You receive: Ore' }).fill('1');
  await dialog.getByRole('button', { name: 'Send offer' }).click();
  await expect.poll(() => observedRevision(page)).toBeGreaterThan(before);
  expect(pageErrors.get(page)).toEqual([]);

  const second = await page.context().newPage();
  try {
    await openGoldenPrefix(second, 35);
    await expect(second.getByText('Player 1: accepted')).toBeVisible();
    await expect(second.getByText('Player 2: accepted')).toBeVisible();
    await expect(second.getByText('Player 3: declined')).toBeVisible();
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

test('a replay-backed development card enters the visible robber flow', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium', 'Development card flow runs in Chromium');
  await openGoldenPrefix(page, 124);
  const before = await observedRevision(page);
  await page.getByRole('button', { name: 'Play Knight' }).click();
  await expect.poll(() => observedRevision(page)).toBeGreaterThan(before);
  const target = await page.evaluate(() => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    return hook?.diagnostics().actions?.placements.robber[0]?.id ?? null;
  });
  expect(target).not.toBeNull();
  if (target) await chooseKeyboardPlacement(page, 'hex', target, before + 1);
  expect(pageErrors.get(page)).toEqual([]);
});

test('replay-backed Year of Plenty and Monopoly use the visible card dialogs', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium', 'Development card flow runs in Chromium');
  await openGoldenPrefix(page, 289, 'all-development-card-types.replay.json');
  const before = await observedRevision(page);
  await page.getByRole('button', { name: 'Play Year of plenty' }).click();
  const plenty = page.getByRole('dialog', { name: 'Year of Plenty' });
  await expect(plenty).toBeVisible();
  await plenty.getByRole('combobox', { name: 'Second resource' }).selectOption('grain');
  await plenty.getByRole('button', { name: 'Confirm' }).click();
  await expect.poll(() => observedRevision(page)).toBeGreaterThan(before);
  expect(pageErrors.get(page)).toEqual([]);

  const monopolyPage = await page.context().newPage();
  try {
    await openGoldenPrefix(monopolyPage, 226, 'all-development-card-types.replay.json');
    const revision = await observedRevision(monopolyPage);
    await monopolyPage.getByRole('button', { name: 'Play Monopoly' }).click();
    const monopoly = monopolyPage.getByRole('dialog', { name: 'Monopoly' });
    await expect(monopoly).toBeVisible();
    await monopoly.getByRole('button', { name: 'Ore' }).click();
    await expect.poll(() => observedRevision(monopolyPage)).toBeGreaterThan(revision);
    expect(pageErrors.get(monopolyPage)).toEqual([]);
  } finally {
    await monopolyPage.close();
  }
});

test('a replay-backed Road Building card places a free road through the board chooser', async ({
  page,
}) => {
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
  if (target) await chooseKeyboardPlacement(page, 'edge', target, before + 1);
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
  const city = await page.evaluate(() => {
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
  });
  if (!city) throw new Error('Golden city input has no visible legal city upgrade');
  const cityAction = page
    .getByRole('group', { name: 'Choose a board action' })
    .getByRole('button', { name: 'city site' });
  await cityAction.click();
  await capturePreview(page, testInfo, 'city-legal-upgrades');
  await selectKeyboardPlacement(page, 'vertex', city.id);
  await expect(page.getByRole('button', { name: 'Confirm city' })).toBeVisible();
  expect(await observedRevision(page)).toBe(city.revision);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm city' })).toBeHidden();
  expect(await observedRevision(page)).toBe(city.revision);
  await selectKeyboardPlacement(page, 'vertex', city.id);
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
  const before = await page.evaluate(() => {
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
  });
  if (!before) throw new Error('Golden settlement input has no visible legal target');
  await page
    .getByRole('group', { name: 'Choose a board action' })
    .getByRole('button', { name: 'settlement spot' })
    .click();
  await selectKeyboardPlacement(page, 'vertex', before.id);
  await expect(page.getByRole('button', { name: 'Confirm settlement' })).toBeVisible();
  expect(await observedRevision(page)).toBe(before.revision);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await observedRevision(page)).toBe(before.revision);
  await selectKeyboardPlacement(page, 'vertex', before.id);
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
              const shown = document.querySelector(`.hand-dock .resource-${resource} strong`);
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
    const target = await page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      if (!hook?.renderer) return null;
      const actions = hook.diagnostics().actions;
      const state = hook.session.getState();
      return {
        settlements: actions?.placements.settlement.map((item) => item.id) ?? [],
        road: actions?.placements.road[0]?.id ?? null,
        pieces: state.board.buildings.length + state.board.roads.length,
      };
    });
    if (!target) throw new Error(`Missing setup target ${placement}`);
    const settlement = target.settlements.length > 0;
    const id = settlement
      ? placement === 10
        ? target.settlements.find((candidate) => dualResourceSiteIds.has(candidate))
        : target.settlements.find((candidate) => !reservedSites.has(candidate))
      : target.road;
    if (!id) throw new Error(`No suitable setup site at placement ${placement}`);
    const point = await page.evaluate(
      ({ kind, id: targetId }) => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        // The ID is one of the exact engine-provided legal targets selected above.
        // eslint-disable-next-line typescript/no-unsafe-type-assertion
        return hook?.pixelPosition({ kind, id: targetId } as never) ?? null;
      },
      { kind: settlement ? 'vertex' : 'edge', id },
    );
    if (!point) throw new Error(`Renderer has no coordinate for ${id}`);
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
      const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
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
  for (let attempt = 0; attempt < 50; attempt++) {
    const seat = await page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      return hook?.session.getState().turn.activeSeat ?? null;
    });
    if (seat !== null) return seat;
    await page.waitForTimeout(20);
  }
  throw new Error('Setup actor is unavailable');
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
    .getByRole('button', { name: 'road edge' });
  if (await roadAction.isVisible()) {
    if (input === 'touch') await roadAction.tap();
    else await roadAction.click();
  }
  const target = await page.evaluate(() => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    if (!hook?.renderer) return null;
    const roads = hook.diagnostics().actions?.placements.road ?? [];
    for (const road of roads) {
      // The engine supplied this edge as a concrete legal action.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      const point = hook.pixelPosition({ kind: 'edge', id: road.id } as never);
      if (
        point &&
        document.elementFromPoint(point.x, point.y) instanceof HTMLCanvasElement &&
        hook.renderer.hitTest(point, 'edge')?.id === road.id
      )
        return { ...point, id: road.id, roads: hook.session.getState().board.roads.length };
    }
    return null;
  });
  if (!target) throw new Error('No legal road center passed renderer hit testing');
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
  const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
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
    page.evaluate((id) => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      const popup = document.querySelector('.game-board .placement-confirmation');
      // The edge comes from the exact legal road choices offered by the engine.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      const point = hook?.pixelPosition({ kind: 'edge', id } as never);
      if (!point || !popup) return null;
      const rect = popup.getBoundingClientRect();
      return {
        point,
        gap: Math.hypot(
          Math.max(rect.left - point.x, point.x - rect.right, 0),
          Math.max(rect.top - point.y, point.y - rect.bottom, 0),
        ),
      };
    }, edge);
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
    await expect(page.getByRole('heading', { name: /wins/ })).toBeVisible();
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
  const point = await page.evaluate(
    ({ kind: hitKind, id: targetId }) => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      // The target is selected from this same hook's exact legal actions.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      return hook?.pixelPosition({ kind: hitKind, id: targetId } as never) ?? null;
    },
    { kind, id },
  );
  if (!point) throw new Error(`Missing board coordinate for ${id}`);
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

async function clickAction(
  page: Page,
  name: string,
  revision: number,
  input: 'mouse' | 'touch' = 'mouse',
): Promise<void> {
  const button = page.getByRole('button', { name, exact: true }).first();
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

async function selectKeyboardPlacement(
  page: Page,
  kind: 'vertex' | 'edge' | 'hex',
  id: string,
  input: 'mouse' | 'touch' = 'mouse',
): Promise<void> {
  const chooser = page.getByTestId('board-keyboard-targets');
  if ((await chooser.getAttribute('open')) === null) {
    if (input === 'touch') await chooser.locator('summary').tap();
    else await chooser.locator('summary').click();
  }
  await chooser.getByLabel('Board location').selectOption(`${kind}:${id}`);
  const select = chooser.getByRole('button', { name: 'Select location' });
  if (input === 'touch') await select.tap();
  else await select.click();
}

async function chooseKeyboardPlacement(
  page: Page,
  kind: 'vertex' | 'edge' | 'hex',
  id: string,
  revision: number,
  input: 'mouse' | 'touch' = 'mouse',
  piece?: 'settlement' | 'city',
): Promise<void> {
  await selectKeyboardPlacement(page, kind, id, input);
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
    await chooseKeyboardPlacement(
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
        await page
          .getByRole('spinbutton', {
            name: `Cards to discard: ${resource[0]?.toUpperCase()}${resource.slice(1)}`,
          })
          .fill(String(count));
        remaining -= count;
      }
    }
    if (remaining !== 0) throw new Error('Could not compose the required discard');
    await clickAction(page, 'Confirm', view.revision, input);
    return 'acted';
  }
  if (actions.placements.robber[0]) {
    await chooseKeyboardPlacement(
      page,
      'hex',
      actions.placements.robber[0].id,
      view.revision,
      input,
    );
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
      ['city', 'city site'],
      ['settlement', 'settlement spot'],
    ] as const) {
      const choice = actions.placements[kind][0];
      if (!choice) continue;
      const chooser = page
        .getByRole('group', { name: 'Choose a board action' })
        .getByRole('button', { name: label });
      if (await chooser.isVisible()) {
        if (input === 'touch') await chooser.tap();
        else await chooser.click();
      }
      await chooseKeyboardPlacement(page, 'vertex', choice.id, view.revision, input, kind);
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
    await expect(page.getByRole('heading', { name: /wins/ })).toBeVisible();
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
  test.setTimeout(1_800_000);
  const sourceBefore = await sourceFingerprint();
  const games: { game: number; summary: Awaited<ReturnType<typeof completedGameSummary>> }[] = [];
  try {
    for (let game = 0; game < 20; game++) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await createGame(page, { players: 4, humans: [0] });
        await completeVisibleGame(page, 'mouse');
        await expect(page.getByRole('heading', { name: /wins/ })).toBeVisible();
        expect(pageErrors.get(page), `Game ${game + 1} had browser errors`).toEqual([]);
        const summary = await completedGameSummary(page);
        expect(summary.vpTarget).toBe(10);
        expect(summary.result?.winner).not.toBeNull();
        expect(summary.rejectionCount).toBe(0);
        games.push({ game: game + 1, summary });
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
