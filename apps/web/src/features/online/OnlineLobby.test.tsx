// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { canonicalEncode } from '@cp2p/codec';
import { identityFromSecret, signObject } from '@cp2p/crypto';
import { BASE_VERSION, ENGINE_VERSION, success } from '@cp2p/engine';
import { LobbyController, PROTOCOL_VERSION } from '@cp2p/protocol';
import { createMemnet } from '@cp2p/protocol/testing';
import englishLobby from '../../i18n/locales/en/lobby.json';
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
  useTranslation: () => ({
    t: (key: string, options?: { version?: number }) => {
      if (key === 'lobby:onlineProtocolMismatch')
        return englishLobby.onlineProtocolMismatch.replace('{{version}}', String(options?.version));
      if (key === 'lobby:onlineEngineMismatch')
        return englishLobby.onlineEngineMismatch.replace('{{version}}', String(options?.version));
      return key;
    },
  }),
}));
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

test('setup failures expose diagnostics while consented waiting cannot start a new game', () => {
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

  snapshot = {
    ...snapshot,
    startup: {
      phase: 'retired',
      awaitingSeats: [],
      locallyConsented: false,
      error: 'online-ceremony-timeout',
      gameId: null,
    },
  };
  page.rerender(<OnlineLobby lobbyId="diagnostic" />);
  expect(page.getByText('lobby:onlineStartRetired')).toBeTruthy();
  expect(page.getByText('lobby:onlineErrorDetails').closest('details')?.textContent).toContain(
    'online-ceremony-timeout',
  );
  expect(page.queryByRole('button', { name: 'lobby:onlineRetryStart' })).toBeNull();
  expect(page.getByRole('button', { name: 'lobby:onlineJoinNewRoom' })).toBeTruthy();

  snapshot = {
    ...snapshot,
    startup: {
      phase: 'waiting',
      awaitingSeats: [1],
      locallyConsented: true,
      error: null,
      gameId: null,
    },
  };
  page.rerender(<OnlineLobby lobbyId="diagnostic" />);
  expect(page.getByText('lobby:onlineStartWaitingAgreement')).toBeTruthy();
  expect(page.queryByRole('button', { name: 'lobby:onlineRetryStart' })).toBeNull();
  expect(page.queryByRole('button', { name: 'lobby:onlineNewRoom' })).toBeNull();
  expect(page.queryByRole('button', { name: 'lobby:onlineJoinNewRoom' })).toBeNull();
});

test.each(['protocol-version', 'engine-version'] as const)(
  'a signed %s mismatch shows the host version in a localized alert and cannot start',
  (kind) => {
    const hostKey = new Uint8Array(32).fill(21);
    const guestKey = new Uint8Array(32).fill(22);
    const hostPeer = identityFromSecret(hostKey).peerId;
    const guestPeer = identityFromSecret(guestKey).peerId;
    const network = createMemnet({ peers: [hostPeer, guestPeer] });
    const hostResult = LobbyController.createHost({
      lobbyId: 'version_mismatch',
      name: 'Version check',
      hostName: 'Host',
      config: {
        modules: [{ id: 'base', version: BASE_VERSION }],
        seats: [0, 1],
        options: { base: { mapLayout: 'random', vpTarget: 10 } },
      },
      transport: network.transport(hostPeer),
      clock: network.clock,
      secretKey: hostKey,
    });
    if (!hostResult.ok) throw new Error(hostResult.error.code);
    const host = hostResult.value;
    const state = host.state();
    if (!state) throw new Error('Host did not create a lobby');
    // Keep the genuine signed-state shape without delivering a compatible state first.
    host.dispose();
    const guestResult = LobbyController.join({
      lobbyId: 'version_mismatch',
      hostPeer,
      transport: network.transport(guestPeer),
      clock: network.clock,
      secretKey: guestKey,
    });
    if (!guestResult.ok) throw new Error(guestResult.error.code);
    const guest = guestResult.value;
    try {
      const hostVersion = kind === 'protocol-version' ? PROTOCOL_VERSION + 1 : ENGINE_VERSION + 1;
      const body = {
        protocolVersion: kind === 'protocol-version' ? hostVersion : PROTOCOL_VERSION,
        engineVersion: kind === 'engine-version' ? hostVersion : ENGINE_VERSION,
        state,
      };
      network.transport(hostPeer).send(
        guestPeer,
        canonicalEncode({
          t: 'LOBBY_STATE',
          snapshot: { body, sig: signObject('lobby-state', body, hostKey) },
        }),
      );
      network.clock.advanceBy(0);
      expect(guest.getDiagnostic()).toEqual({ kind, hostVersion });
      expect(guest.state()).toBeNull();
      const snapshot: OnlineRoomSnapshot = {
        invite: { roomId: 'version_mismatch', hostPeer, serverUrl: '' },
        self: guestPeer,
        signaling: { state: 'ready' },
        manual: { phase: 'idle', code: null, peer: null, gatheringComplete: null, error: null },
        peers: [],
        lobby: guest.state(),
        agreement: null,
        diagnostic: guest.getDiagnostic(),
        connectionError: null,
        startup: null,
        closed: false,
      };
      const startGame = vi.fn<OnlineRoomHandleValue['startGame']>(() => success(undefined));
      vi.mocked(getOnlineRoom).mockReturnValue({
        invite: snapshot.invite,
        lobby: guest,
        startGame,
        retryStart: async () => success(undefined),
        getGame: () => null,
        getSnapshot: () => snapshot,
        subscribe: () => () => undefined,
        close: async () => undefined,
      });
      const page = render(<OnlineLobby lobbyId="version_mismatch" />);
      const message =
        kind === 'protocol-version'
          ? englishLobby.onlineProtocolMismatch
          : englishLobby.onlineEngineMismatch;
      expect(page.getByRole('alert').textContent).toBe(
        message.replace('{{version}}', String(hostVersion)),
      );
      expect(page.queryByRole('button', { name: 'lobby:onlineStartAction' })).toBeNull();
      expect(startGame).not.toHaveBeenCalled();
    } finally {
      guest.dispose();
      network.dispose();
    }
  },
);
