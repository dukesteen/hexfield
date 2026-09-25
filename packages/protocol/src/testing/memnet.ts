import type { PeerId, Transport, Unsubscribe } from '../transport.js';
import { VirtualClock } from './virtual-clock.js';

const DEFAULT_SEED = 0x6d2b79f5;

/** Per-direction packet timing and loss controls for a memnet link. */
export interface MemnetLinkOptions {
  readonly latencyMs?: number;
  readonly jitterMs?: number;
  readonly dropProbability?: number;
  readonly duplicateProbability?: number;
  /** Allow packets to overtake earlier packets while this connection stays up. */
  readonly reorder?: boolean;
}

/** Configuration for a deterministic, authenticated in-memory peer mesh. */
export interface MemnetOptions {
  readonly peers: readonly PeerId[];
  readonly seed?: number;
  readonly clock?: VirtualClock;
  readonly defaultLink?: MemnetLinkOptions;
}

/** In-memory network controls shared by the transports it creates. */
export interface Memnet {
  readonly clock: VirtualClock;
  peers(): PeerId[];
  /** Number of additional duplicated packets actually delivered since creation. */
  diagnostics(): MemnetDiagnostics;
  transport(peer: PeerId): Transport;
  setLinkOptions(from: PeerId, to: PeerId, options: MemnetLinkOptions): void;
  disconnect(from: PeerId, to: PeerId): void;
  connect(from: PeerId, to: PeerId): void;
  partition(groups: readonly (readonly PeerId[])[]): void;
  heal(): void;
  crash(peer: PeerId): void;
  restart(peer: PeerId): Transport;
  dispose(): void;
}

export interface MemnetDiagnostics {
  readonly duplicateDeliveries: number;
}

interface DirectionOptions {
  latencyMs: number;
  jitterMs: number;
  dropProbability: number;
  duplicateProbability: number;
  reorder: boolean;
}

interface LinkPair {
  enabled: boolean;
  generation: number;
  readonly directions: Map<PeerId, DirectionOptions>;
  readonly nextOrderedDelivery: Map<PeerId, number>;
}

interface PeerRuntime {
  readonly id: PeerId;
  alive: boolean;
  generation: number;
  transport: MemnetTransport | null;
}

interface MessageListener {
  (from: PeerId, message: Uint8Array): void;
}

interface PeerChangeListener {
  (peer: PeerId, online: boolean): void;
}

/**
 * A seeded network simulator for protocol tests. It has no runtime game or
 * cryptographic dependencies; peer IDs are the pre-authenticated test roster.
 */
export function createMemnet(options: MemnetOptions): Memnet {
  return new MemnetNetwork(options);
}

class MemnetNetwork implements Memnet {
  readonly clock: VirtualClock;
  private readonly random: SeededRandom;
  private readonly runtimes = new Map<PeerId, PeerRuntime>();
  private readonly pairs = new Map<string, LinkPair>();
  private readonly defaultDirection: DirectionOptions;
  private readonly scheduled = new Set<unknown>();
  private duplicateDeliveries = 0;
  private disposed = false;

