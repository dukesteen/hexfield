/* eslint-disable no-await-in-loop -- Each scene step depends on the state the last one left. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { knightsExt } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import type { GameState, Seat } from '@cp2p/engine';
import {
  SEAT,
  endTurn,
  rollDice,
  startKnightsGame,
  untilHumanTurn,
} from './helpers/knights-play.js';
import {
  apply,
  inMain,
  replace,
  snapshot,
  vertexPoint,
  withBuildings,
  withHand,
  withKnights,
  withLevels,
  withMerchant,
  withMetropolis,
  withProgress,
  withSideways,
  withWalls,
  withRoadPath,
  withFrame,
  withBarbarians,
  withVp,
  inPreRoll,
} from './helpers/knights-scenes.js';
import type { Snapshot } from './helpers/knights-scenes.js';

/**
 * A visual sweep of the Cities and Knights states that are hard to reach by play: each scene builds
 * a position, opens the screen, and takes a picture for every device size. It only runs when
 * `KNIGHTS_SHOTS` names a folder. Every scene also has to finish without a page error.
 */
const SHOTS = process.env.KNIGHTS_SHOTS;

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'landscape', width: 844, height: 390 },
] as const;

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' });
}

/** A picture of the board around one vertex, for a close look at the pieces. */
async function closeup(
  page: Page,
  name: string,
  vertex: string,
  size = Number(process.env.KNIGHTS_CLOSE ?? 300),
): Promise<void> {
  if (!SHOTS) return;
  const at = await vertexPoint(page, vertex);
  const box = await page.locator('.board-view-canvas canvas').boundingBox();
  if (!at || !box) return;
  const x = Math.max(0, box.x + at.x - size / 2);
  const y = Math.max(0, box.y + at.y - size / 2);
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({
    path: join(SHOTS, `${name}.png`),
    clip: { x, y, width: size, height: size },
  });
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/** A fresh local game, the human at the start of its main phase after a plain roll. */
async function toMain(page: Page, options: { seats?: number; scenario?: string } = {}) {
  await startKnightsGame(page, options);
  await untilHumanTurn(page, 'roll');
  await rollDice(page);
  await untilHumanTurn(page, 'main');
  await page.waitForTimeout(1800);
}

const RICH = {
  brick: 4,
  lumber: 4,
  wool: 4,
  grain: 4,
  ore: 4,
  cloth: 3,
  coin: 3,
  paper: 3,
};

function graphOf(state: GameState) {
  return buildBoardGraph(state.board.hexes);
}

/** Empty vertices near a start vertex, nearest first. */
function freeNear(state: GameState, start: string, count: number): string[] {
  const graph = graphOf(state);
  const taken = new Set([
    ...state.board.buildings.map((item) => item.vertex),
    ...knightsExt(state).knights.map((item) => item.vertex),
  ]);
  const seen = new Set([start]);
  const queue = [start];
  const out: string[] = [];
  while (queue.length && out.length < count) {
    const at = queue.shift() ?? '';
    for (const next of graph.vertexNeighbors[graph.vertexIndex[at] ?? -1] ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
      if (!taken.has(next)) out.push(next);
    }
  }
  return out.slice(0, count);
}

function cityOf(state: GameState, seat: Seat): string {
  const city = state.board.buildings.find((item) => item.seat === seat && item.kind === 'city');
  if (!city) throw new Error(`Seat ${seat} has no city`);
  return city.vertex;
}

/** The seat's first settlement becomes a city when it has none, so a scene always has one. */
function withCity(snap: Snapshot, seat: Seat): Snapshot {
  if (snap.state.board.buildings.some((item) => item.seat === seat && item.kind === 'city'))
    return snap;
  const first = snap.state.board.buildings.find((item) => item.seat === seat);
  return first ? withBuildings(snap, [{ vertex: first.vertex, seat, kind: 'city' }]) : snap;
}

/** Walls, knights of every level, a merchant and two metropolises on the board. */
async function boardPieces(page: Page): Promise<void> {
  let snap = withCity(withCity(await snapshot(page), SEAT), 3);
  const mine = cityOf(snap.state, SEAT);
  const theirs = cityOf(snap.state, 3);
  const near = freeNear(snap.state, mine, 5);
  const far = freeNear(snap.state, theirs, 3);
  snap = withHand(snap, SEAT, RICH);
  snap = withWalls(snap, [{ seat: SEAT, vertex: mine }]);
  snap = withLevels(snap, SEAT, { trade: 4, science: 2, politics: 3 });
  snap = withMetropolis(snap, 'trade', SEAT, mine);
  snap = withLevels(snap, 3, { politics: 4 });
  snap = withMetropolis(snap, 'politics', 3, theirs);
  snap = withKnights(snap, [
    { seat: SEAT, vertex: near[0] ?? '', level: 1, active: false },
    { seat: SEAT, vertex: near[1] ?? '', level: 2, active: true, ready: true },
    { seat: SEAT, vertex: near[2] ?? '', level: 3, active: true },
    { seat: 3, vertex: far[0] ?? '', level: 2, active: true },
    { seat: 3, vertex: far[1] ?? '', level: 3, active: false },
  ]);
  const hex = graphOf(snap.state).vertexHexes[graphOf(snap.state).vertexIndex[mine] ?? -1]?.[0];
  if (hex) snap = withMerchant(snap, SEAT, hex);
  const settlement = snap.state.board.buildings.find((item) => item.seat === 2);
  if (settlement && settlement.kind === 'settlement')
    snap = withSideways(snap, 2, settlement.vertex);
  await replace(page, snap);
  await page.waitForTimeout(800);
  await closeup(page, `board-mine-${page.viewportSize()?.width ?? 0}`, mine);
  await closeup(page, `board-theirs-${page.viewportSize()?.width ?? 0}`, theirs);
}

interface Scene {
  readonly name: string;
  readonly run: (page: Page) => Promise<void>;
  /** Wait for this to show before the picture. */
  readonly ready?: (page: Page) => Promise<void>;
}

const dialogUp = async (page: Page): Promise<void> => {
  await expect(page.getByRole('dialog').first()).toBeVisible();
};

/** A frame the game holds the human in, on top of its main phase. */
async function frameScene(
  page: Page,
  frame: { id: string; data: unknown },
  prepare: (snap: Snapshot) => Snapshot = (snap) => snap,
): Promise<void> {
  let snap = await snapshot(page);
  snap = prepare(withHand(inMain(withCity(snap, SEAT), SEAT), SEAT, RICH));
  snap = withFrame(snap, 'knights', frame.id, frame.data);
  await replace(page, snap);
  await page.waitForTimeout(500);
  await closeup(page, `${frame.id}-close`, cityOf(snap.state, SEAT), 240);
}

const SCENES: Scene[] = [
  { name: 'board-pieces', run: boardPieces },
  {
    name: 'dialog-aqueduct',
    ready: dialogUp,
    run: (page) => frameScene(page, { id: 'aqueduct', data: { queue: [SEAT] } }),
  },
  {
    name: 'dialog-wedding',
    ready: dialogUp,
    run: (page) =>
      frameScene(page, { id: 'wedding', data: { actor: 1, remaining: [SEAT] } }, (snap) => snap),
  },
  {
    name: 'dialog-saboteur',
    ready: dialogUp,
    run: (page) =>
      frameScene(page, { id: 'saboteur', data: { actor: 1, remaining: [SEAT] } }, (snap) => snap),
  },
  {
    name: 'dialog-harbor-reply',
    ready: dialogUp,
    run: (page) =>
      frameScene(page, { id: 'harborReply', data: { actor: 2, seat: SEAT, offered: 'ore' } }),
  },
  {
    name: 'pillage',
    run: (page) => frameScene(page, { id: 'pillage', data: { remaining: [SEAT], roll: 5 } }),
  },
  {
    name: 'metropolis-choice',
    run: (page) =>
      frameScene(page, { id: 'metropolis', data: { seat: SEAT, track: 'science' } }, (snap) =>
        withLevels(snap, SEAT, { science: 4 }),
      ),
  },
];

/** A hand of progress cards in the main phase, with rivals that make each card playable. */
async function handScene(
  page: Page,
  cards: readonly string[],
  prepare: (snap: Snapshot) => Snapshot = (snap) => snap,
): Promise<void> {
  let snap = withCity(await snapshot(page), SEAT);
  snap = withHand(inMain(snap, SEAT), SEAT, RICH);
  // Rivals with knights, more points and cards, so every card has a target.
  snap = withCity(snap, 1);
  const rival = cityOf(snap.state, 1);
  const spots = freeNear(snap.state, rival, 2);
  snap = withKnights(snap, [
    { seat: 1, vertex: spots[0] ?? '', level: 2, active: true },
    { seat: 1, vertex: spots[1] ?? '', level: 1, active: false },
  ]);
  snap = withVp(snap, SEAT, 1);
  for (const card of cards) snap = withProgress(snap, SEAT, card);
  await replace(page, prepare(snap));
  await page.waitForTimeout(600);
}

/** Open a held card the way a player does: tap it in the hand, then start its play. */
async function openCard(page: Page, card: string): Promise<void> {
  await page.getByTestId(`progress-card-${card}`).locator('visible=true').first().click();
}

const openCardScene = (card: string, preRoll = false): Scene => ({
  name: `card-${card}`,
  ready: dialogUp,
  run: async (page) => {
    await handScene(page, [card], (snap) => (preRoll ? inPreRoll(snap, SEAT) : snap));
    await openCard(page, card);
  },
});

/** The barbarians land: pictures of the attack effect through its whole length. */
async function attackScene(page: Page, held: boolean): Promise<void> {
  let snap = withCity(await snapshot(page), SEAT);
  snap = withBarbarians(inPreRoll(withHand(snap, SEAT, RICH), SEAT), 6);
  if (held) {
    const near = freeNear(snap.state, cityOf(snap.state, SEAT), 3);
    snap = withKnights(
      snap,
      near.map((vertex) => ({ seat: SEAT, vertex, level: 3, active: true, ready: true })),
    );
  }
  await replace(page, snap);
  await page.waitForTimeout(600);
  await rollDice(page, { dice: [2, 3], event: 'ship' });
  const width = page.viewportSize()?.width ?? 0;
  for (let frame = 0; frame < 14; frame++) {
    await page.waitForTimeout(350);
    await shot(
      page,
      `attack-${held ? 'held' : 'pillaged'}-${width}-${String(frame).padStart(2, '0')}`,
    );
  }
}

/** The costs dialog, where the screen has its button; a compact screen lists the prices on its build rows instead. */
async function openBuildCosts(page: Page): Promise<void> {
  const costs = page.getByRole('button', { name: 'Build costs' }).locator('visible=true');
  if (await costs.count()) await costs.first().click();
}

/** Zoom the board out until the printed track leaves the screen, then tap the countdown. */
async function openBarbarianDialog(page: Page): Promise<void> {
  await handScene(page, []);
  const box = await page.locator('.board-view-canvas canvas').boundingBox();
  if (!box) throw new Error('No board canvas');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 8);
  for (let wheel = 0; wheel < 14; wheel++) {
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(80);
  }
  await page.getByTestId('barbarian-countdown').click();
}

