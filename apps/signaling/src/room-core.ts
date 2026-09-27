import { toBase64Url } from '@cp2p/codec';
import { parsePeerId, verifyObject } from '@cp2p/crypto';
import {
  ROOM_JOIN_DOMAIN,
  ROOM_JOIN_TIMEOUT_MS,
  SERVER_WIRE_LIMIT,
  validRoomChallenge,
} from '@cp2p/p2p/server-signaling-wire';
import type { PeerId } from '@cp2p/protocol';

export const MAX_ROOM_PEERS = 8;
export const ROOM_IDLE_MS = 24 * 60 * 60 * 1_000;
const RATE_WINDOW_MS = 1_000;
const MAX_RATE = 30;
const roomIdPattern = /^[a-z2-7]{10}$/;
const utf8 = new TextEncoder();

export interface RoomSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

interface Session {
  readonly id: number;
  readonly roomId: string;
  readonly socket: RoomSocket;
  readonly challenge: string;
  readonly openedAt: number;
  readonly arrivals: number[];
  lastNow: number;
  peerId: PeerId | null;
}

interface Room {
  readonly peers: Map<PeerId, Session>;
  lastActivity: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return (
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** Host-independent room decisions; adapters own network sockets and provide local time. */
export class RoomCore {
  private readonly sessions = new Map<number, Session>();
  private readonly rooms = new Map<string, Room>();
  private nextId = 0;

  constructor(
    private readonly now: () => number,
    private readonly randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
  ) {}

  open(roomId: string, socket: RoomSocket): number {
    if (!roomIdPattern.test(roomId)) throw new TypeError('Invalid signaling room ID');
    const bytes = this.randomBytes(32);
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32)
      throw new TypeError('Signaling challenge source must provide 32 bytes');
    const challenge = toBase64Url(bytes);
    bytes.fill(0);
    const openedAt = this.now();
    if (!Number.isFinite(openedAt)) throw new TypeError('Invalid signaling clock');
    const session: Session = {
      id: ++this.nextId,
      roomId,
      socket,
      challenge,
      openedAt,
      lastNow: openedAt,
      arrivals: [],
      peerId: null,
    };
    this.sessions.set(session.id, session);
    try {
      this.emit(socket, { type: 'challenge', roomId, challenge });
    } catch (error) {
      this.sessions.delete(session.id);
      throw error;
    }
    return session.id;
  }

  receive(id: number, text: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (typeof text !== 'string' || utf8.encode(text).byteLength > SERVER_WIRE_LIMIT) {
      this.reject(session, 'wire-limit');
      return;
    }
    const now = Math.max(session.lastNow, this.now());
    if (!Number.isFinite(now)) {
      this.reject(session, 'clock');
      return;
    }
    session.lastNow = now;
    while (session.arrivals.length > 0 && (session.arrivals[0] ?? now) <= now - RATE_WINDOW_MS)
      session.arrivals.shift();
    if (session.arrivals.length >= MAX_RATE) {
      this.reject(session, 'rate-limit');
      return;
    }
    session.arrivals.push(now);
    let frame: unknown;
    try {
      frame = JSON.parse(text);
    } catch {
      this.reject(session, 'invalid-frame');
      return;
    }
    if (!record(frame) || typeof frame.type !== 'string') {
      this.reject(session, 'invalid-frame');
      return;
    }
    if (frame.type === 'join') {
      this.join(session, frame, now);
      return;
    }
    if (!session.peerId) {
      this.reject(session, 'join-required');
      return;
    }
    if (frame.type === 'signal') {
      this.signal(session, frame, now);
    } else if (frame.type === 'leave' && exact(frame, ['type'])) {
      this.disconnect(id);
      try {
        session.socket.close(1000, 'left');
      } catch {
        /* Session is already removed. */
      }
    } else this.reject(session, 'invalid-frame');
  }

  disconnect(id: number): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    const room = this.rooms.get(session.roomId);
    if (!room || !session.peerId || room.peers.get(session.peerId) !== session) return;
    room.peers.delete(session.peerId);
    if (room.peers.size === 0) this.rooms.delete(session.roomId);
    else this.announce(room);
  }

