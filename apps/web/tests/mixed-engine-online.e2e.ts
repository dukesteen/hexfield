/* eslint-disable no-await-in-loop -- Membership and game commands depend on prior certified state. */
import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page, PlaywrightWorkerArgs } from '@playwright/test';
import { RandomBot, createBotRng } from '@cp2p/bots';
import type { CommandShape, Seat } from '@cp2p/engine';

test.skip(
  process.env.CP2P_MIXED_ENGINE_ACCEPTANCE !== '1',
  'Manual mixed-engine acceptance runs only from its opt-in workflow',
);

const signalingUrl = 'ws://127.0.0.1:8909';
const appBaseUrl = `http://127.0.0.1:${process.env.PLAYWRIGHT_TEST_PORT ?? '5187'}`;
const engineNames = ['chromium-a', 'chromium-b', 'firefox', 'webkit'] as const;
type EngineName = (typeof engineNames)[number];
type Playwright = PlaywrightWorkerArgs['playwright'];
const registryPaths = new WeakMap<Page, string>();

interface OpenedBrowserSet {
  readonly browsers: readonly Browser[];
  readonly contexts: readonly BrowserContext[];
  readonly pages: readonly Page[];
}

async function launchFourEngines(playwright: Playwright): Promise<OpenedBrowserSet> {
  const browsers: Browser[] = [];
  const contexts: BrowserContext[] = [];
  try {
    const chromium = await playwright.chromium.launch({ headless: true });
    browsers.push(chromium);
    const firefox = await playwright.firefox.launch({ headless: true });
    browsers.push(firefox);
    const webkit = await playwright.webkit.launch({ headless: true });
    browsers.push(webkit);
    const contextOptions = {
      baseURL: appBaseUrl,
      viewport: { width: 1280, height: 900 },
    } as const;
    const first = await chromium.newContext(contextOptions);
    contexts.push(first);
    const second = await chromium.newContext(contextOptions);
    contexts.push(second);
    const third = await firefox.newContext(contextOptions);
    contexts.push(third);
    const fourth = await webkit.newContext(contextOptions);
    contexts.push(fourth);
    await Promise.all(
      contexts.map(async (context) => {
        context.setDefaultTimeout(15_000);
        context.setDefaultNavigationTimeout(30_000);
        await context.addInitScript(() => performance.setResourceTimingBufferSize(5_000));
      }),
    );
    return {
      browsers,
      contexts,
      pages: await Promise.all(contexts.map((context) => context.newPage())),
    };
  } catch (error) {
    await Promise.allSettled(contexts.map((context) => context.close()));
    await Promise.allSettled(browsers.map((browser) => browser.close()));
    throw error;
  }
}

async function roomModulePath(page: Page): Promise<string> {
  const cached = registryPaths.get(page);
  if (cached) return cached;
  const path = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => new URL(name).pathname.endsWith('/room-registry.ts')),
  );
  if (!path) throw new Error('The loaded app room registry is unavailable');
  const url = new URL(path);
  const loadedPath = url.pathname + url.search;
  registryPaths.set(page, loadedPath);
  return loadedPath;
}

async function readRoom(page: Page) {
  const path = await roomModulePath(page);
  return page.evaluate(async (modulePath) => {
    // oxlint-disable typescript/no-unsafe-type-assertion -- Import the registry module actually loaded by this browser context.
    const { getOnlineRoom } = (await import(
      /* @vite-ignore */ modulePath
    )) as typeof import('../src/features/online/room-registry.js');
    // oxlint-enable typescript/no-unsafe-type-assertion
    const room = getOnlineRoom(new URL(location.href).hash.match(/\/lobby\/([^/?]+)/)?.[1] ?? '');
    if (!room) return null;
    const snapshot = room.getSnapshot();
    return {
      peerCount: snapshot.peers.length,
      hasConnectionError: snapshot.connectionError !== null,
      diagnosticKind: snapshot.diagnostic?.kind ?? null,
      startup: snapshot.startup?.phase ?? null,
      lobbyStatus: snapshot.lobby?.status ?? null,
      humanCount: snapshot.lobby?.seats.filter((seat) => seat.kind === 'human').length ?? 0,
      manual: {
        phase: snapshot.manual.phase,
        gatheringComplete: snapshot.manual.gatheringComplete,
        hasCode: snapshot.manual.code !== null,
      },
      closed: snapshot.closed,
    };
  }, path);
}

