// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react';
import { identityFromSecret } from '@cp2p/crypto';
import { BASE_VERSION, success } from '@cp2p/engine';
import { LOBBY_SEAT_REQUEST_TIMEOUT_MS, LobbyController } from '@cp2p/protocol';
import type { GameConfig, Result } from '@cp2p/engine';
import { createMemnet } from '@cp2p/protocol/testing';
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
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./room-registry.js', () => ({
  getOnlineRoom: vi.fn<() => OnlineRoomHandleValue | null>(),
  closeOnlineRoom: vi.fn<() => Promise<void>>(async () => undefined),
}));
vi.mock('./ManualConnectionPanel.js', () => ({ ManualConnectionPanel: () => null }));
vi.mock('./ConnectionDiagnostics.js', () => ({ ConnectionDiagnostics: () => null }));
vi.mock('./ChatPanel.js', () => ({ ChatPanel: () => null }));

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  while (cleanups.length) cleanups.pop()?.();
});

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

/** A real host and guest lobby over memnet, with the guest's page rendered. */
function guestLobby(seatCount: 2 | 3) {
  const hostKey = new Uint8Array(32).fill(51);
  const guestKey = new Uint8Array(32).fill(52);
  const hostPeer = identityFromSecret(hostKey).peerId;
  const guestPeer = identityFromSecret(guestKey).peerId;
  const network = createMemnet({ peers: [hostPeer, guestPeer] });
  const config: GameConfig = {
    modules: [{ id: 'base', version: BASE_VERSION }],
    seats: seatCount === 2 ? [0, 1] : [0, 1, 2],
    options: { base: { mapLayout: 'random', vpTarget: 10 } },
  };
  const host = unwrap(
    LobbyController.createHost({
      lobbyId: 'seat_feedback',
      name: 'Seat feedback',
      hostName: 'Host',
      config,
      transport: network.transport(hostPeer),
      clock: network.clock,
      secretKey: hostKey,
    }),
  );
  const guest = unwrap(
    LobbyController.join({
      lobbyId: 'seat_feedback',
      hostPeer,
      transport: network.transport(guestPeer),
      clock: network.clock,
      secretKey: guestKey,
    }),
  );
  network.clock.advanceBy(0);
  const invite = { roomId: 'seat_feedback', hostPeer, serverUrl: '' };
  const listeners = new Set<() => void>();
  const read = (): OnlineRoomSnapshot => ({
    invite,
    self: guestPeer,
    signaling: { state: 'ready' },
    manual: { phase: 'idle', code: null, peer: null, gatheringComplete: null, error: null },
    peers: [hostPeer],
    lobby: guest.state(),
    agreement: null,
    diagnostic: guest.getDiagnostic(),
    seatRequest: guest.seatRequest(),
    connectionError: null,
    startup: null,
    closed: false,
  });
  let snapshot = read();
  const refresh = () => {
    snapshot = read();
    for (const listener of listeners) listener();
  };
  const offChange = guest.onChange(refresh);
  const offSeat = guest.onSeatRequest(refresh);
  vi.mocked(getOnlineRoom).mockReturnValue({
    invite,
    lobby: guest,
    startGame: () => success(undefined),
    retryStart: async () => success(undefined),
    getGame: () => null,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => undefined,
  });
  cleanups.push(() => {
    offChange();
    offSeat();
    guest.dispose();
    host.dispose();
    network.dispose();
  });
  const page = render(<OnlineLobby lobbyId="seat_feedback" />);
  const flush = (ms = 0) => {
    act(() => {
      network.clock.advanceBy(ms);
    });
  };
  const row = (seat: number) => {
    const rows = page.container.querySelectorAll('.online-seat-row');
    const element = rows.item(seat);
    if (!(element instanceof HTMLElement)) throw new Error(`Seat row ${seat} is missing`);
    return within(element);
  };
  return { host, guest, network, hostPeer, guestPeer, page, flush, row };
}

test('Take seat shows a pending state, then the seat, even when the host changed the lobby first', () => {
  const { host, page, flush, row } = guestLobby(2);
  fireEvent.click(row(1).getByRole('button', { name: 'lobby:onlineTakeSeat' }));
  const pending = row(1).getByRole('button', { name: 'lobby:onlineTakingSeat' });
  expect(pending).toHaveProperty('disabled', true);
  expect(pending.getAttribute('aria-busy')).toBe('true');
  expect(row(1).getByRole('status').textContent).toBe('lobby:onlineSeatRequestPending');
  // The host commits before the guest's request arrives: it is refused as stale and re-sent.
  act(() => {
    unwrap(host.request({ kind: 'setName', name: 'Renamed host' }));
  });
  flush();
  expect(host.state()?.seats[1]?.kind).toBe('human');
  expect(row(1).queryByRole('button', { name: /lobby:onlineTak/ })).toBeNull();
  expect(row(1).getByRole('button', { name: 'lobby:onlineLeaveSeat' })).toBeTruthy();
  expect(page.queryByRole('alert')).toBeNull();
});

test('a seat filled first by the host explains the refusal and leaves other seats available', () => {
  const { host, page, flush, row } = guestLobby(3);
  fireEvent.click(row(1).getByRole('button', { name: 'lobby:onlineTakeSeat' }));
  // While one request is pending, no second seat can be requested.
  expect(row(2).getByRole('button', { name: 'lobby:onlineTakeSeat' })).toHaveProperty(
    'disabled',
    true,
  );
  act(() => {
    unwrap(host.setBot(1, 'easy'));
  });
  flush();
  expect(row(1).getByRole('alert').textContent).toBe('lobby:onlineSeatRequestUnavailable');
  expect(page.getAllByRole('alert')).toHaveLength(1);
  const other = row(2).getByRole('button', { name: 'lobby:onlineTakeSeat' });
  expect(other).toHaveProperty('disabled', false);
  fireEvent.click(other);
  flush();
  expect(host.state()?.seats[2]?.kind).toBe('human');
  expect(page.queryByRole('alert')).toBeNull();
});

test('an unanswered Take seat times out and offers a retry', () => {
  const { host, network, hostPeer, guestPeer, flush, row } = guestLobby(2);
  network.setLinkOptions(guestPeer, hostPeer, { dropProbability: 1 });
  fireEvent.click(row(1).getByRole('button', { name: 'lobby:onlineTakeSeat' }));
  flush(LOBBY_SEAT_REQUEST_TIMEOUT_MS);
  expect(row(1).getByRole('alert').textContent).toBe('lobby:onlineSeatRequestTimeout');
  const retry = row(1).getByRole('button', { name: 'lobby:onlineTakeSeatRetry' });
  expect(retry).toHaveProperty('disabled', false);
  network.setLinkOptions(guestPeer, hostPeer, { dropProbability: 0 });
  fireEvent.click(retry);
  expect(row(1).getByRole('button', { name: 'lobby:onlineTakingSeat' })).toBeTruthy();
  flush();
  expect(host.state()?.seats[1]?.kind).toBe('human');
  expect(row(1).queryByRole('alert')).toBeNull();
});
