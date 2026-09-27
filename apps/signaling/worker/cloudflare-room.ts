import { DurableObject } from 'cloudflare:workers';
import { ROOM_JOIN_TIMEOUT_MS, SERVER_WIRE_LIMIT } from '@cp2p/p2p/server-signaling-wire';
import {
  MAX_ROOM_SOCKETS,
  ROOM_IDLE_MS,
  RoomCore,
  type RoomSessionSnapshot,
  type RoomSocket,
} from '../src/room-core.js';

const roomIdPattern = /^[a-z2-7]{10}$/;
const snapshotVersion = 1;
const attachmentLimit = 2_048;
const bufferedAmountLimit = SERVER_WIRE_LIMIT * 4;
const roomIdKey = 'room-id';
const lastActivityKey = 'last-activity';

type SocketWithAttachment = WebSocket & {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
};

/** One hibernatable, durable signaling room. The Worker routes by room name. */
export class CloudflareRoom extends DurableObject {
  readonly #core: RoomCore;
  #roomId: string | null = null;
  #lastActivity: number | null = null;
  #serial: Promise<void> = Promise.resolve();
  readonly #ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.#core = new RoomCore(() => Date.now());
    this.#ready = this.#restore();
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomId = url.pathname.match(/^\/room\/([a-z2-7]{10})$/)?.[1];
    if (
      request.method !== 'GET' ||
      request.headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
      !roomId ||
      !roomIdPattern.test(roomId)
    )
      return new Response('Not found', { status: 404 });

