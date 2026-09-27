import { identityFromSecret } from '@cp2p/crypto';
import { signRoomJoin } from '@cp2p/p2p/server-signaling-wire';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CloudflareRoom } from './cloudflare-room.js';
import { ROOM_IDLE_MS } from '../src/room-core.js';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    protected ctx: unknown;
    protected env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const ROOM = 'aaaaaaaaaa';

class FakeSocket {
  readonly messages: string[] = [];
  readonly closed: { code: number; reason: string }[] = [];
  readyState = 1;
  #attachment: unknown = null;

  send(value: string): void {
    if (this.readyState !== 1) throw new Error('Socket is closed');
    this.messages.push(value);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.closed.push({ code, reason });
    this.readyState = 3;
  }

  serializeAttachment(value: unknown): void {
    this.#attachment = value === null ? null : structuredClone(value);
  }

  deserializeAttachment(): unknown {
    return this.#attachment === null ? null : structuredClone(this.#attachment);
  }
}

class FakeStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fake store mirrors the platform's generic read boundary.
    return this.values.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
  async setAlarm(value: number): Promise<void> {
    this.alarmAt = value;
  }
  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

class FakeState {
  readonly storage = new FakeStorage();
  readonly sockets: FakeSocket[] = [];
  acceptWebSocket(socket: FakeSocket): void {
    this.sockets.push(socket);
  }
  getWebSockets(): FakeSocket[] {
    return this.sockets.filter((socket) => socket.readyState !== 3);
  }
}

class FakePair {
  static pairs: FakePair[] = [];
  readonly 0 = new FakeSocket();
  readonly 1 = new FakeSocket();
  constructor() {
    FakePair.pairs.push(this);
  }
}

class FakeResponse {
  constructor(
    readonly body: unknown,
    readonly init: { status?: number; webSocket?: FakeSocket } = {},
  ) {}
  get status(): number {
    return this.init.status ?? 200;
  }
}

function request(): Request {
  return new Request(`https://room.test/room/${ROOM}`, {
    headers: { Upgrade: 'websocket' },
  });
}

async function open(room: CloudflareRoom): Promise<FakeSocket> {
  const response = await room.fetch(request());
  expect(response.status).toBe(101);
  const pair = FakePair.pairs.at(-1);
  if (!pair) throw new Error('WebSocketPair was not created');
  return pair[1];
}

function challenge(socket: FakeSocket): string {
  const frame: unknown = JSON.parse(socket.messages[0] ?? 'null');
  if (!frame || typeof frame !== 'object' || !('challenge' in frame))
    throw new Error('Missing challenge');
  return String(frame.challenge);
}

function makeRoom(state: FakeState): CloudflareRoom {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This fake supplies only the Durable Object host operations exercised here.
  return new CloudflareRoom(state as unknown as DurableObjectState, {} as Cloudflare.Env);
}

function nativeSocket(socket: FakeSocket): WebSocket {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The fake models the WebSocket methods used by the adapter.
  return socket as unknown as WebSocket;
}

