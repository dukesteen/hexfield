import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RandomBot, createBotRng } from '@cp2p/bots';
import { canonicalDecode, hashValue, toHex } from '@cp2p/codec';
import { certifiedEntrySchema, entryHash } from '@cp2p/protocol';
import type { CommandShape, Seat } from '@cp2p/engine';
import * as v from 'valibot';

test.use({ channel: 'chrome', actionTimeout: 15_000 });
test.skip(process.env.CP2P_ONLINE_RESUME_E2E !== '1', 'Native Chrome with signaling on port 8909');
const encrypted = process.env.CP2P_ENCRYPTED_RESUME_E2E === '1';
const minimumFinishHead = process.env.CP2P_SNAPSHOT_RESUME_E2E === '1' ? 100 : 0;
const vaultPassphrase = 'disposable encrypted resume acceptance';

async function unlockSavedGame(page: Page): Promise<void> {
  if (!encrypted) return;
  await page.getByLabel('Current passphrase', { exact: true }).fill(vaultPassphrase);
  await page.getByRole('button', { name: 'Unlock games', exact: true }).click();
  await expect(
    page.getByText('Your saved multiplayer games are locked', { exact: true }),
  ).toHaveCount(0);
}

async function enableProtection(page: Page): Promise<void> {
  await page.goto('/#/settings');
  await page.getByLabel('New passphrase', { exact: true }).fill(vaultPassphrase);
  await page.getByLabel('Repeat new passphrase', { exact: true }).fill(vaultPassphrase);
  await page.getByRole('button', { name: 'Turn on protection', exact: true }).click();
  await unlockSavedGame(page);
}

async function verifyPublicSnapshots(page: Page, gameId: string, head: number) {
  const saved = await page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('cp2p');
      request.addEventListener('success', () => resolve(request.result), { once: true });
      request.addEventListener('error', () => reject(request.error), { once: true });
    });
    try {
      const transaction = database.transaction(['entries', 'snapshots'], 'readonly');
      const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
      const read = (name: string) =>
        new Promise<number[][]>((resolve, reject) => {
          const request = transaction.objectStore(name).getAll(range);
          request.addEventListener('error', () => reject(request.error), { once: true });
          request.addEventListener(
            'success',
            () => {
              const rows: unknown = request.result;
              if (!Array.isArray(rows) || rows.some((row) => !(row instanceof Uint8Array))) {
                reject(new Error('Unexpected public journal encoding'));
                return;
              }
              resolve(rows.map((row: Uint8Array) => Array.from(row)));
            },
            { once: true },
          );
        });
      const [entries, snapshots] = await Promise.all([read('entries'), read('snapshots')]);
      return { entries, snapshots };
    } finally {
      database.close();
    }
  }, gameId);
  const entries = new Map(
    saved.entries.map((bytes) => {
      const certified = v.parse(certifiedEntrySchema, canonicalDecode(Uint8Array.from(bytes)));
      return [certified.entry.seq, certified.entry] as const;
    }),
  );
  const sequences = saved.snapshots.map((bytes) => {
    const snapshot = v.parse(
      v.object({ seq: v.number(), hash: v.string(), state: v.unknown() }),
      canonicalDecode(Uint8Array.from(bytes)),
    );
    const entry = entries.get(snapshot.seq);
    if (!entry) throw new Error('Snapshot has no durable certified entry');
    expect(snapshot.hash).toBe(entryHash(entry));
    expect(toHex(hashValue(snapshot.state))).toBe(entry.stateHash);
    return snapshot.seq;
  });
  expect(sequences).toEqual(
    Array.from({ length: Math.floor(head / 100) }, (_, index) => (index + 1) * 100).slice(-3),
  );
  return { sequences };
}

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
      const room = getOnlineGameRoom(id);
      const session = room?.getGame()?.session;
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
        devicePeer: room?.getSnapshot().self,
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

