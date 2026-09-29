/* eslint-disable no-await-in-loop -- Each step of the autoplay depends on the game the last one left. */
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  SEAT,
  endTurn,
  ensureCards,
  gameState,
  humanSubmit,
  knightsOf,
  legalTypes,
  rollDice,
  startKnightsGame,
  trackInView,
  untilHumanTurn,
} from './helpers/knights-play.js';
import {
  inMain,
  replace,
  snapshot,
  vertexPoint,
  withBuildings,
  withFrame,
  withHand,
  withLevels,
  withMetropolis,
  withRoadPath,
  withWalls,
} from './helpers/knights-scenes.js';

/** The pixels of the board around a vertex, to tell whether what is drawn there changed. */
async function cityPicture(page: Page, vertex: string): Promise<Buffer> {
  // The board reports page coordinates, so the clip needs no canvas offset.
  const at = await vertexPoint(page, vertex);
  if (!at) throw new Error('The board is not on screen');
  return page.screenshot({
    clip: { x: at.x - 40, y: at.y - 40, width: 80, height: 80 },
    animations: 'disabled',
  });
}

/**
 * Tap the first spot the game marks for a board choice, the way a player does, and return its id.
 * The game names the spot in its list of actions; the tap goes through the canvas, at a marked
 * spot that no board overlay covers and that the board itself resolves to that spot.
 */
async function tapMarked(page: Page, kind: 'relocate' | 'pillage'): Promise<string> {
  const found: { spot: { id: string; x: number; y: number } | null } = { spot: null };
  await expect
    .poll(async () => {
      found.spot = await page.evaluate((which) => {
        const hook = window['__cp2p'];
        const canvas = document.querySelector('.board-view-canvas canvas');
        // Playwright serializes this callback; helpers outside it are unavailable in the page.
        // eslint-disable-next-line unicorn/consistent-function-scoping
        const vertex = (
          value: string,
        ): value is `v:${number},${number},N` | `v:${number},${number},S` =>
          /^v:-?\d+,-?\d+,[NS]$/.test(value);
        for (const { id } of hook?.diagnostics().actions?.placements[which] ?? []) {
          if (!vertex(id)) continue;
          const point = hook?.pixelPosition({ kind: 'vertex', id });
          if (!point || document.elementFromPoint(point.x, point.y) !== canvas) continue;
          if (hook?.renderer?.hitTest(point)?.id === id) return { id, ...point };
        }
        return null;
      }, kind);
      return found.spot !== null;
    }, `an uncovered spot is marked for ${kind}`)
    .toBe(true);
  if (!found.spot) throw new Error(`Nothing is marked for ${kind}`);
  await page.mouse.click(found.spot.x, found.spot.y);
  return found.spot.id;
}

/** Where screenshots go: `KNIGHTS_SHOTS` when set, otherwise the test's own output folder. */
async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const folder = process.env.KNIGHTS_SHOTS ?? testInfo.outputDir;
  await mkdir(folder, { recursive: true });
  const body = await page.screenshot({ path: join(folder, `${name}.png`), animations: 'disabled' });
  await testInfo.attach(name, { body, contentType: 'image/png' });
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/** What a turn spends its cards on, best first. Every entry is a knights or base build. */
const SPEND = [
  'BUILD_CITY',
  'BUILD_IMPROVEMENT',
  'BUILD_KNIGHT',
  'ACTIVATE_KNIGHT',
  'PROMOTE_KNIGHT',
  'BUILD_CITY_WALL',
  'BUILD_SETTLEMENT',
  'BUILD_ROAD',
] as const;

interface Tally {
  rounds: number;
  knights: number;
  improvements: number;
  attacks: number;
  ended: boolean;
}

/**
 * Play the human for `rounds` rounds against the bots: force a ship face on the first rolls to
 * bring the barbarians in, spend whatever the hand allows, and keep going through every
 * interruption. Returns what the game reached.
 */
async function playRounds(page: Page, rounds: number, ships: number): Promise<Tally> {
  const tally: Tally = { rounds: 0, knights: 0, improvements: 0, attacks: 0, ended: false };
  for (let round = 0; round < rounds; round++) {
    if (!(await untilHumanTurn(page, 'roll'))) break;
    await rollDice(page, round < ships ? { dice: [2, 3], event: 'ship' } : undefined);
    if (!(await untilHumanTurn(page, 'main'))) break;
    for (let spend = 0; spend < 8; spend++) {
      const legal = await legalTypes(page);
      const type = SPEND.find((candidate) => legal.includes(candidate));
      if (!type) break;
      const outcome = await humanSubmit(page, [type]);
      if (!outcome.startsWith('ok:')) break;
    }
    tally.rounds += 1;
    // A build can open a choice of its own first, such as where a first metropolis stands.
    if (!(await untilHumanTurn(page, 'main'))) break;
    await endTurn(page);
  }
  const state = await gameState(page);
  const ext = knightsOf(state);
  tally.knights = ext.knights.filter((knight) => knight.seat === SEAT).length;
  tally.improvements = Object.values(ext.improvements[SEAT] ?? {}).reduce((a, b) => a + b, 0);
  tally.attacks = ext.lastAttack ? 1 : 0;
  tally.ended = Boolean(state.result);
  return tally;
}

