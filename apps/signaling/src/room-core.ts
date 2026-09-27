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
export const MAX_ROOM_SOCKETS = 16;
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

/** Versioned, validated state stored in a hibernatable WebSocket attachment. */
export interface RoomSessionSnapshot {
  readonly version: 1;
  readonly id: number;
  readonly roomId: string;
  readonly challenge: string;
  readonly openedAt: number;
  readonly arrivals: readonly number[];
  readonly lastNow: number;
  readonly peerId: PeerId | null;
  readonly roomLastActivity: number | null;
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
  crypto.getRandomValues(bytes);
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

  snapshotSession(id: number): RoomSessionSnapshot | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    return {
      version: 1,
      id: session.id,
      roomId: session.roomId,
      challenge: session.challenge,
      openedAt: session.openedAt,
      arrivals: [...session.arrivals],
      lastNow: session.lastNow,
      peerId: session.peerId,
      roomLastActivity: this.rooms.get(session.roomId)?.lastActivity ?? null,
    };
  }

  /** Restore only validated attachment state created by this adapter. */
  restoreSession(value: unknown, socket: RoomSocket): number {
    if (!isRoomSessionSnapshot(value)) throw new TypeError('Invalid room session attachment');
    const snapshot = value;
    if (this.sessions.has(snapshot.id)) throw new TypeError('Duplicate room session attachment');
    const now = this.now();
    if (
      !Number.isFinite(now) ||
      now < snapshot.lastNow ||
      (snapshot.roomLastActivity !== null && now < snapshot.roomLastActivity)
    )
      throw new TypeError('Room session attachment is from the future');
    const session: Session = {
      id: snapshot.id,
      roomId: snapshot.roomId,
      socket,
      challenge: snapshot.challenge,
      openedAt: snapshot.openedAt,
      arrivals: [...snapshot.arrivals],
      lastNow: snapshot.lastNow,
      peerId: snapshot.peerId,
    };
    if (session.peerId) {
      const room = this.rooms.get(session.roomId) ?? {
        peers: new Map<PeerId, Session>(),
        lastActivity: snapshot.roomLastActivity ?? now,
      };
      if (room.peers.has(session.peerId) || room.peers.size >= MAX_ROOM_PEERS)
        throw new TypeError('Conflicting room session attachment');
      room.lastActivity = Math.max(room.lastActivity, snapshot.roomLastActivity ?? 0);
      room.peers.set(session.peerId, session);
      this.rooms.set(session.roomId, room);
    } else if (snapshot.roomLastActivity !== null) {
      const room = this.rooms.get(session.roomId) ?? {
        peers: new Map<PeerId, Session>(),
        lastActivity: snapshot.roomLastActivity,
      };
      room.lastActivity = Math.max(room.lastActivity, snapshot.roomLastActivity);
      this.rooms.set(session.roomId, room);
    }
    this.sessions.set(session.id, session);
    this.nextId = Math.max(this.nextId, session.id);
    return session.id;
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

function isRoomSessionSnapshot(value: unknown): value is RoomSessionSnapshot {
  if (!record(value)) return false;
  const openedAt = value.openedAt;
  const lastNow = value.lastNow;
  const arrivals = value.arrivals;
  if (
    !exact(value, [
      'version',
      'id',
      'roomId',
      'challenge',
      'openedAt',
      'arrivals',
      'lastNow',
      'peerId',
      'roomLastActivity',
    ]) ||
    value.version !== 1 ||
    typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) ||
    value.id < 1 ||
    typeof value.roomId !== 'string' ||
    !roomIdPattern.test(value.roomId) ||
    typeof value.challenge !== 'string' ||
    !validRoomChallenge(value.challenge) ||
    typeof openedAt !== 'number' ||
    !Number.isFinite(openedAt) ||
    typeof lastNow !== 'number' ||
    !Number.isFinite(lastNow) ||
    lastNow < openedAt ||
    !Array.isArray(arrivals) ||
    arrivals.length > MAX_RATE ||
    (value.peerId !== null && typeof value.peerId !== 'string') ||
    (value.roomLastActivity !== null &&
      (typeof value.roomLastActivity !== 'number' || !Number.isFinite(value.roomLastActivity)))
  )
    return false;
  if (
    !arrivals.every(
      (arrival) =>
        typeof arrival === 'number' &&
        Number.isFinite(arrival) &&
        arrival >= openedAt &&
        arrival <= lastNow,
    )
  )
    return false;
  if (value.peerId === null) return true;
  if (value.roomLastActivity === null || typeof value.peerId !== 'string') return false;
  try {
    parsePeerId(value.peerId);
    return true;
  } catch {
    return false;
  }
}
