/* eslint-disable no-await-in-loop -- Each browser action depends on the preceding game state. */
import { expect, test } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ARCHIPELAGO_MAIN, seafaringConfig, testArchipelago } from '@cp2p/engine';
import type { GameState, Pending, Resource, Seat } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import type { BoardGraph } from '@cp2p/engine/geometry';
import type { BoardHit } from '@cp2p/renderer';
import type { DevHook } from '../src/features/devtools/hook.js';
import { LocalSession } from '../src/session/local-session.js';
import { hexCornersOutside } from './helpers/seafaring-board.js';

declare global {
  interface Window {
    __cp2p?: DevHook;
  }
}

/** Where screenshots go: `SEAFARING_SHOTS` when set, otherwise the test's own output folder. */
async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const folder = process.env.SEAFARING_SHOTS ?? testInfo.outputDir;
  await mkdir(folder, { recursive: true });
  const body = await page.screenshot({ path: join(folder, `${name}.png`), animations: 'disabled' });
  await testInfo.attach(name, { body, contentType: 'image/png' });
}

/** The human seat in every game here. */
const SEAT: Seat = 0;

const VIEWPORT_NAMES = ['desktop', 'phone-portrait', 'phone-landscape'] as const;
type ViewportName = (typeof VIEWPORT_NAMES)[number];
const VIEWPORTS: Readonly<Record<ViewportName, { width: number; height: number }>> = {
  desktop: { width: 1440, height: 900 },
  'phone-portrait': { width: 390, height: 844 },
  'phone-landscape': { width: 844, height: 390 },
};

const isPhone = (name: ViewportName) => name !== 'desktop';

async function newGame(page: Page, scenario: string): Promise<void> {
  await page.goto('/#/local/new');
  await page.locator('.scenario-picker select').selectOption(scenario);
  await page.getByText('Advanced rules').click();
  await page.getByLabel('Bot pace, milliseconds').fill('0');
  await page.getByRole('button', { name: 'Create game' }).click();
  await expect(page).toHaveURL(/#\/local\/[^/]+$/);
  await expect.poll(() => page.evaluate(() => Boolean(window['__cp2p']?.renderer))).toBe(true);
}

/** Open a game built from an arbitrary config, the way a saved game is opened. */
async function openConfigured(
  page: Page,
  config: Parameters<typeof LocalSession.create>[0]['config'],
) {
  const created = LocalSession.create({
    config,
    humanSeats: [SEAT],
    botSeats: config.seats.filter((seat) => seat !== SEAT),
    botDelayMs: 0,
  });
  if (!created.ok) throw new Error(created.error.message);
  const save = created.value.exportSave();
  created.value.dispose();
  const id = `seafaring-e2e-${Date.now()}`;
  const colors = ['blue', 'orange', 'green', 'magenta'] as const;
  const shapes = ['circle', 'triangle', 'square', 'diamond'] as const;
  const record = {
    v: 1,
    id,
    revision:
      save.genesis.length +
      save.batches.reduce((sum, batch) => sum + 1 + batch.generated.length, 0),
    updatedAt: Date.now(),
    presentation: {
      players: config.seats.map((seat, index) => ({
        seat,
        name: `Player ${seat + 1}`,
        color: colors[index] ?? 'blue',
        shape: shapes[index] ?? 'circle',
      })),
      botDelayMs: 0,
    },
    save,
  };
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: `hexfield:save:v1:${id}`,
    value: JSON.stringify(record),
  });
  await page.goto(`/#/local/${id}`);
  await expect.poll(() => page.evaluate(() => Boolean(window['__cp2p']?.renderer))).toBe(true);
}

function gameState(page: Page): Promise<GameState> {
  return page.evaluate(() => {
    const hook = window['__cp2p'];
    if (!hook) throw new Error('No dev hook');
    return structuredClone(hook.session.getState());
  });
}

function pendingOf(page: Page): Promise<readonly Pending[]> {
  return page.evaluate(() => structuredClone(window['__cp2p']?.session.getPending() ?? []));
}

/** The command types the human seat may use right now. */
async function allowedNow(page: Page): Promise<readonly string[]> {
  const pending = await pendingOf(page);
  return pending.flatMap((item) =>
    item.kind === 'player' && item.seat === SEAT ? item.allowed : [],
  );
}

