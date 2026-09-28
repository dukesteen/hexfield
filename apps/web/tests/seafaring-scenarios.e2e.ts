/* eslint-disable no-await-in-loop -- Each step of the autoplay depends on the game the last one left. */
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandShape, GameState, Seat } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import type { BoardGraph } from '@cp2p/engine/geometry';
import {
  VIEWPORTS,
  VIEWPORT_NAMES,
  gameState,
  hexCornersOutside,
  isPhone,
  newLocalGame,
} from './helpers/seafaring-board.js';

/** Every seafaring scenario the lobby offers, each with the seat count that lists it. */
const SCENARIOS = [
  'new-horizons',
  'new-horizons-56',
  'four-isles',
  'four-isles-56',
  'fogbound',
  'desert-crossing',
  'open-sea',
  'open-sea-56',
] as const;

/** The human seat: the first one, as the lobby sets it up. */
const SEAT: Seat = 0;

/** Where screenshots go: `SEAFARING_SHOTS` when set, otherwise the test's own output folder. */
async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const folder = process.env.SEAFARING_SHOTS ?? testInfo.outputDir;
  await mkdir(folder, { recursive: true });
  const body = await page.screenshot({ path: join(folder, `${name}.png`) });
  await testInfo.attach(name, { body, contentType: 'image/png' });
}

function legalCommands(page: Page): Promise<CommandShape[]> {
  return page.evaluate((seat) => {
    const legal = window['__cp2p']?.session.getLegalCommands(seat);
    const commands = structuredClone(legal?.commands ?? []);
    // A discard is a template, not a list of commands: fill it greedily from the private hand.
    const hand: Record<string, number> = { ...window['__cp2p']?.session.getPrivate(seat)?.hand };
    for (const template of legal?.templates ?? []) {
      if (template.type !== 'DISCARD') continue;
      const cards: Record<string, number> = {};
      let left = template.count ?? 0;
      for (const kind of ['brick', 'lumber', 'wool', 'grain', 'ore']) {
        const take = Math.min(left, hand[kind] ?? 0);
        if (take > 0) cards[kind] = take;
        left -= take;
      }
      commands.push({ type: 'DISCARD', cards });
    }
    return commands;
  }, SEAT);
}

async function submit(page: Page, command: CommandShape): Promise<string | null> {
  return page.evaluate(
    async ({ seat, cmd }) => {
      const result = await window['__cp2p']?.session.submit(seat, cmd);
      return result && !result.ok ? `${result.error.code}: ${result.error.message}` : null;
    },
    { seat: SEAT, cmd: command },
  );
}

/** How many fog hexes the board still has. */
const fogLeft = (state: GameState): number =>
  state.board.hexes.filter((hex) => hex.terrain === 'fog').length;

/** Hexes an edge or a vertex touches, by graph lookup. */
function hexesAt(graph: BoardGraph, command: CommandShape): string[] {
  const edge = command.edge ?? command.to;
  if (typeof edge === 'string') {
    const ends = graph.edgeVertices[graph.edgeIndex[edge] ?? -1] ?? [];
    return ends.flatMap((vertex) => [
      ...(graph.vertexHexes[graph.vertexIndex[vertex] ?? -1] ?? []),
    ]);
  }
  if (typeof command.vertex === 'string')
    return [...(graph.vertexHexes[graph.vertexIndex[command.vertex] ?? -1] ?? [])];
  return [];
}

/**
 * How far a placement is from the nearest fog hex, in hexes; -1 when it touches one. Infinity
 * when the board has no fog left or the command places nothing.
 */
function fogDistance(command: CommandShape, state: GameState, graph: BoardGraph): number {
  const fog = state.board.hexes.filter((hex) => hex.terrain === 'fog');
  const touched = hexesAt(graph, command);
  if (fog.length === 0 || touched.length === 0) return Infinity;
  if (touched.some((id) => fog.some((hex) => hex.id === id))) return -1;
  const cells = state.board.hexes.filter((hex) => touched.includes(hex.id));
  const q = cells.reduce((sum, hex) => sum + hex.q, 0) / cells.length;
  const r = cells.reduce((sum, hex) => sum + hex.r, 0) / cells.length;
  return Math.min(
    ...fog.map((hex) =>
      Math.max(Math.abs(hex.q - q), Math.abs(hex.r - r), Math.abs(hex.q - q + hex.r - r)),
    ),
  );
}

/**
 * How much a placement is worth avoiding when the game seeks fog: its distance to fog, and for a
 * settlement also a bonus for a coast and per adjacent forest or pasture, whose lumber and wool
 * pay for ships.
 */
