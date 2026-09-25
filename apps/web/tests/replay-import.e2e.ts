import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { DevHook } from '../src/features/devtools/hook.js';
import type { GamePresentation } from '../src/queries/repositories/saved-games.js';
import { saveBeforeGoldenInput } from './golden-save.js';

test('Dev tools export and import an authoritative replay without changing the current game on failure', async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  const save = await saveBeforeGoldenInput('normal-game-05.replay.json', 365);
  const id = 'replay-import-origin';
  const presentation: GamePresentation = {
    players: save.config.seats.map((seat, index) => {
      const displaySeat = ([0, 1, 2, 3] as const).find((candidate) => candidate === seat);
      if (displaySeat === undefined) throw new Error('Golden prefix has an unsupported seat');
      return {
        seat: displaySeat,
        name: ['Aster', 'Birch', 'Cedar', 'Dune'][index] ?? `Player ${seat + 1}`,
        color: (['blue', 'orange', 'green', 'magenta'] as const)[index] ?? 'blue',
        shape: (['circle', 'triangle', 'square', 'diamond'] as const)[index] ?? 'circle',
      };
    }),
    botDelayMs: 0,
  };
  const revision =
    save.genesis.length + save.batches.reduce((sum, batch) => sum + 1 + batch.generated.length, 0);
  const record = { v: 1, id, revision, updatedAt: Date.now(), presentation, save };
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: `hexfield:save:v1:${id}`,
    value: JSON.stringify(record),
  });
  await page.goto(`/#/local/${id}`);
  await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__cp2p')))).toBe(true);
  const reveal = page.getByRole('button', { name: 'Reveal hand' });
  if (await reveal.isVisible()) await reveal.click();

  const snapshot = () =>
    page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      if (!hook) return null;
      const authority: unknown = hook.session.exportSave();
      if (typeof authority !== 'object' || authority === null) return null;
      return {
        hash: hook.diagnostics().hash,
        revision: hook.diagnostics().revision,
        roles: Reflect.get(authority, 'roles') as unknown,
        privateBySeat: hook.session
          .getState()
          .config.seats.map((seat) => hook.session.getPrivate(seat)),
      };
    });
  const before = await snapshot();
  expect(before).not.toBeNull();
  const originalSession = await page.evaluateHandle(() => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    return hook?.session;
  });
  const originalUrl = page.url();
  await page.locator('.game-menu > summary').click();
  const drawer = page.getByTestId('dev-drawer');
  await drawer.locator(':scope > summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    drawer.getByRole('button', { name: 'Export replay JSON' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.replay\.json$/);
  const downloadedPath = await download.path();
  if (!downloadedPath) throw new Error('Browser did not retain the replay download');
  const replay: unknown = JSON.parse(await readFile(downloadedPath, 'utf8'));
  if (typeof replay !== 'object' || replay === null || Array.isArray(replay))
    throw new Error('Exported replay is not an object');
  expect(Reflect.get(replay, 'format')).toBe('hexfield-local-replay');
  expect(Reflect.get(replay, 'presentation')).toEqual(presentation);

  const textarea = drawer.getByRole('textbox', { name: 'Save or replay JSON' });
  const load = drawer.getByRole('button', { name: 'Load save or replay' });
  const tampered = { ...replay, finalHash: '0'.repeat(64) };
  await textarea.fill(JSON.stringify(tampered));
  await load.click();
  await expect(drawer.getByRole('status')).toContainText('Failed');
  expect(page.url()).toBe(originalUrl);
  expect(await snapshot()).toEqual(before);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('hexfield:save:v1:')),
    ),
  ).toEqual([`hexfield:save:v1:${id}`]);

  await textarea.fill(JSON.stringify(replay));
  await load.click();
  await expect(page).toHaveURL(/#\/local\/(?!replay-import-origin)[^/]+$/);
  await expect
    .poll(() =>
      page.evaluate((previousSession) => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.session !== undefined && hook.session !== previousSession;
      }, originalSession),
    )
    .toBe(true);
  if (await reveal.isVisible()) await reveal.click();
  expect(await snapshot()).toEqual(before);
  const importedId = page.url().split('/').at(-1);
  expect(importedId).toBeTruthy();
  const importedRecord = await page.evaluate(
    (nextId) => JSON.parse(localStorage.getItem(`hexfield:save:v1:${nextId}`) ?? 'null') as unknown,
    importedId,
  );
  expect(importedRecord).toMatchObject({
    id: importedId,
    presentation,
    save: { roles: save.roles, finalHash: save.finalHash },
  });
  await expect(page.getByText('Aster', { exact: true })).toBeVisible();
  expect(browserErrors).toEqual([]);
  await originalSession.dispose();
});
