import { expect, test, type Page } from '@playwright/test';
import { readManualLobbyOffer } from '@cp2p/p2p';

test.use({
  channel: 'chrome',
  actionTimeout: 15_000,
  trace: 'off',
  screenshot: 'off',
  video: 'off',
});
test.skip(process.env.CP2P_LOCAL_VAULT_E2E !== '1', 'Bounded native Chrome local-vault acceptance');

const oldPassphrase = 'native vault acceptance old phrase';
const newPassphrase = 'native vault acceptance replacement phrase';

async function unlock(page: Page, passphrase: string, returnsToSettings = true): Promise<void> {
  await page.getByLabel('Current passphrase', { exact: true }).fill(passphrase);
  await page.getByRole('button', { name: 'Unlock games', exact: true }).click();
  if (returnsToSettings)
    await expect(page.getByText('Protection is on · unlocked in this tab')).toBeVisible();
  else
    await expect(page.getByRole('link', { name: 'Play with friends', exact: true })).toBeVisible();
}

async function createManualRoomAndReadPublicPeer(page: Page, suffix: string): Promise<string> {
  const playLink = page.getByRole('link', { name: 'Play with friends', exact: true });
  if ((await playLink.count()) === 0)
    await page.getByRole('link', { name: 'Back to home', exact: true }).click();
  await playLink.click();
  await expect(
    page.getByRole('heading', { name: 'Create an online room', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Room name', { exact: true }).fill(`Vault ${suffix}`);
  await page.getByLabel('Your player name', { exact: true }).fill(`Player ${suffix}`);
  const connectionOptions = page.locator('details.online-connection-options');
  await connectionOptions.locator('summary').click();
  await expect(connectionOptions).toHaveAttribute('open', '');
  await connectionOptions.locator('select').selectOption('manual');
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect(page.locator('.manual-connection')).toBeVisible();
  await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
  const invitation = page.getByLabel('Invitation code', { exact: true });
  await expect(invitation).toHaveValue(/^HX1\./, { timeout: 20_000 });
  const code = await invitation.inputValue();
  return (await readManualLobbyOffer(code)).from;
}

test('vault enable, reload, wrong key, cross-tab scope closure, rotation and disable', async ({
  page,
  browserName,
}, testInfo) => {
  test.skip(browserName !== 'chromium', 'Local storage acceptance uses native Chrome');
  test.setTimeout(75_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/#/settings');
  await expect(page.getByText('Protection is off', { exact: true })).toBeVisible();
  await page.getByLabel('New passphrase', { exact: true }).fill(oldPassphrase);
  await page.getByLabel('Repeat new passphrase', { exact: true }).fill(oldPassphrase);
  await page.getByRole('button', { name: 'Turn on protection', exact: true }).click();
  await expect(
    page.getByText('Your saved multiplayer games are locked', { exact: true }),
  ).toBeVisible();

  await page.reload();
  await expect(
    page.getByText('Your saved multiplayer games are locked', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Current passphrase', { exact: true }).fill('incorrect native test phrase');
  await page.getByRole('button', { name: 'Unlock games', exact: true }).click();
  await expect(
    page.getByText('That passphrase did not unlock your saved data. Try again.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Your saved multiplayer games are locked', { exact: true }),
  ).toBeVisible();
  await unlock(page, oldPassphrase);

  const second = await page.context().newPage();
  second.on('pageerror', (error) => errors.push(error.message));
  await second.goto('/#/');
  await expect(
    second.getByText('Your saved multiplayer games are locked', { exact: true }),
  ).toBeVisible();
  await unlock(second, oldPassphrase, false);
  const originalPeer = await createManualRoomAndReadPublicPeer(second, 'second-device');

  await page.getByRole('button', { name: 'Change passphrase', exact: true }).click();
  await page.getByLabel('Current passphrase', { exact: true }).fill(oldPassphrase);
  await page.getByLabel('New passphrase', { exact: true }).fill(newPassphrase);
  await page.getByLabel('Repeat new passphrase', { exact: true }).fill(newPassphrase);
  await page.getByRole('button', { name: 'Change passphrase', exact: true }).click();
  await expect(
    page.getByText('Your saved multiplayer games are locked', { exact: true }),
  ).toBeVisible();
  await expect(
    second.getByText('Your saved multiplayer games are locked', { exact: true }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(second.locator('.online-lobby-page')).toHaveCount(0);

  await page.getByLabel('Current passphrase', { exact: true }).fill(oldPassphrase);
  await page.getByRole('button', { name: 'Unlock games', exact: true }).click();
  await expect(
    page.getByText('That passphrase did not unlock your saved data. Try again.', { exact: true }),
  ).toBeVisible();
  await unlock(page, newPassphrase);

  await page.getByRole('button', { name: 'Remove protection', exact: true }).click();
  await page.getByLabel('Current passphrase', { exact: true }).fill(newPassphrase);
  await page.getByRole('button', { name: 'Remove protection', exact: true }).click();
  await expect(page.getByText('Protection is off', { exact: true })).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath('vault-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#/settings');
  await expect(page.getByText('Protection is off', { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('vault-mobile.png'), fullPage: true });
  const currentPeer = await createManualRoomAndReadPublicPeer(page, 'after-disable');
  expect(currentPeer).toBe(originalPeer);
  expect(errors).toEqual([]);
  await second.close();
});
