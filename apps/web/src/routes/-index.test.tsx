// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { afterEach, expect, test, vi } from 'vitest';
import { routeTree } from '../routeTree.gen.js';

const { useSettings, useSavedGames, useResumableGames } = vi.hoisted(() => ({
  useSettings: vi.fn<() => { data: undefined }>(() => ({ data: undefined })),
  useSavedGames: vi.fn<() => { isError: boolean; isPending: boolean; data: undefined }>(() => ({
    isError: true,
    isPending: false,
    data: undefined,
  })),
  useResumableGames: vi.fn<() => { isError: boolean; data: undefined }>(() => ({
    isError: true,
    data: undefined,
  })),
}));

vi.mock('../queries/hooks.js', () => ({ useSettings, useSavedGames }));
vi.mock('../queries/online-games.js', () => ({
  useResumableGames,
  useDeleteOnlineGame: () => ({ isPending: false }),
  useExportOnlineReplay: () => ({ isPending: false }),
  useOpenOnlineReplay: () => ({ isPending: false }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'lobby:playWithFriends': 'Play with friends',
        'lobby:joinGame': 'Join a game',
      })[key] ?? key,
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderHome() {
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

test('home keeps local play and exposes create/join beta routes', async () => {
  const router = renderHome();

  const localLink = await screen.findByRole('link', { name: 'lobby:newGame' });
  expect(localLink.getAttribute('href')).toContain('/local/new');
  expect(screen.getByRole('link', { name: 'Play with friends' }).getAttribute('href')).toContain(
    '/online/create',
  );
  expect(screen.getByRole('link', { name: 'Join a game' }).getAttribute('href')).toContain('/join');

  expect(router.state.location.pathname).toBe('/');
  expect(screen.getByText('lobby:loadFailed').getAttribute('role')).toBe('alert');
  expect(screen.getByText('lobby:onlineSavedLoadFailed').getAttribute('role')).toBe('alert');
});
