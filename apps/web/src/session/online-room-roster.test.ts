import { canonicalEncode, toBase64Url } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { BASE_VERSION } from '@cp2p/engine';
import { MemoryEscrowLifecycleStore, VirtualClock } from '@cp2p/protocol/testing';
import type { PeerId } from '@cp2p/protocol';
import { expect, test } from 'vitest';
import { WebRtcTransport } from '@cp2p/p2p';
import { OnlineRoom } from './online-room.js';
import { planPregameRoster } from './online-room-roster.js';

const peer = (value: number): PeerId => String(value);

test('seated peers and the current host survive a full spectator and discovery list', () => {
  const roster = planPregameRoster({
    self: peer(1),
    host: peer(2),
    seated: [peer(2), peer(3), peer(4)],
    connected: [peer(5)],
    spectators: [peer(6), peer(7), peer(8)],
    transient: [peer(9), peer(10)],
  });
  expect(roster).toEqual([peer(1), peer(2), peer(3), peer(4), peer(5), peer(6)]);
});

test('obsolete discovery peers disappear and the newest available candidate gets a slot', () => {
  const common = {
    self: peer(1),
    host: peer(1),
    seated: [peer(1), peer(2)],
    connected: [peer(2)],
    spectators: [] as PeerId[],
  };
  const before = planPregameRoster({ ...common, transient: [peer(7), peer(6), peer(5), peer(4)] });
  const after = planPregameRoster({ ...common, transient: [peer(8), peer(7), peer(6), peer(5)] });
  expect(before).toEqual([peer(1), peer(2), peer(7), peer(6), peer(5), peer(4)]);
  expect(after).toEqual([peer(1), peer(2), peer(8), peer(7), peer(6), peer(5)]);
});

class SignalingSocket {
  readonly listeners = new Map<string, ((event: { data?: unknown }) => void)[]>();
  readyState = 1;
  bufferedAmount = 0;

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data });
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
  }

  browserSocket(): WebSocket {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bounded signaling test fake.
    return this as unknown as WebSocket;
  }
}

test('a departed server-discovered peer frees a room slot for a new device', async () => {
  const socket = new SignalingSocket();
  const identities = Array.from({ length: 6 }, (_, index) =>
    identityFromSecret(new Uint8Array(32).fill(index + 51)),
  );
  const [newcomer, ...ghosts] = identities;
  if (!newcomer) throw new Error('Missing newcomer identity');
  const room = await OnlineRoom.open(
    {
      kind: 'host',
      serverUrl: 'ws://localhost:3009',
      name: 'Roster test',
      hostName: 'Host',
      config: {
        modules: [{ id: 'base', version: BASE_VERSION }],
        seats: [0, 1],
        options: { base: { mapLayout: 'random', vpTarget: 3 } },
      },
    },
    {
      store: new MemoryEscrowLifecycleStore(),
      clock: new VirtualClock(),
      socketFactory: () => socket.browserSocket(),
      rtcFactory: () => {
        throw new Error('Peer connection attempted');
      },
      manualRtcFactory: () => {
        throw new Error('Manual target admitted');
      },
      acquireLease: async () => ({
        lockName: 'roster-test',
        run: async <T>(task: () => T | PromiseLike<T>) => task(),
        close: async () => undefined,
      }),
    },
  );
  try {
    const self = room.getSnapshot().self;
    socket.emit(
      'message',
      JSON.stringify({
        type: 'challenge',
        roomId: room.invite.roomId,
        challenge: toBase64Url(new Uint8Array(32).fill(7)),
      }),
    );
    socket.emit(
      'message',
      JSON.stringify({ type: 'peers', peers: [self, ...ghosts.map((id) => id.peerId)] }),
    );
    socket.emit('message', JSON.stringify({ type: 'peers', peers: [self, newcomer.peerId] }));
    const oldTarget = ghosts[0];
    if (!oldTarget) throw new Error('Missing old discovery peer');
    const stale = await room.startManualInvitation(oldTarget.peerId);
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('Unexpected stale target');
    expect(stale.error.code).toBe('manual-roster');
    const admitted = await room.startManualInvitation(newcomer.peerId);
    expect(admitted.ok).toBe(false);
    if (admitted.ok) throw new Error('Expected fake manual connection to fail');
    expect(admitted.error.code).toBe('manual-offer');
  } finally {
    await room.close();
    for (const identity of identities) identity.secretKey.fill(0);
  }
});

test('frozen room forwards only newly present admitted peers as bounded reconnect hints', async () => {
  const socket = new SignalingSocket();
  const pair = [81, 82].map((byte) => identityFromSecret(new Uint8Array(32).fill(byte)));
  const [host, target] = pair.toSorted((left, right) => left.peerId.localeCompare(right.peerId));
  if (!host || !target) throw new Error('Missing reconnect identities');
  const outsider = identityFromSecret(new Uint8Array(32).fill(83));
  const store = new MemoryEscrowLifecycleStore();
  expect(
    await store.putIfAbsent(
      'online-credentials/device-identity/v1',
      canonicalEncode({
        protocol: 'cp2p/online-device-identity/v1',
        peerId: host.peerId,
        secretKey: host.secretKey,
      }),
    ),
  ).toBe(true);
  let attempts = 0;
  const room = await OnlineRoom.open(
    {
      kind: 'host',
      serverUrl: 'ws://localhost:3009',
      name: 'Reconnect test',
      hostName: 'Host',
      config: {
        modules: [{ id: 'base', version: BASE_VERSION }],
        seats: [0, 1],
        options: { base: { mapLayout: 'random', vpTarget: 3 } },
      },
    },
    {
      store,
      clock: new VirtualClock(),
      socketFactory: () => socket.browserSocket(),
      rtcFactory: () => {
        attempts++;
        throw new Error('Connection unavailable');
      },
      manualRtcFactory: () => {
        throw new Error('Manual connection unavailable');
      },
      acquireLease: async () => ({
        lockName: 'reconnect-test',
        run: async <T>(task: () => T | PromiseLike<T>) => task(),
        close: async () => undefined,
      }),
    },
  );
  try {
    const self = room.getSnapshot().self;
    expect(self).toBe(host.peerId);
    const transport: unknown = Reflect.get(room, 'transport');
    if (!(transport instanceof WebRtcTransport)) throw new Error('Missing room transport');
    transport.updatePreGameRoster([self, target.peerId]);
    transport.freezeRoster();
    Reflect.set(room, 'frozenRoster', true);
    const initialAttempts = attempts;
    socket.emit(
      'message',
      JSON.stringify({
        type: 'challenge',
        roomId: room.invite.roomId,
        challenge: toBase64Url(new Uint8Array(32).fill(7)),
      }),
    );
    const peers = (members: readonly PeerId[]) =>
      socket.emit('message', JSON.stringify({ type: 'peers', peers: [self, ...members] }));
    peers([]);
    peers([target.peerId]);
    expect(attempts).toBe(initialAttempts + 1);
    peers([target.peerId]);
    expect(attempts).toBe(initialAttempts + 1);
    peers([outsider.peerId]);
    expect(attempts).toBe(initialAttempts + 1);
    transport.updateCertifiedRoster({
      head: { seq: 0, hash: 'a'.repeat(64) },
      activeDevices: [self],
      catchupDevices: [],
    });
    peers([target.peerId]);
    expect(attempts).toBe(initialAttempts + 1);
  } finally {
    await room.close();
    host.secretKey.fill(0);
    target.secretKey.fill(0);
    outsider.secretKey.fill(0);
  }
});
