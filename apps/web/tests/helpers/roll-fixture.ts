import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { GameState, Seat } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import { LocalSession } from '../../src/session/local-session.js';
import { saveBeforeGoldenInput } from '../golden-save.js';

const colors = ['blue', 'orange', 'green', 'magenta'] as const;
const shapes = ['circle', 'triangle', 'square', 'diamond'] as const;
const terrainKind: Readonly<Record<string, string>> = {
  hills: 'brick',
  forest: 'lumber',
  pasture: 'wool',
  fields: 'grain',
  mountains: 'ore',
};

/** The roll total (not 7) that pays `seat` the most cards, with its per-kind payout. */
export function bestRoll(
  state: GameState,
  seat: Seat,
): { total: number; gains: Record<string, number> } {
  const graph = buildBoardGraph(state.board.hexes);
  let best = { total: 0, gains: {} as Record<string, number>, count: 0 };
  for (let total = 2; total <= 12; total++) {
    if (total === 7) continue;
    const gains: Record<string, number> = {};
    let count = 0;
    for (const hex of state.board.hexes) {
      const kind = terrainKind[hex.terrain];
      if (hex.token !== total || hex.id === state.board.robberHex || !kind) continue;
      const index = graph.hexIndex[hex.id];
      const vertices = index === undefined ? [] : (graph.hexVertices[index] ?? []);
      for (const building of state.board.buildings)
        if (building.seat === seat && vertices.some((vertex) => vertex === building.vertex)) {
          const paid = building.kind === 'city' ? 2 : 1;
          gains[kind] = (gains[kind] ?? 0) + paid;
          count += paid;
        }
    }
    if (count > best.count) best = { total, gains, count };
  }
  return best;
}

/** Open a saved base game just before a roll by the human (the active seat); `botDelayMs` paces the bots. */
export async function openBeforeRoll(
  page: Page,
  id: string,
  options: { botDelayMs?: number } = {},
) {
  const verified = await saveBeforeGoldenInput('normal-completion.replay.json', 17);
  const restored = LocalSession.restore(verified, {
    entropy: { randomBytes: (target) => target.fill(1) },
  });
  if (!restored.ok) throw new Error(restored.error.message);
  const state = restored.value.getState();
  const human = state.turn.activeSeat;
  const hand = { ...restored.value.getPrivate(human)?.hand };
  restored.value.dispose();
  const save = {
    ...verified,
    roles: {
      humanSeats: [human],
      botSeats: verified.config.seats.filter((seat) => seat !== human),
    },
  };
  const record = {
    v: 1,
    id,
    revision:
      save.genesis.length +
      save.batches.reduce((sum, batch) => sum + 1 + batch.generated.length, 0),
    updatedAt: Date.now(),
    presentation: {
      players: save.config.seats.map((seat, index) => ({
        seat,
        name: `Player ${seat + 1}`,
        color: colors[index] ?? 'blue',
        shape: shapes[index] ?? 'circle',
      })),
      botDelayMs: options.botDelayMs ?? 60_000,
    },
    save,
  };
  await page.addInitScript(
    ({ key, value }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    },
    { key: `hexfield:save:v1:${id}`, value: JSON.stringify(record) },
  );
  await page.goto(`/#/local/${id}`);
  await expect.poll(() => page.evaluate(() => Boolean(Reflect.get(window, '__cp2p')))).toBe(true);
  await expect(page.getByRole('button', { name: 'Roll dice' })).toBeVisible();
  return { human, hand, roll: bestRoll(state, human), state };
}