test('a second live tab cannot sign until the original game writer closes', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(process.env.CP2P_WRITER_TAB_E2E !== '1', 'Opt-in native same-game writer check');
  test.setTimeout(90_000);
  if (!baseURL) throw new Error('The writer check requires a configured app URL');
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } })),
  );
  const [hostContext, guestContext] = contexts;
  if (!hostContext || !guestContext) throw new Error('Missing writer test contexts');
  await Promise.all(
    contexts.map((context) =>
      context.addInitScript(() => performance.setResourceTimingBufferSize(5_000)),
    ),
  );
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const duplicate = await hostContext.newPage();
  const errors: string[] = [];
  for (const page of [host, guest, duplicate])
    page.on('pageerror', (error) => errors.push(error.message));
  try {
    await host.goto('/#/online/create');
    await host.getByLabel('Room name').fill('Writer contention acceptance');
    await host.getByLabel('Your player name').fill('Writer host');
    await host.getByText('Advanced connection options', { exact: true }).click();
    await host.getByLabel('Invite friends with').selectOption('server');
    await host.getByLabel('Custom room server').fill('ws://127.0.0.1:8916');
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
    const initial = await inspect(host, gameId);
    if (!initial?.head) throw new Error('Live owner has no certified head');

    await duplicate.goto(route);
    await expect(
      duplicate.getByText(
        "This game could not be restored. If it is open in another tab, return there. Otherwise, keep this browser's saved data and try again.",
        { exact: true },
      ),
    ).toBeVisible({ timeout: 20_000 });
    expect(await inspect(duplicate, gameId)).toBeNull();
    const lockNames = await duplicate.evaluate(
      async () => (await navigator.locks.query()).held?.map((lock) => lock.name) ?? [],
    );
    const gameLocks = lockNames.filter(
      (name) => name === `cp2p/game-active/${gameId.length}:${gameId}`,
    );
    expect(gameLocks).toHaveLength(1);

    // The rejected copy must leave the original signer and peer connection usable.
    const hostActs = (await inspect(host, gameId))?.legal;
    const continuedHead = await certifyMove(
      hostActs ? host : guest,
      hostActs ? guest : host,
      gameId,
    );
    expect(await inspect(duplicate, gameId)).toBeNull();
    await host.close();
    await duplicate.reload();
    await expect
      .poll(async () => (await inspect(duplicate, gameId))?.head, { timeout: 20_000 })
      .toEqual(continuedHead);
    const resumed = await inspect(duplicate, gameId);
    expect(resumed?.seats).toEqual(initial.seats);
    expect(resumed?.devicePeer).toBe(initial.devicePeer);

    // Setup gives two consecutive commands to each seat. Let the remote seat
    // finish its pair if needed, then certify a command signed by the new tab.
    for (let step = 0; step < 2; step++) {
      // oxlint-disable-next-line no-await-in-loop -- Each legal setup command determines the next actor.
      if ((await inspect(duplicate, gameId))?.legal) break;
      // oxlint-disable-next-line no-await-in-loop
      await certifyMove(guest, duplicate, gameId);
    }
    const finalHead = await certifyMove(duplicate, guest, gameId);
    expect(finalHead?.seq).toBeGreaterThan(continuedHead?.seq ?? 0);
    expect(errors).toEqual([]);
    await testInfo.attach('writer-contention', {
      body: JSON.stringify(
        {
          gameId,
          initialHead: initial.head,
          continuedHead,
          finalHead,
          competingGameLocks: gameLocks.length,
          rejectedCopyOpenedSession: false,
          resumedSeats: resumed?.seats,
          pageErrors: errors,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  } catch (error) {
    await testInfo.attach('writer-pages', {
      body: JSON.stringify(
        await Promise.all(
          [host, guest, duplicate].map(async (page) => ({
            url: page.url(),
            body: await page
              .locator('body')
              .innerText()
              .catch(() => 'Page closed'),
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

test('refresh and whole-browser restart preserve the certified game through its final audit', async ({
  playwright,
  baseURL,
}, testInfo) => {
  test.setTimeout(180_000);
  if (!baseURL) throw new Error('The native resume test requires a configured app URL');
  const profileRoot = await mkdtemp(join(tmpdir(), 'hexfield-resume-'));
  const contexts: BrowserContext[] = [];
  const launch = async (name: string) => {
    const context = await playwright.chromium.launchPersistentContext(join(profileRoot, name), {
      channel: 'chrome',
      headless: true,
      baseURL,
      viewport: { width: 1280, height: 900 },
    });
    // Settings plus the game load more resources than the browser's default timing buffer.
    await context.addInitScript(() => performance.setResourceTimingBufferSize(5_000));
    contexts.push(context);
    return context;
  };
  let [hostContext, guestContext] = await Promise.all([launch('host'), launch('guest')]);
  if (!hostContext || !guestContext) throw new Error('Missing test contexts');
  let host = await hostContext.newPage();
  let guest = await guestContext.newPage();
  const errors: string[] = [];
  const watch = (page: Page) => page.on('pageerror', (error) => errors.push(error.message));
  watch(host);
  watch(guest);
  try {
    if (encrypted) await Promise.all([enableProtection(host), enableProtection(guest)]);
    await host.goto('/#/online/create');
    await host.getByLabel('Room name').fill('Resume acceptance');
    await host.getByLabel('Your player name').fill('Resume host');
    await host.getByText('Advanced connection options', { exact: true }).click();
    await host.getByLabel('Invite friends with').selectOption('server');
    await host.getByLabel('Custom room server').fill('ws://127.0.0.1:8909');
    await host.getByLabel('Player count').selectOption('2');
    await host.getByLabel('Victory points to win').fill('3');
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
    // Refresh the higher-ID responder, which cannot send a canonical opening
    // offer itself. This exercises the survivor's lost-offer retry path.
    const hostPeer = (await inspect(host, gameId))?.devicePeer;
    const guestPeer = (await inspect(guest, gameId))?.devicePeer;
    if (!hostPeer || !guestPeer) throw new Error('Missing device peer identifiers');
    const second = hostPeer > guestPeer ? host : guest;
    const first = second === host ? guest : host;
    if (!(await inspect(second, gameId))?.legal) {
      await certifyMove(first, second, gameId);
      await certifyMove(first, second, gameId);
    }
    await certifyMove(second, first, gameId);
    const beforeRefresh = (await inspect(second, gameId))?.head;
    const refreshSeats = (await inspect(second, gameId))?.seats;
    const guestSeats = (await inspect(guest, gameId))?.seats;
    const hostSeats = (await inspect(host, gameId))?.seats;
    const refreshStart = performance.now();
    await second.reload();
    await unlockSavedGame(second);
    await expect
      .poll(async () => (await inspect(second, gameId))?.head, { timeout: 20_000, intervals: [50] })
      .toEqual(beforeRefresh);
    expect((await inspect(second, gameId))?.seats).toEqual(refreshSeats);
    const refreshToRestoredMs = performance.now() - refreshStart;
    await certifyMove(second, first, gameId);
    const refreshToPeerAcceptedMoveMs = performance.now() - refreshStart;
    const savedHead = (await inspect(host, gameId))?.head;
    if (!savedHead) throw new Error('Missing pre-close certified head');

    // Persistent-context close exits each independent browser process. Relaunch
    // from the same disk profiles, without copying or injecting browser storage.
    await Promise.all([hostContext.close(), guestContext.close()]);
    guestContext = await launch('guest');
    guest = await guestContext.newPage();
    watch(guest);
    await guest.goto(route);
    await unlockSavedGame(guest);
    await expect
      .poll(async () => (await inspect(guest, gameId))?.head, { timeout: 20_000 })
      .toEqual(savedHead);
    expect((await inspect(guest, gameId))?.seats).toEqual(guestSeats);
    hostContext = await launch('host');
    host = await hostContext.newPage();
    watch(host);
    await host.goto(route);
    await unlockSavedGame(host);
    await expect
      .poll(async () => (await inspect(host, gameId))?.head, { timeout: 20_000 })
      .toEqual(savedHead);
    expect((await inspect(host, gameId))?.seats).toEqual(hostSeats);
    const hostActs = (await inspect(host, gameId))?.legal;
    const finalHead = await certifyMove(hostActs ? host : guest, hostActs ? guest : host, gameId);
    const terminal = await finishGame([host, guest], gameId);
    expect(terminal.head?.seq).toBeGreaterThanOrEqual(minimumFinishHead);
    const snapshotChecks: { sequences: number[] }[] = [];
    const measurements = JSON.stringify(
      {
        gameId,
        encrypted,
        refreshedTransportRole: 'higher-ID responder',
        savedHead,
        finalHead,
        terminal,
        restartScope: 'two independent Chrome processes with persistent disk profiles',
        refreshToRestoredMs,
        refreshToPeerAcceptedMoveMs,
        withinThreeSecondTarget: refreshToPeerAcceptedMoveMs < 3_000,
      },
      null,
      2,
    );
    await writeFile(testInfo.outputPath('resume-measurements.json'), measurements);
    for (const page of [host, guest]) {
      // Use the player's close action, which drains pending history writes.
      // oxlint-disable-next-line no-await-in-loop -- Check each saved device independently.
      await page.getByRole('button', { name: 'View board', exact: true }).click();
      // oxlint-disable-next-line no-await-in-loop
      await page.getByLabel('Open game menu', { exact: true }).click();
      // oxlint-disable-next-line no-await-in-loop
      await page.getByRole('button', { name: 'Leave game', exact: true }).click();
      // oxlint-disable-next-line no-await-in-loop
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Save and leave', exact: true })
        .click();
      // oxlint-disable-next-line no-await-in-loop
      await expect(page).toHaveURL((url) => url.pathname === '/' && ['#/', ''].includes(url.hash));
      // oxlint-disable-next-line no-await-in-loop
      await expect(page.locator('.online-history-audit[data-audit="verified"]')).toHaveCount(1);
      // oxlint-disable-next-line no-await-in-loop
      await expect(page.locator('.online-history-stats dd').first()).toHaveText('1');
      if (!terminal.head) throw new Error('Missing completed game head');
      // oxlint-disable-next-line no-await-in-loop -- Closing each writer drains its snapshot writes.
      snapshotChecks.push(await verifyPublicSnapshots(page, gameId, terminal.head.seq));
    }
    expect(errors).toEqual([]);
    await writeFile(
      testInfo.outputPath('snapshot-measurements.json'),
      JSON.stringify(snapshotChecks, null, 2),
    );
    await testInfo.attach('resume-measurements', {
      body: measurements,
      contentType: 'application/json',
    });
  } catch (error) {
    await testInfo.attach('host-visible-state', {
      body: await host
        .locator('body')
        .innerText()
        .catch(() => 'Page closed'),
      contentType: 'text/plain',
    });
    throw error;
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    await rm(profileRoot, { recursive: true, force: true });
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
            // A dedicated cache check delays optional building until the hundredth
            // commit, so an early victory cannot skip the snapshot boundary.
            const advance =
              current.head.seq < minimumFinishHead
                ? current.legal.commands.find((item) => item.type === 'END_TURN')
                : undefined;
            command =
              advance ??
              bot.decide(
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
          if (moves > 250) throw new Error('Bounded game exceeded 250 player commands');
        }
        const all = await Promise.all(pages.map((page) => snapshots(page)));
        return all.every((item) => item.state.result && item.audit?.kind === 'complete');
      },
      { timeout: 100_000, intervals: [50] },
    )
    .toBe(true);
  const final = await Promise.all(pages.map((page) => snapshots(page)));
  expect(final[0]?.head).toEqual(final[1]?.head);
  expect(final[0]?.state.result).toEqual(final[1]?.state.result);
  for (const item of final)
    expect(item.audit).toMatchObject({ kind: 'complete', report: { ok: true, complete: true } });
  return { moves, head: final[0]?.head, result: final[0]?.state.result, audit: final[0]?.audit };
}
