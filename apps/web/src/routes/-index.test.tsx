// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { routeTree } from '../routeTree.gen.js';

interface SavedGamesResult {
  isError: boolean;
  isPending: boolean;
  data: unknown[] | undefined;
}
interface ResumableResult {
  isError: boolean;
  data: { games: unknown[]; unavailableGameIds: string[] } | undefined;
}

const failedSaves: SavedGamesResult = { isError: true, isPending: false, data: undefined };
const failedOnline: ResumableResult = { isError: true, data: undefined };

const { useSettings, useSavedGames, useResumableGames } = vi.hoisted(() => ({
  useSettings: vi.fn<() => { data: undefined }>(() => ({ data: undefined })),
  useSavedGames: vi.fn<() => SavedGamesResult>(),
  useResumableGames: vi.fn<() => ResumableResult>(),
}));

vi.mock('../queries/hooks.js', () => ({ useSettings, useSavedGames }));
vi.mock('../queries/online-vault.js', () => ({
  useOnlineVault: () => ({ data: { mode: 'clear', state: 'ready', generation: 0 } }),
}));
vi.mock('../queries/online-games.js', () => ({
  useResumableGames,
  useDeleteOnlineGame: () => ({ isPending: false }),
  useExportOnlineReplay: () => ({ isPending: false }),
  useOpenOnlineReplay: () => ({ isPending: false }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      ({
        'lobby:playWithFriends': 'Play with friends',
        'lobby:joinGame': 'Join a game',
      })[key] ??
      (options && 'min' in options ? `${key}:${String(options.min)}-${String(options.max)}` : key),
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderHome(saves = failedSaves, online = failedOnline) {
  useSavedGames.mockReturnValue(saves);
  useResumableGames.mockReturnValue(online);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ['/'] }),
    context: { queryClient },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/** The route chunk pulls in the engine and maps, so the first render can take a moment. */
const findHero = () => screen.findByRole('heading', { level: 1 }, { timeout: 10_000 });

test('home keeps local play and exposes create/join beta routes', async () => {
  const router = renderHome();
  await findHero();

  const localLink = screen.getByRole('link', { name: 'lobby:newGame' });
  expect(localLink.getAttribute('href')).toContain('/local/new');
  expect(localLink.className).toContain('button');
  expect(screen.getByRole('link', { name: 'Play with friends' }).getAttribute('href')).toContain(
    '/online/create',
  );
  expect(screen.getByRole('link', { name: 'Join a game' }).getAttribute('href')).toContain('/join');
  expect(router.state.location.pathname).toBe('/');
});

test('load failures stay in the secondary area and nothing is offered to resume', async () => {
  renderHome();
  await findHero();

  expect(screen.queryByRole('heading', { name: 'lobby:homeContinueTitle' })).toBeNull();
  const library = screen.getByRole('region', { name: 'lobby:homeLibraryTitle' });
  expect(within(library).getByText('lobby:loadFailed').getAttribute('role')).toBe('alert');
  expect(within(library).getByText('lobby:onlineSavedLoadFailed').getAttribute('role')).toBe(
    'alert',
  );
  expect(within(library).getByRole('button', { name: 'lobby:publicReplayImport' })).toBeTruthy();
  expect(within(library).getByRole('button', { name: 'lobby:fullSaveImport' })).toBeTruthy();
});

test('an empty device shows no saved-game panels at all', async () => {
  renderHome(
    { isError: false, isPending: false, data: [] },
    { isError: false, data: { games: [], unavailableGameIds: [] } },
  );
  await findHero();

  expect(screen.queryByRole('heading', { name: 'lobby:homeContinueTitle' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'lobby:savedGames' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'lobby:onlineSavedGames' })).toBeNull();
});

test('saved games get their own section between the hero and the scenarios', async () => {
  renderHome(
    {
      isError: false,
      isPending: false,
      data: [
        {
          id: 'game-1',
          updatedAt: 0,
          presentation: { players: [{ name: 'Ada' }, { name: 'Bo' }] },
        },
      ],
    },
    { isError: false, data: { games: [], unavailableGameIds: [] } },
  );
  await findHero();

  const continuing = screen.getByRole('region', { name: 'lobby:homeContinueTitle' });
  expect(
    within(continuing)
      .getByRole('link', { name: 'lobby:resumeGame: Ada, Bo' })
      .getAttribute('href'),
  ).toContain('/local/game-1');
  const headings = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
  expect(headings).toEqual([
    'lobby:homeContinueTitle',
    'lobby:homeModesTitle',
    'lobby:homeLibraryTitle',
  ]);
});

test('what you can play lists the scenario groups from the maps package', async () => {
  renderHome();
  await findHero();

  const modes = screen.getByRole('region', { name: 'lobby:homeModesTitle' });
  expect(
    within(modes)
      .getAllByRole('heading', { level: 3 })
      .map((node) => node.textContent),
  ).toEqual([
    'lobby:scenarioGroupClassic',
    'lobby:expansion_five-six',
    'lobby:scenarioGroupSeafaring',
    'lobby:scenarioKnights',
  ]);
  expect(within(modes).getByText('lobby:homeModeSeats:2-4')).toBeTruthy();
  expect(within(modes).getByText('lobby:homeModeSeats:5-6')).toBeTruthy();
  expect(within(modes).getAllByText('lobby:homeModeSeats:3-6')).toHaveLength(2);
  const seafaring = within(modes).getByRole('list', { name: 'lobby:homeModeScenarios' });
  expect(within(seafaring).getByText('lobby:scenarioFogbound')).toBeTruthy();
  // 5–6 player variants are not listed as separate maps.
  expect(within(seafaring).queryByText('lobby:scenarioOpenSeaLarge')).toBeNull();
  expect(within(modes).getByText('lobby:homeModesComing')).toBeTruthy();
});
