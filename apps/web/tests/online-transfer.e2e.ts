/* eslint-disable no-await-in-loop -- Each legal move depends on the prior certified head. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.use(
  process.env.CP2P_CHROMIUM_EXECUTABLE
    ? {
        actionTimeout: 15_000,
        launchOptions: { executablePath: process.env.CP2P_CHROMIUM_EXECUTABLE },
      }
    : { actionTimeout: 15_000, channel: 'chrome' },
);

const SIGNALING_URL = 'ws://127.0.0.1:8909';
let registryModulePath: string | null = null;

async function loadedRegistryPath(page: Page): Promise<string> {
  if (registryModulePath) return registryModulePath;
  const observed = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname.endsWith('/room-registry.ts')),
  );
  if (observed) {
    const url = new URL(observed);
    registryModulePath = url.pathname + url.search;
  }
  if (!registryModulePath) throw new Error('The app room registry has not loaded');
  return registryModulePath;
}

// Native signaling and three isolated browser contexts are supplied by the local harness.
test.skip(process.env.CP2P_ONLINE_TRANSFER_E2E !== '1', 'Requires local signaling on port 8909');

async function gameView(page: Page, gameId: string) {
  const registryPath = await loadedRegistryPath(page);
  return page.evaluate(
    async ({ id, path }) => {
      // oxlint-disable typescript/no-unsafe-type-assertion -- Vite serves this known local module inside the browser; its exports match the compile-time import.
      const { getOnlineGameRoom } = (await import(
        /* @vite-ignore */ path
      )) as typeof import('../src/features/online/room-registry.js');
      // oxlint-enable typescript/no-unsafe-type-assertion
      const game = getOnlineGameRoom(id)?.getGame();
      const session = game?.session;
      if (!session || !game) return null;
      const seats = session.controllableSeats();
      // The signed genesis was validated before OnlineGame opened; count its frozen pass hashes.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Test inspection of the verified genesis commitment shape.
      const decks = game.genesis.commitments.decks as readonly {
        passHashes: readonly string[];
      }[];
      return {
        seats,
        requiredDeckPasses: decks.reduce((total, deck) => total + deck.passHashes.length, 0),
        activeSeat: session.getState().turn.activeSeat,
        legal: seats.map((seat) => ({
          seat,
          count: session.getLegalCommands(seat).commands.length,
        })),
        head: session.getFairness?.()?.head ?? null,
      };
    },
    { id: gameId, path: registryPath },
  );
}

async function submitFirstLegal(page: Page, gameId: string): Promise<boolean> {
  const registryPath = await loadedRegistryPath(page);
  return page.evaluate(
    async ({ id, path }) => {
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
    },
    { id: gameId, path: registryPath },
  );
}

async function transferChanges(page: Page, gameId: string) {
  const registryPath = await loadedRegistryPath(page);
  return page.evaluate(
    async ({ id, path }) => {
      // oxlint-disable typescript/no-unsafe-type-assertion -- This is the app-loaded Vite module, not a second registry instance.
      const { getOnlineGameRoom } = (await import(
        /* @vite-ignore */ path
      )) as typeof import('../src/features/online/room-registry.js');
      // oxlint-enable typescript/no-unsafe-type-assertion
      const session = getOnlineGameRoom(id)?.getGame()?.session;
      if (!session) return [];
      const saved = await session.exportSave();
      if (
        !saved ||
        typeof saved !== 'object' ||
        !('entries' in saved) ||
        !Array.isArray(saved.entries)
      )
        throw new Error('Verified session has no certified entry list');
      return saved.entries.flatMap((item: unknown) => {
        if (!item || typeof item !== 'object' || !('entry' in item)) return [];
        const entry = item.entry;
        if (!entry || typeof entry !== 'object' || !('payload' in entry)) return [];
        const payload = entry.payload;
        if (!payload || typeof payload !== 'object' || !('kind' in payload)) return [];
        if (payload.kind !== 'membership' || !('change' in payload)) return [];
        const change = payload.change;
        if (!change || typeof change !== 'object' || !('kind' in change)) return [];
        if (change.kind !== 'transfer-authorize' && change.kind !== 'transfer-cancel') return [];
        if (!('seq' in entry) || typeof entry.seq !== 'number') return [];
        return [{ seq: entry.seq, kind: change.kind }];
      });
    },
    { id: gameId, path: registryPath },
  );
}

