/* eslint-disable no-await-in-loop -- The viewports are checked one after another. */
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SEAT, rollDice, startKnightsGame, untilHumanTurn } from './helpers/knights-play.js';
import { inMain, replace, snapshot, withHand } from './helpers/knights-scenes.js';

/**
 * The eight kinds of card in a knights hand keep one spacing: the three commodities after the
 * divider must not overlap each other or their count badges. Pictures go to `KNIGHTS_HAND_SHOTS`
 * when set, otherwise to the test's output folder.
 */
const VIEWPORTS = [
  { name: 'phone-portrait', width: 390, height: 844 },
  { name: 'phone-landscape', width: 844, height: 390 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'desktop', width: 1440, height: 900 },
] as const;

const HAND = { brick: 2, lumber: 3, wool: 1, grain: 4, ore: 2, cloth: 1, coin: 2, paper: 3 };

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const folder = process.env.KNIGHTS_HAND_SHOTS ?? testInfo.outputDir;
  await mkdir(folder, { recursive: true });
  const box = await page.locator('.hand-cards:visible').first().boundingBox();
  const body = await page.screenshot({
    path: join(folder, `${name}.png`),
    animations: 'disabled',
    ...(box
      ? { clip: { x: box.x - 16, y: box.y - 16, width: box.width + 32, height: box.height + 24 } }
      : {}),
  });
  await testInfo.attach(name, { body, contentType: 'image/png' });
}

/** Left and right edges of each card's picture and count badge, in hand order. */
function cardBoxes(page: Page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('.resource-hand-card')].filter(
      (element) => element.getBoundingClientRect().width > 0,
    );
    return cards.map((card) => {
      const image = card.querySelector('img')?.getBoundingClientRect();
      const badge = card.querySelector('.resource-card-count')?.getBoundingClientRect();
      return {
        commodity: card.getAttribute('data-commodity') === 'true',
        left: image?.left ?? 0,
        right: image?.right ?? 0,
        badgeLeft: badge?.left ?? 0,
        badgeRight: badge?.right ?? 0,
      };
    });
  });
}

test('the eight hand cards of a knights game keep one spacing', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await startKnightsGame(page);
  await untilHumanTurn(page, 'roll');
  await rollDice(page);
  await untilHumanTurn(page, 'main');
  await replace(page, withHand(inMain(await snapshot(page), SEAT), SEAT, HAND));
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(400);
    await shot(page, testInfo, `hand-${viewport.name}`);
    const cards = await cardBoxes(page);
    expect(cards.map((card) => card.commodity)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
    const steps = cards.slice(1).map((card, index) => card.left - (cards[index]?.left ?? 0));
    const resourceStep = steps[0] ?? 0;
    // Resource to resource, and commodity to commodity, the same step; the divider adds a gap.
    for (const step of [...steps.slice(0, 4), ...steps.slice(5)])
      expect(Math.abs(step - resourceStep), `${viewport.name} steps ${steps.join()}`).toBeLessThan(
        1,
      );
    expect(steps[4] ?? 0).toBeGreaterThan(resourceStep + 4);
    for (let index = 1; index < cards.length; index++) {
      const previous = cards[index - 1];
      const card = cards[index];
      if (!previous || !card) continue;
      expect(card.left, `${viewport.name} card ${index} overlaps`).toBeGreaterThanOrEqual(
        previous.right,
      );
      expect(card.badgeLeft, `${viewport.name} badge ${index} overlaps`).toBeGreaterThanOrEqual(
        previous.badgeRight,
      );
    }
  }
});
