/* eslint-disable no-await-in-loop -- Certified game actions depend on the previous head. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.use({ channel: 'chrome', actionTimeout: 15_000 });
test.skip(
  process.env.CP2P_IMPORTED_TRANSFER_E2E !== '1',
  'Bounded native Chrome imported-save transfer acceptance',
);
test.skip(({ browserName }) => browserName !== 'chromium', 'Runs only in native Chrome');

const signalingUrl = 'ws://127.0.0.1:8909';
const filePassphrase = 'imported checkpoint acceptance phrase';
let registryModulePath: string | null = null;

async function loadedRegistryPath(page: Page): Promise<string> {
  if (registryModulePath) return registryModulePath;
  const observed = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname.endsWith('/room-registry.ts')),
  );
  if (!observed) throw new Error('The app room registry has not loaded');
  const url = new URL(observed);
  registryModulePath = url.pathname + url.search;
  return registryModulePath;
}

async function gameView(page: Page, gameId: string) {
  const path = await loadedRegistryPath(page);
  return page.evaluate(
    async ({ id, modulePath }) => {
      // oxlint-disable typescript/no-unsafe-type-assertion -- This is the Vite-loaded application module used by the online route.
      const { getOnlineGameRoom } = (await import(
        /* @vite-ignore */ modulePath
      )) as typeof import('../src/features/online/room-registry.js');
      // oxlint-enable typescript/no-unsafe-type-assertion
      const game = getOnlineGameRoom(id)?.getGame();
      const session = game?.session;
      if (!session || !game) return null;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Read the verified genesis commitment shape published by the session.
      const decks = game.genesis.commitments.decks as readonly {
        passHashes: readonly string[];
      }[];
      return {
        seats: session.controllableSeats(),
        activeSeat: session.getState().turn.activeSeat,
        requiredDeckPasses: decks.reduce((total, deck) => total + deck.passHashes.length, 0),
        legal: session.controllableSeats().map((seat) => ({
          seat,
          count: session.getLegalCommands(seat).commands.length,
        })),
        head: session.getFairness?.()?.head ?? null,
      };
    },
    { id: gameId, modulePath: path },
  );
}

async function submitFirstLegal(page: Page, gameId: string): Promise<boolean> {
  const path = await loadedRegistryPath(page);
  return page.evaluate(
    async ({ id, modulePath }) => {
      // oxlint-disable typescript/no-unsafe-type-assertion -- This is the Vite-loaded application module used by the online route.
      const { getOnlineGameRoom } = (await import(
        /* @vite-ignore */ modulePath
      )) as typeof import('../src/features/online/room-registry.js');
      // oxlint-enable typescript/no-unsafe-type-assertion
      const session = getOnlineGameRoom(id)?.getGame()?.session;
      if (!session) return false;
      for (const seat of session.controllableSeats()) {
        const command = session.getLegalCommands(seat).commands[0];
        if (!command) continue;
        const submitted = await session.submit(seat, command);
        if (!submitted.ok) throw new Error(`Legal command refused: ${submitted.error.code}`);
        return true;
      }
      return false;
    },
    { id: gameId, modulePath: path },
  );
}

