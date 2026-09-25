/* eslint-disable no-await-in-loop -- Each visible card selection depends on the prior count. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Resource } from '@cp2p/engine';
import type { DevHook } from '../src/features/devtools/hook.js';
import { saveBeforeGoldenInput } from './golden-save.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const resources: readonly Resource[] = ['brick', 'lumber', 'wool', 'grain', 'ore'];
const colors = ['blue', 'orange', 'green', 'magenta'] as const;
const shapes = ['circle', 'triangle', 'square', 'diamond'] as const;

async function openBeforeDiscard(page: Page, id: string): Promise<void> {
  const save = await saveBeforeGoldenInput('normal-game-03.replay.json', 80);
  const revision =
    save.genesis.length + save.batches.reduce((sum, batch) => sum + 1 + batch.generated.length, 0);
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
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: `hexfield:save:v1:${id}`,
    value: JSON.stringify(record),
  });
  await page.goto(`/#/local/${id}`);
  await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__cp2p')))).toBe(true);
  const reveal = page.getByRole('button', { name: 'Reveal hand' });
  if (await reveal.isVisible()) await reveal.click();
  await expect(page.getByRole('dialog', { name: 'Discard cards' })).toBeVisible();
}

async function exerciseDiscard(
  page: Page,
  screenshot: string,
  keyboardConfirm = false,
): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Discard cards' });
  const chooser = dialog.getByRole('group', { name: 'Cards to discard' });
  const confirm = dialog.getByRole('button', { name: 'Confirm' });
  await expect(chooser.locator('.resource-card img')).toHaveCount(5);
  await expect(confirm).toBeDisabled();

  const authority = await page.evaluate(() => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    const pending = hook?.session
      .getPending()
      .find((item) => item.kind === 'player' && item.allowed.includes('DISCARD'));
    if (pending?.kind !== 'player') return null;
    const count = hook?.diagnostics().actions?.templates.find((group) => group.type === 'DISCARD')
      ?.templates[0]?.count;
    return {
      revision: hook?.diagnostics().revision ?? -1,
      count,
      hand: hook?.session.getPrivate(pending.seat)?.hand,
    };
  });
  if (!authority || typeof authority.count !== 'number' || !authority.hand)
    throw new Error('The golden save did not expose the expected discard decision');

  let remaining = authority.count;
  for (const resource of resources) {
    const available = authority.hand[resource] ?? 0;
    const name = resource[0]?.toUpperCase() + resource.slice(1);
    const add = chooser.getByRole('button', { name: `Add ${name} to Cards to discard` });
    if (available === 0) await expect(add).toHaveAttribute('aria-disabled', 'true');
    for (let i = 0; i < Math.min(available, remaining); i++) {
      await add.click();
      remaining--;
    }
    if (remaining === 0) break;
  }
  expect(remaining).toBe(0);
  await expect(dialog).toContainText(`Selected ${authority.count} of ${authority.count}`);
  await expect(confirm).toBeEnabled();
  await expect
    .poll(() =>
      confirm.evaluate((element) => {
        const sample = document.createElement('span');
        sample.style.backgroundColor = 'var(--accent)';
        document.body.append(sample);
        const accent = getComputedStyle(sample).backgroundColor;
        sample.remove();
        return getComputedStyle(element).backgroundColor === accent;
      }),
    )
    .toBe(true);
  expect(
    await page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      return hook?.diagnostics().revision;
    }),
  ).toBe(authority.revision);

  const path = join(repoRoot, 'reports/stage05', screenshot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, await page.screenshot());
  if (keyboardConfirm) await confirm.press('Enter');
  else await confirm.click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.diagnostics().revision;
      }),
    )
    .toBeGreaterThan(authority.revision);
}

test('desktop discard cards select from the real hand and commit only on Confirm', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'chromium', 'Card UI runs in Chromium');
  await page.emulateMedia({ colorScheme: 'dark' });
  await openBeforeDiscard(page, 'discard-desktop');
  await exerciseDiscard(page, 'discard-desktop.png');
});

test('phone discard cards fit and remain keyboard accessible', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium', 'Card UI runs in Chromium');
  await page.setViewportSize({ width: 390, height: 844 });
  await openBeforeDiscard(page, 'discard-phone');
  const dialog = page.getByRole('dialog', { name: 'Discard cards' });
  await dialog.getByRole('button', { name: 'Add Brick to Cards to discard' }).press('Enter');
  await expect(dialog).toContainText(/Selected 1 of \d+/);
  await dialog.getByRole('button', { name: 'Remove Brick from Cards to discard' }).press('Enter');
  await expect(dialog).toContainText(/Selected 0 of \d+/);
  const box = await dialog.boundingBox();
  if (!box) throw new Error('Discard dialog has no visible bounds');
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(391);
  await exerciseDiscard(page, 'discard-phone.png', true);
});
