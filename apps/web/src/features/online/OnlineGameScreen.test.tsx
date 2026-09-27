// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import { success } from '@cp2p/engine';
import { OnlineGameScreen } from './OnlineGameScreen';
import { beginOnlineRoomOpen, closeOnlineRoom, getOnlineGameRoom } from './room-registry';
import * as roomRegistry from './room-registry.js';
import { UnsupportedOnlineGameVersionError } from '../../session/online-game-records.js';
import type { OnlineRoomHandleValue } from './room-registry';
import type { OnlineRoomSnapshot } from '../../session/online-room';
import { OnlineRoom } from '../../session/online-room';

const { navigateMock } = vi.hoisted(() => ({
  navigateMock: vi.fn<() => Promise<void>>(async () => undefined),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
  useBlocker: () => ({ status: 'idle' }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { version?: number }) =>
      key === 'lobby:onlineResumeUnsupportedVersion' ? `${key}:${options?.version}` : key,
  }),
}));
vi.mock('../game/GameReadOnly.js', () => ({ GameReadOnly: () => null }));
vi.mock('../../queries/network.js', () => ({
  loadOnlineConnectionSettings: async () => ({ iceServers: [], iceTransportPolicy: 'all' }),
}));

const roomIds: string[] = [];
const queryClient = new QueryClient();
afterEach(async () => {
  cleanup();
  await Promise.all(roomIds.splice(0).map((id) => closeOnlineRoom(id)));
  vi.restoreAllMocks();
  vi.clearAllMocks();
  queryClient.clear();
});

function restoringRoom(
  roomId: string,
  gameId: string,
  haltedError?: string,
): OnlineRoomHandleValue {
  roomIds.push(roomId);
  let snapshot: OnlineRoomSnapshot = {
    invite: { roomId, hostPeer: 'fixture-host', serverUrl: 'ws://localhost:3009' },
    self: 'fixture-host',
    signaling: { state: 'connecting' },
    manual: { phase: 'idle', code: null, peer: null, gatheringComplete: null, error: null },
    peers: [],
    lobby: null,
    agreement: null,
    diagnostic: null,
    connectionError: null,
    startup: {
      phase: haltedError ? 'halted' : 'opening',
      gameId,
      awaitingSeats: [],
      locallyConsented: true,
      error: haltedError ?? null,
    },
    closed: false,
  };
  return {
    invite: snapshot.invite,
    lobby: null,
    startGame: () => success(undefined),
    retryStart: async () => success(undefined),
    getGame: () => null,
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    close: vi.fn<() => Promise<void>>(async () => {
      snapshot = { ...snapshot, closed: true };
    }),
  };
}

test.each([
  ['worker connection failed', 'lobby:onlineGameStopped'],
  ['online-ceremony-disputed', 'lobby:onlineGameHalted'],
])('halt reason %s uses the matching public message', async (reason, title) => {
  const room = restoringRoom(`halt-${title}`, `game-${title}`, reason);
  vi.spyOn(OnlineRoom, 'open').mockImplementation(async () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the public room handle is used by this component.
    return room as OnlineRoom;
  });
  render(
    <QueryClientProvider client={queryClient}>
      <OnlineGameScreen gameId={`game-${title}`} />
    </QueryClientProvider>,
  );
  expect((await screen.findByRole('alert')).textContent).toBe(title);
});

test('leaving a StrictMode resume loading screen closes its connection and releases the registry', async () => {
  const room = restoringRoom('loadingone', 'game-resume-one');
  // OnlineRoom.open owns browser resources; the registry and component lifecycles remain real.
  vi.spyOn(OnlineRoom, 'open').mockImplementation(async () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the public room handle is used by this component.
    return room as OnlineRoom;
  });
  const page = render(
    <QueryClientProvider client={queryClient}>
      <StrictMode>
        <OnlineGameScreen gameId="game-resume-one" />
      </StrictMode>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(getOnlineGameRoom('game-resume-one')).toBe(room));
  expect(room.close).not.toHaveBeenCalled();
  page.unmount();
  await waitFor(() => expect(room.close).toHaveBeenCalled(), { timeout: 250 });
  expect(getOnlineGameRoom('game-resume-one')).toBeNull();
});

test('leaving while a kept lobby hands off to the board also closes the opening room', async () => {
  const room = restoringRoom('loadingtwo', 'game-resume-two');
  const handoff = beginOnlineRoomOpen(
    'kept-lobby-handoff',
    { kind: 'join', invite: room.invite },
    async () => room,
  );
  await handoff.promise;
  handoff.keep();
  const page = render(
    <QueryClientProvider client={queryClient}>
      <StrictMode>
        <OnlineGameScreen gameId="game-resume-two" />
      </StrictMode>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(page.getByRole('status')).toBeTruthy());
  expect(room.close).not.toHaveBeenCalled();
  page.unmount();
  await waitFor(() => expect(room.close).toHaveBeenCalled(), { timeout: 250 });
  expect(getOnlineGameRoom('game-resume-two')).toBeNull();
});

test('unsupported saved-game versions explain the version, skip retry, and keep the home action', async () => {
  const open = vi.spyOn(roomRegistry, 'beginOnlineRoomOpen');
  open.mockReturnValue({
    promise: Promise.reject(new UnsupportedOnlineGameVersionError(2)),
    keep: vi.fn<() => void>(),
    cancel: vi.fn<() => void>(),
  });

  render(
    <QueryClientProvider client={queryClient}>
      <OnlineGameScreen gameId="unsupported-version-game" />
    </QueryClientProvider>,
  );

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('lobby:onlineResumeUnsupportedVersion:2');
  expect(screen.queryByRole('button', { name: 'lobby:onlineResumeRetry' })).toBeNull();
  const backHome = screen.getByRole('button', { name: 'lobby:backHome' });
  fireEvent.click(backHome);
  await waitFor(() => expect(navigateMock).toHaveBeenCalledWith({ to: '/' }));
  expect(open).toHaveBeenCalledTimes(1);
});

test('ordinary resume failures still offer retry', async () => {
  const open = vi.spyOn(roomRegistry, 'beginOnlineRoomOpen');
  open.mockReturnValue({
    promise: Promise.reject(new Error('temporary storage failure')),
    keep: vi.fn<() => void>(),
    cancel: vi.fn<() => void>(),
  });

  render(
    <QueryClientProvider client={queryClient}>
      <OnlineGameScreen gameId="temporary-failure-game" />
    </QueryClientProvider>,
  );

  const retry = await screen.findByRole('button', { name: 'lobby:onlineResumeRetry' });
  expect(screen.getByRole('alert').textContent).toBe('lobby:onlineResumeFailed');
  fireEvent.click(retry);
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
});