async function getManualInvitation(page: Page, peer?: string): Promise<string> {
  const path = await roomModulePath(page);
  const result = await page.evaluate(
    async ({ modulePath, target }) => {
      // oxlint-disable typescript/no-unsafe-type-assertion -- This is the running room registry, used only to drive the genuine public room method.
      const { getOnlineRoom } = (await import(
        /* @vite-ignore */ modulePath
      )) as typeof import('../src/features/online/room-registry.js');
      // oxlint-enable typescript/no-unsafe-type-assertion
      const roomId = new URL(location.href).hash.match(/\/lobby\/([^/?]+)/)?.[1];
      const room = roomId ? getOnlineRoom(roomId) : null;
      if (!room) throw new Error('The host lobby is not open');
      const start = room.startManualInvitation;
      if (!start) throw new Error('Manual invitation is unavailable');
      const created = await start(target ?? undefined);
      if (!created.ok) throw new Error(`Manual offer failed: ${created.error.code}`);
      return created.value;
    },
    { modulePath: path, target: peer ?? null },
  );
  const final = await manualOfferState(page);
  if (
    !final ||
    !final.code ||
    final.code !== result.code ||
    typeof final.gatheringComplete !== 'boolean'
  )
    throw new Error('Manual room snapshot did not retain the gathered offer');
  return final.code;
}

async function manualOfferState(page: Page) {
  const path = await roomModulePath(page);
  return page.evaluate(async (modulePath) => {
    // oxlint-disable typescript/no-unsafe-type-assertion -- Read public bootstrap progress from the current room only.
    const { getOnlineRoom } = (await import(
      /* @vite-ignore */ modulePath
    )) as typeof import('../src/features/online/room-registry.js');
    // oxlint-enable typescript/no-unsafe-type-assertion
    const roomId = new URL(location.href).hash.match(/\/lobby\/([^/?]+)/)?.[1];
    const room = roomId ? getOnlineRoom(roomId) : null;
    return room?.getSnapshot().manual ?? null;
  }, path);
}

async function acceptManualAnswer(inviter: Page, code: string): Promise<void> {
  const path = await roomModulePath(inviter);
  const result = await inviter.evaluate(
    async ({ modulePath, answer }) => {
      // oxlint-disable typescript/no-unsafe-type-assertion -- Call the app's public manual-answer API on its active room.
      const { getOnlineRoom } = (await import(
        /* @vite-ignore */ modulePath
      )) as typeof import('../src/features/online/room-registry.js');
      // oxlint-enable typescript/no-unsafe-type-assertion
      const roomId = new URL(location.href).hash.match(/\/lobby\/([^/?]+)/)?.[1];
      const room = roomId ? getOnlineRoom(roomId) : null;
      if (!room) throw new Error('The inviter lobby is not open');
      const accept = room.acceptManualAnswer;
      if (!accept) throw new Error('Manual answer is unavailable');
      const accepted = await accept(answer);
      return accepted.ok ? null : accepted.error.code;
    },
    { modulePath: path, answer: code },
  );
  if (result) throw new Error(`Manual answer rejected: ${result}`);
}

