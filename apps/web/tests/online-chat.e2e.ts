import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test.use({ actionTimeout: 15_000 });
test.skip(process.env.CP2P_ONLINE_CHAT_E2E !== '1', 'Requires local signaling on port 8909');
test.skip(({ browserName }) => browserName !== 'chromium', 'Two Chromium contexts');

const SIGNALING_URL = 'ws://127.0.0.1:8909';
const SHOTS = process.env.CP2P_SCREENSHOT_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test('game chat is one tap away, counts unread messages and works on a phone', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const hostContext = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const guestContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const errors: string[] = [];
  for (const page of [host, guest]) page.on('pageerror', (error) => errors.push(error.message));
  try {
    await host.goto('/#/online/create');
    await host.getByLabel('Room name').fill('Chat check');
    await host.getByLabel('Your player name').fill('Ada');
    await host.getByText('Advanced connection options', { exact: true }).click();
    await host.getByLabel('Invite friends with').selectOption('server');
    await host.getByLabel('Custom room server').fill(SIGNALING_URL);
    await host.getByLabel('Player count').selectOption('2');
    await host.getByRole('button', { name: 'Create room' }).click();
    await expect(host.getByRole('heading', { name: 'Chat check' })).toBeVisible();
    const invitation = await host.getByRole('textbox', { name: /^Invitation link/ }).inputValue();
    await guest.goto(invitation);
    await expect(guest.getByRole('heading', { name: 'Chat check' })).toBeVisible();
    await expect(async () => {
      await guest.getByRole('button', { name: 'Take seat' }).click({ timeout: 2_000 });
      await expect(guest.getByRole('button', { name: 'Ready up' })).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 45_000 });
    await host.getByRole('button', { name: 'Ready up' }).click();
    await guest.getByRole('button', { name: 'Ready up' }).click();
    await expect(host.getByRole('button', { name: 'Start game' })).toBeEnabled();
    await host.getByRole('button', { name: 'Start game' }).click();
    await expect(host).toHaveURL(/\/game\/[^/]+$/, { timeout: 90_000 });
    await expect(guest).toHaveURL(/\/game\/[^/]+$/, { timeout: 90_000 });

    // The chat launcher sits on the board, outside the game menu.
    const hostLauncher = host.getByRole('button', { name: /^Chat/ }).first();
    await expect(hostLauncher).toBeVisible({ timeout: 30_000 });
    await hostLauncher.click();
    const hostChat = host.getByRole('dialog', { name: 'Chat' });
    await expect(hostChat).toBeVisible();
    await hostChat.getByLabel('Message').fill('Good luck, have fun');
    await hostChat.getByRole('button', { name: 'Send' }).click();
    await expect(hostChat.getByText('Good luck, have fun')).toBeVisible();

    // The guest keeps playing; an unread count and a short preview appear on the board.
    const guestLauncher = guest.getByRole('button', { name: /^Chat/ }).first();
    await expect(guestLauncher).toHaveAccessibleName(/1 unread/, { timeout: 20_000 });
    await expect(guest.getByRole('button', { name: 'Ada Good luck, have fun' })).toBeVisible();
    await shot(guest, 'chat-phone-unread');
    await shot(host, 'chat-desktop-open');

    await guestLauncher.click();
    const guestChat = guest.getByRole('dialog', { name: 'Chat' });
    await expect(guestChat).toBeVisible();
    await expect(guestLauncher).toHaveAccessibleName('Chat');
    await guestChat.getByRole('button', { name: 'Celebrate' }).click();
    await guestChat.getByLabel('Message').fill('Thanks, you too');
    await guestChat.getByRole('button', { name: 'Send' }).click();
    await expect(guestChat.getByText('Thanks, you too')).toBeVisible();
    await shot(guest, 'chat-phone-open');
    await expect(hostChat.getByText('Thanks, you too')).toBeVisible({ timeout: 20_000 });
    await expect(hostChat.getByRole('list').getByText('🎉')).toBeVisible();
    await guestChat.getByRole('button', { name: 'Close' }).click();
    await expect(guestChat).toBeHidden();

    // Phone landscape keeps the launcher reachable.
    await guest.setViewportSize({ width: 844, height: 390 });
    await expect(guestLauncher).toBeInViewport();
    await shot(guest, 'chat-phone-landscape');
    expect(errors).toEqual([]);
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()]);
  }
});
