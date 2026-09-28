/* eslint-disable no-await-in-loop -- Each certified move and recovery action depends on the prior head. */
/* oxlint-disable typescript/no-unsafe-type-assertion -- The test imports the exact browser-loaded Vite registry module to inspect certified public state. */
import { expect, test } from '@playwright/test';
import { RandomBot, createBotRng } from '@cp2p/bots';
import type { CommandShape, Seat } from '@cp2p/engine';
import type { Page } from '@playwright/test';

test.use(
  process.env.CP2P_CHROMIUM_EXECUTABLE
    ? {
        actionTimeout: 15_000,
        launchOptions: { executablePath: process.env.CP2P_CHROMIUM_EXECUTABLE },
      }
    : { actionTimeout: 15_000, channel: 'chrome' },
);
test.skip(process.env.CP2P_ONLINE_TAKEOVER_E2E !== '1', 'Requires native Chrome and signaling');

const SIGNALING_URL = 'ws://127.0.0.1:8909';

async function registryPath(page: Page): Promise<string> {
  const resource = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((url) => new URL(url).pathname.endsWith('/room-registry.ts')),
  );
  if (!resource) throw new Error('Loaded game registry module was not observed');
  const url = new URL(resource);
  return url.pathname + url.search;
}

async function view(page: Page, gameId: string) {
  const path = await registryPath(page);
  return page.evaluate(
    async ({ id, modulePath }) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Browser imports its already-loaded local Vite module.
      const { getOnlineGameRoom } = (await import(
        /* @vite-ignore */ modulePath
      )) as typeof import('../src/features/online/room-registry.js');
      const game = getOnlineGameRoom(id)?.getGame();
      if (!game) return null;
      const session = game.session;
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Signed verified genesis has this bounded public deck shape.
      const decks = game.genesis.commitments.decks as readonly {
        passHashes: readonly string[];
      }[];
      const seats = session.controllableSeats();
      return {
        head: session.getFairness?.()?.head ?? null,
        turnNumber: session.getState().turn.number,
        activeSeat: session.getState().turn.activeSeat,
        deckPasses: decks.reduce((total, deck) => total + deck.passHashes.length, 0),
        stateSeats: session
          .getState()
          .seats.map((seat) => ({ seat: seat.seat, status: seat.status })),
        seats,
        legal: seats.map((seat) => ({
          seat,
          count: session.getLegalCommands(seat).commands.length,
        })),
      };
    },
    { id: gameId, modulePath: path },
  );
}

async function driveCertifiedStep(
  pages: readonly Page[],
  observer: Page,
  gameId: string,
): Promise<void> {
  const before = (await view(observer, gameId))?.head?.seq;
  if (before === undefined) throw new Error('Certified head is unavailable');
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (((await view(observer, gameId))?.head?.seq ?? 0) > before) return;
    for (const page of pages) {
      if (!page.isClosed() && (await submitOne(page, gameId))) {
        await expect
          .poll(async () => (await view(observer, gameId))?.head?.seq ?? 0, { timeout: 20_000 })
          .toBeGreaterThan(before);
        return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const snapshots = await Promise.all(
    pages.map(async (page) => (page.isClosed() ? null : view(page, gameId))),
  );
  throw new Error(
    `No legal or automatic certified input after head ${before}: ${JSON.stringify(snapshots)}`,
  );
}

async function submitOne(page: Page, gameId: string): Promise<boolean> {
  const path = await registryPath(page);
  return page.evaluate(
    async ({ id, modulePath }) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Browser imports its already-loaded local Vite module.
      const { getOnlineGameRoom } = (await import(
        /* @vite-ignore */ modulePath
      )) as typeof import('../src/features/online/room-registry.js');
      const session = getOnlineGameRoom(id)?.getGame()?.session;
      if (!session) return false;
      for (const seat of session.controllableSeats()) {
        const command = session.getLegalCommands(seat).commands[0];
        if (!command) continue;
        const result = await session.submit(seat, command);
        if (!result.ok) throw new Error(`Legal command rejected: ${result.error.code}`);
        return true;
      }
      return false;
    },
    { id: gameId, modulePath: path },
  );
}

async function certifiedKinds(page: Page, gameId: string): Promise<readonly string[]> {
  const path = await registryPath(page);
  return page.evaluate(
    async ({ id, modulePath }) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Browser imports its already-loaded local Vite module.
      const { getOnlineGameRoom } = (await import(
        /* @vite-ignore */ modulePath
      )) as typeof import('../src/features/online/room-registry.js');
      const saved = await getOnlineGameRoom(id)?.getGame()?.session.exportSave();
      if (
        !saved ||
        typeof saved !== 'object' ||
        !('entries' in saved) ||
        !Array.isArray(saved.entries)
      )
        throw new Error('Certified session history is unavailable');
      return saved.entries.flatMap((item: unknown) => {
        if (!item || typeof item !== 'object' || !('entry' in item)) return [];
        const entry = item.entry;
        if (!entry || typeof entry !== 'object' || !('payload' in entry)) return [];
        const payload = entry.payload;
        if (!payload || typeof payload !== 'object' || !('kind' in payload)) return [];
        if (payload.kind !== 'membership' || !('change' in payload)) return [];
        const change = payload.change;
        if (!change || typeof change !== 'object' || !('kind' in change)) return [];
        return typeof change.kind === 'string' ? [change.kind] : [];
      });
    },
    { id: gameId, modulePath: path },
  );
}

