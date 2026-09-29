/* eslint-disable no-await-in-loop -- Each step of the autoplay depends on the game the last one left. */
import { expect, test } from '@playwright/test';
import type { Browser, Page, TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { comboExt, knightsExt, seafaringExt } from '@cp2p/engine';
import {
  SEAT,
  gameState,
  humanSubmit,
  legalTypes,
  rollDice,
  trackInView,
  untilHumanTurn,
} from './helpers/knights-play.js';
import { VIEWPORTS, hexCornersOutside, isPhone, newLocalGame } from './helpers/seafaring-board.js';
import type { ViewportName } from './helpers/seafaring-board.js';

/** The combined scenarios, each with a seat count the lobby lists it for. */
const SCENARIOS = [
  { id: 'new-horizons-knights', seats: 4 },
  { id: 'new-horizons-knights-56', seats: 5 },
  { id: 'desert-crossing-knights', seats: 3 },
] as const;

/** Where screenshots go: `COMBO_SHOTS` when set, otherwise the test's own output folder. */
async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const folder = process.env.COMBO_SHOTS ?? testInfo.outputDir;
  await mkdir(folder, { recursive: true });
  const body = await page.screenshot({ path: join(folder, `${name}.png`) });
  await testInfo.attach(name, { body, contentType: 'image/png' });
}

/**
 * End the human's turn. On a phone the turn button opens the actions sheet first, so the turn is
 * ended through the session there; the desktop clicks its End turn button.
 */
async function endTurn(page: Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 0) < 600) {
    await page.evaluate(async (seat) => {
      await window['__cp2p']?.session.submit(seat, { type: 'END_TURN' });
    }, SEAT);
    return;
  }
  await page.locator('.desktop-turn-button:visible').first().click();
}

/** What the human builds in its main turn, most wanted first. */
const BUILDS = ['BUILD_SHIP', 'BUILD_KNIGHT', 'ACTIVATE_KNIGHT', 'MOVE_SHIP', 'BUILD_ROAD'];

/**
 * Play the human for `rounds` of its own turns: roll (a barbarian ship face, so the first attack
 * comes quickly and the pirate enters), build what it can, end the turn. Bots play the rest.
 */
async function playRounds(page: Page, rounds: number): Promise<number> {
  let turns = 0;
  for (let round = 0; round < rounds; round++) {
    if (!(await untilHumanTurn(page, 'roll'))) return turns;
    await rollDice(page, { dice: [2, 3], event: 'ship' });
    if (!(await untilHumanTurn(page, 'main'))) return turns;
    for (let build = 0; build < 3; build++) {
      const types = await legalTypes(page);
      if (!BUILDS.some((type) => types.includes(type))) break;
      const outcome = await humanSubmit(page, BUILDS);
      if (!outcome.startsWith('ok')) break;
      if (!(await untilHumanTurn(page, 'main'))) return turns;
    }
    await endTurn(page);
    turns += 1;
  }
  return turns;
}

async function openAt(browser: Browser, name: ViewportName) {
  const context = await browser.newContext({
    viewport: VIEWPORTS[name],
    isMobile: isPhone(name),
    hasTouch: isPhone(name),
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors };
}

test.describe('seafaring with knights against bots', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'The combined UI runs in Chromium');

  for (const scenario of SCENARIOS)
    for (const view of ['desktop', 'phone-portrait'] as const)
      test(`${scenario.id} on ${view}: both layers on one board, rounds play without errors`, async ({
        browser,
      }, testInfo) => {
        test.setTimeout(240_000);
        const { context, page, errors } = await openAt(browser, view);
        try {
          await newLocalGame(page, scenario.id, { seats: scenario.seats });
          const start = await gameState(page);
          const ids = start.config.modules.map((module) => module.id);
          expect(ids).toEqual(
            expect.arrayContaining(['seafaring', 'knights', 'scenario:seafarers-knights']),
          );
          // The barbarian track stands outside the explicit sea board, and the pirate waits.
          expect(start.board.fixtures?.map((fixture) => fixture.id)).toEqual(['barbarian-track']);
          expect(seafaringExt(start).pirateHex).toBeNull();
          await expect.poll(() => hexCornersOutside(page, start)).toBe(0);
          await expect.poll(() => trackInView(page)).toBe(true);
          await shot(page, testInfo, `${scenario.id}-${view}-start`);

          const played = await playRounds(page, 8);
          expect(played).toBeGreaterThan(2);
          const end = await gameState(page);
          expect(end.turn.number).toBeGreaterThan(start.turn.number);
          // Seven ship faces on the human's rolls alone bring the first attack within the rounds.
          const attacked = knightsExt(end).lastAttack !== null;
          expect(comboExt(end).pirateEntered).toBe(attacked);
          expect(attacked).toBe(true);
          expect(seafaringExt(end).pirateHex).not.toBeNull();
          await shot(page, testInfo, `${scenario.id}-${view}-played`);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      });
});
