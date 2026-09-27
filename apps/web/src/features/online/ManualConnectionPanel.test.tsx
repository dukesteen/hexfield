// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { afterEach, expect, test, vi } from 'vitest';
import type { OnlineRoomSnapshot } from '../../session/online-room.js';
import type { OnlineRoomHandleValue } from './room-registry.js';
import { ManualConnectionPanel } from './ManualConnectionPanel.js';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./InvitationCode.js', () => ({
  InvitationCode: () => null,
  ScanInvitation: () => null,
}));

const queryClient = new QueryClient();
afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

test('reconnect target list follows current certified device routes and excludes retired devices', async () => {
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
    peers: [currentDevice],
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

  render(
    <QueryClientProvider client={queryClient}>
      <ManualConnectionPanel room={room} snapshot={typedSnapshot} reconnect />
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
