// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { routeTree } from '../../routeTree.gen.js';

const ID = 'a'.repeat(64);

vi.mock('../../queries/online-public-replays.js', () => ({
  usePublicReplay: () => ({
    isPending: false,
    isError: false,
    data: {
      id: 'a'.repeat(64),
      gameId: 'b'.repeat(22),
      head: { seq: 4, hash: 'head' },
      state: { result: null },
      events: [],
      players: [
        { seat: 0, name: 'Avery', color: 'blue' },
        { seat: 1, name: 'Blair', color: 'orange' },
      ],
    },
  }),
}));
vi.mock('../../queries/hooks.js', () => ({ useSettings: () => ({ data: undefined }) }));
vi.mock('../../queries/online-vault.js', () => ({
  useOnlineVault: () => ({ data: { mode: 'clear', state: 'ready', generation: 0 } }),
}));
vi.mock('../../features/game/use-appearance.js', () => ({
  useBoardAppearance: () => ({ appearance: { theme: 'light', players: [] }, reducedMotion: true }),
}));
vi.mock('../../features/board/toRenderModel.js', () => ({ toRenderModel: () => ({}) }));
vi.mock('../../features/board/BoardView.js', () => ({
  BoardView: () => <div role="group" aria-label="public board" />,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => {
  cleanup();
});

test('verified replay opens a public board and roster without session controls', async () => {
  const queryClient = new QueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [`/replay/${ID}`] }),
    context: { queryClient },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('Avery')).toBeTruthy();
  expect(screen.getByText('Blair')).toBeTruthy();
  expect(screen.getByText('lobby:publicReplayReadOnly')).toBeTruthy();
  expect(screen.getByRole('group', { name: 'public board' })).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  queryClient.clear();
});
