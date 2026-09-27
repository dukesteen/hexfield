import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test.use({ channel: 'chrome', actionTimeout: 15_000 });
test.skip(process.env.CP2P_ONLINE_RESUME_E2E !== '1', 'Native Chrome with signaling on port 8909');

async function inspect(page: Page, gameId: string, submit = false) {
  return page.evaluate(
    async ({ id, submitMove }) => {
      const path = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((name) => new URL(name).pathname.endsWith('/room-registry.ts'));
      if (!path) return null;
      // oxlint-disable typescript/no-unsafe-type-assertion -- Import the actual app-loaded Vite module rather than a separate test registry.
      const { getOnlineGameRoom } = (await import(
        /* @vite-ignore */ path
      )) as typeof import('../src/features/online/room-registry.js');
      // oxlint-enable typescript/no-unsafe-type-assertion
      const session = getOnlineGameRoom(id)?.getGame()?.session;
      if (!session) return null;
      const seats = session.controllableSeats();
      const move = seats.flatMap((seat) => {
        const command = session.getLegalCommands(seat).commands[0];
        return command ? [{ seat, command }] : [];
      })[0];
      const head = session.getFairness?.()?.head ?? null;
      if (submitMove && move) {
        const result = await session.submit(move.seat, move.command);
        if (!result.ok) throw new Error(`Restored legal command refused: ${result.error.code}`);
      }
      return {
        head,
        seats,
        activeSeat: session.getState().turn.activeSeat,
        legal: !!move,
        submitted: submitMove && !!move,
      };
    },
    { id: gameId, submitMove: submit },
  );
}

async function certifyMove(actor: Page, peer: Page, gameId: string) {
  await expect.poll(async () => (await inspect(actor, gameId))?.legal).toBe(true);
  const before = await inspect(actor, gameId, true);
  if (!before?.head || !before.submitted) throw new Error('No legal move was submitted');
  await expect
    .poll(async () => (await inspect(peer, gameId))?.head?.seq ?? 0, { timeout: 20_000 })
    .toBeGreaterThan(before.head.seq);
  await expect
    .poll(async () => (await inspect(actor, gameId))?.head)
    .toEqual((await inspect(peer, gameId))?.head);
  return (await inspect(peer, gameId))?.head;
}

test('refresh and reverse-order reopening preserve the certified game and accept another move', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [hostContext, guestContext] = contexts;
  if (!hostContext || !guestContext) throw new Error('Missing test contexts');
  let host = await hostContext.newPage();
  let guest = await guestContext.newPage();
  const errors: string[] = [];
  const watch = (page: Page) => page.on('pageerror', (error) => errors.push(error.message));
  watch(host);
  watch(guest);
  try {
    await host.goto('/#/online/create');
    await host.getByLabel('Room name').fill('Resume acceptance');
    await host.getByLabel('Your player name').fill('Resume host');
    await host.getByText('Advanced connection options', { exact: true }).click();
    await host.getByLabel('Invite friends with').selectOption('server');
    await host.getByLabel('Custom room server').fill('ws://127.0.0.1:8909');
    await host.getByLabel('Player count').selectOption('2');
    await host.getByRole('button', { name: 'Create room' }).click();
    const invitation = host.getByRole('textbox', { name: /^Invitation link/ });
    await expect(invitation).toBeVisible();
    await guest.goto(await invitation.inputValue());
    await guest.getByRole('button', { name: 'Take seat' }).click();
    await host.getByRole('button', { name: 'Ready up' }).click();
    await guest.getByRole('button', { name: 'Ready up' }).click();
    await expect(host.getByRole('button', { name: 'Start game' })).toBeEnabled();
    await host.getByRole('button', { name: 'Start game' }).click();
    await expect(host).toHaveURL(/\/game\/[^/]+$/, { timeout: 60_000 });
    await expect(guest).toHaveURL(/\/game\/[^/]+$/, { timeout: 60_000 });
    const route = host.url();
    const gameId = new URL(route).hash.match(/\/game\/([^/?]+)/)?.[1];
    if (!gameId) throw new Error('Missing game identifier');
    await expect
      .poll(
        async () => (await inspect(host, gameId))?.legal || (await inspect(guest, gameId))?.legal,
        { timeout: 30_000 },
      )
      .toBe(true);
    // The ceremony chooses first player; the room creator need not act first.
    const firstIsHost = (await inspect(host, gameId))?.legal;
    const first = firstIsHost ? host : guest;
    const second = firstIsHost ? guest : host;
    await certifyMove(first, second, gameId);
    await certifyMove(first, second, gameId);
    const beforeRefresh = (await inspect(second, gameId))?.head;
    const refreshSeats = (await inspect(second, gameId))?.seats;
    const guestSeats = (await inspect(guest, gameId))?.seats;
    const hostSeats = (await inspect(host, gameId))?.seats;
    const refreshStart = performance.now();
    await second.reload();
    await expect
      .poll(async () => (await inspect(second, gameId))?.head, { timeout: 20_000, intervals: [50] })
      .toEqual(beforeRefresh);
    expect((await inspect(second, gameId))?.seats).toEqual(refreshSeats);
    const refreshToRestoredMs = performance.now() - refreshStart;
    await certifyMove(second, first, gameId);
    const refreshToPeerAcceptedMoveMs = performance.now() - refreshStart;
    const savedHead = (await inspect(host, gameId))?.head;
    if (!savedHead) throw new Error('Missing pre-close certified head');

    // Close every app page and worker, preserving each device's real IndexedDB.
    await Promise.all([host.close(), guest.close()]);
    guest = await guestContext.newPage();
    watch(guest);
    await guest.goto(route);
    await expect
      .poll(async () => (await inspect(guest, gameId))?.head, { timeout: 20_000 })
      .toEqual(savedHead);
    expect((await inspect(guest, gameId))?.seats).toEqual(guestSeats);
    host = await hostContext.newPage();
    watch(host);
    await host.goto(route);
    await expect
      .poll(async () => (await inspect(host, gameId))?.head, { timeout: 20_000 })
      .toEqual(savedHead);
    expect((await inspect(host, gameId))?.seats).toEqual(hostSeats);
    const finalHead = await certifyMove(
      firstIsHost ? guest : host,
      firstIsHost ? host : guest,
      gameId,
    );
    expect(errors).toEqual([]);
    const measurements = JSON.stringify(
      {
        gameId,
        savedHead,
        finalHead,
        refreshToRestoredMs,
        refreshToPeerAcceptedMoveMs,
        withinThreeSecondTarget: refreshToPeerAcceptedMoveMs < 3_000,
      },
      null,
      2,
    );
    await writeFile(testInfo.outputPath('resume-measurements.json'), measurements);
    await testInfo.attach('resume-measurements', {
      body: measurements,
      contentType: 'application/json',
    });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
