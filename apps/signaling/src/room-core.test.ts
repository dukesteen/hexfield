import { identityFromSecret } from '@cp2p/crypto';
import { signRoomJoin } from '@cp2p/p2p/server-signaling-wire';
import { describe, expect, test } from 'vitest';
import { MAX_ROOM_PEERS, ROOM_IDLE_MS, RoomCore } from './room-core.js';

const ROOM = 'aaaaaaaaaa';
const OTHER_ROOM = 'bbbbbbbbbb';

class Socket {
  readonly sent: string[] = [];
  readonly closed: { code: number; reason: string }[] = [];
  send(text: string): void {
    this.sent.push(text);
  }
  close(code: number, reason: string): void {
    this.closed.push({ code, reason });
  }
  get challenge(): string {
    const first = this.sent[0];
    if (!first) throw new Error('Missing challenge');
    const frame: unknown = JSON.parse(first);
    if (
      !frame ||
      typeof frame !== 'object' ||
      !('challenge' in frame) ||
      typeof frame.challenge !== 'string'
    )
      throw new Error('Invalid challenge');
    return frame.challenge;
  }
}

function fixture() {
  let now = 0;
  let nextChallenge = 1;
  const core = new RoomCore(
    () => now,
    (length) => new Uint8Array(length).fill(nextChallenge++),
  );
  function join(seed: number, roomId = ROOM) {
    const identity = identityFromSecret(new Uint8Array(32).fill(seed));
    const socket = new Socket();
    const id = core.open(roomId, socket);
    core.receive(id, JSON.stringify(signRoomJoin(roomId, socket.challenge, identity.secretKey)));
    return { identity, socket, id };
  }
  return {
    core,
    join,
    time: (value: number) => {
      now = value;
    },
  };
}