  sweep(): void {
    const now = this.now();
    if (!Number.isFinite(now)) return;
    for (const session of this.sessions.values())
      if (!session.peerId && now - session.openedAt >= ROOM_JOIN_TIMEOUT_MS)
        this.reject(session, 'join-timeout');
    for (const room of this.rooms.values())
      if (now - room.lastActivity >= ROOM_IDLE_MS)
        for (const session of room.peers.values()) this.reject(session, 'room-expired');
  }

  peers(roomId: string): PeerId[] {
    return [...(this.rooms.get(roomId)?.peers.keys() ?? [])].toSorted();
  }

  private join(session: Session, frame: Record<string, unknown>, now: number): void {
    if (
      session.peerId ||
      now - session.openedAt >= ROOM_JOIN_TIMEOUT_MS ||
      !exact(frame, ['type', 'body', 'sig']) ||
      !record(frame.body) ||
      !exact(frame.body, ['version', 'roomId', 'peerId', 'challenge']) ||
      frame.body.version !== 1 ||
      frame.body.roomId !== session.roomId ||
      frame.body.challenge !== session.challenge ||
      typeof frame.body.peerId !== 'string' ||
      typeof frame.sig !== 'string'
    ) {
      this.reject(session, 'invalid-join');
      return;
    }
    let publicKey: Uint8Array;
    try {
      publicKey = parsePeerId(frame.body.peerId);
      if (
        !validRoomChallenge(session.challenge) ||
        !verifyObject(ROOM_JOIN_DOMAIN, frame.body, frame.sig, publicKey)
      )
        throw new Error('Invalid join signature');
    } catch {
      this.reject(session, 'invalid-join');
      return;
    }
    const room = this.rooms.get(session.roomId) ?? {
      peers: new Map<PeerId, Session>(),
      lastActivity: now,
    };
    const existing = room.peers.get(frame.body.peerId);
    if (existing) {
      // The new challenge and signature prove possession of the same key.
      // Remove the old session first so a later close cannot evict its successor.
      room.peers.delete(frame.body.peerId);
      this.sessions.delete(existing.id);
      try {
        existing.socket.close(1008, 'replaced');
      } catch {
        /* The authenticated successor can still take over. */
      }
    }
    if (room.peers.size >= MAX_ROOM_PEERS) {
      this.reject(session, 'room-full');
      return;
    }
    session.peerId = frame.body.peerId;
    room.peers.set(session.peerId, session);
    room.lastActivity = now;
    this.rooms.set(session.roomId, room);
    this.announce(room);
  }

  private signal(session: Session, frame: Record<string, unknown>, now: number): void {
    if (
      !exact(frame, ['type', 'to', 'envelope']) ||
      typeof frame.to !== 'string' ||
      typeof frame.envelope !== 'string' ||
      frame.envelope.length === 0
    ) {
      this.reject(session, 'invalid-signal');
      return;
    }
    const room = this.rooms.get(session.roomId);
    const recipient = room?.peers.get(frame.to);
    if (!room || !recipient || !session.peerId) return;
    const forwarded = JSON.stringify({
      type: 'signal',
      from: session.peerId,
      envelope: frame.envelope,
    });
    if (utf8.encode(forwarded).byteLength > SERVER_WIRE_LIMIT) {
      this.reject(session, 'wire-limit');
      return;
    }
    room.lastActivity = now;
    try {
      recipient.socket.send(forwarded);
    } catch {
      this.reject(recipient, 'send-failed');
    }
  }

  private announce(room: Room): void {
    const frame = { type: 'peers', peers: [...room.peers.keys()].toSorted() };
    for (const session of room.peers.values()) {
      try {
        this.emit(session.socket, frame);
      } catch {
        this.reject(session, 'send-failed');
        // Removing the failed member announces the new roster. Do not follow
        // that announcement with this loop's now-obsolete snapshot.
        return;
      }
    }
  }

  private emit(socket: RoomSocket, frame: unknown): void {
    const text = JSON.stringify(frame);
    if (utf8.encode(text).byteLength > SERVER_WIRE_LIMIT)
      throw new Error('Server frame exceeds wire limit');
    socket.send(text);
  }

  private reject(session: Session, reason: string): void {
    this.disconnect(session.id);
    try {
      session.socket.close(1008, reason);
    } catch {
      /* Membership was already removed. */
    }
  }
}