async function certifiedCommands(
  page: Page,
  gameId: string,
): Promise<readonly { seq: number; seat: number }[]> {
  const path = await registryPath(page);
  return page.evaluate(
    async ({ id, modulePath }) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Inspect the loaded verified session history.
      const { getOnlineGameRoom } = (await import(
        /* @vite-ignore */ modulePath
      )) as typeof import('../src/features/online/room-registry.js');
      const saved = await getOnlineGameRoom(id)?.getGame()?.session.exportSave();
      if (
        !saved ||
        typeof saved !== 'object' ||
        !('entries' in saved) ||
        !Array.isArray(saved.entries)
      )
        throw new Error('Certified command history is unavailable');
      return saved.entries.flatMap((item: unknown) => {
        if (!item || typeof item !== 'object' || !('entry' in item)) return [];
        const entry = item.entry;
        if (!entry || typeof entry !== 'object' || !('payload' in entry) || !('seq' in entry))
          return [];
        const payload = entry.payload;
        if (
          !payload ||
          typeof payload !== 'object' ||
          !('kind' in payload) ||
          payload.kind !== 'command' ||
          !('signed' in payload) ||
          !payload.signed ||
          typeof payload.signed !== 'object' ||
          !('body' in payload.signed) ||
          !payload.signed.body ||
          typeof payload.signed.body !== 'object' ||
          !('seat' in payload.signed.body) ||
          typeof entry.seq !== 'number' ||
          typeof payload.signed.body.seat !== 'number'
        )
          return [];
        return [{ seq: entry.seq, seat: payload.signed.body.seat }];
      });
    },
    { id: gameId, modulePath: path },
  );
}