async function holdReadiness(page: Page): Promise<void> {
  const observed = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname.endsWith('/online-transfer-channel.ts')),
  );
  if (!observed) throw new Error('The active destination transfer channel has not loaded');
  const url = new URL(observed);
  await page.evaluate(async (path) => {
    // oxlint-disable typescript/no-unsafe-type-assertion -- Instrument the already-loaded local channel module for one native delivery fault.
    const { OnlineTransferChannel } = (await import(
      /* @vite-ignore */ path
    )) as typeof import('../src/session/online-transfer-channel.js');
    // oxlint-enable typescript/no-unsafe-type-assertion
    // oxlint-disable-next-line typescript/unbound-method -- Calls below explicitly bind each captured channel.
    const original = OnlineTransferChannel.prototype.send;
    const held: {
      channel: InstanceType<typeof OnlineTransferChannel>;
      artifact: Parameters<typeof original>[0];
    }[] = [];
    OnlineTransferChannel.prototype.send = async function (artifact) {
      if (artifact.kind === 'readiness') {
        held.push({
          channel: this,
          artifact: { kind: artifact.kind, bytes: new Uint8Array(artifact.bytes) },
        });
        return;
      }
      return original.call(this, artifact);
    };
    Object.defineProperty(globalThis, '__cp2pHeldTransferReadiness', {
      configurable: true,
      value: {
        count: () => held.length,
        async release() {
          OnlineTransferChannel.prototype.send = original;
          for (const item of held) {
            // oxlint-disable-next-line no-await-in-loop -- Preserve the signed packet order of this one transfer.
            await original.call(item.channel, item.artifact);
            item.artifact.bytes.fill(0);
          }
          held.length = 0;
        },
        restore() {
          OnlineTransferChannel.prototype.send = original;
          for (const item of held) item.artifact.bytes.fill(0);
          held.length = 0;
        },
      },
    });
  }, url.pathname + url.search);
}

async function heldReadinessCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Test-owned page fault control, never an application credential or state injection.
    const control = Reflect.get(globalThis, '__cp2pHeldTransferReadiness') as
      | { count: () => number }
      | undefined;
    return control?.count() ?? 0;
  });
}

async function releaseReadiness(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Release only the genuine signed readiness generated by the destination.
    const control = Reflect.get(globalThis, '__cp2pHeldTransferReadiness') as
      | { release: () => Promise<void> }
      | undefined;
    if (!control) throw new Error('Readiness delivery control is missing');
    await control.release();
  });
}

