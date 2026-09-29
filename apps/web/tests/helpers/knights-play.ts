/* eslint-disable no-await-in-loop -- Each step of the autoplay depends on the game the last one left. */
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { knightsExt } from '@cp2p/engine';
import type { CommandShape, GameState, KnightsExt, Seat } from '@cp2p/engine';
import type { DevHook } from '../../src/features/devtools/hook.js';
import { waitForRenderer } from './renderer-ready.js';

declare global {
  interface Window {
    __cp2p?: DevHook;
  }
}

/** The human seat: the first one, as the lobby sets it up. */
export const SEAT: Seat = 0;

export function knightsOf(state: GameState): KnightsExt {
  return knightsExt(state);
}

/**
 * Leave a game this page still shows through its own menu. The game screen guards in-app
 * navigation with a leave prompt, so a plain hash change to the lobby would stop at the prompt.
 */
async function leaveOpenGame(page: Page): Promise<void> {
  if (!/#\/local\/(?!new\b)[^/]+$/.test(page.url())) return;
  const menu = page.locator('.game-menu');
  if (!(await menu.evaluate((element) => element instanceof HTMLDetailsElement && element.open)))
    await menu.locator(':scope > summary').click();
  await page.locator('.game-menu-panel').getByRole('button', { name: 'Leave game' }).click();
  const prompt = page.getByRole('dialog').filter({
    has: page.getByRole('heading', { name: 'Leave this game?' }),
  });
  await prompt.getByRole('button', { name: 'Save and leave' }).click();
  // The save finishes before the screen moves home; wait for home itself, not just its URL.
  await expect(page.getByRole('link', { name: 'New local game' })).toBeVisible();
}

/** Start a local Cities and Knights game from the lobby form, the human at seat 0. */
export async function startKnightsGame(
  page: Page,
  options: { scenario?: string; seats?: number } = {},
): Promise<void> {
  await leaveOpenGame(page);
  await page.goto('/#/local/new');
  await page.locator('#player-count').selectOption(String(options.seats ?? 4));
  await page.locator('.scenario-picker select').selectOption(options.scenario ?? 'knights');
  await page.getByText('Advanced rules').click();
  await page.getByLabel('Bot pace, milliseconds').fill('0');
  await page.getByRole('button', { name: 'Create game' }).click();
  await expect(page).toHaveURL(/#\/local\/[^/]+$/);
  await waitForRenderer(page);
}

export function gameState(page: Page): Promise<GameState> {
  return page.evaluate(() => {
    const hook = window['__cp2p'];
    if (!hook) throw new Error('No dev hook');
    return structuredClone(hook.session.getState());
  });
}

/** What the human is asked for right now: the commands the engine allows it. */
function allowedNow(page: Page): Promise<string[]> {
  return page.evaluate((seat) => {
    const session = window['__cp2p']?.session;
    if (!session) throw new Error('No dev hook');
    if (session.getState().result) return ['GAME_OVER'];
    const pending = session
      .getPending()
      .flatMap((item) => (item.kind === 'player' && item.seat === seat ? [item] : []))[0];
    return pending ? [...pending.allowed] : [];
  }, SEAT);
}

/** Submit the human's first legal command of a preferred type (in order), else any. */
export function humanSubmit(page: Page, prefer: readonly string[]): Promise<string> {
  return page.evaluate(
    async ({ seat, order }) => {
      const session = window['__cp2p']?.session;
      if (!session) throw new Error('No dev hook');
      const pending = session
        .getPending()
        .flatMap((item) => (item.kind === 'player' && item.seat === seat ? [item] : []))[0];
      if (!pending) return 'wait';
      const legal = session.getLegalCommands(seat);
      const commands = legal.commands.filter((command) => pending.allowed.includes(command.type));
      const template = legal.templates.find(
        (item) =>
          ['DISCARD', 'SABOTEUR_DISCARD', 'WEDDING_GIVE'].includes(item.type) &&
          pending.allowed.includes(item.type),
      );
      if (template && typeof template.count === 'number') {
        const hand: Record<string, number> = { ...session.getPrivate(seat)?.hand };
        const cards: Record<string, number> = {};
        let left = template.count;
        for (const [kind, count] of Object.entries(hand).toSorted((a, b) => b[1] - a[1])) {
          const take = Math.min(count, left);
          if (take > 0) cards[kind] = take;
          left -= take;
        }
        const done = await session.submit(seat, { type: template.type, cards });
        return done.ok ? `ok:${template.type}` : `err:${done.error.code}`;
      }
      let pick: CommandShape | undefined;
      for (const type of order) {
        pick = commands.find((command) => command.type === type);
        if (pick) break;
      }
      pick ??= commands[0];
      if (!pick) return `none:${pending.allowed.join(',')}`;
      const done = await session.submit(seat, pick);
      return done.ok ? `ok:${pick.type}` : `err:${done.error.code}`;
    },
    { seat: SEAT, order: prefer },
  );
}

/**
 * Play the human through everything that is not its own decision (setup, forced discards,
 * pending choices) until it may `roll` or act in its `main` turn. Returns false when the game ends.
 */
export async function untilHumanTurn(page: Page, phase: 'roll' | 'main'): Promise<boolean> {
  const goal = phase === 'roll' ? 'ROLL_DICE' : 'END_TURN';
  for (let step = 0; step < 4000; step++) {
    const allowed = await allowedNow(page);
    if (allowed.includes('GAME_OVER')) return false;
    if (allowed.includes(goal)) return true;
    if (allowed.length === 0) {
      await page.waitForTimeout(20);
      continue;
    }
    const outcome = await humanSubmit(page, [
      'PLACE_SETTLEMENT',
      'PLACE_ROAD',
      'ROLL_DICE',
      'MOVE_ROBBER',
      'STEAL',
      'CHOOSE_PILLAGE',
      'RELOCATE_KNIGHT',
      'PLACE_METROPOLIS',
    ]);
    if (outcome.startsWith('err') || outcome.startsWith('none')) await page.waitForTimeout(30);
  }
  throw new Error('The human never got its turn');
}

/** Roll the dice from the turn button, with the next dice forced when asked. */
export async function rollDice(
  page: Page,
  forced?: { dice: readonly [number, number]; event?: string },
): Promise<void> {
  if (forced)
    await page.evaluate(({ dice, event }) => {
      const session = window['__cp2p']?.session;
      if (!session) throw new Error('No dev hook');
      if (!('forceDice' in session) || typeof session.forceDice !== 'function')
        throw new Error('This session cannot force dice');
      const result: { ok: boolean } = Reflect.apply(session.forceDice, session, [
        dice,
        event ? { event } : undefined,
      ]);
      if (!result.ok) throw new Error('The dice could not be forced');
    }, forced);
  await page.locator('.desktop-turn-button:visible, .mobile-turn-button:visible').first().click();
}

export async function endTurn(page: Page): Promise<void> {
  await page.locator('.desktop-turn-button:visible, .mobile-turn-button:visible').first().click();
}

/** Every command type the human may play right now in its main turn. */
export function legalTypes(page: Page): Promise<string[]> {
  return page.evaluate((seat) => {
    const session = window['__cp2p']?.session;
    if (!session) throw new Error('No dev hook');
    return session.getLegalCommands(seat).commands.map((command) => command.type);
  }, SEAT);
}

/** True while the printed barbarian track is on screen. */
export function trackInView(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const renderer = window['__cp2p']?.renderer;
    if (!renderer) throw new Error('No renderer');
    return renderer.isFixtureInView('barbarian-track');
  });
}