async function startFourPlayerRoom(pages: readonly Page[], mode: 'signaling' | 'manual') {
  const [host, ...guests] = pages;
  if (!host || guests.length !== 3) throw new Error('Expected four isolated browser pages');
  const gameName = mode === 'signaling' ? 'Mixed signaling acceptance' : 'Mixed manual acceptance';
  await host.goto('/#/online/create');
  await host.getByLabel('Room name', { exact: true }).fill(gameName);
  await host.getByLabel('Your player name', { exact: true }).fill('Player 1');
  await host.getByText('Advanced connection options', { exact: true }).click();
  await host.getByLabel('Player count', { exact: true }).selectOption('4');
  await host.getByLabel('Victory points to win', { exact: true }).fill('3');
  await host
    .getByLabel('Invite friends with', { exact: true })
    .selectOption(mode === 'signaling' ? 'server' : 'manual');
  if (mode === 'signaling')
    await host.getByLabel('Custom room server', { exact: true }).fill(signalingUrl);
  await host.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect(host.getByRole('heading', { name: gameName })).toBeVisible();

  if (mode === 'signaling') {
    const invite = await host.getByRole('textbox', { name: /^Invitation link/ }).inputValue();
    for (const guest of guests) {
      await guest.goto(invite);
      await expect(guest.getByRole('heading', { name: gameName })).toBeVisible({ timeout: 45_000 });
      await guest.getByRole('button', { name: 'Take seat', exact: true }).first().click();
    }
  } else {
    for (const guest of guests) {
      const invite = await getManualInvitation(host);
      await guest.goto('/#/join');
      await guest.getByLabel('Invitation link or code', { exact: true }).fill(invite);
      await guest.getByRole('button', { name: 'Join room', exact: true }).click();
      await expect(guest).toHaveURL(/\/lobby\/[^/]+$/, { timeout: 45_000 });
      await expect
        .poll(async () => {
          const state = await manualOfferState(guest);
          return typeof state?.code === 'string' && typeof state.gatheringComplete === 'boolean';
        })
        .toBe(true);
      const answer = (await manualOfferState(guest))?.code;
      if (!answer) throw new Error('A joined guest did not produce its manual answer');
      await acceptManualAnswer(host, answer);
      await expect(guest.getByRole('heading', { name: gameName })).toBeVisible({ timeout: 45_000 });
      await guest.getByRole('button', { name: 'Take seat', exact: true }).first().click();
      await expect.poll(async () => (await readRoom(host))?.humanCount).toBeGreaterThan(1);
    }
  }

  await expect
    .poll(async () => Promise.all(pages.map(async (page) => (await readRoom(page))?.peerCount)))
    .toEqual([3, 3, 3, 3]);
  await Promise.all(pages.map((page) => page.getByRole('button', { name: 'Ready up' }).click()));
  await expect(host.getByRole('button', { name: 'Start game', exact: true })).toBeEnabled({
    timeout: 45_000,
  });
  await host.getByRole('button', { name: 'Start game', exact: true }).click();
  await Promise.all(
    pages.map((page) => expect(page).toHaveURL(/\/game\/[^/]+$/, { timeout: 90_000 })),
  );
  const gameId = new URL(host.url()).hash.match(/\/game\/([^/?]+)/)?.[1];
  if (!gameId) throw new Error('Game URL did not include an id');
  return { gameId, gameName };
}

async function inspectGame(page: Page, gameId: string) {
  const modulePath = await roomModulePath(page);
  return page.evaluate(
    async ({ path, id }) => {
      // oxlint-disable typescript/no-unsafe-type-assertion -- Read the session from the app-loaded production registry.
      const { getOnlineGameRoom } = (await import(
        /* @vite-ignore */ path
      )) as typeof import('../src/features/online/room-registry.js');
      // oxlint-enable typescript/no-unsafe-type-assertion
      const room = getOnlineGameRoom(id);
      const session = room?.getGame()?.session;
      if (!room || !session) return null;
      const seat = session.controllableSeats()[0];
      const pending =
        seat === undefined
          ? undefined
          : session.getPending().find((item) => item.kind === 'player' && item.seat === seat);
      const legal = seat === undefined ? undefined : session.getLegalCommands(seat);
      return {
        head: session.getFairness?.()?.head ?? null,
        phase: session.getState().turn.phase.at(-1)?.id ?? null,
        result: session.getState().result ?? null,
        seat,
        pending,
        state: session.getState(),
        privateState: seat === undefined ? null : session.getPrivate(seat),
        legal,
        audit: session.getAudit?.() ?? null,
        peerCount: room.getSnapshot().peers.length,
      };
    },
    { path: modulePath, id: gameId },
  );
}