function handOf(page: Page): Promise<Record<Resource, number>> {
  return page.evaluate((seat) => {
    const hand = window['__cp2p']?.session.getPrivate(seat)?.hand;
    return { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0, ...hand };
  }, SEAT);
}

function handSize(hand: Record<Resource, number>): number {
  return Object.values(hand).reduce((sum, count) => sum + count, 0);
}

/** The promoted turn button: roll dice or end turn, on either layout. */
function turnButton(page: Page): Locator {
  return page.locator('.desktop-turn-button:visible, .mobile-turn-button:visible').first();
}

/** Wait for the human's roll, turning down any trade a bot offers on the way. */
async function waitForMyRoll(page: Page): Promise<void> {
  for (let step = 0; step < 600; step++) {
    if ((await allowedNow(page)).includes('ROLL_DICE')) return;
    const decline = page.locator('.board-offers').getByRole('button', { name: 'Decline' });
    if (await decline.isVisible()) await decline.click();
    await page.waitForTimeout(50);
  }
  throw new Error('The human never got a turn');
}

/** Set the next roll, then press the roll button. */
async function rollWith(page: Page, dice: readonly [number, number]): Promise<void> {
  await waitForMyRoll(page);
  await page.evaluate((faces) => {
    const session = window['__cp2p']?.session;
    if (session && 'forceDice' in session && typeof session.forceDice === 'function')
      Reflect.apply(session.forceDice, session, [faces]);
  }, dice);
  await turnButton(page).click();
}

/** Dice faces that add up to `total`. */
function facesFor(total: number): [number, number] {
  const first = Math.max(1, total - 6);
  return [first, total - first];
}

async function tapBoard(page: Page, hit: BoardHit): Promise<void> {
  const point = await page.evaluate(
    (target) => window['__cp2p']?.pixelPosition(target) ?? null,
    hit,
  );
  if (!point) throw new Error(`No screen position for ${hit.kind} ${hit.id}`);
  await page.mouse.click(point.x, point.y);
}

async function tapBoardEdge(page: Page, id: string): Promise<void> {
  const state = await gameState(page);
  const edge = buildBoardGraph(state.board.hexes).edgeIds.find((candidate) => candidate === id);
  if (!edge) throw new Error(`Unknown edge ${id}`);
  await tapBoard(page, { kind: 'edge', id: edge });
}

async function tapBoardHex(page: Page, id: string): Promise<void> {
  const state = await gameState(page);
  const hex = buildBoardGraph(state.board.hexes).hexIds.find((candidate) => candidate === id);
  if (!hex) throw new Error(`Unknown hex ${id}`);
  await tapBoard(page, { kind: 'hex', id: hex });
}

async function tapBoardVertex(page: Page, id: string): Promise<void> {
  const state = await gameState(page);
  const vertex = buildBoardGraph(state.board.hexes).vertexIds.find((candidate) => candidate === id);
  if (!vertex) throw new Error(`Unknown vertex ${id}`);
  await tapBoard(page, { kind: 'vertex', id: vertex });
}

async function confirmPlacement(page: Page, name: RegExp): Promise<void> {
  await page.locator('.placement-confirmation').getByRole('button', { name }).click();
}

/** Ids the UI offers as board targets for one kind of placement. */
function offered(
  page: Page,
  kind: 'settlement' | 'road' | 'ship' | 'moveShip' | 'pirate',
): Promise<string[]> {
  return page.evaluate(
    (key) =>
      (window['__cp2p']?.diagnostics().actions?.placements[key] ?? []).map((item) => item.id),
    kind,
  );
}

function neighbors(graph: BoardGraph, vertex: string) {
  return graph.vertexHexes[graph.vertexIndex[vertex] ?? -1] ?? [];
}

const PIPS: Record<number, number> = {
  2: 1,
  3: 2,
  4: 3,
  5: 4,
  6: 5,
  8: 5,
  9: 4,
  10: 3,
  11: 2,
  12: 1,
};
const TERRAIN_RESOURCE: Record<string, Resource> = {
  forest: 'lumber',
  pasture: 'wool',
  hills: 'brick',
  fields: 'grain',
  mountains: 'ore',
};