  constructor(options: MemnetOptions) {
    if (options.peers.length === 0) throw new RangeError('memnet requires at least one peer');
    const uniquePeers = new Set<PeerId>();
    for (const peer of options.peers) {
      if (typeof peer !== 'string' || peer.length === 0 || peer.includes('\u0000'))
        throw new TypeError('peer IDs must be non-empty strings without NUL characters');
      if (uniquePeers.has(peer)) throw new Error(`duplicate peer ID: ${peer}`);
      uniquePeers.add(peer);
      this.runtimes.set(peer, { id: peer, alive: true, generation: 0, transport: null });
    }
    this.clock = options.clock ?? new VirtualClock();
    this.random = new SeededRandom(options.seed ?? DEFAULT_SEED);
    this.defaultDirection = normalizeDirectionOptions(options.defaultLink ?? {});
    for (let leftIndex = 0; leftIndex < options.peers.length; leftIndex++) {
      const left = options.peers[leftIndex];
      if (!left) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < options.peers.length; rightIndex++) {
        const right = options.peers[rightIndex];
        if (right) this.createPair(left, right);
      }
    }
    for (const peer of options.peers) this.createTransport(peer);
  }

  peers(): PeerId[] {
    return [...this.runtimes.values()]
      .filter((runtime) => runtime.alive)
      .map((runtime) => runtime.id)
      .toSorted();
  }

  diagnostics(): MemnetDiagnostics {
    return { duplicateDeliveries: this.duplicateDeliveries };
  }

  getConnectedPeers(peer: PeerId, generation: number): PeerId[] {
    if (!this.isCurrentTransport(peer, generation)) return [];
    return this.peersFor(peer);
  }

  transport(peer: PeerId): Transport {
    const runtime = this.requireRuntime(peer);
    if (!runtime.alive || !runtime.transport) throw new Error(`peer is offline: ${peer}`);
    return runtime.transport;
  }

  setLinkOptions(from: PeerId, to: PeerId, options: MemnetLinkOptions): void {
    this.assertActive();
    this.assertDistinctPeers(from, to);
    const pair = this.requirePair(from, to);
    const prior = pair.directions.get(from) ?? this.defaultDirection;
    pair.directions.set(from, normalizeDirectionOptions(options, prior));
  }

  disconnect(from: PeerId, to: PeerId): void {
    this.setConnection(from, to, false);
  }

  connect(from: PeerId, to: PeerId): void {
    this.setConnection(from, to, true);
  }

  partition(groups: readonly (readonly PeerId[])[]): void {
    this.assertActive();
    const owner = new Map<PeerId, number>();
    groups.forEach((group, index) => {
      for (const peer of group) {
        this.requireRuntime(peer);
        if (owner.has(peer)) throw new Error(`peer appears in more than one partition: ${peer}`);
        owner.set(peer, index);
      }
    });
    for (const peer of this.runtimes.keys()) if (!owner.has(peer)) owner.set(peer, groups.length);
    for (const [pairKey, pair] of this.pairs) {
      const [left, right] = splitPairKey(pairKey);
      if (owner.get(left) !== owner.get(right)) this.setPairEnabled(left, right, false, pair);
    }
  }

  /** Restore a full mesh among currently live peers. */
  heal(): void {
    this.assertActive();
    for (const [pairKey, pair] of this.pairs) {
      const [left, right] = splitPairKey(pairKey);
      if (this.isAlive(left) && this.isAlive(right)) this.setPairEnabled(left, right, true, pair);
    }
  }

  crash(peer: PeerId): void {
    this.assertActive();
    const runtime = this.requireRuntime(peer);
    if (!runtime.alive) return;
    const connected = this.peersFor(peer);
    runtime.alive = false;
    runtime.generation++;
    runtime.transport?.deactivate();
    runtime.transport = null;
    for (const other of connected) this.notifyPeerChange(other, peer, false);
  }

  restart(peer: PeerId): Transport {
    this.assertActive();
    const runtime = this.requireRuntime(peer);
    if (runtime.alive) throw new Error(`peer is already online: ${peer}`);
    runtime.alive = true;
    runtime.generation++;
    this.createTransport(peer);
    for (const other of this.peersFor(peer)) {
      this.notifyPeerChange(other, peer, true);
      this.notifyPeerChange(peer, other, true);
    }
    if (!runtime.transport) throw new Error('restart failed to create transport');
    return runtime.transport;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const handle of this.scheduled) this.clock.clearTimeout(handle);
    this.scheduled.clear();
    for (const runtime of this.runtimes.values()) {
      runtime.alive = false;
      runtime.generation++;
      runtime.transport?.deactivate();
      runtime.transport = null;
    }
  }

  send(from: PeerId, to: PeerId, message: Uint8Array, generation: number): void {
    if (!this.isCurrentTransport(from, generation)) return;
    this.requireRuntime(to);
    if (!this.isConnected(from, to)) return;
    const pair = this.requirePair(from, to);
    const linkOptions = pair.directions.get(from) ?? this.defaultDirection;
    if (this.random.next() < linkOptions.dropProbability) return;
    const copies = this.random.next() < linkOptions.duplicateProbability ? 2 : 1;
    const bytes = Uint8Array.from(message);
    const senderGeneration = this.requireRuntime(from).generation;
    const receiverGeneration = this.requireRuntime(to).generation;
    const linkGeneration = pair.generation;
    const jitterRange = linkOptions.jitterMs * 2 + 1;
    const sampledJitter = Math.floor(this.random.next() * jitterRange) - linkOptions.jitterMs;
    let deliveryAt = this.clock.now() + linkOptions.latencyMs + sampledJitter;
    deliveryAt = Math.max(this.clock.now(), deliveryAt);
    if (!linkOptions.reorder) {
      deliveryAt = Math.max(deliveryAt, pair.nextOrderedDelivery.get(from) ?? deliveryAt);
      pair.nextOrderedDelivery.set(from, deliveryAt);
    }
    for (let copy = 0; copy < copies; copy++) {
      this.schedule(deliveryAt, () => {
        if (
          this.disposed ||
          !this.isCurrentTransport(from, generation) ||
          this.requireRuntime(from).generation !== senderGeneration ||
          this.requireRuntime(to).generation !== receiverGeneration ||
          pair.generation !== linkGeneration ||
          !this.isConnected(from, to)
        )
          return;
        if (copy > 0) this.duplicateDeliveries++;
        this.requireRuntime(to).transport?.deliver(from, bytes);
      });
    }
  }

  private schedule(at: number, callback: () => void): void {
    const handle = this.clock.setTimeout(() => {
      this.scheduled.delete(handle);
      callback();
    }, at - this.clock.now());
    this.scheduled.add(handle);
  }

  private setConnection(from: PeerId, to: PeerId, enabled: boolean): void {
    this.assertActive();
    this.assertDistinctPeers(from, to);
    const pair = this.requirePair(from, to);
    this.setPairEnabled(from, to, enabled, pair);
  }

  private setPairEnabled(from: PeerId, to: PeerId, enabled: boolean, pair: LinkPair): void {
    if (pair.enabled === enabled) return;
    const wasConnected = this.isAlive(from) && this.isAlive(to) && pair.enabled;
    pair.enabled = enabled;
    pair.generation++;
    pair.nextOrderedDelivery.clear();
    const connected = this.isAlive(from) && this.isAlive(to) && enabled;
    if (wasConnected !== connected) {
      this.notifyPeerChange(from, to, connected);
      this.notifyPeerChange(to, from, connected);
    }
  }

  private createPair(left: PeerId, right: PeerId): void {
    this.pairs.set(makePairKey(left, right), {
      enabled: true,
      generation: 0,
      directions: new Map(),
      nextOrderedDelivery: new Map(),
    });
  }

  private createTransport(peer: PeerId): void {
    const runtime = this.requireRuntime(peer);
    runtime.transport = new MemnetTransport(this, runtime.id, runtime.generation);
  }

  private peersFor(peer: PeerId): PeerId[] {
    return [...this.runtimes.keys()]
      .filter((candidate) => candidate !== peer && this.isConnected(peer, candidate))
      .toSorted();
  }

  private isConnected(left: PeerId, right: PeerId): boolean {
    return (
      left !== right &&
      this.isAlive(left) &&
      this.isAlive(right) &&
      (this.pairs.get(makePairKey(left, right))?.enabled ?? false)
    );
  }

  private isAlive(peer: PeerId): boolean {
    return this.runtimes.get(peer)?.alive ?? false;
  }

  private isCurrentTransport(peer: PeerId, generation: number): boolean {
    const runtime = this.runtimes.get(peer);
    return !this.disposed && Boolean(runtime?.alive && runtime.generation === generation);
  }

  private notifyPeerChange(receiver: PeerId, peer: PeerId, online: boolean): void {
    this.runtimes.get(receiver)?.transport?.deliverPeerChange(peer, online);
  }

  private requireRuntime(peer: PeerId): PeerRuntime {
    const runtime = this.runtimes.get(peer);
    if (!runtime) throw new Error(`unknown peer: ${peer}`);
    return runtime;
  }

  private requirePair(left: PeerId, right: PeerId): LinkPair {
    const pair = this.pairs.get(makePairKey(left, right));
    if (!pair) throw new Error(`unknown link: ${left} ↔ ${right}`);
    return pair;
  }

  private assertDistinctPeers(left: PeerId, right: PeerId): void {
    this.requireRuntime(left);
    this.requireRuntime(right);
    if (left === right) throw new Error('a peer cannot link to itself');
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('memnet is disposed');
  }
}

