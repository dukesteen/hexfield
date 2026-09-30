/* eslint-disable no-await-in-loop -- Each device plays its steal after the previous one. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameState, Seat } from '@cp2p/engine';
import { buildBoardGraph, type HexId } from '@cp2p/engine/geometry';
import type { DevHook } from '../src/features/devtools/hook.js';
import { openBeforeRoll } from './helpers/roll-fixture.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const shots = process.env.CP2P_STEAL_SHOTS ?? join(repoRoot, 'reports/steal-sheet');

interface FlightRecord {
  card: string | null;
  reveal: boolean;
  x: number;
  y: number;
  dx: number;
  dy: number;
  slot: { x: number; y: number } | null;
  shown: string | null;
}

/** Record every card flight as it appears, with the slot it aims for and the count it shows. */
async function recordFlights(page: Page) {
  await page.addInitScript(() => {
    const records: unknown[] = [];
    Reflect.set(window, '__flights', records);
    const seen = new WeakSet<Element>();
    // This callback is serialized into the browser, where its DOM globals exist.
    // eslint-disable-next-line unicorn/consistent-function-scoping
    const center = (element: Element | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    };
    const observe = () => {
      for (const node of document.querySelectorAll<HTMLElement>('.trade-card-flight')) {
        if (seen.has(node)) continue;
        seen.add(node);
        const card = node.dataset.card ?? null;
        const slot = card ? document.querySelector(`.hand-dock [data-resource="${card}"]`) : null;
        records.push({
          card,
          reveal: node.classList.contains('steal-reveal-flight'),
          x: Number.parseFloat(node.style.left),
          y: Number.parseFloat(node.style.top),
          dx: Number.parseFloat(node.style.getPropertyValue('--flight-dx')),
          dy: Number.parseFloat(node.style.getPropertyValue('--flight-dy')),
          slot: center(slot?.querySelector('img') ?? null),
          shown: slot?.querySelector('.resource-card-count')?.textContent ?? null,
        });
      }
    };
    const start = () => {
      new MutationObserver(observe).observe(document.body, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  });
}

async function flights(page: Page): Promise<FlightRecord[]> {
  const json = await page.evaluate(() => JSON.stringify(Reflect.get(window, '__flights') ?? []));
  return JSON.parse(json);
}

function hand(page: Page, seat: Seat): Promise<Record<string, number>> {
  return page.evaluate((human) => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    return { ...hook?.session.getPrivate(human)?.hand };
  }, seat);
}

/** A robber hex next to exactly one opponent with cards: the sheet then opens at once. */
async function robberHex(page: Page, human: Seat): Promise<{ hex: HexId; victim: Seat }> {
  let hexes: string[] = [];
  await expect
    .poll(async () => {
      hexes = await page.evaluate(() => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.diagnostics().actions?.placements.robber.map((item) => item.id) ?? [];
      });
      return hexes.length;
    })
    .toBeGreaterThan(0);
  const state: GameState = JSON.parse(
    await page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      return JSON.stringify(hook?.session.getState());
    }),
  );
  const graph = buildBoardGraph(state.board.hexes);
  for (const hex of hexes) {
    const index = graph.hexIndex[hex];
    const vertices = new Set<string>(index === undefined ? [] : (graph.hexVertices[index] ?? []));
    const victims = [
      ...new Set(
        state.board.buildings
          .filter((building) => building.seat !== human && vertices.has(building.vertex))
          .map((building) => building.seat),
      ),
    ].filter((seat) => (state.seats.find((item) => item.seat === seat)?.resources.total ?? 0) > 0);
    const [victim] = victims;
    const id = graph.hexIds.find((candidate) => candidate === hex);
    if (victims.length === 1 && victim !== undefined && id) return { hex: id, victim };
  }
  throw new Error('No robber hex borders exactly one opponent with cards');
}

async function rollSevenAndRob(page: Page, human: Seat, mobile: boolean) {
  await page.getByLabel('Open game menu').click();
  const drawer = page.getByTestId('dev-drawer');
  await drawer.locator('summary').first().click();
  await drawer.getByLabel('First die').selectOption('3');
  await drawer.getByLabel('Second die').selectOption('4');
  await drawer.getByRole('button', { name: 'Force next dice' }).click();
  await page.getByLabel('Open game menu').click();
  await page.getByRole('button', { name: 'Roll dice' }).click();
  const target = await robberHex(page, human);
  const point = await page.evaluate((id) => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    return hook?.pixelPosition({ kind: 'hex', id }) ?? null;
  }, target.hex);
  if (!point) throw new Error('The robber hex has no screen position');
  // The dice settle and the board takes the robber mode before a tap lands.
  await expect
    .poll(() =>
      page.evaluate(({ x, y }) => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.renderer?.hitTest({ x, y })?.id ?? null;
      }, point),
    )
    .toBe(target.hex);
  if (mobile) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
  return target;
}

async function setPickCard(page: Page, on: boolean) {
  await page.goto('/#/settings');
  const box = page.getByLabel('Pick the card to steal');
  await expect(box).toBeChecked();
  if (!on) await box.uncheck();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
}

