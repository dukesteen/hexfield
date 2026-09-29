import { expect, test } from '@playwright/test';

/** A human against an Easy and a Hard bot, at the default one-second pace. */
test.describe('bot difficulty', () => {
  test('the setup picks each bot’s level, and the rail shows it thinking', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/#/local/new');
    await page.getByLabel('Player count').selectOption('3');
    await page.getByLabel('Player 1 control').selectOption('human');
    await page.getByLabel('Player 2 control').selectOption('bot');
    await page.getByLabel('Player 3 control').selectOption('bot');
    // Bots default to Normal; the human seat has no difficulty.
    await expect(page.getByLabel('Player 2 difficulty')).toHaveValue('normal');
    await expect(page.getByLabel('Player 1 difficulty')).toHaveCount(0);
    await page.getByLabel('Player 2 difficulty').selectOption('easy');
    await page.getByLabel('Player 3 difficulty').selectOption('hard');
    await page.getByRole('button', { name: 'Create game' }).click();
    await expect(page).toHaveURL(/#\/local\/[^/]+$/);

    const rail = page.getByRole('complementary', { name: 'Players' });
    await expect(rail.getByText('Easy bot')).toBeVisible();
    await expect(rail.getByText('Hard bot')).toBeVisible();
    // Whenever a bot owes a move it shows as thinking; the human's own turn shows no indicator.
    await expect
      .poll(
        async () => {
          if (await rail.getByRole('status').filter({ hasText: 'Thinking' }).count()) return true;
          // Pass the human's opening placements so the bots get their turns.
          const placed = await page.evaluate(() => {
            const session = window['__cp2p']?.session;
            if (!session) return false;
            const owes = session
              .getPending()
              .some((item) => item.kind === 'player' && item.seat === 0);
            const command = owes ? session.getLegalCommands(0).commands[0] : undefined;
            if (command) void session.submit(0, command);
            return Boolean(command);
          });
          return placed ? 'human moved' : false;
        },
        { timeout: 30_000, intervals: [250] },
      )
      .toBe(true);
    // The bots think in their worker and still move: bot buildings appear during setup.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window['__cp2p']?.session.getState().board.buildings ?? []).filter(
                (piece) => piece.seat !== 0,
              ).length,
          ),
        { timeout: 60_000 },
      )
      .toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
  });
});
