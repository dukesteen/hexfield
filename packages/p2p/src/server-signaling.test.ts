import { toBase64Url } from '@cp2p/codec';
import { identityFromSecret } from '@cp2p/crypto';
import { describe, expect, test } from 'vitest';
import { VirtualClock } from '../../protocol/src/testing/virtual-clock.js';
import { ServerSignalingAdapter } from './server-signaling.js';
import { SERVER_BUFFER_LIMIT, SERVER_WIRE_LIMIT } from './server-signaling-wire.js';
import { signSignalEnvelope } from './signaling-envelope.js';

class FakeSocket {
  readonly listeners = new Map<
    string,
    ((event: { data?: unknown; code?: number; reason?: string }) => void)[]
  >();
  readonly sent: string[] = [];
  readyState = 1;
  bufferedAmount = 0;
  addEventListener(
    type: string,
    listener: (event: { data?: unknown; code?: number; reason?: string }) => void,
  ): void {
    const values = this.listeners.get(type) ?? [];
    values.push(listener);
    this.listeners.set(type, values);
  }
  emit(type: string, data?: unknown, close?: { code: number; reason: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data, ...close });
  }
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
  browserSocket(): WebSocket {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deterministic fake implements the adapter's WebSocket surface.
    return this as unknown as WebSocket;
  }
}

function fixture() {
  const identity = identityFromSecret(new Uint8Array(32).fill(1));
  const peer = identityFromSecret(new Uint8Array(32).fill(2));
  const clock = new VirtualClock();
  const sockets: FakeSocket[] = [];
  const statuses: { state: string; reason?: string }[] = [];
  const adapter = new ServerSignalingAdapter({
    serverUrl: 'ws://localhost:3009',
    roomId: 'aaaaaaaaaa',
    self: identity.peerId,
    secretKey: identity.secretKey,
    clock,
    onStatus: (status) => statuses.push(status),
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket.browserSocket();
    },
  });
  const socket = sockets[0];
  if (!socket) throw new Error('Missing fake socket');
  const challenge = toBase64Url(new Uint8Array(32).fill(7));
  function ready(target = socket) {
    if (!target) throw new Error('Missing socket');
    target.emit('message', JSON.stringify({ type: 'challenge', roomId: 'aaaaaaaaaa', challenge }));
    target.emit('message', JSON.stringify({ type: 'peers', peers: [identity.peerId] }));
  }
  function offer(sdp = 'v=0\r\n') {
    return signSignalEnvelope(
      {
        version: 2,
        scope: 'lobby',
        from: identity.peerId,
        to: peer.peerId,
        attemptId: 'AQEBAQEBAQEBAQEBAQEBAQ',
        sessionId: 'AwMDAwMDAwMDAwMDAwMDAw',
        attemptSeq: 1,
        blob: {
          kind: 'description',
          generation: 1,
          revision: 1,
          description: { type: 'offer', sdp },
        },
      },
      identity.secretKey,
    );
  }
  return { adapter, identity, peer, clock, sockets, socket, challenge, ready, offer, statuses };
}