test('the thief picks a face-down card, it turns over, then flies into its hand slot', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The steal sheet is checked in Chromium');
  test.setTimeout(120_000);
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
      await recordFlights(page);
      const { human, hand: start } = await openBeforeRoll(page, `steal-sheet-${device.name}`, {
        botDelayMs: 400,
      });
      expect(Object.values(start).reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(7);
      const { victim } = await rollSevenAndRob(page, human, device.mobile);
      const victimCards = await page.evaluate((seat) => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.session.getState().seats.find((item) => item.seat === seat)?.resources.total;
      }, victim);

      const sheet = page.getByRole('dialog', { name: 'Steal a card' });
      await expect(sheet).toBeVisible();
      const backs = sheet.getByRole('button', { name: /face down$/ });
      await expect(backs).toHaveCount(Math.min(victimCards ?? 0, 12));
      await expect(backs.first()).toHaveAttribute(
        'aria-label',
        `Card 1 of ${Math.min(victimCards ?? 0, 12)}, face down`,
      );
      await writeFile(join(shots, `${device.name}-1-sheet.png`), await page.screenshot());

      const before = await hand(page, human);
      const pick = Math.min(2, (victimCards ?? 1) - 1);
      if (device.mobile) await backs.nth(pick).tap();
      else {
        // Keyboard: into the fan, across with the arrows, and Enter to pick.
        await backs.first().focus();
        for (let step = 0; step < pick; step++) await page.keyboard.press('ArrowRight');
        await expect(backs.nth(pick)).toBeFocused();
        await page.keyboard.press('Enter');
      }
      const turned = sheet.locator(`.steal-card.is-turned[data-index="${pick}"]`);
      await expect(turned).toHaveCount(1);
      await page.waitForTimeout(450);
      await writeFile(join(shots, `${device.name}-2-flipped.png`), await page.screenshot());
      const after = await hand(page, human);
      const moved = Object.keys(after).filter((kind) => after[kind] !== before[kind]);
      expect(moved).toHaveLength(1);
      const stolen = moved[0] ?? '';
      expect((after[stolen] ?? 0) - (before[stolen] ?? 0)).toBe(1);
      // The tapped back shows the fair draw's kind, and says so.
      await expect(turned.locator('.steal-card-face')).toHaveCount(1);
      await expect(sheet.getByRole('status')).toHaveText(new RegExp(`^You stole 1 \\w+ from `));
      // Until it lands, the slot still shows the old count.
      const slotCount = page.locator(`.hand-dock [data-resource="${stolen}"] .resource-card-count`);
      await expect(slotCount).toHaveText(String(before[stolen] ?? 0));

      // The sheet closes and the face flies from where it turned to its slot.
      await expect(page.locator('.trade-card-flight')).toHaveCount(1);
      await expect(sheet).toBeHidden();
      await writeFile(
        join(shots, `${device.name}-3-flight.png`),
        await page.screenshot({ animations: 'allow' }),
      );
      const [flight] = await flights(page);
      if (!flight) throw new Error('No steal flight was recorded');
      expect(flight.card).toBe(stolen);
      expect(flight.reveal).toBe(false);
      expect(flight.shown).toBe(String(before[stolen] ?? 0));
      if (!flight.slot) throw new Error('The stolen kind has no hand slot');
      expect(
        Math.hypot(flight.x + flight.dx - flight.slot.x, flight.y + flight.dy - flight.slot.y),
      ).toBeLessThan(30);
      await expect(page.locator('.trade-card-flight')).toHaveCount(0, { timeout: 5_000 });
      await expect(slotCount).toHaveText(String(after[stolen]));
      await writeFile(join(shots, `${device.name}-4-landed.png`), await page.screenshot());
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

test('with the setting off the steal is made at once and turns over in flight', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The steal sheet is checked in Chromium');
  test.setTimeout(60_000);
  await mkdir(shots, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await recordFlights(page);
  await setPickCard(page, false);
  const { human } = await openBeforeRoll(page, 'steal-sheet-auto', { botDelayMs: 400 });
  const { victim } = await rollSevenAndRob(page, human, false);
  const dialog = page.getByRole('dialog', { name: 'Steal a card' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /face down$/ })).toHaveCount(0);
  const before = await hand(page, human);
  await dialog.getByRole('button', { name: new RegExp(`^Player ${victim + 1} — `) }).click();
  await expect(page.locator('.steal-reveal-flight')).toHaveCount(1);
  await page.waitForTimeout(350);
  await writeFile(
    join(shots, 'desktop-auto-flip-in-flight.png'),
    await page.screenshot({ animations: 'allow' }),
  );
  const after = await hand(page, human);
  const stolen = Object.keys(after).find((kind) => after[kind] !== before[kind]) ?? '';
  const [flight] = await flights(page);
  expect(flight?.card).toBe(stolen);
  expect(flight?.reveal).toBe(true);
  await expect(page.locator('.steal-reveal-flight')).toHaveCount(0, { timeout: 5_000 });
  await expect(
    page.locator(`.hand-dock [data-resource="${stolen}"] .resource-card-count`),
  ).toHaveText(String(after[stolen]));
  await expect(page.locator('.steal-announcer')).toHaveText(
    new RegExp(`^You stole 1 \\w+ from Player ${victim + 1}$`),
  );
  expect(errors).toEqual([]);
});
