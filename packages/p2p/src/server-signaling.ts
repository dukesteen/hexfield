import { identityFromSecret, parsePeerId } from '@cp2p/crypto';
import type { PeerId, ProtocolClock, Unsubscribe } from '@cp2p/protocol';
import type { EnvelopeSignalingAdapter, SignedSignalEnvelope } from './signaling-envelope.js';
import {
  ROOM_JOIN_TIMEOUT_MS,
  SERVER_BUFFER_LIMIT,
  SERVER_WIRE_LIMIT,
  signRoomJoin,
  validRoomChallenge,
} from './server-signaling-wire.js';

const WAIT_MS = 10_000;
const MAX_WAITERS = 32;
const SEND_INTERVAL_MS = 50;
const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 4_000;
const SOCKET_OPEN = 1;
const MAX_ROOM_PEERS = 8;
const roomIdPattern = /^[a-z2-7]{10}$/;
const utf8 = new TextEncoder();

interface Waiter {
  readonly wire: string;
  readonly bytes: number;
  resolve(): void;
  reject(error: Error): void;
  timeout: unknown;
}

export interface ServerSignalingOptions {
  readonly serverUrl: string;
  readonly roomId: string;
  readonly self: PeerId;
  readonly secretKey: Uint8Array;
  readonly clock: ProtocolClock;
  readonly socketFactory?: (url: string) => WebSocket;
  readonly onStatus?: (status: {
    readonly state: 'connecting' | 'ready' | 'retrying' | 'closed';
    readonly reason?: string;
  }) => void;
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

/** Browser WebSocket route; origin-signed envelopes are still verified by WebRtcTransport. */
export class ServerSignalingAdapter implements EnvelopeSignalingAdapter {
  private readonly url: string;
  private readonly key: Uint8Array;
  private readonly listeners = new Set<(from: PeerId, value: unknown) => void>();
  private readonly roomPeerListeners = new Set<(peers: readonly PeerId[] | null) => void>();
  private readonly waiters = new Set<Waiter>();
  private roomPeerSnapshot: readonly PeerId[] | null = null;
  private socket: WebSocket | null = null;
  private handshakeTimer: unknown = null;
  private challenged = false;
  private retryTimer: unknown = null;
  private sendTimer: unknown = null;
  private nextSendAt = 0;
  private retryDelay = RETRY_MIN_MS;
  private ready = false;
  private closed = false;

