import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import type { PeerId, ProtocolClock, Unsubscribe } from '@cp2p/protocol';
import type { ManualBridge } from './manual-bootstrap.js';
import type { EnvelopeSignalingAdapter, SignedSignalEnvelope } from './signaling-envelope.js';
import { validSignalEnvelopeBody, verifySignalEnvelope } from './signaling-envelope.js';
import type { WebRtcTransport } from './web-rtc-transport.js';

const MAGIC = new Uint8Array([0x48, 0x58, 0x52, 0x31, 0]); // HXR1\0
const MAX_RELAY_BYTES = 75_000;
const SEEN_LIMIT = 128;
const SEEN_MS = 5 * 60_000;
const PENDING_LIMIT = 8;
const PENDING_MS = 15_000;

interface RelayFrame {
  readonly v: 1;
  readonly hops: 0 | 1;
  readonly envelope: SignedSignalEnvelope;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function encodeFrame(frame: RelayFrame): Uint8Array {
  const payload = canonicalEncode(frame);
  if (payload.length + MAGIC.length > MAX_RELAY_BYTES)
    throw new RangeError('Relay signaling frame is too large');
  const bytes = new Uint8Array(MAGIC.length + payload.length);
  bytes.set(MAGIC);
  bytes.set(payload, MAGIC.length);
  return bytes;
}

function decodeFrame(bytes: Uint8Array): RelayFrame | null {
  if (
    bytes.length < MAGIC.length ||
    bytes.length > MAX_RELAY_BYTES ||
    !MAGIC.every((byte, index) => bytes[index] === byte)
  )
    return null;
  const payload = bytes.subarray(MAGIC.length);
  try {
    const value: unknown = canonicalDecode(payload);
    if (
      !record(value) ||
      Object.keys(value).length !== 3 ||
      value.v !== 1 ||
      (value.hops !== 0 && value.hops !== 1) ||
      !record(value.envelope) ||
      !validSignalEnvelopeBody(value.envelope.body) ||
      typeof value.envelope.sig !== 'string'
    )
      return null;
    const encoded = canonicalEncode(value);
    if (
      encoded.length !== payload.length ||
      !encoded.every((byte, index) => byte === payload[index])
    )
      return null;
    return {
      v: 1,
      hops: value.hops,
      envelope: { body: value.envelope.body, sig: value.envelope.sig },
    };
  } catch {
    return null;
  }
}

/** Combines an optional server, one-use bootstrap bridges and authenticated mesh relay. */
export class MeshRelaySignalingAdapter implements EnvelopeSignalingAdapter {
  private readonly listeners = new Set<(from: PeerId, value: unknown) => void>();
  private readonly bridges = new Map<
    PeerId,
    { bridge: ManualBridge; unsubscribe: Unsubscribe; unsubscribeClose: Unsubscribe }
  >();
  private readonly seen = new Map<string, number>();
  private readonly confirmedRoutes = new Map<PeerId, PeerId>();
  private readonly pending = new Map<
    string,
    { to: PeerId; envelope: SignedSignalEnvelope; expires: number }
  >();
  private readonly unsubscribePrimary: Unsubscribe | null;
  private unsubscribeRelay: Unsubscribe | null = null;
  private unsubscribePeers: Unsubscribe | null = null;
  private transport: WebRtcTransport | null = null;
  private closed = false;

  constructor(
    private readonly self: PeerId,
    private readonly scope: string,
    private readonly clock: ProtocolClock,
    private readonly primary: EnvelopeSignalingAdapter | null = null,
  ) {
    this.unsubscribePrimary = primary?.onSignal((from, value) => this.emit(from, value)) ?? null;
  }

  attachTransport(transport: WebRtcTransport): void {
    if (this.closed || this.transport) throw new Error('Relay transport is already attached');
    if (transport.self !== this.self) throw new TypeError('Relay transport identity differs');
    this.transport = transport;
    this.unsubscribeRelay = transport.onRelayFrame((from, bytes) => this.receiveRelay(from, bytes));
    this.unsubscribePeers = transport.onPeerChange((peer, online) => {
      if (online) this.flushPending(peer);
      else {
        for (const [target, neighbor] of this.confirmedRoutes)
          if (target === peer || neighbor === peer) this.confirmedRoutes.delete(target);
      }
      this.retireRedundantBridges();
    });
  }

  addBridge(bridge: ManualBridge): void {
    if (this.closed) throw new Error('Manual signaling bridge is unavailable');
    const existing = this.bridges.get(bridge.peer);
    if (existing?.bridge.isClosed) this.removeBridge(bridge.peer);
    else if (existing) throw new Error('Manual signaling bridge is unavailable');

    const entry: { bridge: ManualBridge; unsubscribe: Unsubscribe; unsubscribeClose: Unsubscribe } =
      {
        bridge,
        unsubscribe: () => undefined,
        unsubscribeClose: () => undefined,
      };
    this.bridges.set(bridge.peer, entry);
    entry.unsubscribe = bridge.onSignal((from, value) => this.emit(from, value));
    entry.unsubscribeClose = bridge.onClose(() => this.forgetBridge(bridge.peer, entry));
    if (bridge.isClosed) {
      this.forgetBridge(bridge.peer, entry);
      throw new Error('Manual signaling bridge is unavailable');
    }
    this.retireRedundantBridges();
  }

  removeBridge(peer: PeerId): void {
    const current = this.bridges.get(peer);
    if (!current) return;
    this.bridges.delete(peer);
    current.unsubscribe();
    current.unsubscribeClose();
    current.bridge.close();
  }

