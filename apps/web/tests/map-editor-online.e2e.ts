import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { encodeMap, mapFromScenario, scenarioById, validateMap } from '@cp2p/maps';

test.use({ actionTimeout: 15_000 });
test.skip(process.env.CP2P_MAP_EDITOR_ONLINE_E2E !== '1', 'Requires local signaling on port 8911');
test.skip(({ browserName }) => browserName !== 'chromium', 'Two Chromium contexts');

const SIGNALING_URL = 'ws://127.0.0.1:8911';
const SHOTS = process.env.CP2P_SCREENSHOT_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** The classic island with its south-east corner bitten off: a shape no scenario has. */
async function customMapString(): Promise<string> {
  const scenario = scenarioById('standard-fixed');
  const classic = scenario && mapFromScenario(scenario, 'Bitten island');
  if (!classic) throw new Error('missing classic island');
  const map = {
    ...classic,
    seats: { min: 2, max: 4 },
    hexes: classic.hexes.filter((hex) => !(hex.q === 0 && hex.r === 2)),
    harbors: classic.harbors.filter((harbor) => harbor.edge !== 'e:0,3,NW'),
  };
  expect(validateMap(map, { engine: true }).errors).toEqual([]);
  return encodeMap(map);
}

test('a lobby on a custom map: the guest joins and both peers start on the same board', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const text = await customMapString();
  const hostContext = await browser.newContext({ viewport: { width: 1365, height: 900 } });
  const guestContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const errors: string[] = [];
  for (const page of [host, guest]) page.on('pageerror', (error) => errors.push(error.message));
  try {
    await host.goto('/#/online/create');
    await host.getByLabel('Room name').fill('Custom map');
    await host.getByLabel('Your player name').fill('Ada');
    await host.getByText('Advanced connection options', { exact: true }).click();
    await host.getByLabel('Invite friends with').selectOption('server');
    await host.getByLabel('Custom room server').fill(SIGNALING_URL);
    await host.getByLabel('Player count').selectOption('2');
    await host.locator('.scenario-picker select').selectOption('custom');
    await host.getByLabel('Or paste a map string').fill(text);
    await host.getByRole('button', { name: 'Use this map' }).click();
    await expect(host.getByText('Bitten island')).toBeVisible();
    await host.getByRole('button', { name: 'Create room' }).click();
    await expect(host.getByRole('heading', { name: 'Custom map' })).toBeVisible();
    await expect(host.locator('.scenario-picker select')).toHaveValue('custom');

    const invitation = await host.getByRole('textbox', { name: /^Invitation link/ }).inputValue();
    await guest.goto(invitation);
    await expect(guest.getByRole('heading', { name: 'Custom map' })).toBeVisible();
    await expect(guest.getByTestId('online-custom-map')).toContainText('18 hexes');
    await guest.getByRole('button', { name: 'Take seat' }).click();
    await expect(guest.getByRole('button', { name: 'Ready up' })).toBeVisible({ timeout: 15_000 });
    await host.getByRole('button', { name: 'Ready up' }).click();
    await guest.getByRole('button', { name: 'Ready up' }).click();
    await expect(host.getByRole('button', { name: 'Start game' })).toBeEnabled();
    await host.getByRole('button', { name: 'Start game' }).click();
    await expect(host).toHaveURL(/\/game\/[^/]+$/, { timeout: 90_000 });
    await expect(guest).toHaveURL(/\/game\/[^/]+$/, { timeout: 90_000 });

    // Online games expose no dev hook; the signed genesis (tested in tools/sim custom-map.test.ts)
    // is what makes both boards equal. Here both peers load the board and start setup.
    await Promise.all(
      [host, guest].flatMap((page) => [
        expect(page.getByTestId('board-renderer').first()).toBeVisible({ timeout: 30_000 }),
        expect(page.getByText('Loading the board…')).toHaveCount(0, { timeout: 30_000 }),
      ]),
    );
    await host.waitForTimeout(2_000);
    await shot(host, 'map-editor-online-host');
    await shot(guest, 'map-editor-online-guest');
    expect(errors).toEqual([]);
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()]);
  }
});
