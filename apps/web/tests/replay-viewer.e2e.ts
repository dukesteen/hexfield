import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { join } from 'node:path';
import type { GamePresentation } from '../src/queries/repositories/saved-games.js';
import { saveBeforeGoldenInput } from './golden-save.js';

const GOLDEN = 'normal-game-05.replay.json';
const NAMES = ['Aster', 'Birch', 'Cedar', 'Dune'];
const screenshots = process.env.REPLAY_SCREENSHOT_DIR;

/** A finished four-player game saved on this device, three of its seats played by bots. */
async function seedFinishedGame(page: Page): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  const golden: unknown = JSON.parse(
    await readFile(
      join(import.meta.dirname, '../../../packages/engine/test/golden', GOLDEN),
      'utf8',
    ),
  );
  const inputs: unknown =
    typeof golden === 'object' && golden !== null ? Reflect.get(golden, 'inputs') : null;
  if (!Array.isArray(inputs)) throw new Error('Golden game has no inputs');
  const save = await saveBeforeGoldenInput(GOLDEN, inputs.length);
  const presentation: GamePresentation = {
    players: save.config.seats.map((seat, index) => {
      const displaySeat = ([0, 1, 2, 3] as const).find((candidate) => candidate === seat);
      if (displaySeat === undefined) throw new Error('Golden game has an unsupported seat');
      return {
        seat: displaySeat,
        name: NAMES[index] ?? `Player ${seat + 1}`,
        color: (['blue', 'orange', 'green', 'magenta'] as const)[index] ?? 'blue',
        shape: (['circle', 'triangle', 'square', 'diamond'] as const)[index] ?? 'circle',
        ...(index > 0 ? { bot: 'easy' as const } : {}),
      };
    }),
    botDelayMs: 0,
  };
  const id = 'replay-viewer-game';
  const revision =
    save.genesis.length + save.batches.reduce((sum, batch) => sum + 1 + batch.generated.length, 0);
  const record = { v: 1, id, revision, updatedAt: Date.now(), presentation, save };
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: `hexfield:save:v1:${id}`,
    value: JSON.stringify(record),
  });
  return id;
}

async function replayTest(page: Page, label: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await seedFinishedGame(page);
  await page.goto('/#/');
  await page.getByRole('link', { name: `Watch replay: ${NAMES.join(', ')}` }).click();
  await expect(page.getByRole('heading', { name: `Replay: ${NAMES.join(' · ')}` })).toBeVisible({
    timeout: 30_000,
  });

  // A finished game opens at its end; the public view shows no hand.
  const scrubber = page.getByRole('slider', { name: 'Position in the game' });
  const total = Number(await scrubber.getAttribute('max'));
  expect(total).toBeGreaterThan(200);
  await expect(scrubber).toHaveValue(String(total));
  await expect(page.getByLabel('Show')).toHaveValue('public');
  await expect(page.locator('.replay-hand')).toHaveCount(0);

  // Scrub, step with the keyboard and jump to the next 7.
  await scrubber.fill('120');
  await expect(page.getByText(`move 120 of ${total}`)).toBeVisible();
  await page.locator('.replay-latest').click();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByText(`move 121 of ${total}`)).toBeVisible();
  await page.getByRole('button', { name: 'Next 7' }).click();
  await expect.poll(async () => Number(await scrubber.inputValue())).toBeGreaterThan(121);

  // All hands, then one seat's view.
  await page.getByLabel('Show').selectOption({ label: 'All hands' });
  await expect(page.locator('.replay-hand')).toHaveCount(4);
  await page.getByLabel('Show').selectOption({ label: "Birch's view" });
  await expect(page.locator('.replay-hand')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Birch' }).locator('.replay-hand')).toBeVisible();

  // Statistics.
  await page.getByText('Statistics', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dice rolls against the odds' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Robber impact' })).toBeVisible();
  await expect(
    page.getByRole('img', { name: /^Cards gained by the end: Aster \d+/ }),
  ).toBeVisible();
  if (screenshots) {
    await page.screenshot({ path: join(screenshots, `replay-${label}.png`), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.locator('.replay-stats').screenshot({
      path: join(screenshots, `replay-${label}-stats-dark.png`),
    });
    await page.emulateMedia({ colorScheme: 'light' });
  }

  // Export the file and the string, then open the string again.
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download replay file' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('replay-viewer-game.replay.json');
  await page.getByRole('button', { name: 'Copy replay string' }).click();
  const field = page.getByRole('textbox', { name: 'Replay string' });
  await expect(field).toHaveValue(/^HXREPLAY1\./);
  const text = await field.inputValue();
  await expect(page.getByText(/more than most chats accept/)).toBeVisible();

  await page.goto('/#/replay/import');
  await page.getByRole('textbox', { name: 'Replay string' }).fill(text);
  await page.getByRole('button', { name: 'Open replay' }).click();
  await expect(page.getByRole('heading', { name: `Replay: ${NAMES.join(' · ')}` })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('slider', { name: 'Position in the game' })).toHaveAttribute(
    'max',
    String(total),
  );

  // A damaged string is refused.
  await page.getByRole('button', { name: 'Open another replay' }).click();
  await page.getByRole('textbox', { name: 'Replay string' }).fill(`${text.slice(0, -40)}AAAA`);
  await page.getByRole('button', { name: 'Open replay' }).click();
  await expect(page.getByRole('alert')).toContainText('could not be opened');
  expect(errors).toEqual([]);
}

test.describe('replay viewer on a desktop', () => {
  test.use({ viewport: { width: 1360, height: 900 } });
  test('opens a finished bot game, scrubs, switches view, exports and re-imports', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await replayTest(page, 'desktop');
  });
});

test.describe('replay viewer on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('opens a finished bot game, scrubs, switches view, exports and re-imports', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await replayTest(page, 'phone');
  });
});