/** Recruit a knight the way a player does: open the build list, pick the row, look at the board. */
async function recruitFlow(page: Page): Promise<void> {
  await handScene(page, []);
  const build = page.getByRole('button', { name: 'Build', exact: true }).locator('visible=true');
  if (await build.count()) await build.first().click();
  await page.locator('[data-kind="knight"]').locator('visible=true').first().click();
  await page.waitForTimeout(700);
}

SCENES.push(
  { name: 'recruit-flow', run: recruitFlow },
  {
    name: 'build-sheet',
    run: async (page) => {
      await handScene(page, []);
      const build = page
        .getByRole('button', { name: 'Build', exact: true })
        .locator('visible=true');
      if (await build.count()) await build.first().click();
      await page.waitForTimeout(500);
    },
  },
  { name: 'barbarian-dialog', ready: dialogUp, run: openBarbarianDialog },
  {
    name: 'build-costs',
    ready: async (page) => {
      if (await page.locator('.build-costs-panel').count()) await dialogUp(page);
    },
    run: openBuildCosts,
  },
  {
    name: 'improvements-open',
    run: async (page) => {
      await handScene(page, []);
      const strip = page.getByTestId('improvements-strip').locator('visible=true');
      if (await strip.count()) await strip.first().click();
    },
  },
  {
    name: 'progress-hand',
    run: (page) => handScene(page, ['deserter', 'wedding', 'saboteur', 'alchemist']),
  },
  {
    name: 'progress-forced-discard',
    ready: dialogUp,
    run: async (page) => {
      // Over the limit of four, the game asks for the discard by itself.
      await handScene(page, ['deserter', 'wedding', 'saboteur', 'alchemist', 'crane']);
    },
  },
  openCardScene('deserter'),
  openCardScene('wedding'),
  openCardScene('saboteur'),
  openCardScene('alchemist', true),
  openCardScene('crane'),
  openCardScene('resourceMonopoly'),
  openCardScene('masterMerchant'),
  openCardScene('commercialHarbor'),
  {
    name: 'relocate',
    run: async (page) => {
      const walk = withRoadPath(withCity(await snapshot(page), SEAT), SEAT, 3);
      const origin = walk.path[2] ?? '';
      await replace(page, walk.snap);
      await frameScene(page, {
        id: 'displaced',
        data: { seat: SEAT, origin, level: 2, active: true, ready: false, promotedTurn: null },
      });
      await closeup(page, 'relocate-close', origin, 300);
    },
  },
  { name: 'attack-pillaged', run: (page) => attackScene(page, false) },
  { name: 'attack-held', run: (page) => attackScene(page, true) },
);