function placementCost(command: CommandShape, state: GameState, graph: BoardGraph): number {
  const distance = fogDistance(command, state, graph);
  if (command.type !== 'PLACE_SETTLEMENT') return distance;
  const terrainAt = (vertexHexes: readonly string[]) =>
    state.board.hexes.filter((hex) => vertexHexes.includes(hex.id));
  const around = terrainAt(hexesAt(graph, command));
  // The second settlement makes up for whichever of forest and pasture the first one lacks.
  const have = new Set(
    state.board.buildings
      .filter((building) => building.seat === SEAT)
      .flatMap((building) =>
        terrainAt(graph.vertexHexes[graph.vertexIndex[building.vertex] ?? -1] ?? []),
      )
      .map((hex) => hex.terrain),
  );
  const newly = ['forest', 'pasture'].filter(
    (terrain) => !have.has(terrain) && around.some((hex) => hex.terrain === terrain),
  );
  // A ship needs a coast to start from.
  const coastal = around.some((hex) => hex.terrain === 'sea' || hex.terrain === 'fog');
  return distance - 6 * newly.length - (coastal ? 6 : 0);
}

/** Move types the autoplay takes in order of preference; anything not listed is never sent. */
const PREFERENCE: readonly string[] = [
  'CHOOSE_GOLD',
  'DISCARD',
  'MOVE_ROBBER',
  'MOVE_PIRATE',
  'STEAL',
  'PLACE_SETTLEMENT',
  'PLACE_ROAD',
  'PLACE_SETUP_SHIP',
  'PLACE_FREE_ROAD',
  'PLACE_FREE_SHIP',
  'ROLL_DICE',
  'RESPOND_TRADE',
  'BUILD_SHIP',
  'END_TURN',
  'END_SBP',
  'SKIP',
];
const rankOf = (command: CommandShape): number => PREFERENCE.indexOf(command.type);

/**
 * The move the human takes next: the most preferred kind, and among placements of one kind the one
 * closest to fog. With `seekFog` off, ships are never built, so the hand is never spent.
 */
function chooseMove(
  commands: readonly CommandShape[],
  state: GameState,
  graph: BoardGraph,
  seekFog: boolean,
): CommandShape | null {
  return (
    commands
      .filter(
        (command) =>
          rankOf(command) >= 0 &&
          (command.type !== 'RESPOND_TRADE' || command.accept === false) &&
          (seekFog || command.type !== 'BUILD_SHIP'),
      )
      .map((command) => ({
        command,
        rank: rankOf(command),
        distance: seekFog ? placementCost(command, state, graph) : 0,
      }))
      .toSorted((a, b) => a.rank - b.rank || a.distance - b.distance)[0]?.command ?? null
  );
}

/** Dice faces that add up to `total`. */
function facesFor(total: number): [number, number] {
  const first = Math.max(1, total - 6);
  return [first, total - first];
}

/**
 * Set the human's next roll to a number that pays the lumber or wool a ship costs, whichever the
 * hand has less of, so a fog game can sail toward its fog. Any other roll is a 2.
 */
async function steerRoll(page: Page, state: GameState, graph: BoardGraph): Promise<void> {
  const hand = await page.evaluate(
    (seat) => ({ lumber: 0, wool: 0, ...window['__cp2p']?.session.getPrivate(seat)?.hand }),
    SEAT,
  );
  const hexes = new Map(state.board.hexes.map((hex) => [hex.id, hex]));
  const around = state.board.buildings
    .filter((building) => building.seat === SEAT)
    .flatMap((building) => graph.vertexHexes[graph.vertexIndex[building.vertex] ?? -1] ?? [])
    .flatMap((id) => hexes.get(id) ?? []);
  const tokensOf = (terrain: string) =>
    around.flatMap((hex) => (hex.terrain === terrain && hex.token ? [hex.token] : []));
  const lacking = hand.lumber <= hand.wool ? ['forest', 'pasture'] : ['pasture', 'forest'];
  const tokens = tokensOf(lacking[0] ?? '').length
    ? tokensOf(lacking[0] ?? '')
    : tokensOf(lacking[1] ?? '');
  await page.evaluate(
    (faces) => {
      const session = window['__cp2p']?.session;
      if (session && 'forceDice' in session && typeof session.forceDice === 'function')
        Reflect.apply(session.forceDice, session, [faces]);
    },
    facesFor(tokens[0] ?? 2),
  );
}

/**
 * Freeze the game the moment the board loses fog, so a screenshot can catch the reveal while it
 * plays. `setPaused(false)` (see `resume`) lets the game go on.
 */
async function pauseOnReveal(page: Page): Promise<void> {
  await page.evaluate(() => {
    const session = window['__cp2p']?.session;
    const setPaused = Reflect.get(session ?? {}, 'setPaused');
    if (!session || typeof setPaused !== 'function') return;
    let last = session.getState().board.hexes.filter((hex) => hex.terrain === 'fog').length;
    session.subscribe((update) => {
      const now = update.state.board.hexes.filter((hex) => hex.terrain === 'fog').length;
      if (now < last) Reflect.apply(setPaused, session, [true]);
      last = now;
    });
  });
}

