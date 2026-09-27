// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { routeTree } from '../../routeTree.gen.js';

vi.mock('../../queries/online-full-saves.js', () => ({
  useImportedOnlineFullSave: () => ({
    isPending: false,
    isError: false,
    data: {
      id: 'a'.repeat(64),
      gameId: 'b'.repeat(22),
      head: { seq: 14, hash: 'head' },
      state: { result: null },
      events: [],
      players: [
        { seat: 0, name: 'Avery', color: 'blue' },
        { seat: 1, name: 'Blair', color: 'orange' },
      ],
      mode: 'read-only-paused',
      privateCapsule: 'encrypted',
    },
  }),
}));
vi.mock('../../queries/hooks.js', () => ({ useSettings: () => ({ data: undefined }) }));
vi.mock('../../features/game/use-appearance.js', () => ({
  useBoardAppearance: () => ({ appearance: { theme: 'light', players: [] }, reducedMotion: true }),
}));
vi.mock('../../features/board/toRenderModel.js', () => ({ toRenderModel: () => ({}) }));
vi.mock('../../features/board/BoardView.js', () => ({
  BoardView: () => <div role="group" aria-label="full-save board" />,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(cleanup);

test('imported save displays a paused board and does not expose game controls', async () => {
  const queryClient = new QueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [`/full-save/${'a'.repeat(64)}`] }),
    context: { queryClient },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('lobby:fullSavePausedTitle')).toBeTruthy();
  expect(screen.getByText('lobby:fullSavePrivateLocked')).toBeTruthy();
  expect(screen.getByText('lobby:publicReplayHead')).toBeTruthy();
  expect(screen.getByRole('group', { name: 'full-save board' })).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
  queryClient.clear();
});