test('four humans certify takeover, recovered bot continues, and original device returns with a fresh key', async ({
  browser,
}, testInfo) => {
  test.setTimeout(600_000);
  const contexts = await Promise.all(Array.from({ length: 4 }, () => browser.newContext()));
  await Promise.all(
    contexts.map((context) =>
      context.addInitScript(() => performance.setResourceTimingBufferSize(5_000)),
    ),
  );
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const host = pages[0];
  const survivors = pages.slice(1);
  if (!host || survivors.length !== 3) throw new Error('Four native pages are required');
  const errors: string[] = [];
  for (const page of pages) page.on('pageerror', (error) => errors.push(error.message));
  let returning: Page | null = null;
  try {
    await host.goto('/#/online/create');
    await host.getByLabel('Room name').fill('Four human return');
    await host.getByLabel('Your player name').fill('Original');
    await host.getByText('Advanced connection options', { exact: true }).click();
    await host.getByLabel('Invite friends with').selectOption('server');
    await host.getByLabel('Custom room server').fill(SIGNALING_URL);
    await host.getByLabel('Player count').selectOption('4');
    await host.getByRole('button', { name: 'Create room' }).click();
    await expect(host.getByRole('heading', { name: 'Four human return' })).toBeVisible();
    await host.getByLabel('Replace a disconnected player after').selectOption('30');
    const invitation = await host.getByRole('textbox', { name: /^Invitation link/ }).inputValue();
    for (const guest of survivors) {
      await guest.goto(invitation);
      await guest.getByRole('button', { name: 'Take seat' }).first().click();
    }
    await host.getByRole('button', { name: 'Ready up' }).click();
    for (const guest of survivors) await guest.getByRole('button', { name: 'Ready up' }).click();
    for (const page of pages)
      await expect(page.getByText('4 of 4 players connected')).toBeVisible({ timeout: 45_000 });
    await expect(host.getByRole('button', { name: 'Start game' })).toBeEnabled();
    await host.getByRole('button', { name: 'Start game' }).click();
    for (const page of pages) {
      const startupState = async () => {
        if (/\/game\/[^/]+$/.test(page.url())) return 'ready';
        if (await page.getByText('This start was cancelled.').count()) return 'retired';
        return 'starting';
      };
      await expect.poll(startupState, { timeout: 90_000 }).toMatch(/^(ready|retired)$/);
      expect(await startupState()).toBe('ready');
    }
    const gameId = new URL(host.url()).hash.match(/\/game\/([^/?]+)/)?.[1];
    if (!gameId) throw new Error('Game route has no identifier');
    const passes = (await view(host, gameId))?.deckPasses;
    if (!passes) throw new Error('Verified genesis has no signed deck passes');
    await expect
      .poll(async () => (await view(host, gameId))?.head?.seq ?? 0, { timeout: 40_000 })
      .toBeGreaterThanOrEqual(passes);
    for (let step = 0; step < 24 && ((await view(host, gameId))?.turnNumber ?? 0) === 0; step += 1)
      await driveCertifiedStep(pages, host, gameId);
    expect((await view(host, gameId))?.turnNumber).toBeGreaterThan(0);
    const beforeDeparture = (await view(host, gameId))?.head;
    if (!beforeDeparture) throw new Error('No certified head before departure');
    await host.close();
    const initiator = survivors[0];
    if (!initiator) throw new Error('Canonical survivor is missing');
    const request = initiator.getByRole('button', { name: /Request takeover of Original/ });
    await expect(request).toBeVisible({ timeout: 100_000 });
    await request.click();
    for (const voter of survivors.slice(1)) {
      const approve = voter.getByRole('button', { name: 'Approve takeover' });
      await expect(approve).toBeVisible({ timeout: 30_000 });
      await approve.click();
    }
    await expect
      .poll(
        async () =>
          (await view(initiator, gameId))?.stateSeats.find((seat) => seat.seat === 0)?.status,
        {
          timeout: 60_000,
        },
      )
      .toBe('bot');
    expect(await certifiedKinds(initiator, gameId)).toContain('recovery-activate');
    const recoveredHead = (await view(initiator, gameId))?.head;
    if (!recoveredHead) throw new Error('Recovery has no certified head');
    let botCommand = false;
    for (let step = 0; step < 36 && !botCommand; step += 1) {
      await driveCertifiedStep(survivors, initiator, gameId);
      botCommand = (await certifiedCommands(initiator, gameId)).some(
        (command) => command.seat === 0 && command.seq > recoveredHead.seq,
      );
    }
    expect(botCommand).toBe(true);
    await initiator.locator('summary[aria-label="Open game menu"]').click();
    await initiator.getByRole('button', { name: 'Return player 1 to a device' }).click();
    const dialog = initiator.getByRole('dialog', { name: 'Return this player to their device' });
    const returnInvite = await dialog
      .getByRole('textbox', { name: /^Seat transfer invitation/ })
      .inputValue();
    returning = (await contexts[0]?.newPage()) ?? null;
    if (!returning) throw new Error('Original device context was lost');
    returning.on('pageerror', (error) => errors.push(error.message));
    await returning.goto(returnInvite);
    await expect(returning.getByText(/Your hand was visible to other players/)).toBeVisible();
    await returning.getByRole('button', { name: 'Start seat transfer' }).click();
    await expect(dialog.getByRole('radio')).toHaveCount(1, { timeout: 20_000 });
    await dialog.getByRole('radio').click();
    await expect(dialog.getByRole('button', { name: 'Confirm move' })).toBeVisible({
      timeout: 35_000,
    });
    await dialog.getByRole('button', { name: 'Confirm move' }).click();
    await expect(returning.getByRole('button', { name: 'Open game on this device' })).toBeVisible({
      timeout: 90_000,
    });
    await returning.getByRole('button', { name: 'Open game on this device' }).click();
    await expect(returning).toHaveURL(new RegExp(`/game/${gameId}$`), { timeout: 30_000 });
    await expect(returning.locator('summary[aria-label="Open game menu"]')).toBeVisible({
      timeout: 45_000,
    });
    const returnedPage = returning;
    await expect.poll(async () => (await view(returnedPage, gameId))?.seats).toEqual([0]);
    const returnHead = (await view(returnedPage, gameId))?.head;
    if (!returnHead) throw new Error('Returned controller has no certified head');
    await expect
      .poll(async () => (await view(initiator, gameId))?.head?.hash, { timeout: 20_000 })
      .toBe((await view(returning, gameId))?.head?.hash);
    expect(await certifiedKinds(initiator, gameId)).toContain('transfer-activate');
    let returnedCommand = false;
    for (let step = 0; step < 36 && !returnedCommand; step += 1) {
      await driveCertifiedStep([returnedPage, ...survivors], initiator, gameId);
      returnedCommand = (await certifiedCommands(initiator, gameId)).some(
        (command) => command.seat === 0 && command.seq > returnHead.seq,
      );
    }
    expect(returnedCommand).toBe(true);
    const terminal = await finishGame([returnedPage, ...survivors], gameId);
    await testInfo.attach('native-lifecycle-terminal', {
      body: JSON.stringify(terminal, null, 2),
      contentType: 'application/json',
    });
    expect(errors).toEqual([]);
  } catch (error) {
    const pageStatus = await Promise.all(
      [...pages, ...(returning ? [returning] : [])].map(async (page, index) => ({
        index,
        url: page.url(),
        main: page.isClosed()
          ? ''
          : await page
              .locator('main')
              .textContent()
              .catch(() => ''),
        room: page.isClosed()
          ? null
          : await (async () => {
              const lobbyId = page.url().match(/#\/lobby\/([^/?]+)/)?.[1];
              if (!lobbyId) return null;
              const modulePath = await registryPath(page).catch(() => null);
              if (!modulePath) return null;
              return page
                .evaluate(
                  async ({ id, path }) => {
                    const { getOnlineRoom } = (await import(
                      /* @vite-ignore */ path
                    )) as typeof import('../src/features/online/room-registry.js');
                    const snapshot = getOnlineRoom(id)?.getSnapshot();
                    return snapshot
                      ? {
                          self: snapshot.self,
                          peers: snapshot.peers,
                          connectionError: snapshot.connectionError,
                          signaling: snapshot.signaling.state,
                          diagnostic: snapshot.diagnostic?.kind,
                          startup: snapshot.startup?.phase,
                          startupError: snapshot.startup?.error,
                        }
                      : null;
                  },
                  { id: lobbyId, path: modulePath },
                )
                .catch(() => null);
            })(),
        gameStartup: page.isClosed()
          ? null
          : await (async () => {
              const gameId = page.url().match(/#\/game\/([^/?]+)/)?.[1];
              if (!gameId) return null;
              const modulePath = await registryPath(page).catch(() => null);
              if (!modulePath) return null;
              return page
                .evaluate(
                  async ({ id, path }) => {
                    const { getOnlineGameRoom } = (await import(
                      /* @vite-ignore */ path
                    )) as typeof import('../src/features/online/room-registry.js');
                    const snapshot = getOnlineGameRoom(id)?.getSnapshot();
                    return snapshot
                      ? { phase: snapshot.startup?.phase, error: snapshot.startup?.error }
                      : null;
                  },
                  { id: gameId, path: modulePath },
                )
                .catch(() => null);
            })(),
      })),
    );
    throw new Error(
      `${String(error)}\nPages: ${JSON.stringify(pageStatus)}\nPage errors: ${JSON.stringify(errors)}`,
      { cause: error },
    );
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});

async function finishGame(pages: readonly Page[], gameId: string) {
  const snapshots = async (
    page: Page,
    requestedMove?: { seat: Seat; command: CommandShape; revision: number },
  ) =>
    page.evaluate(
      async ({ id, move }) => {
        const path = performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => new URL(name).pathname.endsWith('/room-registry.ts'));
        if (!path) throw new Error('The running room registry is absent');
        // oxlint-disable typescript/no-unsafe-type-assertion -- The actual app-loaded Vite module in a disposable browser profile.
        const { getOnlineGameRoom } = (await import(
          /* @vite-ignore */ path
        )) as typeof import('../src/features/online/room-registry.js');
        // oxlint-enable typescript/no-unsafe-type-assertion
        const session = getOnlineGameRoom(id)?.getGame()?.session;
        if (!session) throw new Error('The resumed session is absent');
        let submitted = false;
        if (move) {
          const result = await session.submit(move.seat, move.command, {
            expectedRevision: move.revision,
          });
          if (!result.ok && !['stale-revision', 'stale-head'].includes(result.error.code))
            throw new Error(`Legal bot move ${move.command.type} refused: ${result.error.code}`);
          submitted = result.ok;
        }
        const seat = session.controllableSeats()[0];
        return {
          head: session.getFairness?.()?.head,
          state: session.getState(),
          audit: session.getAudit?.(),
          pending: session
            .getPending()
            .find((item) => item.kind === 'player' && item.seat === seat),
          seat,
          priv: seat === undefined ? null : session.getPrivate(seat),
          legal: seat === undefined ? null : session.getLegalCommands(seat),
          submitted,
        };
      },
      { id: gameId, move: requestedMove },
    );
  let moves = 0;
  const bot = new RandomBot();
  const rng = createBotRng(new Uint8Array(32).fill(59));
  await expect
    .poll(
      async () => {
        for (const page of pages) {
          // oxlint-disable-next-line no-await-in-loop -- Each command depends on the previous certified state.
          const current = await snapshots(page);
          if (
            current.state.result ||
            current.seat === undefined ||
            current.pending?.kind !== 'player' ||
            !current.priv ||
            !current.head ||
            !current.legal ||
            !(current.legal.commands.length || current.legal.templates.length)
          )
            continue;
          let command: CommandShape;
          try {
            command = bot.decide(
              { state: current.state, priv: current.priv, seat: current.seat },
              current.pending,
              rng,
            );
          } catch (error) {
            throw new Error(
              `Bot could not choose: ${JSON.stringify({ head: current.head, pending: current.pending, legal: current.legal })}`,
              { cause: error },
            );
          }
          // oxlint-disable-next-line no-await-in-loop -- Submit against the captured revision and retry stale snapshots.
          const next = await snapshots(page, {
            seat: current.seat,
            command,
            revision: current.head.seq,
          });
          if (next.submitted) moves += 1;
          if (moves > 1500) throw new Error('Bounded game exceeded 1500 player commands');
        }
        const all = await Promise.all(pages.map((page) => snapshots(page)));
        return all.every((item) => item.state.result && item.audit?.kind === 'complete');
      },
      { timeout: 300_000, intervals: [50] },
    )
    .toBe(true);
  const final = await Promise.all(pages.map((page) => snapshots(page)));
  for (const item of final) {
    expect(item.head).toEqual(final[0]?.head);
    expect(item.state.result).toEqual(final[0]?.state.result);
    expect(item.audit).toMatchObject({
      kind: 'complete',
      report: {
        ok: true,
        complete: true,
        missingSeats: [],
        violations: [],
        inputErrors: [],
        cheatFindings: [],
        historyError: null,
        auditError: null,
      },
    });
  }
  return {
    moves,
    peers: final.map(({ head, state, audit, seat }) => ({
      seat,
      head,
      result: state.result,
      audit,
    })),
  };
}
