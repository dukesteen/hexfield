import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { DevHook } from '../../src/features/devtools/hook.js';

/**
 * How long the board may take to load its textures before it reports ready. A 5-6 seat map with
 * seafaring and knights art draws on software WebGL here, which can take several seconds when the
 * machine is busy; the default five-second poll is not a budget for that.
 */
export const RENDERER_READY_MS = 20_000;

/** Wait until the game screen's board renderer has loaded and registered with the dev hook. */
export async function waitForRenderer(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const hook: DevHook | undefined = Reflect.get(window, '__cp2p');
          return Boolean(hook?.renderer);
        }),
      { message: 'The board renderer is ready', timeout: RENDERER_READY_MS },
    )
    .toBe(true);
}