afterEach(() => {
  FakePair.pairs = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Cloudflare room hibernation adapter', () => {
  test('restores peer identity and routes opaque signals after object eviction', async () => {
    vi.stubGlobal('WebSocketPair', FakePair);
    vi.stubGlobal('Response', FakeResponse);
    const state = new FakeState();
    const firstRoom = makeRoom(state);
    const firstSocket = await open(firstRoom);
    const first = identityFromSecret(new Uint8Array(32).fill(1));
    await firstRoom.webSocketMessage(
      nativeSocket(firstSocket),
      JSON.stringify(signRoomJoin(ROOM, challenge(firstSocket), first.secretKey)),
    );

    const restored = makeRoom(state);
    const secondSocket = await open(restored);
    const second = identityFromSecret(new Uint8Array(32).fill(2));
    await restored.webSocketMessage(
      nativeSocket(secondSocket),
      JSON.stringify(signRoomJoin(ROOM, challenge(secondSocket), second.secretKey)),
    );
    await restored.webSocketMessage(
      nativeSocket(secondSocket),
      JSON.stringify({ type: 'signal', to: first.peerId, envelope: 'opaque' }),
    );

    expect(JSON.parse(firstSocket.messages.at(-1) ?? 'null')).toEqual({
      type: 'signal',
      from: second.peerId,
      envelope: 'opaque',
    });
  });

  test('restored challenge rejects replay and a fresh proof replaces the prior socket', async () => {
    vi.stubGlobal('WebSocketPair', FakePair);
    vi.stubGlobal('Response', FakeResponse);
    const state = new FakeState();
    const room = makeRoom(state);
    const socket = await open(room);
    const identity = identityFromSecret(new Uint8Array(32).fill(3));
    const proof = signRoomJoin(ROOM, challenge(socket), identity.secretKey);
    await room.webSocketMessage(nativeSocket(socket), JSON.stringify(proof));

    const restored = makeRoom(state);
    const replay = await open(restored);
    await restored.webSocketMessage(nativeSocket(replay), JSON.stringify(proof));
    expect(replay.closed.at(-1)?.reason).toBe('invalid-join');
    expect(socket.closed).toEqual([]);
    const replacement = await open(restored);
    await restored.webSocketMessage(
      nativeSocket(replacement),
      JSON.stringify(signRoomJoin(ROOM, challenge(replacement), identity.secretKey)),
    );
    expect(replacement.closed).toEqual([]);
    expect(socket.closed.at(-1)?.reason).toBe('replaced');
  });

  test('restores authentication deadlines through the single alarm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal('WebSocketPair', FakePair);
    vi.stubGlobal('Response', FakeResponse);
    const state = new FakeState();
    const room = makeRoom(state);
    const pending = await open(room);
    const alarm = state.storage.alarmAt;
    expect(alarm).toBeTypeOf('number');

    const restored = makeRoom(state);
    vi.setSystemTime(10_000);
    await restored.alarm();
    expect(pending.closed.at(-1)?.reason).toBe('join-timeout');
  });

  test('completes a close handshake when the runtime has not closed the socket yet', async () => {
    vi.stubGlobal('WebSocketPair', FakePair);
    vi.stubGlobal('Response', FakeResponse);
    const state = new FakeState();
    const room = makeRoom(state);
    const socket = await open(room);
    socket.readyState = 2;

    await room.webSocketClose(nativeSocket(socket), 1008, 'auth-timeout', false);

    expect(socket.closed.at(-1)).toEqual({ code: 1008, reason: 'auth-timeout' });
  });

  test('sweeps expired rooms before serving a message when the alarm is late', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal('WebSocketPair', FakePair);
    vi.stubGlobal('Response', FakeResponse);
    const state = new FakeState();
    const room = makeRoom(state);
    const firstSocket = await open(room);
    const first = identityFromSecret(new Uint8Array(32).fill(5));
    await room.webSocketMessage(
      nativeSocket(firstSocket),
      JSON.stringify(signRoomJoin(ROOM, challenge(firstSocket), first.secretKey)),
    );
    const secondSocket = await open(room);
    const second = identityFromSecret(new Uint8Array(32).fill(6));
    await room.webSocketMessage(
      nativeSocket(secondSocket),
      JSON.stringify(signRoomJoin(ROOM, challenge(secondSocket), second.secretKey)),
    );

    const restored = makeRoom(state);
    vi.setSystemTime(ROOM_IDLE_MS + 1);
    await restored.webSocketMessage(
      nativeSocket(secondSocket),
      JSON.stringify({ type: 'signal', to: first.peerId, envelope: 'too-late' }),
    );

    expect(firstSocket.closed.at(-1)?.reason).toBe('room-expired');
    expect(secondSocket.closed.at(-1)?.reason).toBe('room-expired');
    expect(firstSocket.messages.at(-1)).not.toContain('too-late');
  });

  test('rejects binary messages and keeps the connection ceiling at sixteen', async () => {
    vi.stubGlobal('WebSocketPair', FakePair);
    vi.stubGlobal('Response', FakeResponse);
    const state = new FakeState();
    const room = makeRoom(state);
    const sockets = await Promise.all(Array.from({ length: 16 }, () => open(room)));
    expect((await room.fetch(request())).status).toBe(503);

    const restored = makeRoom(state);
    const first = sockets[0];
    if (!first) throw new Error('Missing socket');
    await restored.webSocketMessage(nativeSocket(first), new ArrayBuffer(1));
    expect(first.closed.at(-1)).toMatchObject({ code: 1003, reason: 'text-only' });
  });
});
