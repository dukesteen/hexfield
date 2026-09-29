/* eslint-disable no-await-in-loop -- Each device runs its roll after the previous one. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameState, Seat } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import type { DevHook } from '../src/features/devtools/hook.js';
import { LocalSession } from '../src/session/local-session.js';
import { saveBeforeGoldenInput } from './golden-save.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const shots = process.env.CP2P_ANIM_SHOTS ?? join(repoRoot, 'reports/card-flights');
const colors = ['blue', 'orange', 'green', 'magenta'] as const;
const shapes = ['circle', 'triangle', 'square', 'diamond'] as const;
const terrainKind: Readonly<Record<string, string>> = {
  hills: 'brick',
  forest: 'lumber',
  pasture: 'wool',
  fields: 'grain',
  mountains: 'ore',
};

/** The roll total (not 7) that pays `seat` the most cards, with its per-kind payout. */
function bestRoll(state: GameState, seat: Seat): { total: number; gains: Record<string, number> } {
  const graph = buildBoardGraph(state.board.hexes);
  let best = { total: 0, gains: {} as Record<string, number>, count: 0 };
  for (let total = 2; total <= 12; total++) {
    if (total === 7) continue;
    const gains: Record<string, number> = {};
    let count = 0;
    for (const hex of state.board.hexes) {
      const kind = terrainKind[hex.terrain];
      if (hex.token !== total || hex.id === state.board.robberHex || !kind) continue;
      const index = graph.hexIndex[hex.id];
      const vertices = index === undefined ? [] : (graph.hexVertices[index] ?? []);
      for (const building of state.board.buildings)
        if (building.seat === seat && vertices.some((vertex) => vertex === building.vertex)) {
          const paid = building.kind === 'city' ? 2 : 1;
          gains[kind] = (gains[kind] ?? 0) + paid;
          count += paid;
        }
    }
    if (count > best.count) best = { total, gains, count };
  }
  return best;
}

async function openBeforeRoll(page: Page, id: string) {
  const verified = await saveBeforeGoldenInput('normal-completion.replay.json', 17);
  const restored = LocalSession.restore(verified, {
    entropy: { randomBytes: (target) => target.fill(1) },
  });
  if (!restored.ok) throw new Error(restored.error.message);
  const state = restored.value.getState();
  const human = state.turn.activeSeat;
  const hand = { ...restored.value.getPrivate(human)?.hand };
  restored.value.dispose();
  const save = {
    ...verified,
    roles: {
      humanSeats: [human],
      botSeats: verified.config.seats.filter((seat) => seat !== human),
    },
  };
  const record = {
    v: 1,
    id,
    revision:
      save.genesis.length +
      save.batches.reduce((sum, batch) => sum + 1 + batch.generated.length, 0),
    updatedAt: Date.now(),
    presentation: {
      players: save.config.seats.map((seat, index) => ({
        seat,
        name: `Player ${seat + 1}`,
        color: colors[index] ?? 'blue',
        shape: shapes[index] ?? 'circle',
      })),
      botDelayMs: 60_000,
    },
    save,
  };
  await page.addInitScript(
    ({ key, value }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    },
    { key: `hexfield:save:v1:${id}`, value: JSON.stringify(record) },
  );
  await page.goto(`/#/local/${id}`);
  await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__cp2p')))).toBe(true);
  await expect(page.getByRole('button', { name: 'Roll dice' })).toBeVisible();
  return { human, hand, roll: bestRoll(state, human) };
}

/** The counts the hand dock and the human's panel draw right now. */
function drawnCounts(page: Page, seat: Seat, kinds: readonly string[]) {
  return page.evaluate(
    ({ seat: panelSeat, kinds: wanted }) => {
      const slots: Record<string, number> = {};
      for (const kind of wanted) {
        const text = document.querySelector(
          `.hand-dock [data-resource="${kind}"] .resource-card-count`,
        )?.textContent;
        slots[kind] = Number(text);
      }
      const total = document.querySelector('.hand-dock .hand-total')?.textContent ?? '';
      const panel = document.querySelector(
        `[data-seat-panel="${panelSeat}"] .player-panel-stats dd`,
      );
      return {
        slots,
        total: Number.parseInt(total, 10),
        panel: panel ? Number(panel.textContent) : null,
      };
    },
    { seat, kinds },
  );
}

