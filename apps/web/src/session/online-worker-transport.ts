import type { PeerId, Transport, Unsubscribe } from '@cp2p/protocol';

export const ONLINE_WORKER_MAX_FRAME_BYTES = 1024 * 1024;
export const ONLINE_WORKER_MAX_FRAMES_PER_PEER = 8;
export const ONLINE_WORKER_MAX_FRAMES_TOTAL = 32;
export const ONLINE_WORKER_MAX_IN_FLIGHT_BYTES = 8 * 1024 * 1024;
const ONLINE_WORKER_MAX_IN_FLIGHT_BYTES_PER_PEER = 2 * 1024 * 1024;

export interface OnlineTransportPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  start?(): void;
  close?(): void;
}

export interface MainThreadTransportBridgeOptions {
  readonly transport: Transport;
  readonly port: OnlineTransportPort;
  readonly generation: string;
  readonly onFailure?: (error: Error) => void;
}

export interface WorkerDeviceTransportOptions {
  readonly self: PeerId;
  readonly peers: readonly PeerId[];
  readonly port: OnlineTransportPort;
  readonly generation: string;
  readonly onFailure?: (error: Error) => void;
}

export interface OnlineWorkerTransportControl {
  close(): void;
  stopOutput(): void;
}

interface FrameMessage {
  readonly type: 'frame';
  readonly generation: string;
  readonly id: number;
  readonly peer: PeerId;
  readonly bytes: ArrayBuffer;
}

interface AckMessage {
  readonly type: 'ack';
  readonly generation: string;
  readonly id: number;
  readonly accepted: boolean;
}

interface PeerMessage {
  readonly type: 'peer';
  readonly generation: string;
  readonly peer: PeerId;
  readonly online: boolean;
}

interface DisconnectMessage {
  readonly type: 'disconnect';
  readonly generation: string;
  readonly peer: PeerId;
}

type PortMessage = FrameMessage | AckMessage | PeerMessage | DisconnectMessage;

interface PendingFrame {
  readonly peer: PeerId;
  readonly bytes: number;
}