class MemnetTransport implements Transport {
  private readonly messageListeners = new Set<MessageListener>();
  private readonly peerChangeListeners = new Set<PeerChangeListener>();
  private active = true;

  constructor(
    private readonly network: MemnetNetwork,
    readonly self: PeerId,
    private readonly generation: number,
  ) {}

  peers(): PeerId[] {
    return this.active ? this.network.getConnectedPeers(this.self, this.generation) : [];
  }

  send(to: PeerId, message: Uint8Array): void {
    if (!this.active) return;
    this.network.send(this.self, to, message, this.generation);
  }

  broadcast(message: Uint8Array): void {
    if (!this.active) return;
    for (const peer of this.peers()) this.send(peer, message);
  }

  onMessage(listener: MessageListener): Unsubscribe {
    return subscribe(this.messageListeners, listener, this.active);
  }

  onPeerChange(listener: PeerChangeListener): Unsubscribe {
    return subscribe(this.peerChangeListeners, listener, this.active);
  }

  disconnect(peer: PeerId): void {
    if (this.active) this.network.disconnect(this.self, peer);
  }

  deliver(from: PeerId, message: Uint8Array): void {
    if (!this.active) return;
    for (const listener of Array.from(this.messageListeners))
      listener(from, Uint8Array.from(message));
  }