/** The best offered building site for the wanted terrains, optionally only on the coast. */
function bestSite(
  state: GameState,
  graph: BoardGraph,
  sites: readonly string[],
  wanted: readonly string[],
  requireCoastal = false,
): string {
  const terrain = new Map(state.board.hexes.map((hex) => [hex.id, hex]));
  const coastal = (vertex: string) =>
    neighbors(graph, vertex).some((id) => terrain.get(id)?.terrain === 'sea');
  const score = (vertex: string) =>
    neighbors(graph, vertex)
      .map((id) => terrain.get(id))
      .reduce(
        (sum, hex) =>
          sum + (hex && wanted.includes(hex.terrain) ? (PIPS[hex.token ?? 0] ?? 0) + 3 : 0),
        0,
      );
  const candidates = requireCoastal ? sites.filter(coastal) : sites;
  const best = candidates.toSorted((a, b) => score(b) - score(a) || (a < b ? -1 : 1))[0];
  if (!best) throw new Error('No building site offered');
  return best;
}

/** The choice between a road and a ship, wherever the layout puts it. */
function pieceChoice(page: Page, label: 'road' | 'ship' | 'pirate' | 'robber'): Locator {
  const text = {
    road: /^(Build road|Road)$/,
    ship: /^(Build ship|Ship)$/,
    pirate: /^(Move pirate|Pirate)$/,
    robber: /^(Move robber|Robber)$/,
  }[label];
  return page
    .locator('.desktop-context-actions:visible, .piece-choice:visible')
    .getByRole('button', { name: text });
}

/** Play the human's setup turns by clicking, with a ship in place of the first road. */
async function playSetup(
  page: Page,
  testInfo: TestInfo,
  options: { firstShip: boolean; wanted: readonly string[]; prefix: string },
) {
  let placements = 0;
  let shipPlaced = false;
  for (let step = 0; step < 400; step++) {
    const allowed = await allowedNow(page);
    if ((await gameState(page)).turn.phase.at(-1)?.id !== 'setup') return;
    if (allowed.includes('PLACE_SETTLEMENT')) {
      const state = await gameState(page);
      const graph = buildBoardGraph(state.board.hexes);
      const sites = await offered(page, 'settlement');
      const site = bestSite(
        state,
        graph,
        sites,
        options.wanted,
        options.firstShip && placements === 0,
      );
      await tapBoardVertex(page, site);
      await confirmPlacement(page, /Confirm settlement/);
      placements += 1;
    } else if (allowed.includes('PLACE_ROAD')) {
      if (options.firstShip && !shipPlaced && allowed.includes('PLACE_SETUP_SHIP')) {
        await pieceChoice(page, 'ship').click();
        await shot(page, testInfo, `${options.prefix}-setup-ship-targets`);
        const edges = await offered(page, 'ship');
        await tapBoardEdge(page, edges[0] ?? '');
        await shot(page, testInfo, `${options.prefix}-setup-ship-preview`);
        await confirmPlacement(page, /Confirm ship/);
        shipPlaced = true;
      } else {
        const edges = await offered(page, 'road');
        await tapBoardEdge(page, edges[0] ?? '');
        await confirmPlacement(page, /Confirm road/);
      }
    } else await page.waitForTimeout(40);
    await page.waitForTimeout(60);
  }
  const state = await gameState(page);
  throw new Error(
    `Setup did not finish after ${placements} placements: ${JSON.stringify(await pendingOf(page))} ${JSON.stringify(state.turn)}`,
  );
}

/** Take turns, rolling numbers that pay the human's lumber and wool, until a ship is affordable. */
async function stockForShip(page: Page): Promise<void> {
  for (let round = 0; round < 12; round++) {
    await waitForMyRoll(page);
    const hand = await handOf(page);
    const missing = (['lumber', 'wool'] as const).find((resource) => hand[resource] < 1);
    if (!missing) return;
    const state = await gameState(page);
    const graph = buildBoardGraph(state.board.hexes);
    const hexes = new Map(state.board.hexes.map((hex) => [hex.id, hex]));
    const tokens = state.board.buildings
      .filter((building) => building.seat === SEAT)
      .flatMap((building) => neighbors(graph, building.vertex))
      .flatMap((id) => {
        const hex = hexes.get(id);
        return hex && TERRAIN_RESOURCE[hex.terrain] === missing && hex.token ? [hex.token] : [];
      });
    await rollWith(page, facesFor(tokens[0] ?? 2));
    await expect.poll(() => allowedNow(page)).toContain('END_TURN');
    await turnButton(page).click();
  }
  throw new Error('The human could not get lumber and wool');
}

function pirateHexOf(state: GameState): unknown {
  const ext: unknown = state.ext.seafaring;
  return typeof ext === 'object' && ext !== null ? Reflect.get(ext, 'pirateHex') : null;
}

