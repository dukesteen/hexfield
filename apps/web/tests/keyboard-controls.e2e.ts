import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { DevHook } from '../src/features/devtools/hook.js';
import { saveBeforeGoldenInput } from './golden-save.js';

const colors = ['blue', 'orange', 'green', 'magenta'] as const;
const shapes = ['circle', 'triangle', 'square', 'diamond'] as const;

async function openGoldenPrefix(page: Page, file: string, stopBefore: number): Promise<void> {
  const save = await saveBeforeGoldenInput(file, stopBefore);
  const id = `keyboard-${stopBefore}`;
  const revision =
    save.genesis.length + save.batches.reduce((sum, batch) => sum + 1 + batch.generated.length, 0);
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: `hexfield:save:v1:${id}`,
    value: JSON.stringify({
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
    }),
  });
  await page.goto(`/#/local/${id}`);
  await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__cp2p')))).toBe(true);
  const reveal = page.getByRole('button', { name: 'Reveal hand' });
  if (await reveal.isVisible()) await reveal.press('Enter');
}

async function boardSnapshot(page: Page) {
  for (let attempt = 0; attempt < 100; attempt++) {
    // The route can briefly reinstall the DEV hook while the renderer mounts.
    // eslint-disable-next-line no-await-in-loop
    const snapshot = await page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      if (!hook) return null;
      const state = hook.session.getState();
      return {
        revision: hook.diagnostics().revision,
        buildings: state.board.buildings.length,
        roads: state.board.roads.length,
      };
    });
    if (snapshot) return snapshot;
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(20);
  }
  throw new Error('Game hook did not expose a board snapshot');
}

async function chooseFirstLocationWithKeyboard(page: Page): Promise<void> {
  const chooser = page.getByTestId('board-keyboard-targets');
  if ((await chooser.getAttribute('open')) === null)
    await chooser.locator('summary').press('Enter');
  const select = chooser.getByLabel('Board location');
  await select.focus();
  await select.press('Home');
  await select.press('Tab');
  await expect(chooser.getByRole('button', { name: 'Select location' })).toBeFocused();
  await page.keyboard.press('Enter');
}

async function previewCancelConfirm(page: Page, piece: 'settlement' | 'road'): Promise<void> {
  const before = await boardSnapshot(page);
  await chooseFirstLocationWithKeyboard(page);
  const confirm = page.getByRole('button', { name: `Confirm ${piece}` });
  await expect(confirm).toBeVisible();
  expect(await boardSnapshot(page)).toEqual(before);
  await page.getByRole('button', { name: 'Cancel', exact: true }).press('Enter');
  await expect(confirm).toBeHidden();
  expect(await boardSnapshot(page)).toEqual(before);
  await chooseFirstLocationWithKeyboard(page);
  await expect(confirm).toBeVisible();
  expect(await boardSnapshot(page)).toEqual(before);
  await confirm.press('Enter');
  await expect
    .poll(async () => (await boardSnapshot(page)).revision)
    .toBeGreaterThan(before.revision);
  const after = await boardSnapshot(page);
  expect(after.buildings).toBe(before.buildings + (piece === 'settlement' ? 1 : 0));
  expect(after.roads).toBe(before.roads + (piece === 'road' ? 1 : 0));
}

test('keyboard shortcuts and native board chooser preview, cancel and confirm setup pieces', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'chromium', 'Keyboard board smoke runs in Chromium');
  await openGoldenPrefix(page, 'normal-completion.replay.json', 1);
  await page.getByLabel('Open game menu').focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('2');
  await expect(
    page.getByRole('group', { name: 'Choose a board action' }).getByRole('button', {
      name: 'Build settlement',
    }),
  ).toHaveAttribute('aria-pressed', 'true');
  await previewCancelConfirm(page, 'settlement');

  await page.getByLabel('Open game menu').focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('1');
  await expect(
    page.getByRole('group', { name: 'Choose a board action' }).getByRole('button', {
      name: 'Build road',
    }),
  ).toHaveAttribute('aria-pressed', 'true');
  await previewCancelConfirm(page, 'road');
});

test('R rolls from the pre-roll phase without a pointer', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium', 'Keyboard shortcuts run in Chromium');
  await openGoldenPrefix(page, 'normal-completion.replay.json', 17);
  const beforeRoll = await boardSnapshot(page);
  await page.getByLabel('Open game menu').focus();
  await page.keyboard.press('r');
  await expect
    .poll(async () => (await boardSnapshot(page)).revision)
    .toBeGreaterThan(beforeRoll.revision);
});

test('E ends the turn but is ignored while editing a form', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium', 'Keyboard shortcuts run in Chromium');
  await openGoldenPrefix(page, 'normal-completion.replay.json', 19);
  const beforeEnd = await boardSnapshot(page);
  const menu = page.getByLabel('Open game menu');
  await menu.press('Enter');
  await page.getByTestId('dev-drawer').locator('summary').first().press('Enter');
  await page.getByRole('textbox', { name: 'Raw command JSON' }).focus();
  await page.keyboard.press('e');
  expect(await boardSnapshot(page)).toEqual(beforeEnd);
  await menu.press('Enter');
  await page.keyboard.press('e');
  await expect
    .poll(async () => (await boardSnapshot(page)).revision)
    .toBeGreaterThan(beforeEnd.revision);
});