    await this.#ready;
    return this.#run(async () => {
      this.#core.sweep();
      if (this.#roomId !== null && this.#roomId !== roomId)
        return new Response('Room binding mismatch', { status: 404 });
      if (this.ctx.getWebSockets().length >= MAX_ROOM_SOCKETS)
        return new Response('Room connection limit reached', { status: 503 });

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1] as SocketWithAttachment;
      this.ctx.acceptWebSocket(server);
      try {
        this.#roomId = roomId;
        await this.ctx.storage.put(roomIdKey, roomId);
        const sessionId = this.#core.open(roomId, socketAdapter(server));
        this.#saveAttachment(server, sessionId);
        await this.#persistAndSchedule();
      } catch {
        try {
          server.close(1011, 'room-open-failed');
        } catch {
          // The upgrade is already being rejected.
        }
        return new Response('Unable to open signaling room', { status: 503 });
      }
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    await this.#ready;
    await this.#run(async () => {
      const socket = ws as SocketWithAttachment;
      const snapshot = this.#readAttachment(socket);
      if (!snapshot) {
        this.#close(socket, 1011, 'invalid-session');
        await this.#persistAndSchedule();
        return;
      }
      if (typeof message !== 'string') {
        this.#core.disconnect(snapshot.id);
        this.#close(socket, 1003, 'text-only');
        await this.#persistAndSchedule();
        return;
      }
      this.#core.sweep();
      this.#core.receive(snapshot.id, message);
      await this.#persistAndSchedule();
    });
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const socket = ws as SocketWithAttachment;
    if (socket.readyState !== 3)
      this.#close(
        socket,
        isValidCloseCode(code) ? code : 1000,
        isValidCloseCode(code) ? reason : '',
      );
    await this.#ready;
    await this.#run(async () => {
      const snapshot = this.#readAttachment(socket);
      if (snapshot) this.#core.disconnect(snapshot.id);
      this.#clearAttachment(socket);
      await this.#persistAndSchedule();
    });
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    await this.webSocketClose(ws, 1001, 'socket-error', false);
  }

  override async alarm(): Promise<void> {
    await this.#ready;
    await this.#run(async () => {
      this.#core.sweep();
      await this.#persistAndSchedule();
    });
  }

  async #restore(): Promise<void> {
    this.#roomId = (await this.ctx.storage.get<string>(roomIdKey)) ?? null;
    const storedActivity = await this.ctx.storage.get<number>(lastActivityKey);
    this.#lastActivity =
      typeof storedActivity === 'number' && Number.isFinite(storedActivity) ? storedActivity : null;
    const sockets = this.ctx.getWebSockets();
    for (const [index, ws] of sockets.entries()) {
      const socket = ws as SocketWithAttachment;
      const snapshot = this.#readAttachment(socket);
      if (
        index >= MAX_ROOM_SOCKETS ||
        !snapshot ||
        (this.#roomId !== null && snapshot.roomId !== this.#roomId)
      ) {
        this.#close(socket, 1011, 'invalid-session');
        continue;
      }
      this.#roomId ??= snapshot.roomId;
      const restoredSnapshot =
        this.#lastActivity === null
          ? snapshot
          : {
              ...snapshot,
              roomLastActivity: Math.max(snapshot.roomLastActivity ?? 0, this.#lastActivity),
            };
      try {
        this.#core.restoreSession(restoredSnapshot, socketAdapter(socket));
      } catch {
        this.#close(socket, 1011, 'invalid-session');
      }
    }
    this.#core.sweep();
    if (this.#roomId) await this.ctx.storage.put(roomIdKey, this.#roomId);
    await this.#persistAndSchedule();
  }

  async #persistAndSchedule(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    const snapshots: RoomSessionSnapshot[] = [];
    for (const ws of sockets) {
      const socket = ws as SocketWithAttachment;
      const current = this.#readAttachment(socket);
      const snapshot = current ? this.#core.snapshotSession(current.id) : undefined;
      if (!snapshot) {
        this.#clearAttachment(socket);
        continue;
      }
      this.#saveAttachment(socket, snapshot.id);
      const saved = this.#readAttachment(socket);
      if (saved) snapshots.push(saved);
    }

    const activity = snapshots.reduce<number | null>((latest, value) => {
      if (value.roomLastActivity === null) return latest;
      return latest === null ? value.roomLastActivity : Math.max(latest, value.roomLastActivity);
    }, null);
    this.#lastActivity = activity;
    if (activity === null) await this.ctx.storage.delete(lastActivityKey);
    else await this.ctx.storage.put(lastActivityKey, activity);

    const now = Date.now();
    const deadlines = snapshots
      .filter((value) => value.peerId === null)
      .map((value) => value.openedAt + ROOM_JOIN_TIMEOUT_MS);
    if (activity !== null) deadlines.push(activity + ROOM_IDLE_MS);
    const nextAlarm = deadlines.length > 0 ? Math.min(...deadlines) : null;
    if (nextAlarm === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(now, nextAlarm));
  }

  #saveAttachment(socket: SocketWithAttachment, id: number): void {
    const snapshot = this.#core.snapshotSession(id);
    if (!snapshot) throw new Error('Cannot attach a missing session');
    const encodedSize = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
    if (encodedSize > attachmentLimit) throw new Error('Session attachment exceeded its bound');
    socket.serializeAttachment(snapshot);
  }

  #readAttachment(socket: SocketWithAttachment): RoomSessionSnapshot | null {
    try {
      const value: unknown = socket.deserializeAttachment();
      if (!isSnapshot(value)) return null;
      const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      return size <= attachmentLimit ? value : null;
    } catch {
      return null;
    }
  }

  #clearAttachment(socket: SocketWithAttachment): void {
    try {
      socket.serializeAttachment(null);
    } catch {
      // The socket may already be closed by the platform.
    }
  }

  #close(socket: SocketWithAttachment, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // The membership has already been removed.
    }
  }

  #run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#serial.then(operation, operation);
    this.#serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function socketAdapter(socket: WebSocket): RoomSocket {
  return {
    send(text) {
      const bufferedAmount = (socket as WebSocket & { bufferedAmount?: number }).bufferedAmount;
      // Some Workers WebSocket implementations do not expose bufferedAmount;
      // they enforce their own send-buffer bound and close sockets on overflow.
      if (typeof bufferedAmount === 'number' && bufferedAmount > bufferedAmountLimit)
        throw new Error('Signaling socket send queue is full');
      socket.send(text);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
  };
}

function isSnapshot(value: unknown): value is RoomSessionSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<RoomSessionSnapshot>;
  return (
    candidate.version === snapshotVersion &&
    Number.isSafeInteger(candidate.id) &&
    typeof candidate.roomId === 'string' &&
    typeof candidate.challenge === 'string' &&
    typeof candidate.openedAt === 'number' &&
    Array.isArray(candidate.arrivals) &&
    typeof candidate.lastNow === 'number' &&
    (candidate.peerId === null || typeof candidate.peerId === 'string') &&
    (candidate.roomLastActivity === null || typeof candidate.roomLastActivity === 'number')
  );
}

function isValidCloseCode(code: number): boolean {
  return (
    code === 1000 ||
    (code >= 1001 && code <= 1003) ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
  );
}
