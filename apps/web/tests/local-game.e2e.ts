/* eslint-disable no-await-in-loop -- Each browser action depends on the preceding game state. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { standardFixedBoard } from '@cp2p/maps';
import type { DevHook } from '../src/features/devtools/hook.js';

declare global {
  interface Window {
    __cp2p?: DevHook;
  }
}

interface NewGameOptions {
  players: 3 | 4;
  humans: readonly number[];
  fixedBoard?: boolean;
}

const fixedBoard = standardFixedBoard();
const fixedGraph = buildBoardGraph(fixedBoard.hexes);
const dualResourceSites = fixedGraph.vertexIds.filter((_, index) => {
  const terrain = fixedGraph.vertexHexes[index]?.map(
    (id) => fixedBoard.hexes.find((hex) => hex.id === id)?.terrain,
  );
  return terrain?.includes('hills') && terrain.includes('forest');
});
const dualResourceSiteIds = new Set<string>(dualResourceSites);
const reservedSites = new Set<string>(
  dualResourceSites.flatMap((vertex) => [
    vertex,
    ...(fixedGraph.vertexNeighbors[fixedGraph.vertexIndex[vertex] ?? -1] ?? []),
  ]),
);
const pageErrors = new WeakMap<Page, string[]>();

async function createGame(page: Page, options: NewGameOptions): Promise<void> {
  const browserErrors: string[] = [];
  pageErrors.set(page, browserErrors);
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  await page.goto('/#/local/new');
  await page.getByLabel('Player count').selectOption(String(options.players));
  for (let seat = 0; seat < options.players; seat++) {
    await page
      .getByLabel(`Player ${seat + 1} control`)
      .selectOption(options.humans.includes(seat) ? 'human' : 'bot');
  }
  if (options.fixedBoard) await page.getByLabel('Map layout').selectOption('standard-fixed');
  await page.getByText('Advanced rules').click();
  await page.getByLabel('Bot pace, milliseconds').fill('0');
  await page.getByRole('button', { name: 'Create game' }).click();
  await expect(page).toHaveURL(/#\/local\/[^/]+$/);
  if (await page.getByRole('heading', { name: "This page couldn't load." }).isVisible())
    throw new Error(`Game route failed: ${browserErrors.join(' | ')}`);
  await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__cp2p')))).toBe(true);
}

async function revealIfCovered(page: Page): Promise<void> {
  const reveal = page.getByRole('button', { name: 'Reveal hand' });
  if (await reveal.isVisible()) await reveal.click();
}

test('four zero-delay bots finish a default ten-point game on the game screen', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'chromium', 'Long local-game acceptance runs in Chromium');
  test.setTimeout(180_000);
  await createGame(page, { players: 4, humans: [] });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
          return hook?.session.getState().result?.winner ?? null;
        }),
      { timeout: 150_000 },
    )
    .not.toBeNull();
  await expect(page.getByRole('heading', { name: /wins/ })).toBeVisible();
  const target = await page.evaluate(() => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    const base = hook?.session.getState().config.options.base;
    return typeof base === 'object' && base !== null && Reflect.get(base, 'vpTarget');
  });
  expect(target).toBe(10);
});

async function completeSetup(page: Page, input: 'mouse' | 'touch'): Promise<void> {
  // The browser hook only reads legal targets and their canvas coordinates.
  for (let placement = 0; placement < 12; placement++) {
    await revealIfCovered(page);
    if (await page.getByRole('heading', { name: "This page couldn't load." }).isVisible())
      throw new Error(`Game route failed during setup: ${pageErrors.get(page)?.join(' | ')}`);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
          const actions = hook?.diagnostics().actions;
          return Boolean(
            hook?.renderer &&
            ((actions?.placements.settlement.length ?? 0) > 0 ||
              (actions?.placements.road.length ?? 0) > 0),
          );
        }),
      )
      .toBe(true);
    const target = await page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      if (!hook?.renderer) return null;
      const actions = hook.diagnostics().actions;
      const state = hook.session.getState();
      return {
        settlements: actions?.placements.settlement.map((item) => item.id) ?? [],
        road: actions?.placements.road[0]?.id ?? null,
        pieces: state.board.buildings.length + state.board.roads.length,
      };
    });
    if (!target) throw new Error(`Missing setup target ${placement}`);
    const settlement = target.settlements.length > 0;
    const id = settlement
      ? placement === 10
        ? target.settlements.find((candidate) => dualResourceSiteIds.has(candidate))
        : target.settlements.find((candidate) => !reservedSites.has(candidate))
      : target.road;
    if (!id) throw new Error(`No suitable setup site at placement ${placement}`);
    const point = await page.evaluate(
      ({ kind, id: targetId }) => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        // The ID is one of the exact engine-provided legal targets selected above.
        // eslint-disable-next-line typescript/no-unsafe-type-assertion
        return hook?.pixelPosition({ kind, id: targetId } as never) ?? null;
      },
      { kind: settlement ? 'vertex' : 'edge', id },
    );
    if (!point) throw new Error(`Renderer has no coordinate for ${id}`);
    if (input === 'touch') await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
          const state = hook?.session.getState();
          return state ? state.board.buildings.length + state.board.roads.length : -1;
        }),
      )
      .toBeGreaterThan(target.pieces);
  }
}

test('three-human hotseat setup uses board clicks, then rolls and builds a road', async ({
  page,
}) => {
  test.skip(test.info().project.name !== 'chromium', 'Interactive acceptance runs in Chromium');
  test.setTimeout(120_000);
  await createGame(page, { players: 3, humans: [0, 1, 2], fixedBoard: true });
  await completeSetup(page, 'mouse');
  await rollAndBuildRoad(page, 'mouse');
});

async function rollAndBuildRoad(page: Page, input: 'mouse' | 'touch'): Promise<void> {
  await revealIfCovered(page);
  await page.getByRole('button', { name: 'Roll dice' }).click();
  let reachedMain = false;
  for (let step = 0; step < 20; step++) {
    const view = await page.evaluate(() => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      return {
        phase: hook?.session.getState().turn.phase.at(-1)?.id,
        robber: hook?.diagnostics().actions?.placements.robber[0]?.id,
        steal: hook?.diagnostics().actions?.stealTargets.length ?? 0,
        revision: hook?.diagnostics().revision ?? -1,
      };
    });
    if (view.phase === 'main') {
      reachedMain = true;
      break;
    }
    if (view.robber) {
      await clickLegalPlacement(page, 'hex', view.robber, view.revision, input);
    } else if (view.steal > 0) {
      const victim = page.getByRole('dialog', { name: 'Steal a card' }).getByRole('button').first();
      if (input === 'touch') await victim.tap();
      else await victim.click();
    } else await page.waitForTimeout(20);
  }
  expect(reachedMain, 'Roll and any robber interruption must reach the main phase').toBe(true);
  // The ordinary action dock must offer an affordable road after this setup.
  const roadAction = page
    .getByRole('group', { name: 'Choose a board action' })
    .getByRole('button', { name: 'road edge' });
  if (await roadAction.isVisible()) {
    if (input === 'touch') await roadAction.tap();
    else await roadAction.click();
  }
  const target = await page.evaluate(() => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    if (!hook?.renderer) return null;
    const roads = hook.diagnostics().actions?.placements.road ?? [];
    for (const road of roads) {
      // The engine supplied this edge as a concrete legal action.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      const point = hook.pixelPosition({ kind: 'edge', id: road.id } as never);
      if (
        point &&
        document.elementFromPoint(point.x, point.y) instanceof HTMLCanvasElement &&
        hook.renderer.hitTest(point, 'edge')?.id === road.id
      )
        return { ...point, id: road.id, roads: hook.session.getState().board.roads.length };
    }
    return null;
  });
  if (!target) throw new Error('No legal road center passed renderer hit testing');
  if (input === 'touch') await page.touchscreen.tap(target.x, target.y);
  else await page.mouse.click(target.x, target.y);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.session.getState().board.roads.length ?? -1;
      }),
    )
    .toBeGreaterThan(target.roads);
}

test('phone touch controls complete hotseat setup, roll, and road placement', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Touch acceptance runs in mobile Chromium');
  test.setTimeout(120_000);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await createGame(page, { players: 3, humans: [0, 1, 2], fixedBoard: true });
    await completeSetup(page, 'touch');
    await rollAndBuildRoad(page, 'touch');
  } finally {
    await context.close();
  }
});

test('four zero-delay bots finish a default ten-point game on a phone viewport', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Mobile completion runs in Chromium');
  test.setTimeout(180_000);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  try {
    const page = await context.newPage();
    await createGame(page, { players: 4, humans: [] });
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
            return hook?.session.getState().result?.winner ?? null;
          }),
        { timeout: 150_000 },
      )
      .not.toBeNull();
    await expect(page.getByRole('heading', { name: /wins/ })).toBeVisible();
  } finally {
    await context.close();
  }
});

async function clickLegalPlacement(
  page: Page,
  kind: 'vertex' | 'edge' | 'hex',
  id: string,
  revision: number,
  input: 'mouse' | 'touch' = 'mouse',
): Promise<void> {
  const point = await page.evaluate(
    ({ kind: hitKind, id: targetId }) => {
      const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
      // The target is selected from this same hook's exact legal actions.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      return hook?.pixelPosition({ kind: hitKind, id: targetId } as never) ?? null;
    },
    { kind, id },
  );
  if (!point) throw new Error(`Missing board coordinate for ${id}`);
  await expect
    .poll(() =>
      page.evaluate(({ x, y }) => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.renderer?.hitTest({ x, y })?.id ?? null;
      }, point),
    )
    .toBe(id);
  if (input === 'touch') await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.diagnostics().revision ?? -1;
      }),
    )
    .toBeGreaterThan(revision);
}

async function clickAction(page: Page, name: string, revision: number): Promise<void> {
  await page.getByRole('button', { name, exact: true }).first().click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
        return hook?.diagnostics().revision ?? -1;
      }),
    )
    .toBeGreaterThan(revision);
}

async function chooseKeyboardPlacement(
  page: Page,
  kind: 'vertex' | 'edge' | 'hex',
  id: string,
  revision: number,
): Promise<void> {
  const chooser = page.getByTestId('board-keyboard-targets');
  if ((await chooser.getAttribute('open')) === null) await chooser.locator('summary').click();
  await chooser.getByLabel('Board location').selectOption(`${kind}:${id}`);
  await chooser.getByRole('button', { name: 'Select location' }).click();
  try {
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
          return hook?.diagnostics().revision ?? -1;
        }),
      )
      .toBeGreaterThan(revision);
  } catch (error) {
    const screen = await page.locator('body').innerText();
    throw new Error(
      `Keyboard ${kind}:${id} at revision ${revision} failed: ${String(error)}; browser errors: ${pageErrors.get(page)?.join(' | ')}; screen: ${screen.slice(0, 1000)}`,
      { cause: error },
    );
  }
}

async function playVisibleHumanStep(page: Page): Promise<'complete' | 'acted' | 'waiting'> {
  if (await page.getByRole('heading', { name: "This page couldn't load." }).isVisible())
    throw new Error(`Game route failed: ${pageErrors.get(page)?.join(' | ')}`);
  await revealIfCovered(page);
  const view = await page.evaluate(() => {
    const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
    if (!hook) return null;
    const state = hook.session.getState();
    const human = hook.session.controllableSeats()[0];
    return {
      result: state.result,
      phase: state.turn.phase.at(-1)?.id,
      actions: hook.diagnostics().actions,
      revision: hook.diagnostics().revision,
      hand: human === undefined ? null : hook.session.getPrivate(human)?.hand,
      rejectionCount: hook.diagnostics().rejectionCount,
    };
  });
  if (!view) return 'waiting';
  if (view.rejectionCount !== 0)
    throw new Error(`Ordinary UI rejected ${view.rejectionCount} inputs`);
  if (view.result) return 'complete';
  const actions = view.actions;
  if (!actions) return 'waiting';
  if (view.phase === 'setup') {
    const settlement = actions.placements.settlement[0];
    const road = actions.placements.road[0];
    const choice = settlement ?? road;
    if (!choice) return 'waiting';
    await chooseKeyboardPlacement(page, settlement ? 'vertex' : 'edge', choice.id, view.revision);
    return 'acted';
  }
  const discard = actions.templates.find((group) => group.type === 'DISCARD')?.templates[0];
  if (discard && typeof discard.count === 'number' && view.hand) {
    let remaining = discard.count;
    for (const resource of ['brick', 'lumber', 'wool', 'grain', 'ore'] as const) {
      const count = Math.min(remaining, view.hand[resource] ?? 0);
      if (count > 0) {
        await page
          .getByRole('spinbutton', {
            name: `Cards to discard: ${resource[0]?.toUpperCase()}${resource.slice(1)}`,
          })
          .fill(String(count));
        remaining -= count;
      }
    }
    if (remaining !== 0) throw new Error('Could not compose the required discard');
    await clickAction(page, 'Confirm', view.revision);
    return 'acted';
  }
  if (actions.placements.robber[0]) {
    await chooseKeyboardPlacement(page, 'hex', actions.placements.robber[0].id, view.revision);
    return 'acted';
  }
  if (actions.stealTargets.length > 0) {
    await page.getByRole('dialog', { name: 'Steal a card' }).getByRole('button').first().click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
          return hook?.diagnostics().revision ?? -1;
        }),
      )
      .toBeGreaterThan(view.revision);
    return 'acted';
  }
  if (actions.primary.some((group) => group.type === 'RESPOND_TRADE')) {
    await clickAction(page, 'Decline', view.revision);
    return 'acted';
  }
  if (actions.primary.some((group) => group.type === 'ROLL_DICE')) {
    await clickAction(page, 'Roll dice', view.revision);
    return 'acted';
  }
  if (view.phase === 'main') {
    for (const [kind, label] of [
      ['city', 'city site'],
      ['settlement', 'settlement spot'],
    ] as const) {
      const choice = actions.placements[kind][0];
      if (!choice) continue;
      const chooser = page
        .getByRole('group', { name: 'Choose a board action' })
        .getByRole('button', { name: label });
      if (await chooser.isVisible()) await chooser.click();
      await chooseKeyboardPlacement(page, 'vertex', choice.id, view.revision);
      return 'acted';
    }
    if (actions.primary.some((group) => group.type === 'BUY_DEV_CARD')) {
      await clickAction(page, 'Buy development card', view.revision);
      return 'acted';
    }
  }
  if (actions.primary.some((group) => group.type === 'END_TURN')) {
    await clickAction(page, 'End turn', view.revision);
    return 'acted';
  }
  if (actions.primary.some((group) => group.type === 'CLAIM_VICTORY')) {
    await clickAction(page, 'Claim victory', view.revision);
    return 'acted';
  }
  return 'waiting';
}

test('twenty complete ten-point games use only offered visible controls without rejected inputs', async ({
  browser,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'The full UI acceptance run uses Chromium');
  test.setTimeout(1_800_000);
  for (let game = 0; game < 20; game++) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await createGame(page, { players: 4, humans: [0] });
      let completed = false;
      for (let step = 0; step < 2_000; step++) {
        const result = await playVisibleHumanStep(page);
        if (result === 'complete') {
          completed = true;
          break;
        }
        if (result === 'waiting') await page.waitForTimeout(20);
      }
      expect(completed, `Game ${game + 1} did not complete`).toBe(true);
      await expect(page.getByRole('heading', { name: /wins/ })).toBeVisible();
      expect(errors, `Game ${game + 1} had browser errors`).toEqual([]);
    } finally {
      await context.close();
    }
  }
});