/** Swap surplus cards for the kinds asked for through the bank, until `need` is in hand. */
export async function ensureCards(
  page: Page,
  need: Readonly<Record<string, number>>,
): Promise<boolean> {
  for (let guard = 0; guard < 40; guard++) {
    const done = await page.evaluate(
      async ({ seat, wanted }) => {
        const session = window['__cp2p']?.session;
        if (!session) throw new Error('No dev hook');
        const held: Record<string, number> = { ...session.getPrivate(seat)?.hand };
        const missing = Object.entries(wanted).find(([kind, count]) => (held[kind] ?? 0) < count);
        if (!missing) return 'done';
        const spare = Object.entries(held)
          .filter(([kind, count]) => count - (wanted[kind] ?? 0) >= 2)
          .toSorted((a, b) => b[1] - (wanted[b[0]] ?? 0) - (a[1] - (wanted[a[0]] ?? 0)));
        for (const [kind] of spare)
          for (const rate of [2, 3, 4]) {
            if ((held[kind] ?? 0) - (wanted[kind] ?? 0) < rate) continue;
            const command = {
              type: 'MARITIME_TRADE',
              give: { [kind]: rate },
              get: { [missing[0]]: 1 },
            };
            const valid = await session.validate(seat, command);
            if (valid.ok && (await session.submit(seat, command)).ok) return 'traded';
          }
        return 'stuck';
      },
      { seat: SEAT, wanted: need },
    );
    if (done === 'done') return true;
    if (done === 'stuck') return false;
  }
  return false;
}
