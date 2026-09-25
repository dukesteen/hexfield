import { expect, test } from '@playwright/test';

test('loads the home screen and opens local game setup', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'A table ready when you are' })).toBeVisible();
  await page.getByRole('link', { name: 'New local game' }).click();
  await expect(page.getByRole('heading', { name: 'New local game' })).toBeVisible();
  await expect(page.getByLabel('Player count')).toHaveValue('4');
  expect(errors).toEqual([]);
});