function validPeer(value: unknown): value is PeerId {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function validGeneration(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeMessage(value: unknown, generation: string): PortMessage | 'stale' | null {
  if (!isRecord(value) || !validGeneration(value.generation)) return null;
  if (value.generation !== generation) return 'stale';
  const messageGeneration = value.generation;
  switch (value.type) {
    case 'frame':
      if (
        typeof value.id !== 'number' ||
        !Number.isSafeInteger(value.id) ||
        !validPeer(value.peer) ||
        !(value.bytes instanceof ArrayBuffer)
      )
        return null;
      if (
        value.id <= 0 ||
        value.bytes.byteLength === 0 ||
        value.bytes.byteLength > ONLINE_WORKER_MAX_FRAME_BYTES
      )
        return null;
      return {
        type: 'frame',
        generation: messageGeneration,
        id: value.id,
        peer: value.peer,
        bytes: value.bytes,
      };
    case 'ack':
      if (
        typeof value.id !== 'number' ||
        !Number.isSafeInteger(value.id) ||
        value.id <= 0 ||
        typeof value.accepted !== 'boolean'
      )
        return null;
      return { type: 'ack', generation: messageGeneration, id: value.id, accepted: value.accepted };
    case 'peer':
      if (!validPeer(value.peer) || typeof value.online !== 'boolean') return null;
      return {
        type: 'peer',
        generation: messageGeneration,
        peer: value.peer,
        online: value.online,
      };
    case 'disconnect':
      if (!validPeer(value.peer)) return null;
      return { type: 'disconnect', generation: messageGeneration, peer: value.peer };
    default:
      return null;
  }
}

function copyFrame(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function post(port: OnlineTransportPort, message: PortMessage, bytes?: ArrayBuffer): void {
  if (bytes) port.postMessage(message, [bytes]);
  else port.postMessage(message);
}

function makeError(message: string, cause?: unknown): Error {
  const error = new Error(message);
  if (cause !== undefined) error.cause = cause;
  return error;
}

/** Bridges authenticated device packets from the main thread to the protocol worker. */
export function createMainThreadTransportBridge(
  options: MainThreadTransportBridgeOptions,
): OnlineWorkerTransportControl {
  validateBridgeOptions(options.generation, options.port);
  let closed = false;
  let outputStopped = false;
  let nextId = 0;
  let lastReceivedId = 0;
  let pendingBytes = 0;
  let notified = false;
  const pending = new Map<number, PendingFrame>();
  const perPeerPending = new Map<PeerId, number>();
  const initialPeers = options.transport.peers();
  if (
    initialPeers.length > 32 ||
    initialPeers.some((peer) => !validPeer(peer) || peer === options.transport.self)
  )
    throw new TypeError('Main-thread transport peer set is invalid');
  const peers = new Set(initialPeers);

  const reportFailure = (error: Error) => {
    if (notified) return;
    notified = true;
    try {
      options.onFailure?.(error);
    } catch {
      // Failure reporting must not escape a transport callback.
    }
  };
  const closeOnFailure = (error: Error) => {
    reportFailure(error);
    close();
  };
  const sendAck = (id: number, accepted: boolean) => {
    if (closed) return;
    try {
      post(options.port, { type: 'ack', generation: options.generation, id, accepted });
    } catch (error) {
      closeOnFailure(makeError('Could not acknowledge a worker frame', error));
    }
  };
  const disconnectPeer = (peer: PeerId) => {
    if (closed) return;
    peers.delete(peer);
    try {
      options.transport.disconnect(peer);
    } catch (error) {
      reportFailure(makeError('Could not disconnect an overloaded device peer', error));
    }
  };
  const enqueue = (peer: PeerId, bytes: Uint8Array) => {
    if (closed || !peers.has(peer)) return;
    if (!(bytes instanceof Uint8Array)) {
      disconnectPeer(peer);
      return;
    }
    if (!validFrameLength(bytes.byteLength)) {
      disconnectPeer(peer);
      return;
    }
    if (!canQueue(pending, perPeerPending, pendingBytes, peer, bytes.byteLength)) {
      // Device transports may drop while reconnecting; retrying belongs to the protocol outbox.
      return;
    }
    const id = allocateId(nextId);
    if (id === null) {
      closeOnFailure(makeError('Worker transport frame identifiers are exhausted'));
      return;
    }
    nextId = id;
    const owned = copyFrame(bytes);
    pending.set(id, { peer, bytes: owned.byteLength });
    perPeerPending.set(peer, (perPeerPending.get(peer) ?? 0) + 1);
    pendingBytes += owned.byteLength;
    try {
      post(
        options.port,
        { type: 'frame', generation: options.generation, id, peer, bytes: owned },
        owned,
      );
    } catch (error) {
      pendingBytes = removePending(id, pending, perPeerPending, pendingBytes);
      closeOnFailure(makeError('Could not forward an authenticated device frame', error));
    }
  };
  const onDeviceMessage = options.transport.onMessage((peer, bytes) => {
    if (!validPeer(peer) || !peers.has(peer)) return;
    enqueue(peer, bytes);
  });
  const onDevicePeer = options.transport.onPeerChange((peer, online) => {
    if (!validPeer(peer) || peer === options.transport.self || closed) return;
    if (online && !peers.has(peer) && peers.size >= 32) {
      disconnectPeer(peer);
      return;
    }
    if (online) peers.add(peer);
    else peers.delete(peer);
    try {
      post(options.port, { type: 'peer', generation: options.generation, peer, online });
    } catch (error) {
      closeOnFailure(makeError('Could not forward an authenticated peer update', error));
    }
  });

  const onPortMessage = (event: MessageEvent<unknown>) => {
    if (closed) return;
    const message = decodeMessage(event.data, options.generation);
    if (message === 'stale') return;
    if (!message) {
      closeOnFailure(makeError('Malformed worker transport message'));
      return;
    }
    if (message.type === 'ack') {
      const item = pending.get(message.id);
      if (!item) return;
      pendingBytes = removePending(message.id, pending, perPeerPending, pendingBytes);
      return;
    }
    if (message.type === 'frame') {
      const accepted = message.id > lastReceivedId && !outputStopped && peers.has(message.peer);
      lastReceivedId = Math.max(lastReceivedId, message.id);
      if (!accepted) {
        sendAck(message.id, false);
        return;
      }
      try {
        options.transport.send(message.peer, new Uint8Array(message.bytes));
        sendAck(message.id, true);
      } catch {
        // A peer may disconnect between its last membership update and this local handoff.
        sendAck(message.id, false);
      }
      return;
    }
    if (message.type === 'disconnect') {
      disconnectPeer(message.peer);
      return;
    }
    closeOnFailure(makeError('Worker sent a peer update in the wrong direction'));
  };

  options.port.addEventListener('message', onPortMessage);
  options.port.start?.();

  function close(): void {
    if (closed) return;
    closed = true;
    onDeviceMessage();
    onDevicePeer();
    options.port.removeEventListener('message', onPortMessage);
    options.port.close?.();
    pending.clear();
    perPeerPending.clear();
    pendingBytes = 0;
  }

  return {
    close,
    stopOutput() {
      outputStopped = true;
    },
  };
}

/** A worker-side Transport over authenticated device peers only. */
export function createWorkerDeviceTransport(
  options: WorkerDeviceTransportOptions,
): Transport & OnlineWorkerTransportControl {
  validateBridgeOptions(options.generation, options.port);
  if (!validPeer(options.self)) throw new TypeError('Worker transport self is invalid');
  const peers = new Set<PeerId>();
  for (const peer of options.peers) {
    if (!validPeer(peer) || peer === options.self || peers.has(peer))
      throw new TypeError('Worker transport peer set is invalid');
    peers.add(peer);
  }
  if (peers.size > 32) throw new TypeError('Worker transport peer set exceeds its bound');

  let closed = false;
  let outputStopped = false;
  let nextId = 0;
  let lastReceivedId = 0;
  let pendingBytes = 0;
  let notified = false;
  const pending = new Map<number, PendingFrame>();
  const perPeerPending = new Map<PeerId, number>();
  const messageListeners = new Set<(from: PeerId, message: Uint8Array) => void>();
  const peerListeners = new Set<(peer: PeerId, online: boolean) => void>();

  const reportFailure = (error: Error) => {
    if (notified) return;
    notified = true;
    try {
      options.onFailure?.(error);
    } catch {
      // Failure reporting must not escape a transport callback.
    }
  };
  const sendControl = (message: PortMessage, bytes?: ArrayBuffer) => {
    if (closed) return false;
    try {
      post(options.port, message, bytes);
      return true;
    } catch (error) {
      reportFailure(makeError('Could not write to the main-thread transport bridge', error));
      close();
      return false;
    }
  };
  const sendAck = (id: number, accepted: boolean) => {
    sendControl({ type: 'ack', generation: options.generation, id, accepted });
  };
  const removePeer = (peer: PeerId, notify: boolean) => {
    if (!peers.delete(peer)) return;
    if (notify) notifyPeerListeners(peer, false);
  };
  const notifyPeerListeners = (peer: PeerId, online: boolean) => {
    for (const listener of peerListeners) {
      try {
        listener(peer, online);
      } catch (error) {
        reportFailure(makeError('Worker transport peer listener failed', error));
      }
    }
  };
  const disconnectPeer = (peer: PeerId) => {
    if (!peers.has(peer)) return;
    removePeer(peer, true);
    sendControl({ type: 'disconnect', generation: options.generation, peer });
  };
  const enqueue = (peer: PeerId, input: Uint8Array) => {
    if (closed || outputStopped || !peers.has(peer) || peer === options.self) return;
    if (!(input instanceof Uint8Array)) throw new TypeError('Worker transport frame is invalid');
    if (!validFrameLength(input.byteLength))
      throw new Error('Worker transport frame exceeds its size limit');
    if (!canQueue(pending, perPeerPending, pendingBytes, peer, input.byteLength)) return;
    const id = allocateId(nextId);
    if (id === null) {
      const error = makeError('Worker transport frame identifiers are exhausted');
      reportFailure(error);
      throw error;
    }
    nextId = id;
    const bytes = copyFrame(input);
    pending.set(id, { peer, bytes: bytes.byteLength });
    perPeerPending.set(peer, (perPeerPending.get(peer) ?? 0) + 1);
    pendingBytes += bytes.byteLength;
    if (!sendControl({ type: 'frame', generation: options.generation, id, peer, bytes }, bytes)) {
      pendingBytes = removePending(id, pending, perPeerPending, pendingBytes);
      throw new Error('Worker transport port is closed');
    }
  };
  const onPortMessage = (event: MessageEvent<unknown>) => {
    if (closed) return;
    const message = decodeMessage(event.data, options.generation);
    if (message === 'stale') return;
    if (!message) {
      reportFailure(makeError('Malformed main-thread transport message'));
      close();
      return;
    }
    if (message.type === 'ack') {
      const item = pending.get(message.id);
      if (!item) return;
      pendingBytes = removePending(message.id, pending, perPeerPending, pendingBytes);
      return;
    }
    if (message.type === 'peer') {
      if (message.peer === options.self) return;
      const changed = message.online ? !peers.has(message.peer) : peers.has(message.peer);
      if (message.online) peers.add(message.peer);
      else peers.delete(message.peer);
      if (peers.size > 32) {
        reportFailure(makeError('Main thread exceeded the authenticated peer bound'));
        close();
        return;
      }
      if (changed) notifyPeerListeners(message.peer, message.online);
      return;
    }
    if (message.type === 'frame') {
      const accepted = message.id > lastReceivedId && peers.has(message.peer);
      lastReceivedId = Math.max(lastReceivedId, message.id);
      if (!accepted) {
        sendAck(message.id, false);
        return;
      }
      let failed = false;
      const listenerCount = messageListeners.size;
      for (const listener of messageListeners) {
        try {
          listener(message.peer, new Uint8Array(message.bytes.slice(0)));
        } catch (error) {
          failed = true;
          reportFailure(makeError('Worker transport message listener failed', error));
        }
      }
      sendAck(message.id, listenerCount > 0 && !failed);
      return;
    }
    reportFailure(makeError('Main thread sent a disconnect request in the wrong direction'));
    close();
  };

  options.port.addEventListener('message', onPortMessage);
  options.port.start?.();

  function close(): void {
    if (closed) return;
    closed = true;
    options.port.removeEventListener('message', onPortMessage);
    options.port.close?.();
    peers.clear();
    pending.clear();
    perPeerPending.clear();
    pendingBytes = 0;
    messageListeners.clear();
    peerListeners.clear();
  }

  const transport: Transport & OnlineWorkerTransportControl = {
    self: options.self,
    peers: () => (closed ? [] : [...peers].toSorted()),
    send: (peer, message) => enqueue(peer, message),
    broadcast: (message) => {
      let firstError: unknown = null;
      for (const peer of peers) {
        try {
          enqueue(peer, message);
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) throw firstError;
    },
    onMessage: (listener): Unsubscribe => {
      if (closed) return () => undefined;
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onPeerChange: (listener): Unsubscribe => {
      if (closed) return () => undefined;
      peerListeners.add(listener);
      return () => peerListeners.delete(listener);
    },
    disconnect: (peer) => disconnectPeer(peer),
    close,
    stopOutput: () => {
      outputStopped = true;
    },
  };
  return transport;
}

function validateBridgeOptions(generation: string, port: OnlineTransportPort): void {
  if (!validGeneration(generation)) throw new TypeError('Transport generation is invalid');
  if (!port || typeof port.postMessage !== 'function')
    throw new TypeError('Transport port is invalid');
}

function validFrameLength(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes > 0 && bytes <= ONLINE_WORKER_MAX_FRAME_BYTES;
}

function canQueue(
  pending: Map<number, PendingFrame>,
  perPeer: Map<PeerId, number>,
  pendingBytes: number,
  peer: PeerId,
  bytes: number,
): boolean {
  let peerBytes = 0;
  for (const frame of pending.values()) {
    if (frame.peer === peer) peerBytes += frame.bytes;
  }
  return (
    (perPeer.get(peer) ?? 0) < ONLINE_WORKER_MAX_FRAMES_PER_PEER &&
    peerBytes + bytes <= ONLINE_WORKER_MAX_IN_FLIGHT_BYTES_PER_PEER &&
    pending.size < ONLINE_WORKER_MAX_FRAMES_TOTAL &&
    pendingBytes + bytes <= ONLINE_WORKER_MAX_IN_FLIGHT_BYTES
  );
}

function allocateId(next: number): number | null {
  if (Number.isSafeInteger(next + 1)) return next + 1;
  return null;
}

function removePending(
  id: number,
  pending: Map<number, PendingFrame>,
  perPeer: Map<PeerId, number>,
  pendingBytes: number,
): number {
  const item = pending.get(id);
  if (!item) return pendingBytes;
  pending.delete(id);
  const count = (perPeer.get(item.peer) ?? 1) - 1;
  if (count > 0) perPeer.set(item.peer, count);
  else perPeer.delete(item.peer);
  return pendingBytes - item.bytes;
}
