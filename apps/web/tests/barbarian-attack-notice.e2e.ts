/* eslint-disable no-await-in-loop -- Each device plays its attack after the previous one. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { knightsExt } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import type { VertexId } from '@cp2p/engine/geometry';
import {
  SEAT,
  gameState,
  rollDice,
  startKnightsGame,
  untilHumanTurn,
} from './helpers/knights-play.js';
import {
  inPreRoll,
  withBuildings,
  replace,
  snapshot,
  withBarbarians,
  withKnights,
  withWalls,
} from './helpers/knights-scenes.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const shots = process.env.CP2P_ANIM_SHOTS ?? join(repoRoot, 'reports/barbarian-attack');

/**
 * A knights game one ship face from landing. The human's only city has a wall and no knight beside
 * it; every other seat has a city and an active knight, so the human alone is the weakest defender.
 * Returns the human's city.
 */
async function sceneBeforeAttack(page: Page): Promise<{ vertex: string }> {
  await startKnightsGame(page);
  expect(await untilHumanTurn(page, 'roll')).toBe(true);

  let snap = await snapshot(page);
  const graph = buildBoardGraph(snap.state.board.hexes);
  const taken = new Set(snap.state.board.buildings.map((piece) => piece.vertex));
  // The human keeps exactly one city (the setup city, or its first settlement made one).
  const own = snap.state.board.buildings.filter((piece) => piece.seat === SEAT);
  const city = own.find((piece) => piece.kind === 'city') ?? own[0];
  if (!city) throw new Error('The human has no building after setup');
  // Every other seat has a city too, so the cities outnumber the three knights.
  snap = withBuildings(snap, [
    { seat: SEAT, vertex: city.vertex, kind: 'city' },
    ...own
      .filter((piece) => piece.vertex !== city.vertex)
      .map((piece) => ({ seat: SEAT, vertex: piece.vertex, kind: 'settlement' as const })),
    ...snap.state.config.seats
      .filter((seat) => seat !== SEAT)
      .flatMap((seat) => {
        const home = snap.state.board.buildings.find((piece) => piece.seat === seat);
        return home ? [{ seat, vertex: home.vertex, kind: 'city' as const }] : [];
      }),
  ]);
  const knights = snap.state.config.seats
    .filter((seat) => seat !== SEAT)
    .map((seat) => {
      const home = snap.state.board.buildings.find((piece) => piece.seat === seat);
      const index = home ? graph.vertexIndex[home.vertex] : undefined;
      const spot = (index === undefined ? [] : (graph.vertexNeighbors[index] ?? [])).find(
        (vertex) => !taken.has(vertex),
      );
      if (!spot) throw new Error(`No room for seat ${seat}'s knight`);
      taken.add(spot);
      return { seat, vertex: spot, level: 1, active: true, ready: true };
    });
  snap = withBarbarians(snap, 6);
  snap = withKnights(snap, knights);
  snap = withWalls(snap, [{ seat: SEAT, vertex: city.vertex }]);
  snap = inPreRoll(snap, SEAT, snap.state.turn.number);
  // Before the first attack: the robber is still locked, and the attack frees it.
  const knightsKey = Object.keys(snap.state.ext).find(
    (id) => snap.state.ext[id] === knightsExt(snap.state),
  );
  if (!knightsKey) throw new Error('No knights state');
  snap = {
    ...snap,
    state: {
      ...snap.state,
      ext: {
        ...snap.state.ext,
        [knightsKey]: { ...knightsExt(snap.state), robberLocked: true, lastAttack: null },
      },
    },
  };
  await replace(page, snap);
  await page.waitForTimeout(500);
  return city;
}

test('a barbarian attack is announced to everyone and the lost city is shown falling', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The attack is pictured in Chromium');
  test.setTimeout(180_000);
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
      const city = await sceneBeforeAttack(page);

      await rollDice(page, { dice: [2, 3], event: 'ship' });
      const rolled = Date.now();
      const notice = page.getByTestId('barbarian-attack-notice');
      await expect(notice).toBeAttached();
      const around = await page.evaluate((vertex) => {
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- it runs in the page
        const isVertex = (value: string): value is VertexId => /^v:-?\d+,-?\d+,(N|S)$/.test(value);
        return isVertex(vertex)
          ? (window['__cp2p']?.pixelPosition({ kind: 'vertex', id: vertex }) ?? null)
          : null;
      }, city.vertex);
      const clip = around
        ? {
            x: Math.max(0, around.x - 120),
            y: Math.max(0, around.y - 120),
            width: 240,
            height: 240,
          }
        : undefined;
      // Pictures at set times after the roll: the ship lands about 1.5 s in, then the city falls.
      for (const [label, at] of [
        ['landing', 1_300],
        ['shake', 1_900],
        ['wall-falls', 2_350],
        ['sinking', 2_700],
        ['settled', 4_200],
      ] as const) {
        await page.waitForTimeout(Math.max(0, rolled + at - Date.now()));
        await writeFile(
          join(shots, `attack-${device.name}-${label}.png`),
          await page.screenshot({ animations: 'allow' }),
        );
        if (clip)
          await writeFile(
            join(shots, `attack-${device.name}-${label}-city.png`),
            await page.screenshot({ animations: 'allow', clip }),
          );
      }
      await expect(notice).toBeVisible();
      // A ring marks the lost city; when the board is zoomed away from it, the notice offers to
      // show the whole board, and the ring follows.
      const show = notice.getByRole('button', { name: 'Show on board' });
      if (await show.isVisible()) await show.click();
      await expect(page.getByTestId('barbarian-attack-marker')).toHaveCount(1);

      await expect(notice).toContainText('Barbarians attack!');
      await expect(notice).toContainText('The barbarians won and pillaged.');
      await expect(notice).toContainText('Your city by');
      await expect(notice).toContainText('your only city');
      await expect(notice).toContainText('The robber is now active.');
      const after = await gameState(page);
      expect(after.board.buildings.find((piece) => piece.vertex === city.vertex)?.kind).toBe(
        'settlement',
      );

      // It stays while play goes on, until it is dismissed.
      await page.waitForTimeout(1_000);
      await expect(notice).toBeVisible();
      await notice.getByRole('button', { name: 'Got it' }).click();
      await expect(notice).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

test('with reduced motion the announcement shows at once, without motion', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The attack is pictured in Chromium');
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 720 });
  await sceneBeforeAttack(page);
  await rollDice(page, { dice: [2, 3], event: 'ship' });
  const notice = page.getByTestId('barbarian-attack-notice');
  await expect(notice).toBeVisible({ timeout: 1_000 });
  expect(await notice.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  await expect(notice).toContainText('Your city by');
  await mkdir(shots, { recursive: true });
  await writeFile(join(shots, 'attack-reduced-motion.png'), await page.screenshot());
});
