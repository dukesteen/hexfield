/* eslint-disable no-await-in-loop -- Each step of the autoplay depends on the game the last one left. */
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SEAT,
  endTurn,
  ensureCards,
  gameState,
  humanSubmit,
  knightsOf,
  legalTypes,
  rollDice,
  startKnightsGame,
  untilHumanTurn,
} from './helpers/knights-play.js';

/** Where screenshots go: `KNIGHTS_SHOTS` when set, otherwise the test's own output folder. */
async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const folder = process.env.KNIGHTS_SHOTS ?? testInfo.outputDir;
  await mkdir(folder, { recursive: true });
  const body = await page.screenshot({ path: join(folder, `${name}.png`), animations: 'disabled' });
  await testInfo.attach(name, { body, contentType: 'image/png' });
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/** What a turn spends its cards on, best first. Every entry is a knights or base build. */
const SPEND = [
  'BUILD_CITY',
  'BUILD_IMPROVEMENT',
  'BUILD_KNIGHT',
  'ACTIVATE_KNIGHT',
  'PROMOTE_KNIGHT',
  'BUILD_CITY_WALL',
  'BUILD_SETTLEMENT',
  'BUILD_ROAD',
] as const;

interface Tally {
  rounds: number;
  knights: number;
  improvements: number;
  attacks: number;
  ended: boolean;
}

/**
 * Play the human for `rounds` rounds against the bots: force a ship face on the first rolls to
 * bring the barbarians in, spend whatever the hand allows, and keep going through every
 * interruption. Returns what the game reached.
 */
async function playRounds(page: Page, rounds: number, ships: number): Promise<Tally> {
  const tally: Tally = { rounds: 0, knights: 0, improvements: 0, attacks: 0, ended: false };
  for (let round = 0; round < rounds; round++) {
    if (!(await untilHumanTurn(page, 'roll'))) break;
    await rollDice(page, round < ships ? { dice: [2, 3], event: 'ship' } : undefined);
    if (!(await untilHumanTurn(page, 'main'))) break;
    for (let spend = 0; spend < 8; spend++) {
      const legal = await legalTypes(page);
      const type = SPEND.find((candidate) => legal.includes(candidate));
      if (!type) break;
      const outcome = await humanSubmit(page, [type]);
      if (!outcome.startsWith('ok:')) break;
    }
    tally.rounds += 1;
    await endTurn(page);
  }
  const state = await gameState(page);
  const ext = knightsOf(state);
  tally.knights = ext.knights.filter((knight) => knight.seat === SEAT).length;
  tally.improvements = Object.values(ext.improvements[SEAT] ?? {}).reduce((a, b) => a + b, 0);
  tally.attacks = ext.lastAttack ? 1 : 0;
  tally.ended = Boolean(state.result);
  return tally;
}

/** Buy the first level of the science track when the engine allows it. */
function submitScience(page: Page): Promise<string> {
  return page.evaluate(async (seat) => {
    const session = window['__cp2p']!.session;
    const command = session
      .getLegalCommands(seat)
      .commands.find((item) => item.type === 'BUILD_IMPROVEMENT' && item['track'] === 'science');
    if (!command) return 'none';
    const done = await session.submit(seat, command);
    return done.ok ? 'ok' : done.error.code;
  }, SEAT);
}