describe('server signaling client', () => {
  test('publishes validated detached room snapshots to late listeners and clears them on reconnect', () => {
    const f = fixture();
    const changes: (readonly string[] | null)[] = [];
    try {
      const unsubscribe = f.adapter.onRoomPeers((peers) => changes.push(peers));
      expect(changes).toEqual([null]);
      f.ready();
      expect(f.adapter.roomPeers()).toEqual([f.identity.peerId]);
      const peerList = [f.peer.peerId, f.identity.peerId];
      f.socket.emit('message', JSON.stringify({ type: 'peers', peers: peerList }));
      const expected = peerList.toSorted();
      expect(f.adapter.roomPeers()).toEqual(expected);
      const detached = f.adapter.roomPeers();
      if (!detached) throw new Error('Missing room snapshot');
      Reflect.set(detached, 0, 'corrupted');
      expect(f.adapter.roomPeers()).toEqual(expected);
      const late: (readonly string[] | null)[] = [];
      f.adapter.onRoomPeers((peers) => late.push(peers));
      expect(late).toEqual([expected]);
      f.socket.emit('message', JSON.stringify({ type: 'peers', peers: peerList }));
      expect(changes).toHaveLength(3);
      f.socket.emit('error');
      expect(f.adapter.roomPeers()).toBeNull();
      expect(changes.at(-1)).toBeNull();
      f.clock.advanceBy(250);
      const replacement = f.sockets[1];
      if (!replacement) throw new Error('Missing retry socket');
      f.ready(replacement);
      expect(f.adapter.roomPeers()).toEqual([f.identity.peerId]);
      unsubscribe();
    } finally {
      f.adapter.close();
    }
  });

  test('rejects invalid initial rosters and ignores malformed later advice', () => {
    const f = fixture();
    try {
      f.socket.emit(
        'message',
        JSON.stringify({ type: 'challenge', roomId: 'aaaaaaaaaa', challenge: f.challenge }),
      );
      f.socket.emit(
        'message',
        JSON.stringify({ type: 'peers', peers: [f.identity.peerId, f.identity.peerId] }),
      );
      expect(f.socket.readyState).toBe(3);
      expect(f.adapter.roomPeers()).toBeNull();
      f.clock.advanceBy(250);
      const replacement = f.sockets[1];
      if (!replacement) throw new Error('Missing retry socket');
      f.ready(replacement);
      const initial = f.adapter.roomPeers();
      replacement.emit('message', JSON.stringify({ type: 'peers', peers: [f.peer.peerId] }));
      replacement.emit(
        'message',
        JSON.stringify({ type: 'peers', peers: [f.identity.peerId, 'bad'] }),
      );
      replacement.emit(
        'message',
        JSON.stringify({ type: 'peers', peers: Array(9).fill(f.identity.peerId) }),
      );
      expect(f.adapter.roomPeers()).toEqual(initial);
      expect(replacement.readyState).toBe(1);
    } finally {
      f.adapter.close();
    }
  });

  test('open socket without challenge or join acknowledgement expires and retries', () => {
    const f = fixture();
    try {
      f.clock.advanceBy(10_000);
      expect(f.socket.readyState).toBe(3);
      f.clock.advanceBy(250);
      expect(f.sockets).toHaveLength(2);
      const replacement = f.sockets[1];
      if (!replacement) throw new Error('Missing replacement socket');
      replacement.emit(
        'message',
        JSON.stringify({ type: 'challenge', roomId: 'aaaaaaaaaa', challenge: f.challenge }),
      );
      expect(replacement.sent).toHaveLength(1);
      f.clock.advanceBy(10_000);
      expect(replacement.readyState).toBe(3);
    } finally {
      f.adapter.close();
    }
  });

  test('signs one canonical challenge, ignores duplicates and enforces local buffer limit', async () => {
    const f = fixture();
    try {
      f.socket.emit(
        'message',
        JSON.stringify({ type: 'challenge', roomId: 'aaaaaaaaaa', challenge: 'AAAA' }),
      );
      expect(f.socket.readyState).toBe(3);
      f.clock.advanceBy(250);
      const socket = f.sockets[1];
      if (!socket) throw new Error('Missing replacement');
      const challengeFrame = JSON.stringify({
        type: 'challenge',
        roomId: 'aaaaaaaaaa',
        challenge: f.challenge,
      });
      socket.emit('message', challengeFrame);
      socket.emit('message', challengeFrame);
      expect(socket.sent).toHaveLength(1);
      const join: unknown = JSON.parse(socket.sent[0] ?? 'null');
      expect(join).toMatchObject({
        type: 'join',
        body: { challenge: f.challenge, peerId: f.identity.peerId },
      });
      socket.emit('message', JSON.stringify({ type: 'peers', peers: [f.identity.peerId] }));
      socket.emit('message', challengeFrame);
      expect(socket.sent).toHaveLength(1);
      const envelope = f.offer();
      socket.bufferedAmount = SERVER_BUFFER_LIMIT;
      await expect(f.adapter.send(f.peer.peerId, envelope)).rejects.toThrow('buffer is full');
      expect(socket.sent).toHaveLength(1);
      socket.bufferedAmount = 0;
      await f.adapter.send(f.peer.peerId, envelope);
      expect(socket.sent).toHaveLength(2);
    } finally {
      f.adapter.close();
    }
  });
  test('paces a burst below the server rate while resolving only sent frames', async () => {
    const f = fixture();
    let settled: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      f.ready();
      let completed = 0;
      const sends = Array.from({ length: 31 }, () =>
        f.adapter.send(f.peer.peerId, f.offer()).then(() => {
          completed++;
          return undefined;
        }),
      );
      settled = Promise.allSettled(sends);
      expect(f.socket.sent).toHaveLength(2); // Join and first signal.
      await sends[0];
      expect(completed).toBe(1);
      f.clock.advanceBy(999);
      expect(f.socket.sent).toHaveLength(21);
      f.clock.advanceBy(501);
      await Promise.all(sends);
      expect(f.socket.sent).toHaveLength(32);
      expect(completed).toBe(31);
    } finally {
      f.adapter.close();
      await settled;
    }
  });

  test('counts forwarded frame bytes including JSON escaping before accepting a send', async () => {
    const f = fixture();
    try {
      f.ready();
      const base = f.offer('');
      const overhead = new TextEncoder().encode(
        JSON.stringify({
          type: 'signal',
          from: f.identity.peerId,
          envelope: JSON.stringify(base),
        }),
      ).byteLength;
      const exact = f.offer('x'.repeat(SERVER_WIRE_LIMIT - overhead));
      await f.adapter.send(f.peer.peerId, exact);
      const wire = f.socket.sent.at(-1) ?? '';
      expect(new TextEncoder().encode(wire)).toHaveLength(SERVER_WIRE_LIMIT - 2);
      const oneTooLarge = f.offer('x'.repeat(SERVER_WIRE_LIMIT - overhead + 1));
      await expect(f.adapter.send(f.peer.peerId, oneTooLarge)).rejects.toThrow('exceeds 64 KiB');
      await expect(f.adapter.send(f.peer.peerId, f.offer('Ω"\r\n'.repeat(7_000)))).rejects.toThrow(
        'exceeds 64 KiB',
      );
      expect(f.socket.sent).toHaveLength(2);
    } finally {
      f.adapter.close();
    }
  });

  test('replacement is terminal so two sockets with one key cannot continually evict each other', async () => {
    const f = fixture();
    try {
      const pending = f.adapter.send(f.peer.peerId, f.offer());
      f.socket.emit('close', undefined, { code: 1008, reason: 'replaced' });
      await expect(pending).rejects.toThrow('closed');
      f.clock.advanceBy(60_000);
      expect(f.sockets).toHaveLength(1);
      expect(f.statuses.at(-1)).toEqual({ state: 'closed', reason: 'replaced' });
    } finally {
      f.adapter.close();
    }
  });

  test('queued sends survive a reconnect and ignore stale socket readiness', async () => {
    const f = fixture();
    try {
      const pending = f.adapter.send(f.peer.peerId, f.offer());
      f.socket.emit('error');
      f.ready(f.socket);
      expect(f.socket.sent).toEqual([]);
      f.clock.advanceBy(250);
      const replacement = f.sockets[1];
      if (!replacement) throw new Error('Missing replacement');
      f.ready(replacement);
      await pending;
      expect(replacement.sent).toHaveLength(2);
    } finally {
      f.adapter.close();
    }
  });

  test('caps pending sends and expires them without a socket write', async () => {
    const f = fixture();
    try {
      const pending = Promise.allSettled(
        Array.from({ length: 32 }, () => f.adapter.send(f.peer.peerId, f.offer())),
      );
      await expect(f.adapter.send(f.peer.peerId, f.offer())).rejects.toThrow('waiters are full');
      f.clock.advanceBy(10_000);
      const settled = await pending;
      expect(settled).toHaveLength(32);
      expect(settled.every((result) => result.status === 'rejected')).toBe(true);
      expect(f.socket.sent).toEqual([]);
    } finally {
      f.adapter.close();
    }
  });
});