test('hand counts wait for produced cards to land, then settle on the state', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Card flight timing is checked in Chromium');
  test.setTimeout(60_000);
  await mkdir(shots, { recursive: true });
  for (const device of [
    { name: 'desktop', mobile: false, width: 1280, height: 720 },
    { name: 'phone', mobile: true, width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({
      viewport: { width: device.width, height: device.height },
      isMobile: device.mobile,
      hasTouch: device.mobile,
    });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const { human, hand, roll } = await openBeforeRoll(page, `card-counts-${device.name}`);
      const kinds = Object.keys(roll.gains);
      expect(kinds.length, 'the fixture has a paying roll for the human').toBeGreaterThan(0);
      const handTotal = Object.values(hand).reduce((sum, count) => sum + count, 0);
      const gained = Object.values(roll.gains).reduce((sum, count) => sum + count, 0);

      const first = Math.min(6, roll.total - 1);
      await page.getByLabel('Open game menu').click();
      const drawer = page.getByTestId('dev-drawer');
      await drawer.locator('summary').first().click();
      await drawer.getByLabel('First die').selectOption(String(first));
      await drawer.getByLabel('Second die').selectOption(String(roll.total - first));
      await drawer.getByRole('button', { name: 'Force next dice' }).click();
      await page.getByLabel('Open game menu').click();
      await page.getByRole('button', { name: 'Roll dice' }).click();

      // The state already holds the new cards while the dice tumble...
      await expect
        .poll(() =>
          page.evaluate((seat) => {
            const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
            const now = hook?.session.getPrivate(seat)?.hand;
            return now ? Object.values(now).reduce((sum, count) => sum + count, 0) : 0;
          }, human),
        )
        .toBe(handTotal + gained);
      // ...but the hand shows the old counts until a card reaches its slot.
      const beforeLaunch = await drawnCounts(page, human, kinds);
      for (const kind of kinds) expect(beforeLaunch.slots[kind]).toBe(hand[kind] ?? 0);
      expect(beforeLaunch.total).toBe(handTotal);
      await expect(page.locator('.resource-flight').first()).toBeVisible({ timeout: 5_000 });
      const midFlight = await drawnCounts(page, human, kinds);
      await writeFile(
        join(shots, `production-${device.name}-mid-flight.png`),
        await page.screenshot({ animations: 'allow' }),
      );
      // The first card is in the air: at least one kind still shows its old count.
      expect(kinds.some((kind) => midFlight.slots[kind] === (hand[kind] ?? 0))).toBe(true);
      expect(midFlight.total).toBeLessThan(handTotal + gained);

      await expect(page.locator('.resource-flight')).toHaveCount(0, { timeout: 10_000 });
      const landed = await drawnCounts(page, human, kinds);
      await writeFile(
        join(shots, `production-${device.name}-landed.png`),
        await page.screenshot({ animations: 'allow' }),
      );
      for (const kind of kinds)
        expect(landed.slots[kind]).toBe((hand[kind] ?? 0) + (roll.gains[kind] ?? 0));
      expect(landed.total).toBe(handTotal + gained);
      if (landed.panel !== null) expect(landed.panel).toBe(handTotal + gained);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

test('reduced motion shows produced cards in the hand at once', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Card flight timing is checked in Chromium');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { human, hand, roll } = await openBeforeRoll(page, 'card-counts-reduced');
  const kinds = Object.keys(roll.gains);
  const first = Math.min(6, roll.total - 1);
  await page.getByLabel('Open game menu').click();
  const drawer = page.getByTestId('dev-drawer');
  await drawer.locator('summary').first().click();
  await drawer.getByLabel('First die').selectOption(String(first));
  await drawer.getByLabel('Second die').selectOption(String(roll.total - first));
  await drawer.getByRole('button', { name: 'Force next dice' }).click();
  await page.getByLabel('Open game menu').click();
  await page.getByRole('button', { name: 'Roll dice' }).click();
  for (const kind of kinds)
    await expect(
      page.locator(`.hand-dock [data-resource="${kind}"] .resource-card-count`),
    ).toHaveText(String((hand[kind] ?? 0) + (roll.gains[kind] ?? 0)), { timeout: 1_000 });
  await expect(page.locator('.resource-flight')).toHaveCount(0);
  expect(human).toBeGreaterThanOrEqual(0);
});