async function restoreReadiness(page: Page): Promise<void> {
  if (page.isClosed()) return;
  await page.evaluate(() => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Test-only prototype restoration after the network fault.
    const control = Reflect.get(globalThis, '__cp2pHeldTransferReadiness') as
      | { restore: () => void }
      | undefined;
    control?.restore();
  });
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
  for (const page of [source, survivor, destination]) {
    page.on('pageerror', (error) => errors.push(error.message));
  }

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

    const invitation = await source.getByRole('textbox', { name: /^Invitation link/ }).inputValue();
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
    // Transfer is permitted after the signed deck passes have certified.
    await expect
      .poll(async () => (await gameView(source, gameId))?.requiredDeckPasses ?? 0, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    const requiredDeckPasses = (await gameView(source, gameId))?.requiredDeckPasses;
    if (!requiredDeckPasses) throw new Error('Verified game has no deck-pass commitments');
    await expect
      .poll(async () => (await gameView(source, gameId))?.head?.seq ?? 0, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(requiredDeckPasses);

    await source.locator('summary[aria-label="Open game menu"]').click();
    await source.getByRole('button', { name: 'Move this seat to another device' }).click();
    const transferDialog = source.getByRole('dialog', { name: 'Move this seat to another device' });
    const transferInvitation = await transferDialog
      .getByRole('textbox', { name: /^Seat transfer invitation/ })
      .inputValue();
    await destination.goto(transferInvitation);
    await destination.getByRole('button', { name: 'Start seat transfer' }).click();
    await expect(transferDialog.getByRole('radio')).toHaveCount(1, { timeout: 20_000 });
    await transferDialog.getByRole('radio').click();
    await expect(transferDialog.getByRole('radio')).toBeChecked();
    await expect(transferDialog.getByRole('button', { name: 'Confirm move' })).toBeVisible({
      timeout: 35_000,
    });
    await transferDialog.getByRole('button', { name: 'Confirm move' }).click();

    await Promise.race([
      destination
        .getByRole('button', { name: 'Open game on this device' })
        .waitFor({ state: 'visible', timeout: 90_000 }),
      transferDialog
        .getByRole('alert')
        .waitFor({ state: 'visible', timeout: 90_000 })
        .then(async () => {
          throw new Error(
            `Transfer refused: ${await transferDialog.getByRole('alert').innerText()}`,
          );
        }),
    ]);
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
    await source.reload();
    await expect(source.locator('main.online-resume-page').getByRole('alert')).toContainText(
      /could not be restored|no longer secure|retired/i,
      { timeout: 30_000 },
    );
    expect(errors).toEqual([]);
  } catch (error) {
    await test.info().attach('transfer-pages', {
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

test('certified cancellation keeps the source in control after delayed genuine readiness', async ({
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
    await source.getByLabel('Room name').fill('Transfer cancellation');
    await source.getByLabel('Your player name').fill('Source');
    await source.getByText('Advanced connection options', { exact: true }).click();
    await source.getByLabel('Invite friends with').selectOption('server');
    await source.getByLabel('Custom room server').fill(SIGNALING_URL);
    await source.getByLabel('Player count').selectOption('2');
    await source.getByRole('button', { name: 'Create room' }).click();
    const invitation = await source.getByRole('textbox', { name: /^Invitation link/ }).inputValue();
    await survivor.goto(invitation);
    await survivor.getByRole('button', { name: 'Take seat' }).click();
    await source.getByRole('button', { name: 'Ready up' }).click();
    await survivor.getByRole('button', { name: 'Ready up' }).click();
    await expect(source.getByRole('button', { name: 'Start game' })).toBeEnabled();
    await source.getByRole('button', { name: 'Start game' }).click();
    await expect(source).toHaveURL(/\/game\/[^/]+$/, { timeout: 90_000 });
    await expect(survivor).toHaveURL(/\/game\/[^/]+$/, { timeout: 90_000 });
    const gameId = new URL(source.url()).hash.match(/\/game\/([^/?]+)/)?.[1];
    if (!gameId) throw new Error('Game route has no identifier');
    await expect
      .poll(async () => (await gameView(source, gameId))?.requiredDeckPasses ?? 0, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    const requiredDeckPasses = (await gameView(source, gameId))?.requiredDeckPasses;
    if (!requiredDeckPasses) throw new Error('Verified game has no deck-pass commitments');
    await expect
      .poll(async () => (await gameView(source, gameId))?.head?.seq ?? 0, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(requiredDeckPasses);

    await source.locator('summary[aria-label="Open game menu"]').click();
    await source.getByRole('button', { name: 'Move this seat to another device' }).click();
    const dialog = source.getByRole('dialog', { name: 'Move this seat to another device' });
    const transferInvitation = await dialog
      .getByRole('textbox', { name: /^Seat transfer invitation/ })
      .inputValue();
    await destination.goto(transferInvitation);
    await destination.getByRole('button', { name: 'Start seat transfer' }).click();
    await expect(dialog.getByRole('radio')).toHaveCount(1, { timeout: 20_000 });
    // The route has now loaded the exact channel module used by the authenticated link.
    await holdReadiness(destination);
    await dialog.getByRole('radio').click();
    await expect(dialog.getByRole('radio')).toBeChecked();
    await expect(dialog.getByRole('button', { name: 'Confirm move' })).toBeVisible({
      timeout: 35_000,
    });
    await dialog.getByRole('button', { name: 'Confirm move' }).click();
    await expect
      .poll(() => heldReadinessCount(destination), { timeout: 30_000 })
      .toBeGreaterThan(0);
    const authorization = (await transferChanges(source, gameId)).find(
      (item) => item.kind === 'transfer-authorize',
    );
    if (!authorization) throw new Error('Transfer authorization was not certified');
    await expect(dialog.getByRole('button', { name: 'Cancel move' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel move' }).click();
    await expect(dialog.getByRole('status')).toContainText(
      /recorded the cancellation|move was cancelled/,
      {
        timeout: 30_000,
      },
    );
    await releaseReadiness(destination);
    await expect(destination.getByRole('status')).toContainText('This device did not take over', {
      timeout: 30_000,
    });
    await expect(dialog.getByRole('status')).toContainText('The move was cancelled', {
      timeout: 30_000,
    });
    const cancellation = (await transferChanges(source, gameId)).find(
      (item) => item.kind === 'transfer-cancel',
    );
    if (!cancellation || cancellation.seq <= authorization.seq)
      throw new Error('Certified cancellation does not follow authorization');
    await expect(destination.getByRole('button', { name: 'Open game on this device' })).toHaveCount(
      0,
    );
    await expect
      .poll(async () => (await gameView(survivor, gameId))?.head?.seq ?? 0, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(cancellation.seq);
    await expect
      .poll(async () => (await gameView(source, gameId))?.seats.includes(0) ?? false)
      .toBe(true);

    for (let step = 0; step < 6; step += 1) {
      const sourceView = await gameView(source, gameId);
      if (sourceView?.legal.some((item) => item.count > 0)) break;
      const survivorView = await gameView(survivor, gameId);
      if (!survivorView?.head || !survivorView.legal.some((item) => item.count > 0))
        throw new Error('Neither current voter has a legal move');
      const before = survivorView.head.seq;
      await submitFirstLegal(survivor, gameId);
      await expect
        .poll(async () => (await gameView(source, gameId))?.head?.seq, { timeout: 20_000 })
        .toBeGreaterThan(before);
    }
    const before = (await gameView(source, gameId))?.head?.seq;
    if (before === undefined || !(await submitFirstLegal(source, gameId)))
      throw new Error('Source lost its legal move after certified cancellation');
    await expect
      .poll(async () => (await gameView(survivor, gameId))?.head?.seq, { timeout: 20_000 })
      .toBeGreaterThan(before);
    expect((await gameView(source, gameId))?.head).toEqual(
      (await gameView(survivor, gameId))?.head,
    );

    await restoreReadiness(destination);
    await destination.reload();
    await expect(destination.getByRole('button', { name: 'Open game on this device' })).toHaveCount(
      0,
    );
    await destination.getByRole('button', { name: 'Start seat transfer' }).click();
    await expect(destination.getByRole('status')).toContainText('This device did not take over', {
      timeout: 20_000,
    });
    expect(errors).toEqual([]);
  } catch (error) {
    const statuses = await Promise.all(
      [source, survivor, destination].map((page) =>
        page
          .getByRole('status')
          .allInnerTexts()
          .catch(() => []),
      ),
    );
    await test.info().attach('cancellation-pages', {
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
    throw new Error(
      `${error instanceof Error ? error.message : 'Cancellation trace failed'}; visible statuses: ${JSON.stringify(statuses)}`,
      { cause: error },
    );
  } finally {
    await restoreReadiness(destination).catch(() => undefined);
    await Promise.all(contexts.map((context) => context.close()));
  }
});