describe('signaling room core', () => {
  test('routes opaque envelope text only within a signed room and preserves its bytes', () => {
    const f = fixture();
    const a = f.join(1);
    const b = f.join(2);
    const outside = f.join(3, OTHER_ROOM);
    const envelope = '{ "opaque": "sdp\\r\\n  Ω", "order": [2,1] }';
    f.core.receive(a.id, JSON.stringify({ type: 'signal', to: b.identity.peerId, envelope }));
    const delivered = b.socket.sent.at(-1);
    expect(delivered).toBeDefined();
    expect(JSON.parse(delivered ?? '')).toEqual({
      type: 'signal',
      from: a.identity.peerId,
      envelope,
    });
    expect(delivered).toContain(JSON.stringify(envelope).slice(1, -1));
    f.core.receive(a.id, JSON.stringify({ type: 'signal', to: outside.identity.peerId, envelope }));
    expect(outside.socket.sent).toHaveLength(2);
  });

  test('rejects replay and a second join on the same socket', () => {
    const f = fixture();
    const a = f.join(1);
    const replaySocket = new Socket();
    const replayId = f.core.open(ROOM, replaySocket);
    f.core.receive(
      replayId,
      JSON.stringify(signRoomJoin(ROOM, a.socket.challenge, a.identity.secretKey)),
    );
    expect(replaySocket.closed.at(-1)?.reason).toBe('invalid-join');
    f.core.receive(
      a.id,
      JSON.stringify(signRoomJoin(ROOM, a.socket.challenge, a.identity.secretKey)),
    );
    expect(a.socket.closed.at(-1)?.reason).toBe('invalid-join');
  });

  test('requires a valid signature from the claimed key for this room', () => {
    const f = fixture();
    const a = identityFromSecret(new Uint8Array(32).fill(1));
    const b = identityFromSecret(new Uint8Array(32).fill(2));
    for (const makeFrame of [
      (challenge: string) => {
        const signed = signRoomJoin(ROOM, challenge, a.secretKey);
        return { ...signed, sig: 'A'.repeat(signed.sig.length) };
      },
      (challenge: string) => {
        const signed = signRoomJoin(ROOM, challenge, b.secretKey);
        return { ...signed, body: { ...signed.body, peerId: a.peerId } };
      },
      (challenge: string) => signRoomJoin(OTHER_ROOM, challenge, a.secretKey),
    ]) {
      const socket = new Socket();
      const id = f.core.open(ROOM, socket);
      f.core.receive(id, JSON.stringify(makeFrame(socket.challenge)));
      expect(socket.closed.at(-1)?.reason).toBe('invalid-join');
      expect(f.core.peers(ROOM)).toEqual([]);
    }
  });

  test('fresh proof of the same key replaces a half-open socket without losing membership', () => {
    const f = fixture();
    const first = f.join(1);
    const second = f.join(1);
    expect(first.socket.closed).toEqual([{ code: 1008, reason: 'replaced' }]);
    expect(second.socket.closed).toEqual([]);
    expect(f.core.peers(ROOM)).toEqual([first.identity.peerId]);
    f.core.disconnect(first.id);
    expect(f.core.peers(ROOM)).toEqual([first.identity.peerId]);
    const receiver = f.join(2);
    f.core.receive(
      second.id,
      JSON.stringify({ type: 'signal', to: receiver.identity.peerId, envelope: 'successor' }),
    );
    expect(JSON.parse(receiver.socket.sent.at(-1) ?? 'null')).toEqual({
      type: 'signal',
      from: first.identity.peerId,
      envelope: 'successor',
    });
  });

  test('bounds room size, message rate, join deadline and idle lifetime', () => {
    const f = fixture();
    const members = Array.from({ length: MAX_ROOM_PEERS }, (_, index) => f.join(index + 1));
    expect(f.core.peers(ROOM)).toHaveLength(MAX_ROOM_PEERS);
    const ninth = f.join(20);
    expect(ninth.socket.closed.at(-1)?.reason).toBe('room-full');
    const pending = new Socket();
    f.core.open(OTHER_ROOM, pending);
    f.time(10_000);
    f.core.sweep();
    expect(pending.closed.at(-1)?.reason).toBe('join-timeout');
    const first = members[0];
    if (!first) throw new Error('Missing member');
    for (let index = 0; index < 30; index++)
      f.core.receive(first.id, JSON.stringify({ type: 'signal', to: 'unknown', envelope: 'x' }));
    expect(first.socket.closed).toEqual([]);
    f.core.receive(first.id, JSON.stringify({ type: 'signal', to: 'unknown', envelope: 'x' }));
    expect(first.socket.closed.at(-1)?.reason).toBe('rate-limit');
    f.time(ROOM_IDLE_MS + 10_001);
    f.core.sweep();
    expect(f.core.peers(ROOM)).toEqual([]);
  });

  test('drops a slow recipient without retaining its room membership', () => {
    const f = fixture();
    const a = f.join(1);
    const b = f.join(2);
    b.socket.send = () => {
      throw new Error('queued over host limit');
    };
    f.core.receive(
      a.id,
      JSON.stringify({ type: 'signal', to: b.identity.peerId, envelope: 'opaque' }),
    );
    expect(b.socket.closed.at(-1)?.reason).toBe('send-failed');
    expect(f.core.peers(ROOM)).toEqual([a.identity.peerId]);
  });

  test('a failed roster send cannot overwrite the updated membership with a stale snapshot', () => {
    const f = fixture();
    const a = f.join(1);
    const b = f.join(2);
    a.socket.send = () => {
      throw new Error('recipient disconnected');
    };
    const c = f.join(3);
    const peers = [b.identity.peerId, c.identity.peerId].toSorted();
    expect(f.core.peers(ROOM)).toEqual(peers);
    for (const socket of [b.socket, c.socket])
      expect(JSON.parse(socket.sent.at(-1) ?? 'null')).toEqual({ type: 'peers', peers });
  });

  test('rejects a complete wire frame over 64 KiB before parsing it', () => {
    const f = fixture();
    const a = f.join(1);
    f.core.receive(a.id, 'x'.repeat(65_537));
    expect(a.socket.closed.at(-1)?.reason).toBe('wire-limit');
    expect(f.core.peers(ROOM)).toEqual([]);
  });

  test('wire limit counts UTF-8 bytes and accepts a frame at exactly 64 KiB', () => {
    const f = fixture();
    const a = f.join(1);
    const frame = JSON.stringify({ type: 'signal', to: 'unknown', envelope: 'x' });
    f.core.receive(a.id, `${frame}${' '.repeat(65_536 - Buffer.byteLength(frame))}`);
    expect(a.socket.closed).toEqual([]);
    const multibyte = `${frame}${' '.repeat(65_535 - Buffer.byteLength(frame))}Ω`;
    expect(Buffer.byteLength(multibyte)).toBe(65_537);
    f.core.receive(a.id, multibyte);
    expect(a.socket.closed.at(-1)?.reason).toBe('wire-limit');
  });

  test('a delivered signal refreshes room idle time through the TTL boundary', () => {
    const f = fixture();
    const a = f.join(1);
    const b = f.join(2);
    f.time(ROOM_IDLE_MS - 1);
    f.core.sweep();
    expect(f.core.peers(ROOM)).toHaveLength(2);
    f.core.receive(a.id, JSON.stringify({ type: 'signal', to: b.identity.peerId, envelope: 'x' }));
    f.time(2 * ROOM_IDLE_MS - 2);
    f.core.sweep();
    expect(f.core.peers(ROOM)).toHaveLength(2);
    f.time(2 * ROOM_IDLE_MS - 1);
    f.core.sweep();
    expect(f.core.peers(ROOM)).toEqual([]);
  });
});
