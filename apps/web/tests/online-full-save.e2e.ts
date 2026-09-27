import { expect, test } from '@playwright/test';
import { canonicalEncode } from '@cp2p/codec';
import { createConsensusState, validateGenesisOnlineStart } from '@cp2p/protocol';
import { advanceRecoveryFixture, createRecoveryFixture } from '@cp2p/protocol/testing';
import type { Result } from '@cp2p/engine';
import { fileURLToPath } from 'node:url';
import { stat } from 'node:fs/promises';

test.use({ channel: 'chrome' });
test.skip(process.env.CP2P_ONLINE_FULL_SAVE_E2E !== '1', 'Bounded native Chrome full-save check');
test.skip(
  ({ browserName }) => browserName !== 'chromium',
  'Full-save browser check runs only in Chrome',
);

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

test('default full save imports, persists, and opens only as a paused read-only view', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const fixture = createRecoveryFixture({ seed: 75, offlineSeat: null, lobbyId: 'fullsavtst' });
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
  // Seed disposable, signed public history and safety; no real device identity or private export.
  const storagePath = `/@fs${fileURLToPath(new URL('../../../packages/storage/src/index.ts', import.meta.url))}`;
  await page.evaluate(
    async ({
      start: savedStart,
      initialSafety: firstSafety,
      entries: certifiedEntries,
      storagePath: modulePath,
    }) => {
      // oxlint-disable typescript/no-unsafe-type-assertion -- These are the known local Vite modules used by this opt-in browser test.
      const { IndexedDbByteStore, IndexedDbProtocolJournal } = (await import(
        /* @vite-ignore */ modulePath
      )) as typeof import('@cp2p/storage');
      const recordsPath = '/src/session/online-game-records.ts';
      const { saveOnlineGameRecord } = (await import(
        /* @vite-ignore */ recordsPath
      )) as typeof import('../src/session/online-game-records.js');
      // oxlint-enable typescript/no-unsafe-type-assertion
      const store = new IndexedDbByteStore();
      const journal = new IndexedDbProtocolJournal(savedStart.result.genesis.gameId);
      try {
        await saveOnlineGameRecord(store, savedStart);
        if (!(await journal.initialize(savedStart.result.entry, new Uint8Array(firstSafety))))
          throw new Error('Fixture journal was not new');
        for (const entry of certifiedEntries) {
          // oxlint-disable-next-line no-await-in-loop -- Preserve certified parent order.
          const committed = await journal.commit(
            entry.certified.entry.seq,
            0,
            entry.certified,
            new Uint8Array(entry.safety),
          );
          if (!committed) throw new Error('Fixture journal failed to commit');
        }
      } finally {
        await journal.close();
        await store.close();
      }
    },
    { start, initialSafety, entries, storagePath },
  );

  await page.reload();
  const savedGame = page.locator('.online-history-item');
  await expect(savedGame).toHaveCount(1);
  await savedGame.getByRole('button', { name: 'Export full save', exact: true }).click();
  const exportDialog = page.getByRole('dialog');
  await expect(exportDialog).toBeVisible();
  await expect(exportDialog.getByRole('checkbox')).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('public-export-dialog.png') });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    exportDialog.getByRole('button', { name: 'Export full save', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.hxfs$/);
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error('Full-save download was not retained');
  expect((await stat(downloadPath)).size).toBeGreaterThan(0);

  await page.getByLabel('Choose full-save file').setInputFiles(downloadPath);
  await expect(page).toHaveURL(/#\/full-save\/[a-f0-9]{64}$/);
  await expect(page.getByRole('heading', { name: 'Imported game snapshot' })).toBeVisible();
  await expect(page.getByText('Paused, read-only snapshot')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Replay board' })).toBeVisible();
  const snapshot = page.getByRole('main');
  await expect(snapshot.getByRole('button')).toHaveCount(0);
  await expect(snapshot.getByRole('link')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Back to home' })).toBeVisible();
  await expect(page.getByText('Roll dice', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Build', { exact: true })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Imported game snapshot' })).toBeVisible();
  await expect(snapshot.getByRole('button')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  const board = page.locator('.public-replay-board canvas');
  await expect(board).toBeVisible();
  const bounds = await board.boundingBox();
  expect(bounds?.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(snapshot.getByRole('button')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('imported-save-mobile.png'), fullPage: true });
  expect(errors).toEqual([]);
});