function resume(page: Page): Promise<void> {
  return page.evaluate(() => {
    const session = window['__cp2p']?.session;
    const setPaused = Reflect.get(session ?? {}, 'setPaused');
    if (session && typeof setPaused === 'function') Reflect.apply(setPaused, session, [false]);
  });
}

interface PlayOptions {
  /** Stop once this many turns have passed after the setup. */
  turns: number;
  /** Build ships toward fog, steering the human's rolls to pay for them. */
  seekFog: boolean;
  /** Stop earlier, once this holds of the game. */
  until?: (state: GameState) => boolean;
  /** Called each time the board loses fog, with the hexes that were revealed. */
  onReveal?: (hexes: readonly { q: number; r: number }[]) => Promise<void>;
}

/** Play the human seat by legal moves while the bots take the rest, until `turns` have passed. */
async function autoplay(
  page: Page,
  options: PlayOptions,
): Promise<{ moves: number; reveals: number }> {
  let moves = 0;
  let reveals = 0;
  let setupEnded: number | null = null;
  let lastProgress = Date.now();
  let lastSeen = '';
  let previous: GameState | null = null;
  for (;;) {
    const state = await gameState(page);
    // A reveal by any seat, the human's own or a bot's, is caught on the loop after it happens.
    if (previous !== null && fogLeft(state) < fogLeft(previous)) {
      reveals += 1;
      const was = new Set(
        previous.board.hexes.filter((hex) => hex.terrain === 'fog').map((hex) => hex.id),
      );
      await options.onReveal?.(
        state.board.hexes.filter((hex) => was.has(hex.id) && hex.terrain !== 'fog'),
      );
    }
    previous = state;
    if (state.result || options.until?.(state)) return { moves, reveals };
    const inSetup = state.turn.phase.some((frame) => frame.id === 'setup');
    if (!inSetup && setupEnded === null) setupEnded = state.turn.number;
    if (setupEnded !== null && state.turn.number >= setupEnded + options.turns)
      return { moves, reveals };
    const commands = await legalCommands(page);
    const graph = buildBoardGraph(state.board.hexes);
    const move = commands.length ? chooseMove(commands, state, graph, options.seekFog) : null;
    if (move) {
      if (move.type === 'ROLL_DICE' && options.seekFog) await steerRoll(page, state, graph);
      const failure = await submit(page, move);
      // A paused game (frozen on a reveal for a screenshot) simply waits.
      if (failure?.startsWith('session-paused')) {
        await page.waitForTimeout(30);
        continue;
      }
      if (failure) throw new Error(`The human's ${move.type} was refused: ${failure}`);
      moves += 1;
      lastProgress = Date.now();
    } else {
      await page.waitForTimeout(30);
      const seen = `${state.turn.number}${JSON.stringify(state.turn.phase)}`;
      if (seen !== lastSeen) {
        lastSeen = seen;
        lastProgress = Date.now();
      }
    }
    if (Date.now() - lastProgress > 20_000) {
      const pending = await page.evaluate(() => window['__cp2p']?.session.getPending());
      throw new Error(`The game stalled: ${JSON.stringify(state.turn)} ${JSON.stringify(pending)}`);
    }
  }
}

