// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { baseLongestRoadLength, seafaringConfig, seafaringEngine } from '@cp2p/engine';
import type { GameState } from '@cp2p/engine';
import { buildBoardGraph } from '@cp2p/engine/geometry';
import game from '../../i18n/locales/en/game.json';
import { islandBonusOf, isSeafaring, routeLength } from '../game/seafaring';
import { victoryBreakdown } from '../game/stats';
import { IslandBonusBadge } from './seafaring';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { game } }, initImmediate: false });
});
afterEach(cleanup);

const engine = seafaringEngine();
const genesis = engine.createGame(seafaringConfig({ seats: 3 }), new Uint8Array(32).fill(2));
const presentation = { players: [], botDelayMs: 0 };

function withBonus(tokens: { seat: number; region: string; vertex: string }[]): GameState {
  const seafaring: unknown = genesis.ext.seafaring;
  if (typeof seafaring !== 'object' || seafaring === null) throw new Error('No seafaring state');
  return { ...genesis, ext: { ...genesis.ext, seafaring: { ...seafaring, bonus: tokens } } };
}

test('the island badge counts the seat’s new islands and what they are worth', () => {
  const state = withBonus([
    { seat: 1, region: 'h:4,-3', vertex: 'v:4,-3,N' },
    { seat: 1, region: 'h:-4,3', vertex: 'v:-4,3,N' },
    { seat: 2, region: 'h:0,4', vertex: 'v:0,4,N' },
  ]);
  expect(islandBonusOf(state, 1)).toEqual({ count: 2, points: 4 });
  expect(islandBonusOf(state, 2)).toEqual({ count: 1, points: 2 });
  expect(islandBonusOf(state, 0)).toEqual({ count: 0, points: 0 });
  render(
    <I18nextProvider i18n={i18n}>
      <IslandBonusBadge state={state} seat={1} presentation={presentation} />
    </I18nextProvider>,
  );
  expect(screen.getByLabelText('2 new islands, +4 VP')).toBeTruthy();
});

test('no badge before the first new island', () => {
  const page = render(
    <I18nextProvider i18n={i18n}>
      <IslandBonusBadge state={withBonus([])} seat={0} presentation={presentation} />
    </I18nextProvider>,
  );
  expect(page.container.textContent).toBe('');
});

test('the final score breakdown gains an islands row only when the bonus scored', () => {
  expect(victoryBreakdown(genesis, 1, 0)).not.toHaveProperty('islands');
  const scored = victoryBreakdown(
    withBonus([{ seat: 1, region: 'h:4,-3', vertex: 'v:4,-3,N' }]),
    1,
    0,
  );
  expect(scored).toMatchObject({ islands: 2, total: 2 });
});

test('the route length counts ships, which the plain road count would miss', () => {
  const graph = buildBoardGraph(genesis.board.hexes);
  const hexes = new Map(genesis.board.hexes.map((hex) => [hex.id, hex.terrain]));
  const open = (edge: string): boolean =>
    (graph.edgeHexes[graph.edgeIndex[edge] ?? -1] ?? []).every((id) => hexes.get(id) === 'sea');
  // Find a path of four open-water edges, each starting where the last one ended.
  const extend = (path: string[], vertex: string): string[] | null => {
    if (path.length === 4) return path;
    for (const next of graph.vertexEdges[graph.vertexIndex[vertex] ?? -1] ?? []) {
      if (!open(next) || path.includes(next)) continue;
      const ends: readonly string[] = graph.edgeVertices[graph.edgeIndex[next] ?? -1] ?? [];
      const far = ends.find((end) => end !== vertex);
      const found = far ? extend([...path, next], far) : null;
      if (found) return found;
    }
    return null;
  };
  const chain = graph.edgeIds
    .filter(open)
    .flatMap((first) => {
      const ends: readonly string[] = graph.edgeVertices[graph.edgeIndex[first] ?? -1] ?? [];
      const far = ends[1];
      return far ? [extend([first], far)] : [];
    })
    .find((path) => path !== null);
  if (!chain) throw new Error('The test board has a path over open water');
  expect(chain).toHaveLength(4);
  const state: GameState = {
    ...genesis,
    board: { ...genesis.board, ships: chain.map((piece) => ({ edge: piece, seat: 0 })) },
  };
  expect(isSeafaring(state)).toBe(true);
  expect(baseLongestRoadLength(state, 0)).toBe(0);
  expect(routeLength(state, 0)).toBe(4);
});
