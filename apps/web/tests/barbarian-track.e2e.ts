/* eslint-disable no-await-in-loop -- Each picture waits for the board the last step left. */
import { expect, test } from '@playwright/test';
import type { Browser, Page, TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { knightsExt } from '@cp2p/engine';
import type { GameState } from '@cp2p/engine';
import { rollDice, startKnightsGame, untilHumanTurn } from './helpers/knights-play.js';
import { replace, snapshot, withBarbarians } from './helpers/knights-scenes.js';
import type { Snapshot } from './helpers/knights-scenes.js';
import { HEX_SIZE, VIEWPORTS, gameState, isPhone } from './helpers/seafaring-board.js';

/**
 * The composed barbarian track on every board that has one, in both themes and on a desktop and
 * a phone, plus the six directions a two-hex track can lie in. Pictures go to `BARBARIAN_SHOTS`
 * when it is set, otherwise to the test's output folder.
 */
const BOARDS = [
  { id: 'knights', seats: 4 },
  { id: 'knights-56', seats: 5 },
  { id: 'new-horizons-knights', seats: 4 },
  { id: 'new-horizons-knights-56', seats: 5 },
  { id: 'desert-crossing-knights', seats: 3 },
] as const;
const VIEWS = ['desktop', 'phone-portrait'] as const;
const SCHEMES = ['light', 'dark'] as const;

async function open(browser: Browser, view: (typeof VIEWS)[number], scheme: 'light' | 'dark') {
  const context = await browser.newContext({
    viewport: VIEWPORTS[view],
    isMobile: isPhone(view),
    hasTouch: isPhone(view),
    colorScheme: scheme,
    // Sharp enough to read the step numbers in the close-ups.
    deviceScaleFactor: Number(process.env.BARBARIAN_DPR ?? 3),
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors };
}

async function folder(testInfo: TestInfo): Promise<string> {
  const target = process.env.BARBARIAN_SHOTS ?? testInfo.outputDir;
  await mkdir(target, { recursive: true });
  return target;
}

/** The track's cells on screen, padded by a hex, clipped to the window. */
async function trackClip(page: Page, state: GameState) {
  const footprint = state.board.fixtures?.[0]?.footprint ?? [];
  const corners = await page.evaluate(
    ({ cells, size }) => {
      const renderer = window['__cp2p']?.renderer;
      if (!renderer) throw new Error('Renderer is not ready');
      return cells.flatMap(({ q, r }) => {
        const center = { x: Math.sqrt(3) * size * (q + r / 2), y: 1.5 * size * r };
        return [
          renderer.boardToScreen({ x: center.x - size * 1.2, y: center.y - size * 1.2 }),
          renderer.boardToScreen({ x: center.x + size * 1.2, y: center.y + size * 1.2 }),
        ];
      });
    },
    { cells: footprint, size: HEX_SIZE },
  );
  const screen = page.viewportSize() ?? { width: 0, height: 0 };
  const x = Math.max(0, Math.min(...corners.map((point) => point.x)));
  const y = Math.max(0, Math.min(...corners.map((point) => point.y)));
  const right = Math.min(screen.width, Math.max(...corners.map((point) => point.x)));
  const bottom = Math.min(screen.height, Math.max(...corners.map((point) => point.y)));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

async function pictures(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const target = await folder(testInfo);
  // Let the knights art arrive and the board settle before the picture.
  await page.waitForTimeout(600);
  const state = await gameState(page);
  await page.screenshot({ path: join(target, `${name}.png`), animations: 'disabled' });
  await page.screenshot({
    path: join(target, `${name}-track.png`),
    clip: await trackClip(page, state),
    animations: 'disabled',
  });
}

test.describe('the barbarian track', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'The pictures are taken in Chromium');

  for (const board of BOARDS)
    for (const view of VIEWS)
      for (const scheme of SCHEMES)
        test(`${board.id} on ${view} in ${scheme}`, async ({ browser }, testInfo) => {
          test.setTimeout(120_000);
          const { context, page, errors } = await open(browser, view, scheme);
          try {
            await startKnightsGame(page, { scenario: board.id, seats: board.seats });
            expect((await gameState(page)).board.fixtures?.map((fixture) => fixture.id)).toEqual([
              'barbarian-track',
            ]);
            await replace(page, withBarbarians(await snapshot(page), 3));
            await expect
              .poll(() =>
                page.evaluate(() => window['__cp2p']?.renderer?.isFixtureInView('barbarian-track')),
              )
              .toBe(true);
            await pictures(page, testInfo, `${board.id}-${view}-${scheme}`);
            expect(errors).toEqual([]);
          } finally {
            await context.close();
          }
        });

  test('the ship sails a step and the barbarians attack without errors', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(180_000);
    const { context, page, errors } = await open(browser, 'desktop', 'light');
    try {
      await startKnightsGame(page, { scenario: 'new-horizons-knights' });
      expect(await untilHumanTurn(page, 'roll')).toBe(true);
      await replace(page, withBarbarians(await snapshot(page), 5));
      await rollDice(page, { dice: [2, 3], event: 'ship' });
      const target = await folder(testInfo);
      await page.waitForTimeout(350);
      const state = await gameState(page);
      await page.screenshot({
        path: join(target, 'sail-mid-track.png'),
        clip: await trackClip(page, state),
      });
      await expect.poll(async () => knightsExt(await gameState(page)).barbarians.step).toBe(6);
      if (!(await untilHumanTurn(page, 'roll'))) return;
      await rollDice(page, { dice: [2, 3], event: 'ship' });
      await page.waitForTimeout(500);
      await page.screenshot({
        path: join(target, 'attack-sailing-track.png'),
        clip: await trackClip(page, state),
      });
      await page.waitForTimeout(3500);
      await page.screenshot({
        path: join(target, 'attack-home-track.png'),
        clip: await trackClip(page, state),
      });
      expect(knightsExt(await gameState(page)).lastAttack).not.toBeNull();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('the track reads upright in all six directions', async ({ browser }, testInfo) => {
    test.setTimeout(120_000);
    const { context, page, errors } = await open(browser, 'desktop', 'light');
    try {
      await startKnightsGame(page, { scenario: 'knights' });
      const start = await snapshot(page);
      const directions = [
        { name: 'east', q: 1, r: 0 },
        { name: 'south-east', q: 0, r: 1 },
        { name: 'south-west', q: -1, r: 1 },
        { name: 'west', q: -1, r: 0 },
        { name: 'north-west', q: 0, r: -1 },
        { name: 'north-east', q: 1, r: -1 },
      ];
      for (const direction of directions) {
        // The track on the sea ring, its outer hex one step further out.
        const footprint = [3, 4].map((ring) => ({ q: direction.q * ring, r: direction.r * ring }));
        const moved: Snapshot = {
          ...start,
          state: {
            ...start.state,
            board: {
              ...start.state.board,
              fixtures: (start.state.board.fixtures ?? []).map((fixture) => ({
                ...fixture,
                footprint,
              })),
            },
          },
        };
        await replace(page, withBarbarians(moved, direction.name.length % 7));
        await page.evaluate(() => window['__cp2p']?.renderer?.fitToBoard());
        await pictures(page, testInfo, `direction-${direction.name}`);
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