test.describe('every seafaring scenario against bots', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Seafaring UI runs in Chromium');

  for (const scenario of SCENARIOS) {
    test(`${scenario} starts, fits the screen and plays on`, async ({ page }, testInfo) => {
      test.setTimeout(150_000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize(VIEWPORTS.desktop);
      await newLocalGame(page, scenario);
      const start = await gameState(page);
      expect(start.config.modules.map((module) => module.id)).toContain('seafaring');
      expect(start.board.ships).toEqual([]);
      // The default camera shows every hex, the water ring, the harbors and the pirate.
      await expect.poll(() => hexCornersOutside(page, start)).toBe(0);
      await expect(page.locator('.board-view-canvas canvas')).toBeVisible();
      await shot(page, testInfo, `board-${scenario}`);

      const played = await autoplay(page, { turns: start.config.seats.length + 2, seekFog: false });
      expect(played.moves).toBeGreaterThan(4);
      const end = await gameState(page);
      expect(end.turn.number).toBeGreaterThan(start.turn.number);
      expect(end.board.buildings.length).toBeGreaterThanOrEqual(start.config.seats.length * 2);
      expect(errors).toEqual([]);
      await shot(page, testInfo, `played-${scenario}`);
    });
  }

  test('fogbound reveals fog: the tile flips, the log says so and the reward arrives', async ({
    page,
  }, testInfo) => {
    test.setTimeout(170_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize(VIEWPORTS.desktop);
    await newLocalGame(page, 'fogbound');
    const start = await gameState(page);
    const fogAtStart = fogLeft(start);
    expect(fogAtStart).toBeGreaterThan(0);
    let flipShot = false;
    await pauseOnReveal(page);
    await autoplay(page, {
      turns: 90,
      seekFog: true,
      until: (state) => fogLeft(state) < fogAtStart,
      onReveal: async (hexes) => {
        if (flipShot) return;
        flipShot = true;
        // The game is frozen and the fog tile is turning: catch it early, mid-turn and settled.
        expect(
          await page.evaluate(() => window['__cp2p']?.renderer?.getDiagnostics().activeEffects),
        ).toBeGreaterThan(0);
        // Small clips around the tile are quick enough to catch it turning.
        const at = await page.evaluate(
          (hex) => {
            const size = 54;
            return window['__cp2p']?.renderer?.boardToScreen({
              x: Math.sqrt(3) * size * (hex.q + hex.r / 2),
              y: 1.5 * size * hex.r,
            });
          },
          hexes[0] ?? { q: 0, r: 0 },
        );
        if (at)
          for (let frame = 0; frame < 6; frame++) {
            const body = await page.screenshot({
              path: join(
                process.env.SEAFARING_SHOTS ?? testInfo.outputDir,
                `fogbound-reveal-clip-${frame}.png`,
              ),
              clip: {
                x: Math.max(0, at.x - 130),
                y: Math.max(0, at.y - 130),
                width: 260,
                height: 260,
              },
            });
            await testInfo.attach(`clip-${frame}`, { body, contentType: 'image/png' });
          }
        await shot(page, testInfo, 'fogbound-reveal-1-start');
        await page.waitForTimeout(300);
        await shot(page, testInfo, 'fogbound-reveal-2-settled');
        // A gold tile then opens its choice dialog, which waited for the reveal to finish.
        await page.waitForTimeout(500);
        await shot(page, testInfo, 'fogbound-reveal-3-after');
        await resume(page);
      },
    });
    const end = await gameState(page);
    const mine = end.board.buildings.filter((building) => building.seat === SEAT);
    const debug = await page.evaluate(
      (seat) => ({
        hand: window['__cp2p']?.session.getPrivate(seat)?.hand,
        legal: window['__cp2p']?.session.getLegalCommands(seat).commands.map((c) => c.type),
      }),
      SEAT,
    );
    expect(
      fogLeft(end),
      `no fog revealed by turn ${end.turn.number}; mine ${JSON.stringify(mine)}; ${JSON.stringify(debug)}; ships ${JSON.stringify(end.board.ships)}`,
    ).toBeLessThan(fogAtStart);
    // A revealed hex is a real tile now, with a token unless it is sea or desert.
    const revealed = end.board.hexes.filter(
      (hex) =>
        start.board.hexes.find((old) => old.id === hex.id)?.terrain === 'fog' &&
        hex.terrain !== 'fog',
    );
    expect(revealed.length).toBe(fogAtStart - fogLeft(end));
    for (const hex of revealed)
      expect(hex.token !== null).toBe(hex.terrain !== 'sea' && hex.terrain !== 'desert');
    // The log names the reveal.
    await expect(
      page.locator('.event-log-message', { hasText: /revealed/ }).first(),
    ).toBeAttached();
    await shot(page, testInfo, 'fogbound-after-reveal');
    expect(errors).toEqual([]);
  });

  test('a fog reveal is skipped at once with reduced motion', async ({ browser }, testInfo) => {
    test.setTimeout(170_000);
    const context = await browser.newContext({
      viewport: VIEWPORTS.desktop,
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await newLocalGame(page, 'fogbound');
      const fogAtStart = fogLeft(await gameState(page));
      let checked = false;
      await autoplay(page, {
        turns: 90,
        seekFog: true,
        until: (state) => fogLeft(state) < fogAtStart,
        onReveal: async () => {
          checked = true;
          expect(
            await page.evaluate(() => window['__cp2p']?.renderer?.getDiagnostics().activeEffects),
          ).toBe(0);
        },
      });
      expect(checked).toBe(true);
      await shot(page, testInfo, 'fogbound-reveal-reduced-motion');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  for (const scenario of SCENARIOS) {
    for (const name of VIEWPORT_NAMES) {
      test(`${scenario} fits a ${name} screen at the default zoom`, async ({
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
          await newLocalGame(page, scenario);
          const state = await gameState(page);
          await expect.poll(() => hexCornersOutside(page, state)).toBe(0);
          if (scenario === 'new-horizons' || scenario === 'open-sea-56')
            await shot(page, testInfo, `fit-${scenario}-${name}`);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      });
    }
  }
});