test.describe('cities and knights, local', () => {
  test.setTimeout(240_000);

  test('a four-player game plays many rounds: knights, an attack, no page errors', async ({
    page,
  }, testInfo) => {
    const errors = watchErrors(page);
    await startKnightsGame(page, { seats: 4 });
    await expect(page.getByTestId('knights-panel').first()).toBeVisible();
    const tally = await playRounds(page, 22, 8);
    await shot(page, testInfo, 'four-player-after-play');
    expect(tally.ended || tally.rounds >= 10).toBe(true);
    expect(tally.attacks, 'the forced ship faces bring an attack').toBe(1);
    expect(errors).toEqual([]);
  });

  test('a five-player game plays rounds on the five-six board without page errors', async ({
    page,
  }, testInfo) => {
    const errors = watchErrors(page);
    await startKnightsGame(page, { scenario: 'knights-56', seats: 5 });
    const tally = await playRounds(page, 14, 8);
    await shot(page, testInfo, 'five-player-after-play');
    expect(tally.ended || tally.rounds >= 8).toBe(true);
    expect(tally.attacks).toBe(1);
    expect(errors).toEqual([]);
  });

  test('a city buys a city improvement and a science card is drawn and played', async ({
    page,
  }, testInfo) => {
    const errors = watchErrors(page);
    let bought = false;
    for (let attempt = 0; attempt < 5 && !bought; attempt++) {
      await startKnightsGame(page);
      for (let round = 0; round < 45 && !bought; round++) {
        if (!(await untilHumanTurn(page, 'roll'))) break;
        await rollDice(page);
        if (!(await untilHumanTurn(page, 'main'))) break;
        if ((await legalTypes(page)).includes('BUILD_CITY'))
          await humanSubmit(page, ['BUILD_CITY']);
        const hasCity = (await gameState(page)).board.buildings.some(
          (item) => item.seat === SEAT && item.kind === 'city',
        );
        if (hasCity && (await ensureCards(page, { paper: 1 }))) {
          const outcome = await submitScience(page);
          bought = outcome === 'ok';
        }
        if (!bought) await endTurn(page);
      }
    }
    expect(bought, 'an improvement was bought').toBe(true);
    await expect(page.getByTestId('improve-science').locator('visible=true').first()).toBeVisible();
    await shot(page, testInfo, 'improvement-bought');
    const ext = knightsOf(await gameState(page));
    expect(Object.values(ext.improvements[SEAT] ?? {}).some((level) => level > 0)).toBe(true);
    // A red die of one with the science gate draws a science card; a lit card in hand plays.
    await endTurn(page);
    let drawn = false;
    for (let round = 0; round < 8 && !drawn; round++) {
      if (!(await untilHumanTurn(page, 'roll'))) break;
      await rollDice(page, { dice: [1, 4], event: 'science' });
      if (!(await untilHumanTurn(page, 'main'))) break;
      drawn = (await page.locator('.progress-hand-card').count()) > 0;
      if (!drawn) await endTurn(page);
    }
    expect(drawn, 'a progress card was drawn').toBe(true);
    await shot(page, testInfo, 'progress-hand');
    const lit = page.locator('.progress-hand-card[data-playable="true"]:not([disabled])');
    if (await lit.count()) {
      await lit.first().click();
      const play = page.getByRole('button', { name: 'Play card' });
      if (await play.count()) {
        await play.click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
      }
    }
    expect(errors).toEqual([]);
  });

  test('the phone shows the barbarian track and reaches the improvements', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = watchErrors(page);
    await startKnightsGame(page);
    await expect
      .poll(() =>
        page.evaluate(() => window['__cp2p']!.renderer!.isFixtureInView('barbarian-track')),
      )
      .toBe(true);
    await expect(page.getByTestId('barbarian-countdown')).toHaveCount(0);
    await shot(page, testInfo, 'phone-default-fit');
    await untilHumanTurn(page, 'roll');
    await rollDice(page);
    await untilHumanTurn(page, 'main');
    const strip = page.getByTestId('improvements-strip');
    await expect(strip).toBeVisible();
    await strip.click();
    await expect(page.getByTestId('improve-science').locator('visible=true').first()).toBeVisible();
    await shot(page, testInfo, 'phone-improvements');
    expect(errors).toEqual([]);
  });

  test('the countdown pill shows only while the track is out of view', async ({ page }) => {
    const errors = watchErrors(page);
    await startKnightsGame(page);
    const track = (): Promise<boolean> =>
      page.evaluate(() => window['__cp2p']!.renderer!.isFixtureInView('barbarian-track'));
    await expect.poll(track).toBe(true);
    await expect(page.getByTestId('barbarian-countdown')).toHaveCount(0);
    const box = await page.locator('.board-view-canvas canvas').boundingBox();
    if (!box) throw new Error('No board canvas');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 8);
    for (let wheel = 0; wheel < 12 && (await track()); wheel++) {
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(80);
    }
    await expect.poll(track).toBe(false);
    await expect(page.getByTestId('barbarian-countdown')).toBeVisible();
    await expect(page.getByTestId('barbarian-countdown')).toContainText('Barbarians:');
    await page.getByTestId('barbarian-countdown').click();
    await expect(page.getByTestId('barbarian-dialog')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