  hasBridge(peer: PeerId): boolean {
    return this.bridges.has(peer);
  }

  async send(to: PeerId, value: SignedSignalEnvelope): Promise<void> {
    if (this.closed) throw new Error('Signaling adapter is closed');
    const signed = verifySignalEnvelope(value, this.scope, to, new Set([this.self]));
    if (!signed || signed.body.from !== this.self) throw new TypeError('Invalid local signal');
    const bridge = this.bridges.get(to)?.bridge;
    if (bridge) {
      try {
        await bridge.send(to, signed);
        return;
      } catch {
        this.removeBridge(to);
      }
    }
    const directOrRelayed = this.sendViaMesh(to, signed);
    if (this.primary) {
      const serverSend = this.primary.send(to, signed);
      if (directOrRelayed) {
        void serverSend.catch(() => undefined);
        return;
      }
      return serverSend;
    }
    if (directOrRelayed) return;
    throw new Error('No signaling route to peer');
  }

  onSignal(listener: (from: PeerId, value: unknown) => void): Unsubscribe {
    if (this.closed) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribePrimary?.();
    this.unsubscribeRelay?.();
    this.unsubscribePeers?.();
    for (const peer of this.bridges.keys()) this.removeBridge(peer);
    this.primary?.close();
    this.listeners.clear();
    this.seen.clear();
    this.confirmedRoutes.clear();
    this.pending.clear();
    this.transport = null;
  }

  private sendViaMesh(to: PeerId, envelope: SignedSignalEnvelope): boolean {
    const transport = this.transport;
    if (!transport || !transport.roster().includes(to)) return false;
    const peers = transport.peers();
    const direct = peers.includes(to);
    const frame = encodeFrame({ v: 1, hops: direct ? 0 : 1, envelope });
    let sent = false;
    for (const peer of direct ? [to] : peers) {
      try {
        transport.sendRelayFrame(peer, frame);
        sent = true;
      } catch {
        /* Another authenticated route may still carry this attempt. */
      }
    }
    return sent;
  }

  private forgetBridge(
    peer: PeerId,
    entry: { bridge: ManualBridge; unsubscribe: Unsubscribe; unsubscribeClose: Unsubscribe },
  ): void {
    if (this.bridges.get(peer) !== entry) return;
    this.bridges.delete(peer);
    entry.unsubscribe();
    entry.unsubscribeClose();
  }

  private receiveRelay(from: PeerId, bytes: Uint8Array): void {
    if (this.closed) return;
    const transport = this.transport;
    const frame = decodeFrame(bytes);
    if (!transport || !frame) return;
    const roster = new Set(transport.roster());
    if (!roster.has(from)) return;
    const { to } = frame.envelope.body;
    if (!roster.has(to)) return;
    const signed = verifySignalEnvelope(frame.envelope, this.scope, to, roster);
    if (!signed || (frame.hops === 1 && signed.body.from !== from)) return;
    if (to === this.self) {
      if (this.recent(toHex(hashValue(signed)))) return;
      if (from !== signed.body.from) {
        this.confirmedRoutes.set(signed.body.from, from);
        this.retireRedundantBridges();
      }
      this.emit(signed.body.from, signed);
      return;
    }
    if (frame.hops !== 1) return;
    const id = toHex(hashValue(signed));
    if (this.seen.has(id)) return;
    if (!transport.peers().includes(to)) {
      this.queuePending(id, to, signed);
      return;
    }
    try {
      transport.sendRelayFrame(to, encodeFrame({ v: 1, hops: 0, envelope: signed }));
      this.recent(id);
    } catch {
      /* The target may have disconnected after the route check. */
      this.queuePending(id, to, signed);
    }
  }

  private retireRedundantBridges(): void {
    const online = new Set(this.transport?.peers() ?? []);
    for (const peer of this.bridges.keys()) {
      if (!online.has(peer)) continue;
      const neighbor = this.confirmedRoutes.get(peer);
      if (neighbor && neighbor !== peer && online.has(neighbor)) this.removeBridge(peer);
    }
  }

  private queuePending(id: string, to: PeerId, envelope: SignedSignalEnvelope): void {
    if (this.pending.has(id)) return;
    const now = this.clock.now();
    for (const [key, item] of this.pending) if (item.expires <= now) this.pending.delete(key);
    if (this.pending.size >= PENDING_LIMIT) return;
    this.pending.set(id, { to, envelope, expires: now + PENDING_MS });
  }

  private flushPending(peer: PeerId): void {
    const transport = this.transport;
    if (!transport || !transport.peers().includes(peer)) return;
    for (const [id, item] of this.pending) {
      if (item.expires <= this.clock.now()) {
        this.pending.delete(id);
        continue;
      }
      if (item.to !== peer) continue;
      try {
        transport.sendRelayFrame(peer, encodeFrame({ v: 1, hops: 0, envelope: item.envelope }));
        this.recent(id);
        this.pending.delete(id);
      } catch {
        /* Another authenticated target link may be established before expiry. */
      }
    }
  }

  private recent(id: string): boolean {
    const now = this.clock.now();
    for (const [key, time] of this.seen) if (now - time >= SEEN_MS) this.seen.delete(key);
    if (this.seen.has(id)) return true;
    this.seen.set(id, now);
    while (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return false;
  }

  private emit(from: PeerId, value: unknown): void {
    for (const listener of this.listeners) {
      try {
        listener(from, value);
      } catch {
        /* One observer cannot interrupt signaling. */
      }
    }
  }
}
