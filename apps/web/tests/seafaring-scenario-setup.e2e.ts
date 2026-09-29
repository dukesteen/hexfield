/* eslint-disable no-await-in-loop -- Each check depends on the game the page just created. */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SCENARIOS } from '@cp2p/maps';
import type { DevHook } from '../src/features/devtools/hook.js';
import { waitForRenderer } from './helpers/renderer-ready.js';

declare global {
  interface Window {
    __cp2p?: DevHook;
  }
}

const SEAFARING = SCENARIOS.filter((scenario) => scenario.modules.includes('seafaring'));

/** Create a local game from the setup form: the scenario's own board, the human at seat 0. */
async function newGame(page: Page, scenario: string, seats: number): Promise<void> {
  await page.goto('/#/local/new');
  await page.getByLabel('Player count').selectOption(String(seats));
  await page.locator('.scenario-picker select').selectOption(scenario);
  await page.getByText('Advanced rules').click();
  await page.getByLabel('Bot pace, milliseconds').fill('0');
  await page.getByRole('button', { name: 'Create game' }).click();
  await expect(page).toHaveURL(/#\/local\/[^/]+$/);
  await waitForRenderer(page);
}

/** Submit the first legal command of a type for the human seat, through the session. */
function submitFirst(page: Page, types: readonly string[]): Promise<string | null> {
  return page.evaluate(async (wanted) => {
    const session = window['__cp2p']?.session;
    if (!session) throw new Error('No dev hook');
    const command = session.getLegalCommands(0).commands.find((item) => wanted.includes(item.type));
    if (!command) return null;
    const result = await session.submit(0, command);
    return result.ok ? command.type : `rejected:${result.error.code}`;
  }, types);
}

test.describe('every seafaring scenario starts and plays locally', () => {
  for (const scenario of SEAFARING) {
    test(`${scenario.id}: the board draws and bots answer the human's setup pieces`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width: 1280, height: 900 });
      const seats = scenario.seats.max;
      await newGame(page, scenario.id, seats);
      const state = await page.evaluate(() => {
        const hook = window['__cp2p'];
        if (!hook) throw new Error('No dev hook');
        return structuredClone(hook.session.getState());
      });
      expect(state.config.modules.map((module) => module.id)).toContain('seafaring');
      expect(state.config.seats).toHaveLength(seats);
      expect(state.board.hexes.some((hex) => hex.terrain === 'sea')).toBe(true);
      // Every Fogbound map, at either seat count and with knights, hides hexes under fog.
      expect(state.board.hexes.some((hex) => hex.terrain === 'fog')).toBe(
        scenario.id.startsWith('fogbound'),
      );
      // A random seat starts, so bots placing first answer from their worker before the human.
      await expect
        .poll(() =>
          page.evaluate(() =>
            (window['__cp2p']?.session.getPending() ?? []).some(
              (item) =>
                item.kind === 'player' &&
                item.seat === 0 &&
                item.allowed.includes('PLACE_SETTLEMENT'),
            ),
          ),
        )
        .toBe(true);
      // The human places a settlement and its road (or ship), and the bots then place theirs.
      expect(await submitFirst(page, ['PLACE_SETTLEMENT'])).toBe('PLACE_SETTLEMENT');
      expect(await submitFirst(page, ['PLACE_ROAD', 'PLACE_SETUP_SHIP'])).toMatch(/^PLACE_/);
      await expect
        .poll(() =>
          page.evaluate(() => window['__cp2p']?.session.getState().board.buildings.length ?? 0),
        )
        .toBeGreaterThanOrEqual(seats);
      expect(errors).toEqual([]);
    });
  }
});
