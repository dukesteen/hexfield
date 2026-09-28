import { expect, test } from '@playwright/test';
import { canonicalEncode } from '@cp2p/codec';
import {
  createConsensusState,
  entryHash,
  genesisDigest,
  validateGenesisOnlineStart,
} from '@cp2p/protocol';
import { advanceRecoveryFixture, createRecoveryFixture } from '@cp2p/protocol/testing';
import type { Result } from '@cp2p/engine';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

test.use({ channel: 'chrome' });
test.skip(process.env.CP2P_ONLINE_HISTORY_E2E !== '1', 'Bounded native Chrome history check');

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

test('inactive history stays readable and deletion prevents revival of its signed save', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixture = createRecoveryFixture({ seed: 74, offlineSeat: null, lobbyId: 'historytst' });
  const online = value(validateGenesisOnlineStart(fixture.genesis));
  let context = fixture.beforeSetup;
  const initialSafety = Array.from(canonicalEncode(value(createConsensusState(context, 0))));
  const entries = fixture.deckEntries.map((certified) => {
    context = advanceRecoveryFixture(context, certified);
    return {
      certified,
      safety: Array.from(canonicalEncode(value(createConsensusState(context, 0)))),
    };
  });
  const agreement = online.bindings.agreement;
  const start = {
    invite: {
      roomId: agreement.state.lobbyId,
      hostPeer: agreement.state.hostPeer,
      serverUrl: '',
    },
    agreement,
    result: {
      entry: fixture.genesisEntry,
      genesis: fixture.genesis,
      transcripts: fixture.deck.transcripts,
      bindings: online.bindings.bindings,
    },
  };
  await page.goto('/');
  // Seed a disposable signed test history, without real keys or a running session.
  const storagePath = `/@fs${fileURLToPath(new URL('../../../packages/storage/src/index.ts', import.meta.url))}`;
  await page.evaluate(
    async ({
      start: savedStart,
      initialSafety: firstSafety,
      entries: certifiedEntries,
      storagePath: storageModulePath,
      activity,
    }) => {
      // oxlint-disable typescript/no-unsafe-type-assertion -- Known local Vite modules in an isolated browser test context.
      const { IndexedDbByteStore, IndexedDbProtocolJournal } = (await import(
        /* @vite-ignore */ storageModulePath
      )) as typeof import('@cp2p/storage');
      const recordsPath = '/src/session/online-game-records.ts';
      const { saveOnlineGameRecord } = (await import(
        /* @vite-ignore */ recordsPath
      )) as typeof import('../src/session/online-game-records.js');
      const activityPath = '/src/session/online-game-activity.ts';
      const { saveOnlineGameActivity } = (await import(
        /* @vite-ignore */ activityPath
      )) as typeof import('../src/session/online-game-activity.js');
      // oxlint-enable typescript/no-unsafe-type-assertion
      const store = new IndexedDbByteStore();
      const journal = new IndexedDbProtocolJournal(savedStart.result.genesis.gameId);
      try {
        await saveOnlineGameRecord(store, savedStart);
        if (!(await journal.initialize(savedStart.result.entry, new Uint8Array(firstSafety))))
          throw new Error('Fixture journal was not new');
        for (const entry of certifiedEntries) {
          // oxlint-disable-next-line no-await-in-loop -- Preserve the certified parent order.
          const committed = await journal.commit(
            entry.certified.entry.seq,
            0,
            entry.certified,
            new Uint8Array(entry.safety),
          );
          if (!committed) throw new Error('Fixture journal failed to commit');
        }
        await saveOnlineGameActivity(store, activity);
      } finally {
        await journal.close();
        await store.close();
      }
    },
    {
      start,
      initialSafety,
      entries,
      storagePath,
      activity: {
        gameId: fixture.genesis.gameId,
        genesisDigest: genesisDigest(fixture.genesis),
        head: { seq: context.log.head.seq, hash: entryHash(context.log.head) },
        lastActivityAt: Date.now() - 31 * 24 * 60 * 60 * 1_000,
      },
    },
  );
  await page.reload();
  const saved = page.locator('.online-history-item');
  await expect(saved).toHaveCount(1);
  await expect(saved.locator('.online-history-inactive')).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    saved.getByRole('button', { name: 'Export replay', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.hxar$/);
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('Replay download was not saved');
  expect((await readFile(downloadPath)).subarray(0, 5).toString()).toBe('HXAR1');
  await saved.getByRole('button', { name: 'View replay', exact: true }).click();
  await expect(page).toHaveURL(/#\/replay\/[a-f0-9]{64}$/);
  await expect(page.getByRole('heading', { name: 'Public game replay' })).toBeVisible();
  const canvas = page.locator('.public-replay-board canvas');
  await expect(canvas).toBeVisible();
  const bounds = await canvas.boundingBox();
  expect(bounds?.height).toBeGreaterThan(300);
  expect(bounds?.width).toBeGreaterThan(300);
  await expect(page.getByRole('button', { name: 'Roll dice' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('public-replay-desktop.png') });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Public game replay' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(canvas).toBeVisible();
  const mobileCanvas = await canvas.boundingBox();
  expect(mobileCanvas?.width).toBeLessThanOrEqual(390);
  expect(mobileCanvas?.height).toBeGreaterThan(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('public-replay-mobile.png') });
  await page.getByRole('link', { name: 'Back to home' }).click();
  await saved.getByRole('button', { name: 'Remove', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('remove-save-mobile.png') });
  await dialog.getByRole('button', { name: 'Keep game' }).click();
  await expect(saved).toHaveCount(1);
  await saved.getByRole('button', { name: 'Remove', exact: true }).click();
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  // The vault gate hides history while deletion is busy. Wait for durable completion
  // before reloading; an empty transient view is not a deletion acknowledgement.
  await expect
    .poll(() =>
      page.evaluate(
        async ({ storagePath: modulePath, gameId }) => {
          // oxlint-disable typescript/no-unsafe-type-assertion -- Known local Vite modules in an isolated browser test context.
          const { readOnlineGameTombstone } = (await import(
            /* @vite-ignore */ modulePath
          )) as typeof import('@cp2p/storage');
          const controllerPath = '/src/session/online-vault-controller.ts';
          const { getOnlineVaultController } = (await import(
            /* @vite-ignore */ controllerPath
          )) as typeof import('../src/session/online-vault-controller.js');
          // oxlint-enable typescript/no-unsafe-type-assertion
          return {
            deleted: (await readOnlineGameTombstone(gameId)) !== null,
            vaultState: getOnlineVaultController().snapshot().state,
          };
        },
        { storagePath, gameId: fixture.genesis.gameId },
      ),
    )
    .toEqual({ deleted: true, vaultState: 'ready' });
  await expect(saved).toHaveCount(0);
  await page.reload();
  await expect(saved).toHaveCount(0);
  const deletion = await page.evaluate(
    async ({ start: savedStart, initialSafety: safety, storagePath: storageModulePath }) => {
      // oxlint-disable typescript/no-unsafe-type-assertion -- Known local Vite modules in an isolated browser test context.
      const { IndexedDbByteStore, IndexedDbProtocolJournal, readOnlineGameTombstone } =
        (await import(/* @vite-ignore */ storageModulePath)) as typeof import('@cp2p/storage');
      const recordsPath = '/src/session/online-game-records.ts';
      const { saveOnlineGameRecord } = (await import(
        /* @vite-ignore */ recordsPath
      )) as typeof import('../src/session/online-game-records.js');
      // oxlint-enable typescript/no-unsafe-type-assertion
      const gameId = savedStart.result.genesis.gameId;
      const store = new IndexedDbByteStore();
      const journal = new IndexedDbProtocolJournal(gameId);
      try {
        const tombstone = await readOnlineGameTombstone(gameId);
        const savedAgain = await saveOnlineGameRecord(store, savedStart).then(
          () => 'accepted',
          (error: unknown) => (error instanceof Error ? error.message : 'unknown'),
        );
        const initializedAgain = await journal
          .initialize(savedStart.result.entry, new Uint8Array(safety))
          .then(
            () => 'accepted',
            (error: unknown) => (error instanceof Error ? error.message : 'unknown'),
          );
        return { tombstone, savedAgain, initializedAgain };
      } finally {
        await journal.close();
        await store.close();
      }
    },
    { start, initialSafety, storagePath },
  );
  expect(deletion.tombstone).toMatchObject({
    gameId: fixture.genesis.gameId,
    genesisDigest: genesisDigest(fixture.genesis),
  });
  expect(deletion.savedAgain).toContain('deleted locally');
  expect(deletion.initializedAgain).toContain('deleted locally');
  await testInfo.attach('history-deletion-evidence', {
    body: JSON.stringify({
      protocolVersion: fixture.genesis.protocolVersion,
      gameId: fixture.genesis.gameId,
      lastCertifiedSequence: context.log.head.seq,
      inactivityDays: 31,
      deletion,
    }),
    contentType: 'application/json',
  });
  await page.getByRole('link', { name: /^Open public replay:/ }).click();
  await expect(page.getByRole('heading', { name: 'Public game replay' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to home' }).click();
  await page.getByLabel('Choose public replay archive').setInputFiles(downloadPath);
  await expect(page.getByRole('heading', { name: 'Public game replay' })).toBeVisible();
  expect(errors).toEqual([]);
});