/** Buy the first level of the science track when the engine allows it. */
function submitScience(page: Page): Promise<string> {
  return page.evaluate(async (seat) => {
    const session = window['__cp2p']?.session;
    if (!session) throw new Error('No dev hook');
    const command = session
      .getLegalCommands(seat)
      .commands.find((item) => item.type === 'BUILD_IMPROVEMENT' && item['track'] === 'science');
    if (!command) return 'none';
    const done = await session.submit(seat, command);
    return done.ok ? 'ok' : done.error.code;
  }, SEAT);
}

test.describe('cities and knights, local', () => {
  test.setTimeout(240_000);

  test('a four-player game plays many rounds: knights, an attack, no page errors', async ({
    page,
  }, testInfo) => {
    const errors = watchErrors(page);
    await startKnightsGame(page, { seats: 4 });
    await expect(page.getByTestId('knights-panel').first()).toBeVisible();
    const tally = await playRounds(page, 22, 8);
    await shot(page, testInfo, 'four-player-after-play');
    expect(tally.ended || tally.rounds >= 10).toBe(true);
    expect(tally.attacks, 'the forced ship faces bring an attack').toBe(1);
    expect(errors).toEqual([]);
  });

  test('a five-player game plays rounds on the five-six board without page errors', async ({
    page,
  }, testInfo) => {
    const errors = watchErrors(page);
    await startKnightsGame(page, { scenario: 'knights-56', seats: 5 });
    const tally = await playRounds(page, 14, 8);
    await shot(page, testInfo, 'five-player-after-play');
    expect(tally.ended || tally.rounds >= 8).toBe(true);
    expect(tally.attacks).toBe(1);
    expect(errors).toEqual([]);
  });

  test('a city buys a city improvement and a science card is drawn and played', async ({
    page,
  }, testInfo) => {
    const errors = watchErrors(page);
    let bought = false;
    for (let attempt = 0; attempt < 5 && !bought; attempt++) {
      await startKnightsGame(page);
      for (let round = 0; round < 45 && !bought; round++) {
        if (!(await untilHumanTurn(page, 'roll'))) break;
        await rollDice(page);
        if (!(await untilHumanTurn(page, 'main'))) break;
        if ((await legalTypes(page)).includes('BUILD_CITY'))
          await humanSubmit(page, ['BUILD_CITY']);
        const hasCity = (await gameState(page)).board.buildings.some(
          (item) => item.seat === SEAT && item.kind === 'city',
        );
        if (hasCity && (await ensureCards(page, { paper: 1 }))) {
          const outcome = await submitScience(page);
          bought = outcome === 'ok';
        }
        if (!bought) await endTurn(page);
      }
    }
    expect(bought, 'an improvement was bought').toBe(true);
    // The sidebar keeps a strip of the tracks; it opens the full board.
    await page.getByTestId('improvements-strip').locator('visible=true').first().click();
    await expect(page.getByTestId('improve-science').locator('visible=true').first()).toBeVisible();
    await shot(page, testInfo, 'improvement-bought');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const ext = knightsOf(await gameState(page));
    expect(Object.values(ext.improvements[SEAT] ?? {}).some((level) => level > 0)).toBe(true);
    // A red die of one with the science gate draws a science card; a lit card in hand plays.
    await endTurn(page);
    let drawn = false;
    for (let round = 0; round < 8 && !drawn; round++) {
      if (!(await untilHumanTurn(page, 'roll'))) break;
      await rollDice(page, { dice: [1, 4], event: 'science' });
      if (!(await untilHumanTurn(page, 'main'))) break;
      drawn = (await page.locator('.progress-hand-card').count()) > 0;
      if (!drawn) await endTurn(page);
    }
    expect(drawn, 'a progress card was drawn').toBe(true);
    await shot(page, testInfo, 'progress-hand');
    const lit = page.locator('.progress-hand-card[data-playable="true"]:not([disabled])');
    if (await lit.count()) {
      await lit.first().click();
      const play = page.getByRole('button', { name: 'Play card' });
      if (await play.count()) {
        await play.click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
      }
    }
    expect(errors).toEqual([]);
  });

  test('the phone shows the barbarian track and reaches the improvements', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = watchErrors(page);
    await startKnightsGame(page);
    await expect.poll(() => trackInView(page)).toBe(true);
    await expect(page.getByTestId('barbarian-countdown')).toHaveCount(0);
    await shot(page, testInfo, 'phone-default-fit');
    await untilHumanTurn(page, 'roll');
    await rollDice(page);
    await untilHumanTurn(page, 'main');
    const strip = page.getByTestId('improvements-strip');
    await expect(strip).toBeVisible();
    await strip.click();
    await expect(page.getByTestId('improve-science').locator('visible=true').first()).toBeVisible();
    await shot(page, testInfo, 'phone-improvements');
    expect(errors).toEqual([]);
  });

  test('walls and a metropolis stand on the board; a displaced knight and a pillage are answered by tapping it', async ({
    page,
  }, testInfo) => {
    const errors = watchErrors(page);
    await startKnightsGame(page);
    await untilHumanTurn(page, 'roll');
    await rollDice(page);
    await untilHumanTurn(page, 'main');
    await page.waitForTimeout(1800);

    // Two cities for the human, one walled and holding the trade metropolis.
    let snap = await snapshot(page);
    const mine = snap.state.board.buildings.filter((item) => item.seat === SEAT);
    const [first, second] = mine.map((item) => item.vertex);
    if (!first || !second) throw new Error('The human needs two buildings');
    const before = await cityPicture(page, first);
    snap = withBuildings(snap, [
      { vertex: first, seat: SEAT, kind: 'city' },
      { vertex: second, seat: SEAT, kind: 'city' },
    ]);
    snap = withWalls(snap, [{ seat: SEAT, vertex: first }]);
    snap = withLevels(snap, SEAT, { trade: 4 });
    snap = withMetropolis(snap, 'trade', SEAT, first);
    snap = withHand(inMain(snap, SEAT), SEAT, { wool: 1, ore: 1 });
    await replace(page, snap);
    await page.waitForTimeout(800);
    const ext = knightsOf(await gameState(page));
    expect(ext.walls).toEqual(expect.arrayContaining([{ seat: SEAT, vertex: first }]));
    expect(ext.metropolises.trade).toEqual({ seat: SEAT, vertex: first });
    // The wall and the metropolis change what is drawn around the city.
    expect((await cityPicture(page, first)).equals(before)).toBe(false);
    await shot(page, testInfo, 'wall-and-metropolis');

    // A displaced knight: the game holds the human until it is placed on a marked site.
    // Roads for the knight to walk: it stands on the second vertex, and its owner may put it on the first or third.
    const walk = withRoadPath(await snapshot(page), SEAT, 3);
    const origin = walk.path[2] ?? '';
    await replace(
      page,
      withFrame(walk.snap, 'knights', 'displaced', {
        seat: SEAT,
        origin,
        level: 2,
        active: true,
        ready: false,
        promotedTurn: null,
      }),
    );
    await expect(page.getByText(/Your knight was displaced/).first()).toBeVisible();
    expect(await legalTypes(page)).toContain('RELOCATE_KNIGHT');
    await shot(page, testInfo, 'relocate-prompt');
    const site = await tapMarked(page, 'relocate');
    await page.getByRole('button', { name: 'Place the knight here?' }).click();
    await expect.poll(async () => (await legalTypes(page)).includes('RELOCATE_KNIGHT')).toBe(false);
    const placed = knightsOf(await gameState(page)).knights.find((item) => item.vertex === site);
    expect(placed).toMatchObject({ seat: SEAT, level: 2 });

    // A pillage: the human picks which city is lost, and the walled one may be kept.
    await replace(
      page,
      withFrame(await snapshot(page), 'knights', 'pillage', { remaining: [SEAT], roll: 5 }),
    );
    await expect(page.getByText(/The barbarians won/).first()).toBeVisible();
    expect(await legalTypes(page)).toContain('CHOOSE_PILLAGE');
    await shot(page, testInfo, 'pillage-prompt');
    const lost = await tapMarked(page, 'pillage');
    await page.getByRole('button', { name: 'Lose this city?' }).click();
    await expect.poll(async () => (await legalTypes(page)).includes('CHOOSE_PILLAGE')).toBe(false);
    const after = await gameState(page);
    const kept = after.board.buildings.find((item) => item.vertex === lost);
    expect(kept?.kind).toBe('settlement');
    expect(errors).toEqual([]);
  });

  test('the countdown pill shows only while the track is out of view', async ({ page }) => {
    const errors = watchErrors(page);
    await startKnightsGame(page);
    const track = (): Promise<boolean> => trackInView(page);
    await expect.poll(track).toBe(true);
    await expect(page.getByTestId('barbarian-countdown')).toHaveCount(0);
    const box = await page.locator('.board-view-canvas canvas').boundingBox();
    if (!box) throw new Error('No board canvas');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 8);
    for (let wheel = 0; wheel < 12 && (await track()); wheel++) {
      await page.mouse.wheel(0, -600);
      await page.waitForTimeout(80);
    }
    await expect.poll(track).toBe(false);
    await expect(page.getByTestId('barbarian-countdown')).toBeVisible();
    await expect(page.getByTestId('barbarian-countdown')).toContainText('Barbarians:');
    await page.getByTestId('barbarian-countdown').click();
    await expect(page.getByTestId('barbarian-dialog')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