test('encrypted imported history stays read-only until a fresh certified seat transfer', async ({
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
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
    await source.getByLabel('Room name').fill('Imported checkpoint transfer');
    await source.getByLabel('Your player name').fill('Original device');
    await source.getByText('Advanced connection options', { exact: true }).click();
    await source.getByLabel('Invite friends with').selectOption('server');
    await source.getByLabel('Custom room server').fill(signalingUrl);
    await source.getByLabel('Player count').selectOption('2');
    await source.getByRole('button', { name: 'Create room' }).click();
    const lobbyTitle = source.getByRole('heading', { name: 'Imported checkpoint transfer' });
    await expect(lobbyTitle).toBeVisible();

    const lobbyInvite = await source
      .getByRole('textbox', { name: /^Invitation link/ })
      .inputValue();
    await survivor.goto(lobbyInvite);
    await expect(
      survivor.getByRole('heading', { name: 'Imported checkpoint transfer' }),
    ).toBeVisible();
    await survivor.getByRole('button', { name: 'Take seat' }).click();
    await source.getByRole('button', { name: 'Ready up' }).click();
    await survivor.getByRole('button', { name: 'Ready up' }).click();
    await expect(source.getByRole('button', { name: 'Start game' })).toBeEnabled();
    await source.getByRole('button', { name: 'Start game' }).click();
    await expect(source).toHaveURL(/\/game\/[^/]+$/, { timeout: 90_000 });
    await expect(survivor).toHaveURL(/\/game\/[^/]+$/, { timeout: 90_000 });
    const gameId = new URL(source.url()).hash.match(/\/game\/([^/?]+)/)?.[1];
    if (!gameId) throw new Error('Game route has no identifier');
    const requiredDeckPasses = (await gameView(source, gameId))?.requiredDeckPasses;
    if (!requiredDeckPasses) throw new Error('Verified game has no deck-pass commitments');
    await expect
      .poll(async () => (await gameView(source, gameId))?.head?.seq ?? 0, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(requiredDeckPasses);

    // Export the certified live head with its private package encrypted; importing it must not
    // open a writer or restore control on the destination device.
    await source.locator('summary[aria-label="Open game menu"]').click();
    await source.getByRole('button', { name: 'Export full save', exact: true }).click();
    const exportDialog = source.getByRole('dialog');
    await exportDialog.getByRole('checkbox').check();
    await exportDialog.getByLabel('File passphrase', { exact: true }).fill(filePassphrase);
    const [download] = await Promise.all([
      source.waitForEvent('download'),
      exportDialog.getByRole('button', { name: 'Export full save', exact: true }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.hxfs$/);
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error('Encrypted full-save download was not retained');

    await destination.goto('/#/');
    await expect(destination.getByLabel('File passphrase, if needed')).toBeVisible();
    await destination.getByLabel('File passphrase, if needed').fill(filePassphrase);
    await destination.getByLabel('Choose full-save file').setInputFiles(downloadPath);
    await expect(destination).toHaveURL(/#\/full-save\/([a-f0-9]{64})$/);
    await expect(
      destination.getByRole('heading', { name: 'Imported game snapshot' }),
    ).toBeVisible();
    await expect(destination.getByText('Paused, read-only snapshot')).toBeVisible();
    await expect(
      destination.getByText(
        'This file contains an encrypted private package. This view does not unlock or install it.',
      ),
    ).toBeVisible();
    await expect(destination.getByRole('button', { name: 'Roll dice', exact: true })).toHaveCount(
      0,
    );
    await expect(destination.getByRole('button', { name: 'Build', exact: true })).toHaveCount(0);
    const archiveId = new URL(destination.url()).hash.match(/\/full-save\/([a-f0-9]{64})$/)?.[1];
    if (!archiveId) throw new Error('Imported archive has no immutable identifier');

    const gameMenu = source.locator('details.game-menu');
    if ((await gameMenu.getAttribute('open')) === null)
      await source.locator('summary[aria-label="Open game menu"]').click();
    await source.getByRole('button', { name: 'Move this seat to another device' }).click();
    const transferDialog = source.getByRole('dialog', { name: 'Move this seat to another device' });
    const sourceDevice = await transferDialog
      .locator('.online-transfer-self code')
      .first()
      .innerText();
    const transferInvite = await transferDialog
      .getByRole('textbox', { name: /^Seat transfer invitation/ })
      .inputValue();

    await destination
      .getByLabel("Current player's signed transfer invitation URL")
      .fill(transferInvite);
    await destination.getByRole('button', { name: 'Continue with this invitation' }).click();
    await expect(destination).toHaveURL(new RegExp(`/transfer/[^?]+\\?archiveId=${archiveId}$`));
    await expect(destination.getByRole('button', { name: 'Start seat transfer' })).toBeVisible();
    await destination.getByRole('button', { name: 'Start seat transfer' }).click();
    await expect
      .poll(
        () =>
          destination
            .locator('.online-transfer-panel .online-transfer-self strong')
            .first()
            .innerText()
            .catch(() => ''),
        { timeout: 30_000 },
      )
      .toBe('This device');
    const destinationDevice = await destination
      .locator('.online-transfer-self code')
      .first()
      .innerText();
    expect(destinationDevice).not.toBe(sourceDevice);

    await expect(transferDialog.getByRole('radio')).toHaveCount(1, { timeout: 30_000 });
    await transferDialog.getByRole('radio').click();
    await expect(transferDialog.getByRole('button', { name: 'Confirm move' })).toBeEnabled({
      timeout: 35_000,
    });
    await transferDialog.getByRole('button', { name: 'Confirm move' }).click();
    await expect(destination.getByRole('button', { name: 'Open game on this device' })).toBeVisible(
      { timeout: 90_000 },
    );
    await destination.getByRole('button', { name: 'Open game on this device' }).click();
    await expect(destination).toHaveURL(new RegExp(`/game/${gameId}$`), { timeout: 30_000 });

    await expect
      .poll(async () => (await gameView(destination, gameId))?.head ?? null, { timeout: 30_000 })
      .toEqual(await gameView(survivor, gameId).then((view) => view?.head ?? null));
    await expect
      .poll(async () => (await gameView(source, gameId))?.seats.length ?? 0, { timeout: 20_000 })
      .toBe(0);

    let acceptedMove = false;
    for (let attempt = 0; attempt < 8 && !acceptedMove; attempt += 1) {
      const current = await gameView(destination, gameId);
      const peer = await gameView(survivor, gameId);
      if (!current?.head || !peer?.head) throw new Error('Transferred game has no certified head');
      if (current.legal.some((item) => item.count > 0)) {
        const before = current.head.seq;
        acceptedMove = await submitFirstLegal(destination, gameId);
        if (acceptedMove) {
          await expect
            .poll(async () => (await gameView(survivor, gameId))?.head?.seq ?? 0, {
              timeout: 30_000,
            })
            .toBeGreaterThan(before);
        }
      } else if (peer.legal.some((item) => item.count > 0)) {
        const before = peer.head.seq;
        await submitFirstLegal(survivor, gameId);
        await expect
          .poll(async () => (await gameView(destination, gameId))?.head?.seq ?? 0, {
            timeout: 30_000,
          })
          .toBeGreaterThan(before);
      }
    }
    expect(acceptedMove).toBe(true);
    expect((await gameView(destination, gameId))?.head).toEqual(
      (await gameView(survivor, gameId))?.head,
    );

    await source.reload();
    await expect(source.locator('main.online-resume-page').getByRole('alert')).toContainText(
      /could not be restored|no longer secure|retired/i,
      { timeout: 30_000 },
    );
    expect(errors).toEqual([]);
  } catch (error) {
    await testInfo.attach('imported-transfer-pages', {
      body: JSON.stringify(
        await Promise.all(
          [source, survivor, destination].map(async (page) => ({
            url: page.url(),
            text: await page
              .locator('main')
              .innerText({ timeout: 1_000 })
              .catch(() => ''),
          })),
        ),
        null,
        2,
      ),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
