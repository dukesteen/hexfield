// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { success } from '@cp2p/engine';
import { afterEach, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { OnlineRoomSnapshot } from '../../session/online-room.js';
import type { OnlineRoomHandleValue } from './room-registry.js';
import { getOnlineRoom } from './room-registry.js';
import { OnlineLobby } from './OnlineLobby.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
  useBlocker: () => ({ status: 'idle' }),
  useNavigate: () => vi.fn<() => Promise<void>>(async () => undefined),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./room-registry.js', () => ({
  getOnlineRoom: vi.fn<() => OnlineRoomHandleValue | null>(),
  closeOnlineRoom: vi.fn<() => Promise<void>>(async () => undefined),
}));
vi.mock('./ManualConnectionPanel.js', () => ({ ManualConnectionPanel: () => null }));
vi.mock('./ConnectionDiagnostics.js', () => ({ ConnectionDiagnostics: () => null }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('failed and halted setup show their public error only when details are opened', () => {
  let snapshot: OnlineRoomSnapshot = {
    invite: { roomId: 'diagnostic', hostPeer: 'host', serverUrl: '' },
    self: 'host',
    signaling: { state: 'ready' },
    manual: { phase: 'idle', code: null, peer: null, gatheringComplete: null, error: null },
    peers: [],
    lobby: null,
    agreement: null,
    diagnostic: null,
    connectionError: null,
    startup: {
      phase: 'error',
      awaitingSeats: [],
      locallyConsented: false,
      error: 'ceremony transcript mismatch',
      gameId: null,
    },
    closed: false,
  };
  const room: OnlineRoomHandleValue = {
    invite: snapshot.invite,
    lobby: null,
    startGame: () => success(undefined),
    retryStart: async () => success(undefined),
    getGame: () => null,
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    close: async () => undefined,
  };
  vi.mocked(getOnlineRoom).mockReturnValue(room);

  const page = render(<OnlineLobby lobbyId="diagnostic" />);
  const details = page.getByText('lobby:onlineErrorDetails').closest('details');
  expect(details?.open).toBe(false);
  expect(details?.textContent).toContain('ceremony transcript mismatch');
  fireEvent.click(page.getByText('lobby:onlineErrorDetails'));
  expect(details?.open).toBe(true);

  snapshot = {
    ...snapshot,
    startup: {
      phase: 'halted',
      awaitingSeats: [],
      locallyConsented: true,
      error: 'signed setup dispute',
      gameId: null,
    },
  };
  page.rerender(<OnlineLobby lobbyId="diagnostic" />);
  expect(page.getByText('lobby:onlineErrorDetails').closest('details')?.textContent).toContain(
    'signed setup dispute',
  );
  expect(page.queryByRole('button', { name: 'lobby:onlineRetryStart' })).toBeNull();
});
