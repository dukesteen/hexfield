import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { CommandShape, Seat } from '@cp2p/engine';
import { SEAT, untilHumanTurn } from './helpers/knights-play.js';
import { inMain, snapshot, withHand } from './helpers/knights-scenes.js';
import type { Snapshot } from './helpers/knights-scenes.js';

/** A three-seat base game against two bots that answer at once. */
async function startBotGame(page: Page): Promise<void> {
  await page.goto('/#/local/new');
  await page.locator('#player-count').selectOption('3');
  await page.getByText('Advanced rules').click();
  await page.getByLabel('Bot pace, milliseconds').fill('0');
  await page.getByRole('button', { name: 'Create game' }).click();
  await expect(page).toHaveURL(/#\/local\/[^/]+$/);
  await expect.poll(() => page.evaluate(() => Boolean(window['__cp2p']?.renderer))).toBe(true);
}

/**
 * Put a hand-built position in place and, in the same task, play `seat`'s first command, so no
 * bot moves in between.
 */
async function stage(page: Page, snap: Snapshot, then?: { seat: Seat; command: CommandShape }) {
  const outcome = await page.evaluate(
    ({ next, first }) => {
      const session = window['__cp2p']?.session;
      if (!session || !('devReplace' in session) || !('devApply' in session))
        return 'No scene control';
      const replaced: { ok: boolean } = Reflect.apply(session.devReplace, session, [
        next.state,
        next.privates,
      ]);
      if (!replaced.ok) return 'replace failed';
      if (!first) return 'ok';
      const applied: { ok: boolean; error?: { message: string } } = Reflect.apply(
        session.devApply,
        session,
        [first.seat, first.command],
      );
      return applied.ok ? 'ok' : (applied.error?.message ?? 'apply failed');
    },
    { next: snap, first: then },
  );
  expect(outcome).toBe('ok');
}

function humanHand(page: Page): Promise<Record<string, number>> {
  return page.evaluate((seat) => ({ ...window['__cp2p']?.session.getPrivate(seat)?.hand }), SEAT);
}

test.describe('trading with bots', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Bot trades run in Chromium');

  test('a bot’s offer completes once the player accepts, and the player’s once a bot accepts', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await startBotGame(page);
    expect(await untilHumanTurn(page, 'main')).toBe(true);
    const start = await snapshot(page);

    // Seat 1 (a bot) offers a brick for a lumber. Seat 2 has no lumber, so only the player can
    // take it; the bot waits for the answer and then trades with the player.
    let scene = withHand(withHand(withHand(start, 0, { lumber: 2 }), 1, { brick: 2 }), 2, {});
    await stage(page, inMain(scene, 1), {
      seat: 1,
      command: { type: 'OFFER_TRADE', give: { brick: 1 }, want: { lumber: 1 } },
    });
    const offers = page.getByRole('region', { name: 'Trade offers' });
    await expect(offers.getByText(/^Offer from /)).toBeVisible();
    await offers.getByRole('button', { name: 'Accept' }).click();
    await expect(page.locator('.trade-notice')).toHaveText(/^Trade with .+ completed\.$/);
    await expect.poll(() => humanHand(page)).toMatchObject({ brick: 1, lumber: 1 });

    // The player offers a brick for a lumber. Seat 1 has lumber to spare and accepts, seat 2 has
    // none and declines; the player then confirms with seat 1.
    scene = withHand(withHand(withHand(start, 0, { brick: 2 }), 1, { lumber: 3 }), 2, {});
    await stage(page, inMain(scene, SEAT));
    await page
      .getByRole('group', { name: 'Offer trade' })
      .getByRole('button', { name: 'Players' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Player trade' });
    await dialog.getByRole('button', { name: 'Add Brick to You give' }).click();
    await dialog.getByRole('button', { name: 'Add Lumber to You get' }).click();
    await dialog.getByRole('button', { name: 'Send offer' }).click();
    const responses = offers.getByRole('list', { name: 'Player responses' });
    await expect(responses.locator('li[data-status="accepted"]')).toHaveCount(1);
    await expect(responses.locator('li[data-status="declined"]')).toHaveCount(1);
    await expect(offers.getByRole('status')).toHaveText(/ accepted\. Trade to complete it\.$/);
    await offers.getByRole('button', { name: /^Trade with / }).click();
    await expect(page.locator('.trade-notice')).toHaveText(/^Trade with .+ completed\.$/);
    await expect.poll(() => humanHand(page)).toMatchObject({ brick: 1, lumber: 1 });
    expect(errors).toEqual([]);
  });
});