  constructor(private readonly options: ServerSignalingOptions) {
    if (!roomIdPattern.test(options.roomId)) throw new TypeError('Invalid signaling room ID');
    const url = new URL(options.serverUrl);
    if (
      !['ws:', 'wss:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new TypeError('Invalid signaling server URL');
    url.pathname = `/room/${options.roomId}`;
    this.url = url.href;
    const owned = identityFromSecret(options.secretKey);
    try {
      if (owned.peerId !== options.self) throw new TypeError('Signaling key does not match self');
      this.key = owned.secretKey.slice();
    } finally {
      owned.secretKey.fill(0);
    }
    try {
      this.connect();
    } catch (error) {
      this.key.fill(0);
      throw error;
    }
  }

  async send(to: PeerId, value: SignedSignalEnvelope): Promise<void> {
    if (this.closed) throw new Error('Signaling adapter is closed');
    const envelope = JSON.stringify(value);
    const wire = JSON.stringify({ type: 'signal', to, envelope });
    const forwarded = JSON.stringify({ type: 'signal', from: this.options.self, envelope });
    const bytes = utf8.encode(wire).byteLength;
    if (Math.max(bytes, utf8.encode(forwarded).byteLength) > SERVER_WIRE_LIMIT)
      throw new RangeError('Server signaling wire exceeds 64 KiB');
    if (this.waiters.size >= MAX_WAITERS) throw new Error('Signaling send waiters are full');
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        wire,
        bytes,
        resolve,
        reject,
        timeout: this.options.clock.setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error('Signaling send timed out'));
        }, WAIT_MS),
      };
      this.waiters.add(waiter);
      this.flush();
    });
  }

  onSignal(listener: (from: PeerId, value: unknown) => void): Unsubscribe {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Authenticated server discovery advice, never a game membership decision. */
  roomPeers(): readonly PeerId[] | null {
    return this.roomPeerSnapshot?.slice() ?? null;
  }

  onRoomPeers(listener: (peers: readonly PeerId[] | null) => void): Unsubscribe {
    if (this.closed) return () => undefined;
    this.roomPeerListeners.add(listener);
    try {
      listener(this.roomPeers());
    } catch {
      /* Isolate observers. */
    }
    return () => {
      this.roomPeerListeners.delete(listener);
    };
  }

  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.updateRoomPeers(null);
    this.clearHandshakeTimer();
    this.clearSendTimer();
    if (this.retryTimer !== null) this.options.clock.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      /* Local queue and key cleanup must complete even if close throws. */
    }
    this.rejectWaiters(new Error('Signaling adapter is closed'));
    this.listeners.clear();
    this.roomPeerListeners.clear();
    this.key.fill(0);
    this.status('closed', reason);
  }

  private connect(): void {
    if (this.closed) return;
    const socket = (this.options.socketFactory ?? ((url) => new WebSocket(url)))(this.url);
    this.socket = socket;
    this.challenged = false;
    this.status('connecting');
    if (this.closed || this.socket !== socket) return;
    this.handshakeTimer = this.options.clock.setTimeout(() => {
      if (this.socket === socket && !this.ready) this.lost();
    }, ROOM_JOIN_TIMEOUT_MS);
    socket.addEventListener('message', (event) => {
      if (this.socket === socket) this.message(socket, event.data);
    });
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return;
      if (
        event.code === 1008 &&
        ['replaced', 'invalid-join', 'room-full', 'wire-limit'].includes(event.reason)
      ) {
        this.close(event.reason);
      } else this.lost();
    });
    socket.addEventListener('error', () => {
      if (this.socket === socket) this.lost();
    });
  }

  private message(socket: WebSocket, data: unknown): void {
    if (typeof data !== 'string' || utf8.encode(data).byteLength > SERVER_WIRE_LIMIT) return;
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!record(frame) || typeof frame.type !== 'string') return;
    if (frame.type === 'challenge' && !this.ready && !this.challenged) {
      if (
        !exact(frame, ['type', 'roomId', 'challenge']) ||
        frame.roomId !== this.options.roomId ||
        !validRoomChallenge(frame.challenge)
      ) {
        this.lost();
        return;
      }
      this.challenged = true;
      try {
        const join = signRoomJoin(this.options.roomId, frame.challenge, this.key);
        const wire = JSON.stringify(join);
        if (socket.bufferedAmount + utf8.encode(wire).byteLength > SERVER_BUFFER_LIMIT)
          throw new Error('Signaling send buffer is full');
        socket.send(wire);
      } catch {
        this.lost();
      }
    } else if (frame.type === 'peers' && this.challenged) {
      const peers = this.parseRoomPeers(frame);
      if (!peers) {
        if (!this.ready) this.lost();
        return;
      }
      const first = !this.ready;
      this.ready = true;
      this.updateRoomPeers(peers);
      if (first) {
        this.clearHandshakeTimer();
        this.retryDelay = RETRY_MIN_MS;
        this.status('ready');
        this.flush();
      }
    } else if (
      frame.type === 'signal' &&
      this.ready &&
      typeof frame.from === 'string' &&
      typeof frame.envelope === 'string'
    ) {
      let envelope: unknown;
      try {
        envelope = JSON.parse(frame.envelope);
      } catch {
        return;
      }
      for (const listener of this.listeners) {
        try {
          listener(frame.from, envelope);
        } catch {
          /* Isolate observers. */
        }
      }
    }
  }

  private lost(): void {
    const socket = this.socket;
    this.socket = null;
    this.clearHandshakeTimer();
    this.clearSendTimer();
    this.challenged = false;
    try {
      socket?.close();
    } catch {
      /* Retry still proceeds. */
    }
    this.ready = false;
    this.updateRoomPeers(null);
    if (this.closed || this.retryTimer !== null) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(delay * 2, RETRY_MAX_MS);
    this.status('retrying');
    if (this.closed) return;
    this.retryTimer = this.options.clock.setTimeout(() => {
      this.retryTimer = null;
      try {
        this.connect();
      } catch {
        this.lost();
      }
    }, delay);
  }

  private parseRoomPeers(frame: Record<string, unknown>): PeerId[] | null {
    if (
      !exact(frame, ['type', 'peers']) ||
      !Array.isArray(frame.peers) ||
      frame.peers.length < 1 ||
      frame.peers.length > MAX_ROOM_PEERS
    )
      return null;
    const peers: PeerId[] = [];
    try {
      for (const value of frame.peers) {
        if (typeof value !== 'string') return null;
        parsePeerId(value);
        peers.push(value);
      }
    } catch {
      return null;
    }
    if (new Set(peers).size !== peers.length || !peers.includes(this.options.self)) return null;
    return peers.toSorted();
  }

  private updateRoomPeers(peers: readonly PeerId[] | null): void {
    const previous = this.roomPeerSnapshot;
    if (previous === null && peers === null) return;
    if (
      previous &&
      peers &&
      previous.length === peers.length &&
      previous.every((peer, index) => peer === peers[index])
    )
      return;
    this.roomPeerSnapshot = peers?.slice() ?? null;
    for (const listener of this.roomPeerListeners) {
      try {
        listener(this.roomPeers());
      } catch {
        /* Isolate observers. */
      }
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) this.options.clock.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private clearSendTimer(): void {
    if (this.sendTimer !== null) this.options.clock.clearTimeout(this.sendTimer);
    this.sendTimer = null;
  }

  private flush(): void {
    if (this.closed || !this.ready || this.socket?.readyState !== SOCKET_OPEN) return;
    const waiter = this.waiters.values().next().value;
    if (!waiter) return;
    const delay = Math.max(0, this.nextSendAt - this.options.clock.now());
    if (delay > 0) {
      if (this.sendTimer === null)
        this.sendTimer = this.options.clock.setTimeout(() => {
          this.sendTimer = null;
          this.flush();
        }, delay);
      return;
    }
    this.waiters.delete(waiter);
    this.options.clock.clearTimeout(waiter.timeout);
    if (this.socket.bufferedAmount + waiter.bytes > SERVER_BUFFER_LIMIT) {
      waiter.reject(new Error('Signaling send buffer is full'));
      this.flush();
      return;
    }
    try {
      this.socket.send(waiter.wire);
      this.nextSendAt = this.options.clock.now() + SEND_INTERVAL_MS;
      waiter.resolve();
      this.flush();
    } catch {
      waiter.reject(new Error('Signaling connection is unavailable'));
      this.lost();
    }
  }

  private status(state: 'connecting' | 'ready' | 'retrying' | 'closed', reason?: string): void {
    try {
      this.options.onStatus?.(reason === undefined ? { state } : { state, reason });
    } catch {
      /* Observer failures do not affect socket or queue ownership. */
    }
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      this.options.clock.clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}
