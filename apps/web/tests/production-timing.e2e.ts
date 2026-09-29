/* eslint-disable no-await-in-loop -- Frames are captured one after another. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Seat } from '@cp2p/engine';
import type { DevHook } from '../src/features/devtools/hook.js';
import { openBeforeRoll } from './helpers/roll-fixture.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const shots = process.env.CP2P_ANIM_SHOTS ?? join(repoRoot, 'reports/production-timing');

interface Timeline {
  rolls: number[];
  /** Production cards still in the air when each roll arrived. */
  inFlightAtRoll: number[];
  firstFlight: number | null;
  lastFlightGone: number | null;
  /** The most effects of one kind seen running at once on the board. */
  peak: Record<string, number>;
  /** Frames where a production card flew while the token pulse ran. */
  overlap: number;
}

declare global {
  interface Window {
    cp2pTimeline?: Timeline;
  }
}

/**
 * Record, in the page, when rolls land, when production cards fly, and what the board runs. It is
 * installed before the page loads and attaches as the dev hook appears, so bots with no delay
 * cannot play before it listens.
 */
function watch(page: Page) {
  return page.addInitScript(() => {
    const recorded: Timeline = {
      rolls: [],
      inFlightAtRoll: [],
      firstFlight: null,
      lastFlightGone: null,
      peak: {},
      overlap: 0,
    };
    window.cp2pTimeline = recorded;
    let hook: DevHook | undefined;
    Object.defineProperty(window, '__cp2p', {
      configurable: true,
      get: () => hook,
      set: (value: DevHook) => {
        hook = value;
        value.session.subscribe((update) => {
          if (update.events.some((event) => event.type === 'diceRolled')) {
            recorded.rolls.push(performance.now());
            // This listener runs before the page's own, so the last roll's cards are still shown.
            recorded.inFlightAtRoll.push(document.querySelectorAll('.resource-flight').length);
          }
        });
      },
    });
    let flying = false;
    const frame = () => {
      const now = performance.now();
      const flights = document.querySelectorAll('.resource-flight').length;
      if (flights > 0 && recorded.firstFlight === null) recorded.firstFlight = now;
      if (flights > 0) flying = true;
      if (flights === 0 && flying) {
        flying = false;
        recorded.lastFlightGone = now;
      }
      const kinds = hook?.renderer?.getDiagnostics().activeEffectKinds ?? [];
      const counts: Record<string, number> = {};
      for (const kind of kinds) counts[kind] = (counts[kind] ?? 0) + 1;
      for (const [kind, count] of Object.entries(counts))
        recorded.peak[kind] = Math.max(recorded.peak[kind] ?? 0, count);
      if (flights > 0 && kinds.includes('production-pulse')) recorded.overlap += 1;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

function timeline(page: Page): Promise<Timeline> {
  return page.evaluate(() => {
    if (!window.cp2pTimeline) throw new Error('timeline missing');
    return window.cp2pTimeline;
  });
}

/** Each seat's card total on its panel and in the state. */
function totals(page: Page, seats: readonly Seat[]) {
  return page.evaluate((all) => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    return all.map((seat) => {
      const hand = hook?.session.getPrivate(seat)?.hand ?? {};
      const panel = document.querySelector(`[data-seat-panel="${seat}"] .player-panel-stats dd`);
      return {
        seat,
        state: Object.values(hand).reduce((sum, count) => sum + count, 0),
        shown: panel ? Number(panel.textContent) : null,
      };
    });
  }, seats);
}

/** Force the next roll to the fixture's best total, then roll. */
async function rollBest(page: Page, total: number) {
  const first = Math.min(6, total - 1);
  await page.getByLabel('Open game menu').click();
  const drawer = page.getByTestId('dev-drawer');
  await drawer.locator('summary').first().click();
  await drawer.getByLabel('First die').selectOption(String(first));
  await drawer.getByLabel('Second die').selectOption(String(total - first));
  await drawer.getByRole('button', { name: 'Force next dice' }).click();
  await page.getByLabel('Open game menu').click();
  await page.getByRole('button', { name: 'Roll dice' }).click();
}

test('production cards fly as the dice settle, alongside the token pulse', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Effect timing is checked in Chromium');
  await mkdir(shots, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await watch(page);
  const { roll } = await openBeforeRoll(page, 'production-timing');
  await rollBest(page, roll.total);

  await expect(page.locator('.resource-flight').first()).toBeVisible({ timeout: 3_000 });
  await writeFile(
    join(shots, 'roll-cards-in-flight.png'),
    await page.screenshot({ animations: 'allow' }),
  );
  for (const [index, wait] of [250, 250, 300, 400].entries()) {
    await page.waitForTimeout(wait);
    await writeFile(
      join(shots, `roll-cards-in-flight-${index + 2}.png`),
      await page.screenshot({ animations: 'allow' }),
    );
  }
  await expect(page.locator('.resource-flight')).toHaveCount(0, { timeout: 5_000 });
  await expect.poll(async () => (await timeline(page)).lastFlightGone).not.toBeNull();
  const seen = await timeline(page);
  const rolled = seen.rolls[0] ?? 0;
  const launched = (seen.firstFlight ?? 0) - rolled;
  const done = (seen.lastFlightGone ?? 0) - rolled;
  test.info().annotations.push({
    type: 'timing',
    description: `first card ${Math.round(launched)} ms, last card gone ${Math.round(done)} ms`,
  });
  // The cards take off as the dice settle (450 ms; a cold first frame can add a little).
  expect(launched).toBeGreaterThan(350);
  expect(launched).toBeLessThan(900);
  // Slow enough to follow, yet finished before a bot at the default pace can roll again (2 s).
  expect(done).toBeGreaterThan(1_300);
  expect(done).toBeLessThan(2_300);
  expect(seen.overlap, 'cards fly while the tokens pulse').toBeGreaterThan(0);
  expect(seen.peak['dice-roll'] ?? 0).toBeLessThanOrEqual(1);
});

test('rapid bot rolls never stack effects and the counts catch up', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Effect timing is checked in Chromium');
  test.setTimeout(60_000);
  await mkdir(shots, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await watch(page);
  // The human rolls and ends the turn at once; three bots with no delay then roll in a row.
  const { state, human, roll } = await openBeforeRoll(page, 'production-rapid', { botDelayMs: 0 });
  await rollBest(page, roll.total);
  await page.getByRole('button', { name: 'End turn' }).click();
  for (let index = 0; index < 8; index += 1) {
    await writeFile(
      join(shots, `rapid-bots-${index}.png`),
      await page.screenshot({ animations: 'allow' }),
    );
    await page.waitForTimeout(80);
  }
  // The bots play up to the human's turn; their trade offers to the human are declined.
  const rollButton = page.getByRole('button', { name: 'Roll dice' });
  const decline = page.getByRole('button', { name: 'Decline' });
  const deadline = Date.now() + 20_000;
  while (!(await rollButton.isVisible())) {
    if (Date.now() > deadline) throw new Error('the bots never reached the human turn');
    if (await decline.isVisible()) await decline.click().catch(() => undefined);
    await page.waitForTimeout(50);
  }
  const seen = await timeline(page);
  test.info().annotations.push({
    type: 'effects',
    description: `rolls ${seen.rolls.length}, peaks ${JSON.stringify(seen.peak)}`,
  });
  expect(seen.rolls.length).toBeGreaterThan(1);
  for (const kind of ['dice-roll', 'production-pulse', 'barbarian-sail', 'robber-move'])
    expect(seen.peak[kind] ?? 0, kind).toBeLessThanOrEqual(1);
  // Within one production sequence of the last roll, every panel shows the state.
  await expect
    .poll(
      async () =>
        (await totals(page, state.config.seats)).every(
          ({ state: count, shown }) => shown === null || shown === count,
        ),
      { timeout: 3_000 },
    )
    .toBe(true);
  await expect(page.locator('.resource-flight')).toHaveCount(0);
  await writeFile(join(shots, 'rapid-bots-settled.png'), await page.screenshot());
  expect(human).toBeGreaterThanOrEqual(0);
});

test('at the default bot pace each roll plays out before the next one', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Effect timing is checked in Chromium');
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  await watch(page);
  const { roll } = await openBeforeRoll(page, 'production-paced', { botDelayMs: 1_000 });
  await rollBest(page, roll.total);
  await expect(page.locator('.resource-flight').first()).toBeVisible({ timeout: 3_000 });
  await expect(page.locator('.resource-flight')).toHaveCount(0, { timeout: 5_000 });
  await page.getByRole('button', { name: 'End turn' }).click();
  // Watch the three bots take their turns, declining their offers to the human.
  const rollButton = page.getByRole('button', { name: 'Roll dice' });
  const decline = page.getByRole('button', { name: 'Decline' });
  const deadline = Date.now() + 70_000;
  while (!(await rollButton.isVisible())) {
    if (Date.now() > deadline) throw new Error('the bots never reached the human turn');
    if (await decline.isVisible()) await decline.click().catch(() => undefined);
    await page.waitForTimeout(100);
  }
  const seen = await timeline(page);
  test.info().annotations.push({
    type: 'effects',
    description: `rolls ${seen.rolls.length}, cards in the air at each roll ${JSON.stringify(seen.inFlightAtRoll)}`,
  });
  expect(seen.rolls.length).toBeGreaterThanOrEqual(4);
  // No roll ever fast-forwards the cards of the one before.
  expect(seen.inFlightAtRoll.every((count) => count === 0)).toBe(true);
});