async function submit(page: Page, gameId: string, seat: Seat, command: CommandShape, seq: number) {
  const modulePath = await roomModulePath(page);
  return page.evaluate(
    async ({ path, id, actingSeat, action, revision }) => {
      // oxlint-disable typescript/no-unsafe-type-assertion -- Submit a legal action through the actual online session.
      const { getOnlineGameRoom } = (await import(
        /* @vite-ignore */ path
      )) as typeof import('../src/features/online/room-registry.js');
      // oxlint-enable typescript/no-unsafe-type-assertion
      const session = getOnlineGameRoom(id)?.getGame()?.session;
      if (!session) throw new Error('The online session is unavailable');
      const result = await session.submit(actingSeat, action, { expectedRevision: revision });
      return result.ok ? null : result.error.code;
    },
    { path: modulePath, id: gameId, actingSeat: seat, action: command, revision: seq },
  );
}

async function certifyPostSetupMove(pages: readonly Page[], gameId: string): Promise<void> {
  const ready = async () => Promise.all(pages.map((page) => inspectGame(page, gameId)));
  const setupBots = pages.map((_, index) => ({
    bot: new RandomBot(),
    rng: createBotRng(new Uint8Array(32).fill(index + 101)),
  }));
  await expect
    .poll(
      async () => {
        const views = await ready();
        if (views.every((item) => item?.phase === 'main')) return true;
        const index = views.findIndex(
          (item) => item?.phase === 'setup' && item.pending?.kind === 'player' && item.legal,
        );
        if (index < 0) return false;
        const view = views[index];
        const actor = setupBots[index];
        const page = pages[index];
        if (
          view?.seat === undefined ||
          !view.pending ||
          !view.privateState ||
          !view.legal ||
          !view.head ||
          !actor ||
          !page
        )
          return false;
        const command = actor.bot.decide(
          { state: view.state, priv: view.privateState, seat: view.seat },
          view.pending,
          actor.rng,
        );
        const refused = await submit(page, gameId, view.seat, command, view.head.seq);
        if (refused && refused !== 'stale-head' && refused !== 'stale-revision')
          throw new Error(`A legal setup placement was rejected: ${refused}`);
        return false;
      },
      {
        timeout: 120_000,
        intervals: [100],
      },
    )
    .toBe(true);
  const views = await ready();
  const before = views[0]?.head;
  if (!before) throw new Error('No certified head after setup');
  let accepted = false;
  for (const [index, view] of views.entries()) {
    if (!view?.pending || view.seat === undefined || !view.legal) continue;
    const command = view.legal.commands.find((item) => item.type !== 'END_TURN');
    if (!command) continue;
    const page = pages[index];
    if (!page) throw new Error('Post-setup actor page disappeared');
    const refused = await submit(page, gameId, view.seat, command, before.seq);
    if (refused) throw new Error(`Post-setup move rejected: ${refused}`);
    accepted = true;
    break;
  }
  if (!accepted) throw new Error('No non-END_TURN main-phase move was available');
  await expect
    .poll(
      async () => {
        const heads = (await ready()).map((item) => item?.head);
        const seq = heads[0]?.seq;
        return seq !== undefined && seq > before.seq && heads.every((head) => head?.seq === seq);
      },
      { timeout: 45_000 },
    )
    .toBe(true);
  const after = await ready();
  const afterHead = after[0]?.head;
  if (!afterHead || afterHead.seq <= before.seq)
    throw new Error('Post-setup action did not advance the head');
  expect(after.map((item) => item?.head)).toEqual([afterHead, afterHead, afterHead, afterHead]);
}