  deliverPeerChange(peer: PeerId, online: boolean): void {
    if (!this.active) return;
    for (const listener of Array.from(this.peerChangeListeners)) listener(peer, online);
  }

  deactivate(): void {
    this.active = false;
    this.messageListeners.clear();
    this.peerChangeListeners.clear();
  }
}

function subscribe<T>(listeners: Set<T>, listener: T, active: boolean): Unsubscribe {
  if (!active) return () => {};
  listeners.add(listener);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    listeners.delete(listener);
  };
}

function normalizeDirectionOptions(
  options: MemnetLinkOptions,
  base: DirectionOptions = {
    latencyMs: 0,
    jitterMs: 0,
    dropProbability: 0,
    duplicateProbability: 0,
    reorder: false,
  },
): DirectionOptions {
  const normalized = {
    latencyMs: options.latencyMs ?? base.latencyMs,
    jitterMs: options.jitterMs ?? base.jitterMs,
    dropProbability: options.dropProbability ?? base.dropProbability,
    duplicateProbability: options.duplicateProbability ?? base.duplicateProbability,
    reorder: options.reorder ?? base.reorder,
  };
  if (!Number.isSafeInteger(normalized.latencyMs) || normalized.latencyMs < 0)
    throw new RangeError('latencyMs must be a non-negative safe integer');
  if (!Number.isSafeInteger(normalized.jitterMs) || normalized.jitterMs < 0)
    throw new RangeError('jitterMs must be a non-negative safe integer');
  for (const [name, value] of [
    ['dropProbability', normalized.dropProbability],
    ['duplicateProbability', normalized.duplicateProbability],
  ] as const)
    if (!Number.isFinite(value) || value < 0 || value > 1)
      throw new RangeError(`${name} must be between zero and one`);
  return normalized;
}

function makePairKey(left: PeerId, right: PeerId): string {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function splitPairKey(key: string): readonly [PeerId, PeerId] {
  const separator = key.indexOf('\u0000');
  return [key.slice(0, separator), key.slice(separator + 1)];
}

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) throw new RangeError('seed must be a safe integer');
    this.state = seed >>> 0 || DEFAULT_SEED;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }
}
