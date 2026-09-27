// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { afterEach, expect, test, vi } from 'vitest';
import type { OnlineRoomSnapshot } from '../../session/online-room.js';
import type { OnlineRoomHandleValue } from './room-registry.js';
import { ManualConnectionPanel } from './ManualConnectionPanel.js';
import { useReconnectFallback } from './use-reconnect-fallback.js';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./InvitationCode.js', () => ({
  InvitationCode: () => null,
  ScanInvitation: () => null,
}));

const queryClient = new QueryClient();
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  queryClient.clear();
});

function fixture() {
  const oldDevice = 'old-device-peer';
  const currentDevice = 'current-device-peer';
  const localDevice = 'local-device-peer';
  const invite = { roomId: 'transferqa', hostPeer: oldDevice, serverUrl: 'ws://localhost:3009' };
  const startManualInvitation = vi.fn<() => Promise<Result<void>>>(async () => success(undefined));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This panel test exercises only the invitation method on the room handle.
  const room = { startManualInvitation } as unknown as OnlineRoomHandleValue;
  const snapshot = {
    invite,
    self: localDevice,
    signaling: { state: 'connected' },
    manual: { phase: 'idle', code: null, peer: null, gatheringComplete: null, error: null },
    peers: [],
    lobby: null,
    agreement: {
      state: {
        seats: [
          { seat: 0, kind: 'human', peer: oldDevice, name: 'Host', colour: 'red', ready: true },
          { seat: 1, kind: 'human', peer: localDevice, name: 'Guest', colour: 'blue', ready: true },
          { seat: 2, kind: 'bot', botHost: localDevice, name: 'Random bot', colour: 'green' },
        ],
      },
    },
    diagnostic: null,
    connectionError: null,
    startup: null,
    closed: false,
    deviceRoutes: {
      head: { seq: 42, hash: 'a'.repeat(64) },
      seats: [
        { seat: 0, devicePeer: currentDevice },
        { seat: 1, devicePeer: localDevice },
        { seat: 2, devicePeer: null },
      ],
      activeDevices: [currentDevice, localDevice],
      catchupDevices: [oldDevice],
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The component reads only these public roster and route snapshot fields.
  const typedSnapshot = snapshot as unknown as OnlineRoomSnapshot;
  return { room, snapshot: typedSnapshot, startManualInvitation, currentDevice, oldDevice };
}

test('reconnect target list follows current certified device routes and excludes retired devices', async () => {
  const { room, snapshot, startManualInvitation, currentDevice, oldDevice } = fixture();

  render(
    <QueryClientProvider client={queryClient}>
      <ManualConnectionPanel room={room} snapshot={snapshot} reconnect reconnectFallback />
    </QueryClientProvider>,
  );
  const select = screen.getByRole('combobox');
  expect(select.textContent).toContain('Host');
  expect(select.textContent).not.toContain('old-device-peer');
  expect(select.querySelector(`option[value="${oldDevice}"]`)).toBeNull();
  fireEvent.change(select, { target: { value: currentDevice } });
  fireEvent.click(screen.getByRole('button', { name: 'lobby:manualCreateCode' }));
  await waitFor(() => expect(startManualInvitation).toHaveBeenCalledWith(currentDevice));
});

function AutomaticPanel({
  room,
  snapshot,
}: {
  room: OnlineRoomHandleValue;
  snapshot: OnlineRoomSnapshot;
}) {
  const fallback = useReconnectFallback(snapshot);
  return (
    <QueryClientProvider client={queryClient}>
      <ManualConnectionPanel
        room={room}
        snapshot={snapshot}
        reconnect
        reconnectFallback={fallback}
      />
    </QueryClientProvider>
  );
}

test('automatic reconnect gets an attempt before showing the picker and resets after return', async () => {
  vi.useFakeTimers();
  const { room, snapshot, currentDevice, startManualInvitation } = fixture();
  const view = render(<AutomaticPanel room={room} snapshot={snapshot} />);
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('lobby:manualAutomaticReconnect');
  await act(() => vi.advanceTimersByTime(29_999));
  expect(screen.queryByRole('combobox')).toBeNull();
  await act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe(currentDevice);
  expect(startManualInvitation).not.toHaveBeenCalled();

  view.rerender(<AutomaticPanel room={room} snapshot={{ ...snapshot, peers: [currentDevice] }} />);
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('lobby:manualAllConnected');
  view.rerender(<AutomaticPanel room={room} snapshot={snapshot} />);
  expect(screen.queryByRole('combobox')).toBeNull();
  await act(() => vi.advanceTimersByTime(29_999));
  expect(screen.queryByRole('combobox')).toBeNull();
});

test('a manual room without a signaling route offers codes without pretending to reconnect', () => {
  const { room, snapshot } = fixture();
  render(
    <AutomaticPanel
      room={room}
      snapshot={{ ...snapshot, invite: { ...snapshot.invite, serverUrl: '' } }}
    />,
  );
  expect(screen.getByRole('combobox')).toBeDefined();
  expect(screen.queryByText('lobby:manualAutomaticReconnect')).toBeNull();
});
