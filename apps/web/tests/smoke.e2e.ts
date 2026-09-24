import { expect, test } from '@playwright/test';

test('loads the placeholder page', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Hexfield' })).toBeVisible();
  await expect(page.getByText('v0.0.0')).toBeVisible();
  expect(errors).toEqual([]);
});