test.describe('seafaring on the game screen', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Seafaring UI runs in Chromium');

  for (const name of VIEWPORT_NAMES) {
    test(`New Horizons fits a ${name} screen at the default zoom`, async ({
      browser,
    }, testInfo) => {
      const context = await browser.newContext({
        viewport: VIEWPORTS[name],
        isMobile: isPhone(name),
        hasTouch: isPhone(name),
      });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await newGame(page, 'new-horizons');
        const state = await gameState(page);
        expect(state.board.hexes.length).toBeGreaterThan(50);
        expect(state.board.ships).toEqual([]);
        // The default fit, with no nudge: the hexes and the water ring are all on screen.
        await expect.poll(() => hexCornersOutside(page, state)).toBe(0);
        await shot(page, testInfo, `board-new-horizons-${name}`);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test('a New Horizons game against bots: setup ship, sail, build, pirate', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize(VIEWPORTS.desktop);
    await newGame(page, 'new-horizons');
    await playSetup(page, testInfo, {
      firstShip: true,
      wanted: ['forest', 'pasture'],
      prefix: 'desktop',
    });
    const afterSetup = await gameState(page);
    const setupShips = afterSetup.board.ships?.filter((ship) => ship.seat === SEAT) ?? [];
    expect(setupShips).toHaveLength(1);
    await shot(page, testInfo, 'after-setup');

    // Make sure the hand can pay for a ship, then sail the setup ship: it has one open end.
    await stockForShip(page);
    await rollWith(page, [1, 1]);
    await expect.poll(() => allowedNow(page)).toContain('END_TURN');
    const moveButton = page
      .locator('.desktop-build-grid')
      .getByRole('button', { name: 'Move ship' });
    await expect(moveButton).toBeEnabled();
    await moveButton.click();
    await expect(page.locator('.desktop-placement-instruction')).toContainText('can sail');
    await shot(page, testInfo, 'move-ship-choose');
    expect((await offered(page, 'moveShip')).length).toBeGreaterThan(0);
    await tapBoardEdge(page, setupShips[0]?.edge ?? '');
    await expect(page.locator('.desktop-placement-instruction')).toContainText('to sail to');
    await shot(page, testInfo, 'move-ship-targets');
    const target = (await offered(page, 'moveShip'))[0] ?? '';
    expect(target).not.toBe('');
    await tapBoardEdge(page, target);
    await shot(page, testInfo, 'move-ship-confirm');
    await confirmPlacement(page, /Confirm move/);
    await expect
      .poll(async () => (await gameState(page)).board.ships?.map((ship) => ship.edge))
      .toContain(target);
    const moved = await gameState(page);
    expect(moved.board.ships?.filter((ship) => ship.seat === SEAT)).toHaveLength(1);
    await shot(page, testInfo, 'move-ship-done');

    // Build a ship with the lumber and wool the setup and the rolls paid.
    const buildButton = page
      .locator('.desktop-build-grid')
      .getByRole('button', { name: /^Build ship, Ships left: 14$/ });
    await expect(buildButton).toBeEnabled();
    await buildButton.click();
    await shot(page, testInfo, 'build-ship-targets');
    const edges = await offered(page, 'ship');
    expect(edges.length).toBeGreaterThan(0);
    await tapBoardEdge(page, edges[Math.floor(edges.length / 2)] ?? '');
    await confirmPlacement(page, /Confirm ship/);
    await expect
      .poll(async () => (await gameState(page)).board.ships?.filter((s) => s.seat === SEAT).length)
      .toBe(2);
    await expect(page.locator('.build-supply').first()).toHaveText('13');
    await shot(page, testInfo, 'build-ship-done');

    // The next turn: a forced 7 makes the pirate an option next to the robber.
    await turnButton(page).click();
    await rollWith(page, [3, 4]);
    await expect.poll(() => allowedNow(page)).toContain('MOVE_PIRATE');
    await expect(page.locator('.desktop-context-actions').getByRole('button')).toHaveText([
      'Move robber',
      'Move pirate',
    ]);
    await shot(page, testInfo, 'blocker-choice-robber');
    await pieceChoice(page, 'pirate').click();
    await shot(page, testInfo, 'blocker-choice-pirate');
    const seas = await offered(page, 'pirate');
    expect(seas.length).toBeGreaterThan(0);
    const destination = seas[0] ?? '';
    await tapBoardHex(page, destination);
    await expect.poll(async () => pirateHexOf(await gameState(page))).toBe(destination);
    await shot(page, testInfo, 'pirate-moved');
    expect(errors).toEqual([]);
  });

  for (const name of ['desktop', 'phone-portrait'] as const) {
    test(`a gold field pays out through the choice dialog on ${name}`, async ({
      browser,
    }, testInfo) => {
      test.setTimeout(120_000);
      const context = await browser.newContext({
        viewport: VIEWPORTS[name],
        isMobile: isPhone(name),
        hasTouch: isPhone(name),
      });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        // The test archipelago, with two gold fields on the home island.
        const board = testArchipelago();
        const gold = new Map([
          ['h:0,-1', 10],
          ['h:0,1', 8],
        ]);
        const config = seafaringConfig({
          seats: 2,
          board: {
            ...board,
            hexes: board.hexes.map((hex) =>
              gold.has(hex.id) ? { ...hex, terrain: 'gold', token: gold.get(hex.id) ?? null } : hex,
            ),
          },
          seafaring: { setupAreas: [...ARCHIPELAGO_MAIN] },
        });
        await openConfigured(page, config);
        await playSetup(page, testInfo, { firstShip: false, wanted: ['gold'], prefix: name });
        const state = await gameState(page);
        const graph = buildBoardGraph(state.board.hexes);
        const around = new Map(
          state.board.buildings
            .filter((building) => building.seat === SEAT)
            .flatMap((building) => neighbors(graph, building.vertex))
            .map((id) => [id, state.board.hexes.find((hex) => hex.id === id)] as const),
        );
        const claimed = [...around.values()].find((hex) => hex?.terrain === 'gold');
        if (!claimed?.token) throw new Error('The human settled away from the gold fields');
        const before = await handOf(page);
        await rollWith(page, facesFor(claimed.token));
        const dialog = page.getByRole('dialog', { name: 'Gold field' });
        await expect(dialog).toBeVisible();
        await shot(page, testInfo, `gold-dialog-${name}`);
        const confirm = dialog.getByRole('button', { name: 'Confirm' });
        await expect(confirm).toBeDisabled();
        const need = Number(/Take (\d+) cards?/.exec((await dialog.textContent()) ?? '')?.[1]);
        expect(need).toBeGreaterThan(0);
        for (let card = 0; card < need; card++)
          await dialog.getByRole('button', { name: 'Add Ore to Cards to take' }).click();
        await expect(dialog.getByText(`Selected ${need} of ${need}`)).toBeVisible();
        // One more is refused, so the count cannot pass the claim.
        await dialog.getByRole('button', { name: 'Add Brick to Cards to take' }).click();
        await expect(dialog.getByText(`Selected ${need} of ${need}`)).toBeVisible();
        await expect(confirm).toBeEnabled();
        await confirm.click();
        await expect(dialog).toBeHidden();
        const after = await handOf(page);
        expect(after.ore - before.ore).toBeGreaterThanOrEqual(need);
        expect(handSize(after)).toBeGreaterThanOrEqual(handSize(before) + need);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    });
  }

  test('on a phone a ship is offered beside the road and built from the Build sheet', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
      viewport: VIEWPORTS['phone-portrait'],
      isMobile: true,
      hasTouch: true,
    });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await newGame(page, 'new-horizons');
      await playSetup(page, testInfo, {
        firstShip: true,
        wanted: ['forest', 'pasture'],
        prefix: 'phone',
      });
      await expect
        .poll(
          async () => (await gameState(page)).board.ships?.filter((s) => s.seat === SEAT).length,
        )
        .toBe(1);
      await stockForShip(page);
      await rollWith(page, [1, 1]);
      await expect.poll(() => allowedNow(page)).toContain('END_TURN');
      await page.getByRole('button', { name: 'Build', exact: true }).click();
      const sheet = page.locator('.cockpit-sheet');
      await expect(sheet.getByRole('button', { name: 'Build ship' })).toBeEnabled();
      await expect(sheet.getByText('Ships left: 14')).toBeVisible();
      await shot(page, testInfo, 'phone-build-sheet');
      await sheet.getByRole('button', { name: 'Build ship' }).click();
      const edges = await offered(page, 'ship');
      expect(edges.length).toBeGreaterThan(0);
      await shot(page, testInfo, 'phone-build-ship-targets');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