/** Five and six players: the board, the panels and the hand with everything at its fullest. */
const SIX_SCENES: Scene[] = [
  { name: 'six-players', run: (page) => handScene(page, ['deserter', 'wedding']) },
  {
    name: 'six-players-pieces',
    run: async (page) => {
      await boardPieces(page);
    },
  },
];

test.use({ deviceScaleFactor: Number(process.env.KNIGHTS_DPR ?? 1) });

test.describe('cities and knights visual sweep', () => {
  test.skip(!SHOTS, 'Set KNIGHTS_SHOTS to a folder to take the pictures');
  test.setTimeout(Number(process.env.KNIGHTS_TIMEOUT ?? 120_000));
  for (const viewport of VIEWPORTS)
    for (const scene of SCENES)
      test(`${scene.name} at ${viewport.name}`, async ({ page }) => {
        const errors = watchErrors(page);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await toMain(page);
        await scene.run(page);
        await scene.ready?.(page);
        await shot(page, `${scene.name}-${viewport.name}`);
        expect(errors).toEqual([]);
      });
});

test.describe('cities and knights, six players', () => {
  test.skip(!SHOTS, 'Set KNIGHTS_SHOTS to a folder to take the pictures');
  test.setTimeout(Number(process.env.KNIGHTS_TIMEOUT ?? 120_000));
  for (const viewport of VIEWPORTS)
    for (const scene of SIX_SCENES)
      test(`${scene.name} at ${viewport.name}`, async ({ page }) => {
        const errors = watchErrors(page);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await toMain(page, { scenario: 'knights-56', seats: 6 });
        await scene.run(page);
        await shot(page, `${scene.name}-${viewport.name}`);
        expect(errors).toEqual([]);
      });
});

export { apply, endTurn };
