import { expect, test } from '@playwright/test';

test('four peer game views commit one setup action to every session', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/#/dev/network');
  await expect(page.getByRole('heading', { name: 'Four-peer network simulation' })).toBeVisible();
  const views = page.getByTestId('network-peer-view');
  await expect(views).toHaveCount(4);
  await expect(page.getByTestId('board-renderer')).toHaveCount(4);
  await expect(page.locator('.network-peer-game.is-turn-active')).toHaveCount(1);

  await expect
    .poll(async () => {
      const values = await Promise.all(
        [0, 1, 2, 3].map(async (seat) => {
          const text = await page.getByTestId(`network-peer-revision-${seat}`).innerText();
          return Number(text.replace('Revision ', ''));
        }),
      );
      const firstRevision = values[0];
      return (
        values.length === 4 &&
        new Set(values).size === 1 &&
        firstRevision !== undefined &&
        firstRevision >= 1
      );
    })
    .toBe(true);

  const revisionTexts = await Promise.all(
    [0, 1, 2, 3].map((seat) => page.getByTestId(`network-peer-revision-${seat}`).innerText()),
  );
  const initialRevisions = revisionTexts.map((text) => Number(text.replace('Revision ', '')));
  expect(new Set(initialRevisions).size).toBe(1);
  const initialRevision = initialRevisions[0];
  if (initialRevision === undefined) throw new Error('Peer revision is unavailable');

  const activeBoard = page
    .locator('.network-peer-game.is-turn-active')
    .getByRole('group', { name: /simulation board/ });
  await activeBoard.focus();
  await activeBoard.press('Home');
  await activeBoard.press('Enter');

  await expect
    .poll(async () => {
      const values = await Promise.all(
        [0, 1, 2, 3].map(async (seat) => {
          const text = await page.getByTestId(`network-peer-revision-${seat}`).innerText();
          return Number(text.replace('Revision ', ''));
        }),
      );
      return values.every((revision) => revision === initialRevision + 1);
    })
    .toBe(true);
  expect(errors).toEqual([]);
});
