// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { SavedOnlineGames } from './SavedOnlineGames.js';

const mocks = vi.hoisted(() => ({
  remove: vi.fn<() => Promise<string>>(async () => 'deleted'),
  open: vi.fn<() => Promise<string>>(async () => 'c'.repeat(64)),
  export: vi.fn<() => Promise<Uint8Array>>(async () => new Uint8Array([1, 2, 3])),
  navigate: vi.fn<() => Promise<void>>(async () => undefined),
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: { children: ReactNode; 'aria-label': string }) => (
    <a href="#game" aria-label={props['aria-label']}>
      {children}
    </a>
  ),
  useNavigate: () => mocks.navigate,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../queries/online-games', () => ({
  useResumableGames: () => ({
    isError: false,
    data: {
      games: [
        {
          gameId: 'A'.repeat(22),
          genesisDigest: 'B'.repeat(43),
          genesis: {
            seats: [
              { seat: 0, name: 'Blue' },
              { seat: 1, name: 'Orange' },
            ],
            createdAt: 1000,
          },
          outcome: null,
          outcomeUnavailable: false,
          activity: { lastActivityAt: 1000 },
          abandoned: true,
        },
      ],
      unavailableGameIds: [],
    },
  }),
  useDeleteOnlineGame: () => ({ mutateAsync: mocks.remove, isPending: false }),
  useOpenOnlineReplay: () => ({ mutateAsync: mocks.open, isPending: false }),
  useExportOnlineReplay: () => ({ mutateAsync: mocks.export, isPending: false }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('removing requires a separate confirmation, and cancel leaves storage untouched', () => {
  render(<SavedOnlineGames />);
  expect(screen.getByText('lobby:onlineHistoryInactive')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'lobby:onlineResumeTitle: Blue, Orange' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'lobby:onlineHistoryDelete' }));
  expect(mocks.remove).not.toHaveBeenCalled();
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByText('lobby:onlineHistoryDeleteWarning')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'lobby:onlineHistoryCancelDelete' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(mocks.remove).not.toHaveBeenCalled();
});

test('an active writer keeps the confirmation and saved item visible for a later retry', async () => {
  mocks.remove.mockResolvedValueOnce('busy').mockResolvedValueOnce('deleted');
  render(<SavedOnlineGames />);
  fireEvent.click(screen.getByRole('button', { name: 'lobby:onlineHistoryDelete' }));
  const confirm = within(screen.getByRole('dialog')).getByRole('button', {
    name: 'lobby:onlineHistoryDelete',
  });
  fireEvent.click(confirm);
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe('lobby:onlineHistoryDeleteBusy'),
  );
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(mocks.remove).toHaveBeenCalledWith({
    gameId: 'A'.repeat(22),
    genesisDigest: 'B'.repeat(43),
  });
  fireEvent.click(confirm);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('replay opens only after validation succeeds; failure leaves the game link available', async () => {
  mocks.open.mockRejectedValueOnce(new Error('invalid certified history'));
  render(<SavedOnlineGames />);
  fireEvent.click(screen.getByRole('button', { name: 'lobby:onlineHistoryReplay' }));
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(screen.getByRole('link')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'lobby:onlineHistoryReplay' }));
  await waitFor(() =>
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: '/replay/$archiveId',
      params: { archiveId: 'c'.repeat(64) },
    }),
  );
});