async function finishAndAudit(pages: readonly Page[], gameId: string) {
  const bots = pages.map((_, index) => ({
    bot: new RandomBot(),
    rng: createBotRng(new Uint8Array(32).fill(index + 31)),
  }));
  let commands = 0;
  await expect
    .poll(
      async () => {
        for (const [index, page] of pages.entries()) {
          const view = await inspectGame(page, gameId);
          if (
            !view ||
            view.result ||
            view.seat === undefined ||
            view.pending?.kind !== 'player' ||
            !view.privateState ||
            !view.legal ||
            !view.head
          )
            continue;
          const actor = bots[index];
          if (!actor) throw new Error('Missing deterministic browser bot');
          const command = actor.bot.decide(
            { state: view.state, priv: view.privateState, seat: view.seat },
            view.pending,
            actor.rng,
          );
          const refused = await submit(page, gameId, view.seat, command, view.head.seq);
          if (refused && refused !== 'stale-head' && refused !== 'stale-revision')
            throw new Error(`A legal browser move was rejected: ${refused}`);
          if (!refused) commands += 1;
          if (commands > 300) throw new Error('The bounded mixed-engine game exceeded 300 moves');
        }
        const views = await Promise.all(pages.map((page) => inspectGame(page, gameId)));
        return views.every((view) => view?.result && view.audit?.kind === 'complete');
      },
      { timeout: 150_000, intervals: [100] },
    )
    .toBe(true);
  const final = await Promise.all(pages.map((page) => inspectGame(page, gameId)));
  const head = final[0]?.head;
  const result = final[0]?.result;
  if (!head || !result) throw new Error('Missing audited terminal state');
  for (const view of final) {
    expect(view?.head).toEqual(head);
    expect(view?.result).toEqual(result);
    expect(view?.audit).toMatchObject({ kind: 'complete', report: { ok: true, complete: true } });
    expect(view?.peerCount).toBe(3);
  }
  return { commands, terminalSeq: head.seq, modeAuditCount: final.length };
}

async function runMode(playwright: Playwright, mode: 'signaling' | 'manual') {
  const opened = await launchFourEngines(playwright);
  const [host, second, third, fourth] = opened.pages;
  if (!host || !second || !third || !fourth) throw new Error('Missing mixed-engine page');
  const errors: EngineName[] = [];
  for (const [index, page] of opened.pages.entries()) {
    const engine = engineNames[index];
    if (!engine) throw new Error('Missing browser engine label');
    page.on('pageerror', () => errors.push(engine));
  }
  try {
    const fixture = await startFourPlayerRoom(opened.pages, mode);
    await certifyPostSetupMove(opened.pages, fixture.gameId);
    const completion = await finishAndAudit(opened.pages, fixture.gameId);
    expect(errors).toEqual([]);
    return { mode, browserSet: engineNames, ...completion };
  } catch (error) {
    const diagnostics = await Promise.all(
      opened.pages.map(async (page, index) => ({
        engine: engineNames[index],
        ...(await readRoom(page).catch(() => null)),
      })),
    );
    throw new Error(
      `Mixed-engine ${mode} acceptance failed. Sanitized peer/lobby diagnostics: ${JSON.stringify(diagnostics)}`,
      { cause: error },
    );
  } finally {
    await Promise.allSettled(opened.contexts.map((context) => context.close()));
    await Promise.allSettled(opened.browsers.map((browser) => browser.close()));
  }
}

test('four mixed-engine contexts finish a signaling full-mesh game with matching audits', async ({
  playwright,
}, testInfo) => {
  test.skip(
    process.env.CP2P_MIXED_ENGINE_MODE !== 'signaling',
    'The workflow runs one connection mode per job',
  );
  test.setTimeout(240_000);
  const result = await runMode(playwright, 'signaling');
  await testInfo.attach('mixed-engine-summary', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
});

test('four mixed-engine contexts finish a manual-relay full-mesh game with matching audits', async ({
  playwright,
}, testInfo) => {
  test.skip(
    process.env.CP2P_MIXED_ENGINE_MODE !== 'manual-relay',
    'The workflow runs one connection mode per job',
  );
  test.setTimeout(300_000);
  const result = await runMode(playwright, 'manual');
  await testInfo.attach('mixed-engine-summary', {
    body: JSON.stringify(result, null, 2),
    contentType: 'application/json',
  });
});
