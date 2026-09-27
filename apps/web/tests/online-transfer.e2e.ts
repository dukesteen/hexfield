/* eslint-disable no-await-in-loop -- Each legal move depends on the prior certified head. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.use(
  process.env.CP2P_CHROMIUM_EXECUTABLE
    ? { launchOptions: { executablePath: process.env.CP2P_CHROMIUM_EXECUTABLE } }
    : { channel: 'chrome' },
);

const SIGNALING_URL = 'ws://127.0.0.1:8909';

// Native signaling and three isolated browser contexts are supplied by the local harness.
test.skip(process.env.CP2P_ONLINE_TRANSFER_E2E !== '1', 'Requires local signaling on port 8909');

async function gameView(page: Page, gameId: string) {
  return page.evaluate(async (id) => {
    const path: string = '/src/features/online/room-registry.ts';
    // oxlint-disable typescript/no-unsafe-type-assertion -- Vite serves this known local module inside the browser; its exports match the compile-time import.
    const { getOnlineGameRoom } = (await import(
      /* @vite-ignore */ path
    )) as typeof import('../src/features/online/room-registry.js');
    // oxlint-enable typescript/no-unsafe-type-assertion
    const session = getOnlineGameRoom(id)?.getGame()?.session;
    if (!session) return null;
    const seats = session.controllableSeats();
    return {
      seats,
      activeSeat: session.getState().turn.activeSeat,
      legal: seats.map((seat) => ({ seat, count: session.getLegalCommands(seat).commands.length })),
      head: session.getFairness?.()?.head ?? null,
    };
  }, gameId);
}

async function submitFirstLegal(page: Page, gameId: string): Promise<boolean> {
  return page.evaluate(async (id) => {
    const path: string = '/src/features/online/room-registry.ts';
    // oxlint-disable typescript/no-unsafe-type-assertion -- Vite serves this known local module inside the browser; its exports match the compile-time import.
    const { getOnlineGameRoom } = (await import(
      /* @vite-ignore */ path
    )) as typeof import('../src/features/online/room-registry.js');
    // oxlint-enable typescript/no-unsafe-type-assertion
    const session = getOnlineGameRoom(id)?.getGame()?.session;
    if (!session) return false;
    for (const seat of session.controllableSeats()) {
      const command = session.getLegalCommands(seat).commands[0];
      if (!command) continue;
      const result = await session.submit(seat, command);
      if (!result.ok) throw new Error(`Legal command refused: ${result.error.code}`);
      return true;
    }
    return false;
  }, gameId);
}

test('a certified seat transfer retires the old signer and the new device makes a peer-accepted move', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext()));
  const [source, survivor, destination] = await Promise.all(
    contexts.map((context) => context.newPage()),
  );
  if (!source || !survivor || !destination) throw new Error('Missing Chromium page');
  const errors: string[] = [];
  for (const page of [source, survivor, destination])
    page.on('pageerror', (error) => errors.push(error.message));

  try {
    await source.goto('/#/online/create');
    await source.getByLabel('Room name').fill('Transfer acceptance');
    await source.getByLabel('Your player name').fill('Source');
    await source.getByText('Advanced connection options', { exact: true }).click();
    await source.getByLabel('Invite friends with').selectOption('server');
    await source.getByLabel('Custom room server').fill(SIGNALING_URL);
    await source.getByLabel('Player count').selectOption('2');
    await source.getByRole('button', { name: 'Create room' }).click();
    await expect(source.getByRole('heading', { name: 'Transfer acceptance' })).toBeVisible();

    const invitation = await source.getByLabel('Invitation link', { exact: true }).inputValue();
    await survivor.goto(invitation);
    await expect(survivor.getByRole('heading', { name: 'Transfer acceptance' })).toBeVisible();
    await survivor.getByRole('button', { name: 'Take seat' }).click();
    await expect(source.getByText('Source', { exact: true })).toBeVisible();
    await source.getByRole('button', { name: 'Ready up' }).click();
    await survivor.getByRole('button', { name: 'Ready up' }).click();
    await expect(source.getByRole('button', { name: 'Start game' })).toBeEnabled();
    await source.getByRole('button', { name: 'Start game' }).click();
    await expect(source).toHaveURL(/\/game\/[^/]+$/, { timeout: 90_000 });
    await expect(survivor).toHaveURL(/\/game\/[^/]+$/, { timeout: 90_000 });
    const gameId = new URL(source.url()).hash.match(/\/game\/([^/?]+)/)?.[1];
    if (!gameId) throw new Error('Game route has no identifier');

    await source.locator('summary[aria-label="Open game menu"]').click();
    await source.getByRole('button', { name: 'Move this seat to another device' }).click();
    const transferDialog = source.getByRole('dialog', { name: 'Move this seat to another device' });
    const transferInvitation = await transferDialog
      .getByLabel('Seat transfer invitation')
      .inputValue();
    await destination.goto(transferInvitation);
    await destination.getByRole('button', { name: 'Start seat transfer' }).click();
    await expect(transferDialog.getByRole('radio')).toHaveCount(1, { timeout: 20_000 });
    await transferDialog.getByRole('radio').check();
    await transferDialog.getByRole('button', { name: 'Confirm move' }).click();

    await expect(destination.getByRole('button', { name: 'Open game on this device' })).toBeVisible(
      { timeout: 90_000 },
    );
    await destination.getByRole('button', { name: 'Open game on this device' }).click();
    await expect(destination).toHaveURL(new RegExp(`/game/${gameId}$`), { timeout: 30_000 });
    await expect
      .poll(async () => (await gameView(destination, gameId))?.seats.length, { timeout: 20_000 })
      .toBe(1);
    await expect
      .poll(async () => (await gameView(source, gameId))?.seats.length ?? 0, { timeout: 20_000 })
      .toBe(0);

    let transferredMove = false;
    for (let step = 0; step < 6 && !transferredMove; step += 1) {
      const newView = await gameView(destination, gameId);
      const otherView = await gameView(survivor, gameId);
      if (!newView?.head || !otherView?.head)
        throw new Error('Transferred game has no certified head');
      if (newView.legal.some((item) => item.count > 0)) {
        const before = newView.head.seq;
        transferredMove = await submitFirstLegal(destination, gameId);
        await expect
          .poll(async () => (await gameView(survivor, gameId))?.head?.seq, { timeout: 20_000 })
          .toBeGreaterThan(before);
      } else if (otherView.legal.some((item) => item.count > 0)) {
        const before = otherView.head.seq;
        await submitFirstLegal(survivor, gameId);
        await expect
          .poll(async () => (await gameView(destination, gameId))?.head?.seq, { timeout: 20_000 })
          .toBeGreaterThan(before);
      } else {
        await expect
          .poll(
            async () => {
              const left = await gameView(destination, gameId);
              const right = await gameView(survivor, gameId);
              return [...(left?.legal ?? []), ...(right?.legal ?? [])].some(
                (item) => item.count > 0,
              );
            },
            { timeout: 15_000 },
          )
          .toBe(true);
      }
    }
    expect(transferredMove).toBe(true);
    expect((await gameView(destination, gameId))?.head).toEqual(
      (await gameView(survivor, gameId))?.head,
    );
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
