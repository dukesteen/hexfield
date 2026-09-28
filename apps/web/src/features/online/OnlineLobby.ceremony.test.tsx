// @vitest-environment happy-dom
import { canonicalDecode, canonicalEncode, fromBase64Url, hashValue, toHex } from '@cp2p/codec';
import { decodePoint, encodePoint, G, proveDleq, scalePoint, signObject } from '@cp2p/crypto';
import { BASE_VERSION, createBaseEngine } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { createStealSecretSource, LobbyController } from '@cp2p/protocol';
import type { EscrowShareEnvelope, Transport } from '@cp2p/protocol';
import {
  createMemnet,
  escrowShareEnvelopeHash,
  MemoryEscrowLifecycleStore,
} from '@cp2p/protocol/testing';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import englishLobby from '../../i18n/locales/en/lobby.json';
import {
  loadCeremonyMaterial,
  loadOrCreateOnlineIdentity,
} from '../../session/online-credentials.js';
import { createOnlineLobbyTransport } from '../../session/online-lobby-transport.js';
import { OnlineStartup } from '../../session/online-startup.js';
import type { OnlineRoomSnapshot } from '../../session/online-room.js';
import { openOnlineGame } from '../../session/online-game.js';
import { getOnlineRoom } from './room-registry.js';
import type { OnlineRoomHandleValue } from './room-registry.js';
import { OnlineLobby } from './OnlineLobby.js';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
  useBlocker: () => ({ status: 'idle' }),
  useNavigate: () => vi.fn<() => Promise<void>>(async () => undefined),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === 'lobby:onlineStartRetired') return englishLobby.onlineStartRetired;
      if (key === 'lobby:onlineStartWaitingAgreement')
        return englishLobby.onlineStartWaitingAgreement;
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
vi.mock('../../session/online-game.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../session/online-game.js')>()),
  // The genuine coordinator must assemble/persist genesis before this boundary.
  // No gameplay or worker/RTC relay behavior is claimed by this focused UI bridge.
  openOnlineGame: vi.fn<typeof openOnlineGame>(async () => {
    throw new Error('test-post-agreement-game-opening');
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function required<T>(item: T | null | undefined): T {
  if (item === null || item === undefined) throw new Error('Missing ceremony UI fixture value');
  return item;
}
function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
function ceremonyKind(bytes: Uint8Array): string | null {
  try {
    const packet: unknown = canonicalDecode(bytes);
    if (!packet || typeof packet !== 'object' || !('body' in packet)) return null;
    const body = packet.body;
    if (!body || typeof body !== 'object' || !('protocol' in body) || !('kind' in body))
      return null;
    return body.protocol === 'online-ceremony-v1' && typeof body.kind === 'string'
      ? body.kind
      : null;
  } catch {
    return null;
  }
}

async function fixture(heldKind: 'seed-commit' | 'consent', humanCount: 2 | 4 = 2) {
  const stores = Array.from({ length: humanCount }, () => new MemoryEscrowLifecycleStore());
  const identities = await Promise.all(
    stores.map((store, index) =>
      loadOrCreateOnlineIdentity(store, (length) => new Uint8Array(length).fill(index + 31)),
    ),
  );
  const hostIdentity = required(identities[0]);
  const guestIdentity = required(identities[1]);
  const network = createMemnet({ peers: identities.map((identity) => identity.peerId) });
  const invite = { roomId: 'ceremonyui', hostPeer: hostIdentity.peerId, serverUrl: '' };
  let held = true;
  const guestPackets: Uint8Array[] = [];
  const hostConsents: Uint8Array[] = [];
  const envelopes: EscrowShareEnvelope[] = [];
  const transports: Transport[] = identities.map((identity, index) => {
    const device = network.transport(identity.peerId);
    const send = (to: string, bytes: Uint8Array) => {
      const kind = ceremonyKind(bytes);
      if (kind === 'escrow-envelope') {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Capture an actual coordinator-produced canonical envelope; production authenticates it again on disclosure.
        const packet = canonicalDecode(bytes) as { body: { payload: EscrowShareEnvelope } };
        envelopes.push(packet.body.payload);
      }
      if (index === 0 && kind === 'consent') hostConsents.push(bytes.slice());
      if (index === 1 && kind === heldKind && held) {
        guestPackets.push(bytes.slice());
        return;
      }
      device.send(to, bytes);
    };
    return {
      self: device.self,
      peers: () => device.peers(),
      send,
      broadcast: (bytes) => {
        for (const peer of device.peers()) send(peer, bytes);
      },
      disconnect: (peer) => device.disconnect(peer),
      onMessage: (listener) => device.onMessage(listener),
      onPeerChange: (listener) => device.onPeerChange(listener),
    };
  });
  const lobbies = identities.map((identity, index) => {
    const options = {
      lobbyId: invite.roomId,
      transport: createOnlineLobbyTransport(required(transports[index])),
      clock: network.clock,
      secretKey: identity.secretKey,
    };
    return value(
      index === 0
        ? LobbyController.createHost({
            ...options,
            name: 'Ceremony UI',
            hostName: 'Host',
            config: {
              modules: [{ id: 'base', version: BASE_VERSION }],
              seats: humanCount === 4 ? [0, 1, 2, 3] : [0, 1],
              options: { base: { mapLayout: 'random', vpTarget: 10 } },
            },
          })
        : LobbyController.join({ ...options, hostPeer: hostIdentity.peerId }),
    );
  });
  const create = (index: number) =>
    new OnlineStartup({
      invite,
      identity: required(identities[index]),
      lobby: required(lobbies[index]),
      transport: required(transports[index]),
      store: required(stores[index]),
      clock: network.clock,
      engine: createBaseEngine(),
      freezePeers: () => undefined,
    });
  const starts = identities.map((_identity, index) => create(index));
  const snapshots: NonNullable<OnlineRoomSnapshot['startup']>[] = [];
  let uiSnapshot: OnlineRoomSnapshot | null = null;
  const uiListeners = new Set<() => void>();
  const observe = () => {
    const current = required(starts[0]).snapshot();
    if (current) snapshots.push(structuredClone(current));
    uiSnapshot = snapshot();
    for (const listener of uiListeners) listener();
  };
  let unsubscribe = required(starts[0]).subscribe(observe);
  const snapshot = (): OnlineRoomSnapshot => ({
    invite,
    self: hostIdentity.peerId,
    signaling: { state: 'ready' },
    manual: { phase: 'idle', code: null, peer: null, gatheringComplete: null, error: null },
    peers: [],
    lobby: required(lobbies[0]).state(),
    agreement: required(starts[0]).agreement(),
    diagnostic: required(lobbies[0]).getDiagnostic(),
    connectionError: null,
    startup: required(starts[0]).snapshot(),
    closed: false,
  });
  vi.mocked(getOnlineRoom).mockReturnValue({
    invite,
    lobby: required(lobbies[0]),
    startGame: () => required(starts[0]).begin(),
    retryStart: () => required(starts[0]).retryFailed(),
    getGame: () => null,
    getSnapshot: () => (uiSnapshot ??= snapshot()),
    subscribe: (listener) => {
      uiListeners.add(listener);
      return () => uiListeners.delete(listener);
    },
    close: async () => undefined,
  });
  const settle = async (until: () => boolean) => {
    for (let step = 0; step < 300; step++) {
      network.clock.advanceBy(step % 10 === 0 ? 100 : 0);
      // oxlint-disable-next-line no-await-in-loop -- Drain the real serialized ceremony and its startup retry pulses.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (until()) return;
    }
    throw new Error(
      `Ceremony UI stalled: ${JSON.stringify(starts.map((start) => start.snapshot()))}`,
    );
  };
  network.clock.advanceBy(0);
  for (const [index, lobby] of lobbies.entries()) {
    if (index > 0)
      value(
        lobby.request({
          kind: 'takeSeat',
          seat: required(required(lobby.state()).seats[index]).seat,
        }),
      );
    network.clock.advanceBy(0);
  }
  for (const lobby of lobbies) {
    value(lobby.request({ kind: 'setReady', ready: true }));
    network.clock.advanceBy(0);
  }
  value(required(starts[0]).begin());
  return {
    network,
    starts,
    snapshots,
    hostConsents,
    guestPackets,
    settle,
    snapshot,
    async discloseSignedShare() {
      const agreement = required(required(starts[0]).agreement());
      const nonce = required(agreement.state.ceremonyNonce);
      const material = await loadCeremonyMaterial({
        store: required(stores[1]),
        identity: guestIdentity,
        ceremonyNonce: fromBase64Url(nonce),
        layout: agreement.state.seats.map((seat) => {
          if (seat.kind !== 'human') throw new Error('Disclosure fixture requires human seats');
          return { seat: seat.seat, kind: 'human', devicePeerId: seat.peer };
        }),
      });
      try {
        const owner = required(material.keys.find((seat) => seat.seat === 1));
        const envelope = required(
          envelopes.find((item) => item.body.dealer.seat === 0 && item.body.holder.seat === 1),
        );
        const source = createStealSecretSource(owner.master, nonce, 1, owner.peerId);
        try {
          const context = {
            protocol: 'escrow-share-dispute-v1' as const,
            ceremonyId: envelope.body.ceremonyId,
            dealerSeat: 0,
            holderSeat: 1,
            envelopeHash: escrowShareEnvelopeHash(envelope),
          };
          const secret = source.encryptionSecret();
          const sharedPoint = encodePoint(
            scalePoint(decodePoint(envelope.body.sealed.ephemeral), secret),
          );
          const proof = proveDleq(
            {
              base1: encodePoint(G),
              point1: envelope.body.holder.encryptionKey,
              base2: envelope.body.sealed.ephemeral,
              point2: sharedPoint,
            },
            secret,
            new Uint8Array(32).fill(99),
            context,
          );
          const disputeBody = { ...context, sharedPoint, proof };
          const dispute = {
            body: disputeBody,
            sig: signObject('escrow-share-dispute', disputeBody, owner.signingKey),
          };
          const body = {
            protocol: 'online-ceremony-v1',
            freezeHash: toHex(hashValue(agreement.state)),
            ceremonyNonce: nonce,
            senderDevice: guestIdentity.peerId,
            kind: 'escrow-dispute',
            seat: 1,
            step: 0,
            payload: { envelope, dispute },
          };
          const packet = canonicalEncode({
            body,
            sig: signObject('online-ceremony-message-v1', body, guestIdentity.secretKey),
          });
          network.transport(guestIdentity.peerId).send(hostIdentity.peerId, packet);
          return packet;
        } finally {
          source.dispose();
        }
      } finally {
        material.dispose();
      }
    },
    async restoreHost() {
      unsubscribe();
      await required(starts[0]).close();
      starts[0] = create(0);
      uiSnapshot = snapshot();
      unsubscribe = required(starts[0]).subscribe(observe);
    },
    releaseExactGuestPacket() {
      const packet = required(guestPackets[0]);
      held = false;
      network.transport(guestIdentity.peerId).send(hostIdentity.peerId, packet.slice());
      return packet.slice();
    },
    async close() {
      unsubscribe();
      uiListeners.clear();
      await Promise.all(starts.map((start) => start.close()));
      for (const lobby of lobbies) lobby.dispose();
      for (const identity of identities) identity.dispose();
      network.dispose();
    },
  };
}

test('genuine pre-consent timeout emits a retired UI snapshot and stays retired on restore', async () => {
  const room = await fixture('seed-commit');
  try {
    await room.settle(() => room.snapshot().startup?.phase === 'seed-commits');
    expect(room.snapshot().startup?.locallyConsented).toBe(false);
    room.network.clock.advanceBy(20_001);
    await room.settle(() => room.snapshot().startup?.phase === 'retired');
    expect(room.snapshot().startup?.error).toContain('online-ceremony-timeout');
    expect(room.hostConsents).toHaveLength(0);
    expect(openOnlineGame).not.toHaveBeenCalled();
    const page = render(<OnlineLobby lobbyId="ceremonyui" />);
    expect(page.getByText(englishLobby.onlineStartRetired)).toBeTruthy();
    expect(page.getByRole('button', { name: 'lobby:onlineNewRoom' })).toBeTruthy();
    expect(page.queryByRole('button', { name: 'lobby:onlineRetryStart' })).toBeNull();
    await act(async () => {
      await room.restoreHost();
      await room.settle(() => room.snapshot().startup?.phase === 'retired');
    });
    expect(page.getByText(englishLobby.onlineStartRetired)).toBeTruthy();
    expect(room.snapshot().startup?.locallyConsented).toBe(false);
    expect(room.hostConsents).toHaveLength(0);
    expect(openOnlineGame).not.toHaveBeenCalled();
  } finally {
    await room.close();
  }
}, 60_000);

test('genuine post-consent timeout emits recoverable waiting and restores before exact signature release', async () => {
  const room = await fixture('consent');
  try {
    await room.settle(() =>
      Boolean(room.snapshot().startup?.locallyConsented && room.guestPackets.length),
    );
    const consent = required(room.hostConsents[0]);
    const held = required(room.guestPackets[0]);
    room.network.clock.advanceBy(20_001);
    await room.settle(() => room.snapshot().startup?.phase === 'waiting');
    const page = render(<OnlineLobby lobbyId="ceremonyui" />);
    expect(page.getByText(englishLobby.onlineStartWaitingAgreement)).toBeTruthy();
    expect(page.queryByRole('button', { name: 'lobby:onlineRetryStart' })).toBeNull();
    expect(page.queryByRole('button', { name: 'lobby:onlineJoinNewRoom' })).toBeNull();
    expect(openOnlineGame).not.toHaveBeenCalled();
    await act(async () => {
      await room.restoreHost();
      await room.settle(() => room.snapshot().startup?.phase === 'waiting');
    });
    expect(room.snapshot().startup?.locallyConsented).toBe(true);
    expect(page.getByText(englishLobby.onlineStartWaitingAgreement)).toBeTruthy();
    for (const bytes of room.hostConsents) expect(bytes).toEqual(consent);
    expect(room.releaseExactGuestPacket()).toEqual(held);
    await act(async () => {
      await room.settle(() => vi.mocked(openOnlineGame).mock.calls.length > 0);
    });
    const input = required(vi.mocked(openOnlineGame).mock.calls[0])[0];
    if (input.entry.payload.kind !== 'genesis') throw new Error('Expected assembled genesis entry');
    expect(input.entry.payload.genesis.signatures).toHaveLength(2);
    const packet: unknown = canonicalDecode(held);
    if (!packet || typeof packet !== 'object' || !('body' in packet))
      throw new Error('Missing retained signed consent packet');
    const body = packet.body;
    if (!body || typeof body !== 'object' || !('payload' in body))
      throw new Error('Missing retained genesis signature');
    expect(input.entry.payload.genesis.signatures).toContainEqual(body.payload);
    expect(
      room.snapshots.some((snapshot) => snapshot.phase === 'opening' && snapshot.locallyConsented),
    ).toBe(true);
  } finally {
    await room.close();
  }
}, 60_000);

test('authenticated post-consent share disclosure reaches halted UI and retains its promise on restore', async () => {
  const room = await fixture('consent', 4);
  try {
    await room.settle(() =>
      Boolean(room.snapshot().startup?.locallyConsented && room.guestPackets.length),
    );
    const consent = required(room.hostConsents[0]);
    const page = render(<OnlineLobby lobbyId="ceremonyui" />);
    await act(async () => {
      await room.discloseSignedShare();
      await room.settle(() => room.snapshot().startup?.phase === 'halted');
    });
    expect(room.snapshot().startup).toMatchObject({
      phase: 'halted',
      locallyConsented: true,
      error: 'online-ceremony-disputed',
    });
    expect(page.getByText('lobby:onlineGameHalted')).toBeTruthy();
    expect(page.queryByRole('button', { name: 'lobby:onlineRetryStart' })).toBeNull();
    expect(page.queryByRole('button', { name: 'lobby:onlineNewRoom' })).toBeNull();
    expect(openOnlineGame).not.toHaveBeenCalled();
    await act(async () => {
      await room.restoreHost();
      await room.settle(() => room.snapshot().startup?.phase === 'halted');
    });
    expect(room.snapshot().startup).toMatchObject({
      locallyConsented: true,
      error: 'online-ceremony-disputed',
    });
    expect(page.getByText('lobby:onlineGameHalted')).toBeTruthy();
    for (const bytes of room.hostConsents) expect(bytes).toEqual(consent);
    expect(openOnlineGame).not.toHaveBeenCalled();
  } finally {
    await room.close();
  }
}, 60_000);
