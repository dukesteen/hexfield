# Pinned online worker source bundle
The manifest hashes complete source files. Sections below are exact snapshot excerpts; line range labels refer to the full files. No runtime data is included.

## apps/web/src/session/online-worker-messages.ts L1–L169
```typescript
import type { CommandShape, GameEvent, LegalCommandSet, PrivateState, Seat } from '@cp2p/engine';
import type {
  Genesis,
  LobbyFreezeAgreement,
  LobbyState,
  RecoveryApprovalPreview,
  SessionUpdate,
} from '@cp2p/protocol';
import type { OnlineInvite } from './online-invite.js';
import type { OnlineStartupSnapshot } from './online-startup.js';

export const ONLINE_WORKER_PROTOCOL = 'cp2p-online-worker-v1' as const;
export const MAX_ONLINE_WORKER_REQUEST_BYTES = 1_048_576;
export const MAX_ONLINE_WORKER_PENDING_REQUESTS = 16;
export const MAX_ONLINE_WORKER_SNAPSHOT_BYTES = 16 * 1024 * 1024;

export interface OnlineWorkerHead {
  readonly seq: number;
  readonly hash: string;
}

export type OnlineWorkerRequestBody =
  | {
      readonly kind: 'initialize';
      readonly self: string;
      readonly mode: 'fresh';
      readonly invite: OnlineInvite;
    }
  | {
      readonly kind: 'initialize';
      readonly self: string;
      readonly mode: 'resume';
      readonly gameId: string;
    }
  | {
      readonly kind: 'attachTransport';
      readonly self: string;
      readonly peers: readonly string[];
      readonly port: MessagePort;
    }
  | { readonly kind: 'pinFreeze'; readonly state: LobbyState }
  | { readonly kind: 'startCeremony'; readonly agreement: LobbyFreezeAgreement }
  | { readonly kind: 'retryStart' }
  | {
      readonly kind: 'validate';
      readonly seat: Seat;
      readonly head: OnlineWorkerHead;
      readonly command: CommandShape;
    }
  | {
      readonly kind: 'submit';
      readonly seat: Seat;
      readonly head: OnlineWorkerHead;
      readonly command: CommandShape;
    }
  | {
      readonly kind: 'setPrivateVisible';
      readonly visible: boolean;
      readonly visibilityToken: number;
    }
  | { readonly kind: 'exportSave' }
  | { readonly kind: 'retryAudit' }
  | { readonly kind: 'ackSession'; readonly snapshotId: number }
  | { readonly kind: 'approveRecoveryAuthorization'; readonly change: unknown }
  | { readonly kind: 'clearRecoveryApproval' }
  | {
      readonly kind: 'requestTakeover';
      readonly departedSeat: Seat;
      readonly botLevel: 'easy' | 'medium' | 'hard';
    }
  | { readonly kind: 'cancelPending'; readonly seat: Seat }
  | { readonly kind: 'shutdown' };

export interface OnlineWorkerRequest {
  readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
  readonly generation: string;
  readonly id: number;
  readonly body: OnlineWorkerRequestBody;
}

export interface OnlineWorkerResumeInfo {
  readonly gameId: string;
  readonly genesisDigest: string;
  readonly agreement: LobbyFreezeAgreement;
  readonly genesis: Genesis;
}

export interface OnlineWorkerInitialization {
  readonly self: string;
  readonly invite: OnlineInvite;
  readonly resume: OnlineWorkerResumeInfo | null;
}

export interface OnlineWorkerReplyByKind {
  initialize: OnlineWorkerInitialization;
  attachTransport: void;
  pinFreeze: { readonly freezeHash: string };
  startCeremony: void;
  retryStart: void;
  validate: void;
  submit: void;
  setPrivateVisible: void;
  exportSave: unknown;
  retryAudit: boolean;
  ackSession: void;
  approveRecoveryAuthorization: RecoveryApprovalPreview;
  clearRecoveryApproval: void;
  requestTakeover: void;
  cancelPending: boolean;
  shutdown: void;
}

export type OnlineWorkerReply = {
  [K in keyof OnlineWorkerReplyByKind]: {
    readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
    readonly generation: string;
    readonly id: number;
    readonly kind: K;
    readonly result:
      | { readonly ok: true; readonly value: OnlineWorkerReplyByKind[K] }
      | {
          readonly ok: false;
          readonly error: {
            readonly code: string;
            readonly message: string;
            readonly savedVersion?: number;
          };
        };
  };
}[keyof OnlineWorkerReplyByKind];

/** A complete public snapshot. `events` is full history, unlike `update.events`. */
export interface OnlineWorkerSessionSnapshot {
  readonly committedHead: OnlineWorkerHead;
  readonly update: SessionUpdate;
  readonly events: readonly GameEvent[];
  readonly localHumanSeat: Seat;
  readonly privateState: PrivateState | null;
  readonly legal: LegalCommandSet | null;
  readonly controllableSeats: readonly Seat[];
  readonly visibilityToken: number;
}

export type OnlineWorkerEvent =
  | {
      readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
      readonly generation: string;
      readonly kind: 'startup';
      readonly snapshot: OnlineStartupSnapshot | null;
    }
  | {
      readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
      readonly generation: string;
      readonly kind: 'gameReady';
      readonly game: { readonly gameId: string; readonly genesis: Genesis; readonly seat: Seat };
    }
  | {
      readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
      readonly generation: string;
      readonly kind: 'session';
      readonly snapshotId: number;
      readonly snapshot: OnlineWorkerSessionSnapshot;
    }
  | {
      readonly protocol: typeof ONLINE_WORKER_PROTOCOL;
      readonly generation: string;
      readonly kind: 'fatal';
      readonly error: { readonly code: string; readonly message: string };
    };

```

## apps/web/src/session/online-worker-transport.ts L1–L557
```typescript
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
    if (!canQueue(pending, perPeerPending, pendingBytes, peer, bytes.byteLength)) return;
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
    if (closed || outputStopped) throw new Error('Worker transport output is stopped');
    if (!peers.has(peer) || peer === options.self) throw new Error('Device peer is not connected');
    if (!(input instanceof Uint8Array)) throw new TypeError('Worker transport frame is invalid');
    if (!validFrameLength(input.byteLength))
      throw new Error('Worker transport frame exceeds its size limit');
    if (!canQueue(pending, perPeerPending, pendingBytes, peer, input.byteLength))
      throw new Error('Worker transport frame exceeds its bounded capacity');
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

```

## apps/web/src/session/online-worker-client.ts L1–L287
```typescript
import { canonicalEncode } from '@cp2p/codec';
import { failure } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import type { Unsubscribe } from '@cp2p/protocol';
import {
  MAX_ONLINE_WORKER_PENDING_REQUESTS,
  MAX_ONLINE_WORKER_REQUEST_BYTES,
  ONLINE_WORKER_PROTOCOL,
} from './online-worker-messages.js';
import type {
  OnlineWorkerEvent,
  OnlineWorkerReplyByKind,
  OnlineWorkerRequest,
  OnlineWorkerRequestBody,
} from './online-worker-messages.js';

export interface OnlineProtocolWorkerPort {
  postMessage(message: OnlineWorkerRequest, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  terminate(): void;
}

interface PendingRequest {
  kind: OnlineWorkerRequestBody['kind'];
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
  finish(result: Result<unknown>): void;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResult(value: unknown): value is Result<unknown> {
  return (
    object(value) &&
    (value.ok === true ||
      (value.ok === false &&
        object(value.error) &&
        typeof value.error.code === 'string' &&
        typeof value.error.message === 'string'))
  );
}

function transfers(body: OnlineWorkerRequestBody): Transferable[] {
  return body.kind === 'attachTransport' ? [body.port] : [];
}

function isEvent(
  value: Record<string, unknown>,
): value is Record<string, unknown> & OnlineWorkerEvent {
  switch (value.kind) {
    case 'startup':
      return (
        value.snapshot === null ||
        (object(value.snapshot) && typeof value.snapshot.phase === 'string')
      );
    case 'gameReady':
      return (
        object(value.game) &&
        typeof value.game.gameId === 'string' &&
        object(value.game.genesis) &&
        Number.isInteger(value.game.seat)
      );
    case 'session': {
      const snapshot = value.snapshot;
      return (
        Number.isSafeInteger(value.snapshotId) &&
        object(snapshot) &&
        object(snapshot.update) &&
        object(snapshot.update.state) &&
        object(snapshot.update.status) &&
        Array.isArray(snapshot.update.pending) &&
        Array.isArray(snapshot.update.timers) &&
        Array.isArray(snapshot.update.events) &&
        object(snapshot.committedHead) &&
        Number.isSafeInteger(snapshot.committedHead.seq) &&
        snapshot.update.revision === snapshot.committedHead.seq &&
        typeof snapshot.committedHead.hash === 'string' &&
        Array.isArray(snapshot.events) &&
        Array.isArray(snapshot.controllableSeats) &&
        Number.isSafeInteger(snapshot.visibilityToken) &&
        Number.isInteger(snapshot.localHumanSeat)
      );
    }
    case 'fatal':
      return (
        object(value.error) &&
        typeof value.error.code === 'string' &&
        typeof value.error.message === 'string'
      );
    default:
      return false;
  }
}

/** Only display data and commands cross this channel. Keys stay in the worker. */
export class OnlineWorkerClient {
  readonly generation: string;
  private readonly worker: OnlineProtocolWorkerPort;
  private readonly listeners = new Set<(event: OnlineWorkerEvent) => void>();
  private readonly failures = new Set<(error: Error) => void>();
  private readonly pending = new Map<number, PendingRequest>();
  private pendingBytes = 0;
  private nextId = 0;
  private stopped = false;
  private closing: Promise<void> | null = null;
  private fatalError: Error | null = null;

  constructor(options: { worker?: OnlineProtocolWorkerPort; generation?: string } = {}) {
    this.generation = options.generation ?? crypto.randomUUID();
    this.worker =
      options.worker ??
      new Worker(new URL('./online-protocol-worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', this.receive);
    this.worker.addEventListener('error', this.workerFailed);
    this.worker.addEventListener('messageerror', this.workerFailed);
  }

  request<K extends OnlineWorkerRequestBody['kind']>(
    body: Extract<OnlineWorkerRequestBody, { kind: K }>,
    options: { timeoutMs?: number } = {},
  ): Promise<Result<OnlineWorkerReplyByKind[K]>> {
    if (this.stopped || (this.closing && body.kind !== 'shutdown'))
      return Promise.resolve(failure('online-worker-closed', 'The online worker is unavailable'));
    let bytes: number;
    try {
      bytes = canonicalEncode(
        body.kind === 'attachTransport' ? { ...body, port: null } : body,
      ).byteLength;
    } catch {
      return Promise.resolve(failure('online-worker-request', 'The worker request is malformed'));
    }
    const shutdown = body.kind === 'shutdown';
    const control =
      body.kind === 'ackSession' ||
      body.kind === 'setPrivateVisible' ||
      body.kind === 'cancelPending';
    const countLimit = control
      ? MAX_ONLINE_WORKER_PENDING_REQUESTS
      : MAX_ONLINE_WORKER_PENDING_REQUESTS - 4;
    const byteLimit = control
      ? MAX_ONLINE_WORKER_REQUEST_BYTES
      : MAX_ONLINE_WORKER_REQUEST_BYTES - 65_536;
    if (
      bytes > MAX_ONLINE_WORKER_REQUEST_BYTES ||
      (!shutdown && (this.pendingBytes + bytes > byteLimit || this.pending.size >= countLimit))
    )
      return Promise.resolve(failure('online-worker-busy', 'Too many online requests are pending'));
    const id = ++this.nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.fail(new Error('The online worker stopped responding')),
        options.timeoutMs ?? 120_000,
      );
      this.pending.set(id, {
        kind: body.kind,
        bytes,
        timer,
        finish: (result) => {
          // The matched request ID and kind bind the reply to this method's result type.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          resolve(result as Result<OnlineWorkerReplyByKind[K]>);
        },
      });
      this.pendingBytes += bytes;
      try {
        this.worker.postMessage(
          { protocol: ONLINE_WORKER_PROTOCOL, generation: this.generation, id, body },
          transfers(body),
        );
      } catch {
        this.fail(new Error('Could not communicate with the online worker'));
      }
    });
  }

  subscribe(listener: (event: OnlineWorkerEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void): Unsubscribe {
    this.failures.add(listener);
    if (this.fatalError) listener(this.fatalError);
    return () => this.failures.delete(listener);
  }

  fail(error: Error): void {
    if (this.stopped) return;
    this.fatalError = error;
    // Stop the network bridge before terminating the signer or resolving pending UI work.
    for (const listener of this.failures) {
      try {
        listener(error);
      } catch {
        /* Other owners must still stop output. */
      }
    }
    this.terminate();
  }

  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.stopped) return Promise.resolve();
    this.closing = Promise.resolve().then(async () => {
      const result = await this.request({ kind: 'shutdown' }, { timeoutMs: 10_000 });
      this.terminate();
      if (!result.ok) throw new Error(result.error.message);
      return undefined;
    });
    return this.closing;
  }

  private readonly workerFailed = () =>
    this.fail(new Error('The online worker failed. Reopen the saved game to reconnect.'));

  private readonly receive = (event: MessageEvent<unknown>) => {
    if (this.stopped) return;
    const message = event.data;
    if (!object(message) || message.protocol !== ONLINE_WORKER_PROTOCOL) {
      this.fail(new Error('Malformed online worker response'));
      return;
    }
    if (message.generation !== this.generation) return;
    if ('id' in message) {
      if (typeof message.id !== 'number' || !Number.isSafeInteger(message.id)) {
        this.fail(new Error('Malformed online worker request ID'));
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.kind !== pending.kind || !isResult(message.result)) {
        this.fail(new Error('Online worker reply does not match its request'));
        return;
      }
      this.pending.delete(message.id);
      this.pendingBytes -= pending.bytes;
      clearTimeout(pending.timer);
      pending.finish(message.result);
      return;
    }
    if (!isEvent(message)) {
      this.fail(new Error('Malformed online worker update'));
      return;
    }
    if (message.kind === 'fatal') {
      this.fail(new Error(message.error.message));
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        this.fail(new Error('Could not apply the online worker update'));
      }
    }
    if (message.kind === 'session' && !this.stopped) {
      void this.request({ kind: 'ackSession', snapshotId: message.snapshotId }).then((result) => {
        if (!result.ok && !this.stopped) this.fail(new Error(result.error.message));
        return undefined;
      });
    }
  };

  private terminate(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.worker.removeEventListener('message', this.receive);
    this.worker.removeEventListener('error', this.workerFailed);
    this.worker.removeEventListener('messageerror', this.workerFailed);
    this.worker.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.finish(
        failure('online-worker-closed', this.fatalError?.message ?? 'The online worker is closed'),
      );
    }
    this.pending.clear();
    this.pendingBytes = 0;
    this.listeners.clear();
    this.failures.clear();
  }
}

```

## apps/web/src/session/online-worker-session.ts L1–L202
```typescript
import { failure } from '@cp2p/engine';
import type { CommandShape, Result, Seat } from '@cp2p/engine';
import type { GameSession, SessionUpdate, SubmitOptions } from '@cp2p/protocol';
import { OnlineWorkerClient } from './online-worker-client.js';
import type { OnlineWorkerHead, OnlineWorkerSessionSnapshot } from './online-worker-messages.js';

const emptyLegal = { commands: [], templates: [] };

function sameHead(left: OnlineWorkerHead, right: OnlineWorkerHead): boolean {
  return left.seq === right.seq && left.hash === right.hash;
}

/** Display cache only. The worker owns every validation, proof and state transition. */
export class OnlineWorkerSession implements GameSession {
  readonly mode = 'p2p';
  private current: OnlineWorkerSessionSnapshot;
  private readonly listeners = new Set<(update: SessionUpdate) => void>();
  private visible = true;
  private visibilityToken = 0;
  private disposed = false;

  constructor(
    private readonly client: OnlineWorkerClient,
    snapshot: OnlineWorkerSessionSnapshot,
    private readonly onDispose: () => void,
  ) {
    this.current = this.sanitize(snapshot);
  }

  private sanitize(snapshot: OnlineWorkerSessionSnapshot): OnlineWorkerSessionSnapshot {
    if (snapshot.controllableSeats.some((seat) => seat !== snapshot.localHumanSeat))
      throw new Error('Worker exposed another seat as locally controllable');
    const showPrivate = this.visible && snapshot.visibilityToken === this.visibilityToken;
    return {
      ...snapshot,
      privateState: showPrivate ? snapshot.privateState : null,
      legal: showPrivate ? snapshot.legal : null,
    };
  }

  accept(snapshot: OnlineWorkerSessionSnapshot): void {
    if (this.disposed) return;
    if (
      snapshot.localHumanSeat !== this.current.localHumanSeat ||
      snapshot.committedHead.seq < this.current.committedHead.seq
    )
      throw new Error('Worker snapshot does not belong to the current session');
    this.current = this.sanitize(snapshot);
    this.notify();
  }

  getState() {
    return this.current.update.state;
  }
  getCommittedHead() {
    return { ...this.current.committedHead };
  }
  getPrivate(seat: Seat) {
    return !this.disposed && seat === this.current.localHumanSeat
      ? this.current.privateState
      : null;
  }
  getLegalCommands(seat: Seat) {
    return !this.disposed && seat === this.current.localHumanSeat
      ? (this.current.legal ?? emptyLegal)
      : emptyLegal;
  }
  getPending() {
    return this.current.update.pending;
  }
  getTimers() {
    return this.current.update.timers;
  }
  getEvents() {
    return this.current.events;
  }
  getAudit() {
    return this.current.update.audit ?? { kind: 'not-started' as const };
  }
  getRecoveryCandidate() {
    return this.current.update.recoveryCandidate ?? null;
  }
  controllableSeats() {
    return this.disposed ? [] : [...this.current.controllableSeats];
  }

  async validate(seat: Seat, command: CommandShape): Promise<Result<void>> {
    if (this.disposed || seat !== this.current.localHumanSeat)
      return failure('session-inactive', 'This peer cannot control the requested seat');
    const head = this.getCommittedHead();
    const token = this.visibilityToken;
    const result = await this.client.request({ kind: 'validate', seat, command, head });
    if (!sameHead(head, this.current.committedHead) || token !== this.visibilityToken)
      return failure('stale-revision', 'Board changed; choose the action again');
    return result;
  }

  async submit(
    seat: Seat,
    command: CommandShape,
    options: SubmitOptions = {},
  ): Promise<Result<void>> {
    if (this.disposed || seat !== this.current.localHumanSeat)
      return failure('session-inactive', 'This peer cannot control the requested seat');
    const head = this.getCommittedHead();
    if (options.expectedRevision !== undefined && options.expectedRevision !== head.seq)
      return failure('stale-revision', 'Board changed; choose the action again');
    return this.client.request({ kind: 'submit', seat, command, head });
  }

  setPrivateVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.visible = visible;
    this.visibilityToken++;
    // Clear immediately; late replies cannot restore a concealed or superseded view.
    this.current = { ...this.current, privateState: null, legal: null };
    void this.client
      .request({ kind: 'setPrivateVisible', visible, visibilityToken: this.visibilityToken })
      .then((result) => {
        if (!result.ok && !this.disposed) this.client.fail(new Error(result.error.message));
        return undefined;
      });
  }

  async exportSave(): Promise<unknown> {
    const result = await this.client.request({ kind: 'exportSave' });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }

  async retryAudit(): Promise<boolean> {
    const result = await this.client.request({ kind: 'retryAudit' });
    return result.ok && result.value;
  }

  async cancelPending(seat: Seat): Promise<boolean> {
    if (seat !== this.current.localHumanSeat || this.disposed) return false;
    const result = await this.client.request({ kind: 'cancelPending', seat });
    return result.ok && result.value;
  }

  approveRecoveryAuthorization(change: unknown) {
    return this.client.request({ kind: 'approveRecoveryAuthorization', change });
  }

  clearRecoveryApproval(): void {
    void this.client.request({ kind: 'clearRecoveryApproval' });
  }

  requestTakeover(departedSeat: Seat, botLevel: 'easy' | 'medium' | 'hard') {
    return this.client.request({ kind: 'requestTakeover', departedSeat, botLevel });
  }

  subscribe(listener: (update: SessionUpdate) => void) {
    this.listeners.add(listener);
    listener(this.current.update);
    return () => this.listeners.delete(listener);
  }

  fail(error: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.current = {
      ...this.current,
      privateState: null,
      legal: null,
      controllableSeats: [],
      update: {
        ...this.current.update,
        pending: [],
        timers: [],
        status: { kind: 'error', message: error.message },
      },
    };
    this.notify();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.current = {
      ...this.current,
      privateState: null,
      legal: null,
      controllableSeats: [],
      update: { ...this.current.update, pending: [], timers: [], status: { kind: 'disposed' } },
    };
    this.onDispose();
    this.notify();
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.current.update);
      } catch {
        /* A view cannot interrupt other subscribers. */
      }
    }
  }
}

```

## apps/web/src/session/online-worker-startup.ts L1–L334
```typescript
import { hashValue, toBase64Url, toHex } from '@cp2p/codec';
import { failure, success } from '@cp2p/engine';
import type {
  GameSession,
  LobbyController,
  LobbyFreezeAgreement,
  ProtocolClock,
  Transport,
  Unsubscribe,
} from '@cp2p/protocol';
import type { OnlineGame } from './online-game.js';
import type { OnlineInvite } from './online-invite.js';
import type { OnlineStartupSnapshot } from './online-startup.js';
import { OnlineWorkerClient } from './online-worker-client.js';
import type {
  OnlineWorkerEvent,
  OnlineWorkerInitialization,
  OnlineWorkerResumeInfo,
} from './online-worker-messages.js';
import { OnlineWorkerSession } from './online-worker-session.js';
import { createMainThreadTransportBridge } from './online-worker-transport.js';

interface WorkerStartupOptions {
  invite: OnlineInvite;
  self: string;
  transport: Transport;
  clock: ProtocolClock;
  lobby?: LobbyController;
  freezePeers?: (peers: readonly string[]) => void;
  resume?: OnlineWorkerResumeInfo;
  client?: OnlineWorkerClient;
  initialization?: OnlineWorkerInitialization;
  createClient?: () => OnlineWorkerClient;
}

/** The UI pins consent through the worker before ACKing; certified work stays there. */
export class OnlineWorkerStartup {
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: Unsubscribe[] = [];
  private client: OnlineWorkerClient | null = null;
  private bridge: ReturnType<typeof createMainThreadTransportBridge> | null = null;
  private attached: Promise<void> | null = null;
  private approved: LobbyFreezeAgreement | null;
  private current: OnlineStartupSnapshot | null;
  private activeGame: OnlineGame<GameSession> | null = null;
  private gameInfo: Extract<OnlineWorkerEvent, { kind: 'gameReady' }>['game'] | null = null;
  private work: Promise<void> | null = null;
  private retry: unknown = null;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly options: WorkerStartupOptions) {
    this.approved = options.resume?.agreement ?? null;
    this.current = options.resume
      ? {
          phase: 'opening',
          awaitingSeats: [],
          locallyConsented: true,
          error: null,
          gameId: options.resume.gameId,
        }
      : null;
    if (options.client) this.connectClient(options.client);
    if (options.lobby) this.unsubscribers.push(options.lobby.onChange(() => this.observe()));
    this.unsubscribers.push(options.transport.onPeerChange(() => this.observe()));
    this.observe();
  }

  snapshot() {
    return this.current;
  }
  agreement() {
    return this.approved;
  }
  game() {
    return this.activeGame;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  begin() {
    if (this.closed || !this.options.lobby || this.current)
      return failure('online-start-active', 'An online start is already active');
    return this.options.lobby.start(toBase64Url(crypto.getRandomValues(new Uint8Array(32))));
  }

  async retryFailed() {
    if (this.closed || this.activeGame || this.work || this.current?.phase !== 'error')
      return failure('online-start-retry', 'There is no failed start ready to retry');
    if (this.approved && this.client) {
      const result = await this.client.request({ kind: 'retryStart' });
      if (!result.ok) return result;
    }
    this.update({
      phase: this.approved ? 'opening' : 'freezing',
      awaitingSeats: [],
      locallyConsented: this.approved !== null,
      error: null,
      gameId: this.current.gameId,
    });
    this.observe();
    return success(undefined);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.bridge?.stopOutput();
    if (this.retry !== null) this.options.clock.clearTimeout(this.retry);
    this.retry = null;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.closing = Promise.resolve().then(async () => {
      try {
        await this.client?.shutdown();
      } finally {
        this.bridge?.close();
      }
      return undefined;
    });
    this.activeGame?.session.dispose();
    this.listeners.clear();
    return this.closing;
  }

  private update(snapshot: OnlineStartupSnapshot): void {
    if (this.closed) return;
    if (snapshot.error && snapshot.error !== this.current?.error) {
      // oxlint-disable-next-line no-console -- Temporary local worker integration diagnostic; no key or packet data.
      console.warn('Online startup stopped:', snapshot.error);
    }
    this.current = snapshot;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Keep lifecycle independent of UI listeners. */
      }
    }
  }

  private fail(error: Error, halted = false): void {
    if (this.closed) return;
    this.bridge?.stopOutput();
    if (this.activeGame?.session instanceof OnlineWorkerSession)
      this.activeGame.session.fail(error);
    this.update({
      phase: halted ? 'halted' : 'error',
      awaitingSeats: [],
      locallyConsented: this.approved !== null,
      error: error.message,
      gameId: this.activeGame?.gameId ?? this.options.resume?.gameId ?? null,
    });
  }

  private connectClient(client: OnlineWorkerClient): void {
    this.client = client;
    this.unsubscribers.push(
      client.subscribe((event) => this.receive(event)),
      client.onFailure((error) => this.fail(error, true)),
    );
  }

  private receive(event: OnlineWorkerEvent): void {
    if (this.closed) return;
    if (event.kind === 'startup') {
      if (event.snapshot?.phase === 'halted')
        this.fail(new Error(event.snapshot.error ?? 'Online game stopped'), true);
      else if (event.snapshot) this.update(event.snapshot);
    } else if (event.kind === 'gameReady') {
      this.gameInfo = event.game;
    } else if (event.kind === 'session') {
      if (!this.gameInfo || !this.client)
        throw new Error('Worker published a session before admitting the game');
      if (this.activeGame?.session instanceof OnlineWorkerSession)
        this.activeGame.session.accept(event.snapshot);
      else {
        const session = new OnlineWorkerSession(this.client, event.snapshot, () => {
          void this.close().catch(() => undefined);
        });
        this.activeGame = { ...this.gameInfo, session, close: () => this.close() };
        this.update({
          phase: 'playing',
          awaitingSeats: [],
          locallyConsented: true,
          error: null,
          gameId: this.gameInfo.gameId,
        });
      }
    }
  }

  private ensureAttached(): Promise<void> {
    if (this.attached) return this.attached;
    this.attached = (async () => {
      if (!this.client)
        this.connectClient(this.options.createClient?.() ?? new OnlineWorkerClient());
      const client = this.client;
      if (!client) throw new Error('Online worker is unavailable');
      if (!this.options.initialization) {
        const result = await client.request({
          kind: 'initialize',
          mode: 'fresh',
          self: this.options.self,
          invite: this.options.invite,
        });
        if (!result.ok) throw new Error(result.error.message);
        if (result.value.self !== this.options.self)
          throw new Error('Online worker device identity differs');
      }
      if (this.closed) return;
      const channel = new MessageChannel();
      this.bridge = createMainThreadTransportBridge({
        transport: this.options.transport,
        port: channel.port1,
        generation: client.generation,
        onFailure: (error) => client.fail(error),
      });
      const attached = await client.request({
        kind: 'attachTransport',
        self: this.options.self,
        peers: this.options.transport.peers(),
        port: channel.port2,
      });
      if (!attached.ok) throw new Error(attached.error.message);
    })().catch((error: unknown) => {
      const cause = error instanceof Error ? error : new Error('Could not attach online worker');
      this.client?.fail(cause);
      throw cause;
    });
    return this.attached;
  }

  private observe(): void {
    if (
      this.closed ||
      this.work ||
      this.activeGame ||
      this.current?.phase === 'error' ||
      this.current?.phase === 'halted'
    )
      return;
    this.work = this.advance()
      .catch((error: unknown) => {
        if (!this.closed && this.current?.phase !== 'halted')
          this.update({
            phase: 'error',
            awaitingSeats: [],
            locallyConsented: this.approved !== null,
            error: error instanceof Error ? error.message : 'Online startup failed',
            gameId: this.options.resume?.gameId ?? null,
          });
      })
      .finally(() => {
        this.work = null;
        if (
          this.closed ||
          this.approved ||
          this.activeGame ||
          this.current?.phase === 'error' ||
          this.current?.phase === 'halted'
        )
          return;
        if (this.retry === null)
          this.retry = this.options.clock.setTimeout(() => {
            this.retry = null;
            this.observe();
          }, 1_000);
      });
  }

  private async advance(): Promise<void> {
    if (this.options.resume) {
      await this.ensureAttached();
      return;
    }
    const lobby = this.options.lobby;
    const state = lobby?.state();
    if (
      !state ||
      state.status !== 'starting' ||
      this.approved ||
      !state.seats.some((seat) => seat.kind === 'human' && seat.peer === this.options.self)
    )
      return;
    this.update({
      phase: 'freezing',
      awaitingSeats: [],
      locallyConsented: false,
      error: null,
      gameId: null,
    });
    await this.ensureAttached();
    if (this.closed || !this.client || !lobby) return;
    const pinned = await this.client.request({ kind: 'pinFreeze', state });
    if (!pinned.ok) throw new Error(pinned.error.message);
    if (this.closed) return;
    const current = lobby.state();
    if (!current || toHex(hashValue(current)) !== pinned.value.freezeHash) return;
    const acknowledged = lobby.ackFreeze();
    if (!acknowledged.ok) return;
    const agreement = lobby.freezeAgreement();
    if (!agreement) return;
    if (toHex(hashValue(agreement.state)) !== pinned.value.freezeHash) {
      const error = new Error('Lobby changed after pinned consent');
      this.client.fail(error);
      throw error;
    }
    // Freeze authenticated device discovery before the worker discloses ceremony material.
    if (!this.options.freezePeers) {
      const error = new Error('Fresh online start has no roster freeze');
      this.client.fail(error);
      throw error;
    }
    try {
      this.options.freezePeers(
        agreement.state.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.peer] : [])),
      );
    } catch (error) {
      const cause = error instanceof Error ? error : new Error('Could not freeze device roster');
      this.client.fail(cause);
      throw cause;
    }
    this.approved = agreement;
    const started = await this.client.request({ kind: 'startCeremony', agreement });
    if (!started.ok) {
      const error = new Error(started.error.message);
      this.client.fail(error);
      throw error;
    }
  }
}

```

## apps/web/src/session/online-worker-runtime.ts L1–L549
```typescript
import { canonicalDecode, canonicalEncode, hashValue, toHex } from '@cp2p/codec';
import { createBaseEngine, success } from '@cp2p/engine';
import { verifyLobbyFreezeAgreement } from '@cp2p/protocol';
import type { ProtocolClock, SessionUpdate, Unsubscribe } from '@cp2p/protocol';
import { IndexedDbByteStore } from '@cp2p/storage';
import { loadOnlineIdentity } from './online-credentials.js';
import type { DisposableOnlineIdentity } from './online-credentials.js';
import { validateOnlineInvite } from './online-invite.js';
import type { OnlineInvite } from './online-invite.js';
import { loadOnlineGameRecord } from './online-game-records.js';
import type { SavedOnlineGameRecord } from './online-game-records.js';
import { OnlineStartup, pinOnlineFreeze } from './online-startup.js';
import { createWorkerDeviceTransport } from './online-worker-transport.js';
import {
  MAX_ONLINE_WORKER_REQUEST_BYTES,
  MAX_ONLINE_WORKER_PENDING_REQUESTS,
  MAX_ONLINE_WORKER_SNAPSHOT_BYTES,
  ONLINE_WORKER_PROTOCOL,
} from './online-worker-messages.js';
import type {
  OnlineWorkerEvent,
  OnlineWorkerReply,
  OnlineWorkerReplyByKind,
  OnlineWorkerRequest,
  OnlineWorkerRequestBody,
  OnlineWorkerSessionSnapshot,
} from './online-worker-messages.js';

type WorkerTransport = ReturnType<typeof createWorkerDeviceTransport>;
type WorkerStore = Pick<
  IndexedDbByteStore,
  'load' | 'putIfAbsent' | 'compareAndSwap' | 'withCeremonyLock' | 'close'
>;

export interface OnlineWorkerRuntimeOptions {
  readonly emit: (event: OnlineWorkerEvent) => void;
  readonly store?: WorkerStore;
  readonly clock?: ProtocolClock;
}

function workerClock(): ProtocolClock {
  const epoch = Date.now();
  const started = performance.now();
  return {
    now: () => epoch + performance.now() - started,
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => {
      if (typeof handle === 'number') globalThis.clearTimeout(handle);
    },
  };
}

function copyPublic<T>(value: T): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Canonical encoding detaches only public evidence and snapshots.
  return canonicalDecode(canonicalEncode(value)) as T;
}

function errorResult(error: unknown): {
  ok: false;
  error: { code: string; message: string; savedVersion?: number };
} {
  const code =
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'online-worker';
  const message = error instanceof Error ? error.message : 'Online worker request failed';
  const savedVersion =
    typeof error === 'object' &&
    error !== null &&
    'savedVersion' in error &&
    typeof error.savedVersion === 'number'
      ? error.savedVersion
      : undefined;
  return {
    ok: false,
    error: savedVersion === undefined ? { code, message } : { code, message, savedVersion },
  };
}

/** Owns one room's certified online ceremony and session, never exposing its keys to main. */
export class OnlineWorkerRuntime {
  private readonly store: WorkerStore;
  private readonly clock: ProtocolClock;
  private readonly emit: (event: OnlineWorkerEvent) => void;
  private generation: string | null = null;
  private lastId = 0;
  private pending = 0;
  private pendingBytes = 0;
  private work: Promise<void> = Promise.resolve();
  private readonly sessionWork = new Set<Promise<unknown>>();
  private identity: DisposableOnlineIdentity | null = null;
  private invite: OnlineInvite | null = null;
  private resume: SavedOnlineGameRecord | null = null;
  private transport: WorkerTransport | null = null;
  private startup: OnlineStartup | null = null;
  private sessionUnsubscribe: Unsubscribe | null = null;
  private startupUnsubscribe: Unsubscribe | null = null;
  private gameAnnounced = false;
  private lastUpdate: SessionUpdate | null = null;
  private pinnedFreezeHash: string | null = null;
  private visible = true;
  private visibilityToken = 0;
  private lastSnapshotId = 0;
  private unackedSnapshotId: number | null = null;
  private queuedSnapshot: OnlineWorkerSessionSnapshot | null = null;
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(options: OnlineWorkerRuntimeOptions) {
    this.store = options.store ?? new IndexedDbByteStore();
    this.clock = options.clock ?? workerClock();
    this.emit = options.emit;
  }

  /** Request IDs are one-way and generation-scoped; shutdown bypasses queued work. */
  handle(request: OnlineWorkerRequest): Promise<OnlineWorkerReply> {
    if (
      request.protocol !== ONLINE_WORKER_PROTOCOL ||
      !Number.isSafeInteger(request.id) ||
      request.id <= this.lastId ||
      typeof request.generation !== 'string' ||
      request.generation.length < 1 ||
      request.generation.length > 256 ||
      (this.generation !== null && request.generation !== this.generation)
    )
      return Promise.resolve(this.reply(request, errorResult(new Error('Stale worker request'))));
    if (this.generation === null) this.generation = request.generation;
    this.lastId = request.id;
    if (request.body.kind === 'shutdown') {
      this.stopOutput();
      return this.close().then(
        () => this.reply(request, success(undefined)),
        (error: unknown) => this.reply(request, errorResult(error)),
      );
    }
    let bytes: number;
    try {
      const body =
        request.body.kind === 'attachTransport'
          ? { kind: request.body.kind, self: request.body.self, peers: request.body.peers }
          : request.body;
      bytes = canonicalEncode({
        protocol: request.protocol,
        generation: request.generation,
        id: request.id,
        body,
      }).byteLength;
    } catch {
      return Promise.resolve(
        this.reply(request, errorResult(new Error('Malformed worker request'))),
      );
    }
    const control =
      request.body.kind === 'ackSession' ||
      request.body.kind === 'setPrivateVisible' ||
      request.body.kind === 'cancelPending';
    const countLimit = control
      ? MAX_ONLINE_WORKER_PENDING_REQUESTS
      : MAX_ONLINE_WORKER_PENDING_REQUESTS - 4;
    const byteLimit = control
      ? MAX_ONLINE_WORKER_REQUEST_BYTES
      : MAX_ONLINE_WORKER_REQUEST_BYTES - 65_536;
    if (
      this.closed ||
      bytes > MAX_ONLINE_WORKER_REQUEST_BYTES ||
      this.pending >= countLimit ||
      this.pendingBytes + bytes > byteLimit
    )
      return Promise.resolve(
        this.reply(request, errorResult(new Error('Worker is closed or busy'))),
      );
    this.pending += 1;
    this.pendingBytes += bytes;
    const lifecycle = [
      'initialize',
      'attachTransport',
      'pinFreeze',
      'startCeremony',
      'retryStart',
    ].includes(request.body.kind);
    const operation = async () => {
      if (this.closed) throw new Error('Worker is closed');
      return this.dispatch(request.body);
    };
    const result = lifecycle ? this.work.then(operation) : Promise.resolve().then(operation);
    if (lifecycle)
      this.work = result.then(
        () => undefined,
        () => undefined,
      );
    else {
      this.sessionWork.add(result);
      void result.finally(() => this.sessionWork.delete(result)).catch(() => undefined);
    }
    return result
      .then(
        (value) => this.reply(request, success(value)),
        (error: unknown) => this.reply(request, errorResult(error)),
      )
      .finally(() => {
        this.pending -= 1;
        this.pendingBytes -= bytes;
      });
  }

  private reply(
    request: OnlineWorkerRequest,
    result:
      | { ok: true; value: unknown }
      | { ok: false; error: { code: string; message: string; savedVersion?: number } },
  ): OnlineWorkerReply {
    const reply = {
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: request.generation,
      id: request.id,
      kind: request.body.kind,
      result,
    };
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Dispatch fixes the response value for each request kind.
    return reply as OnlineWorkerReply;
  }

  private async dispatch(body: OnlineWorkerRequestBody): Promise<unknown> {
    switch (body.kind) {
      case 'initialize':
        return this.initialize(body);
      case 'attachTransport':
        return this.attachTransport(body);
      case 'pinFreeze':
        return this.pinFreeze(body.state);
      case 'startCeremony':
        return this.startCeremony(body.agreement);
      case 'retryStart': {
        const retried = await this.requireStartup().retryFailed();
        if (!retried.ok) throw new Error(retried.error.message);
        return undefined;
      }
      case 'validate':
      case 'submit': {
        const session = this.requireSession();
        this.requireHead(body.head);
        if (body.seat !== this.requireStartup().game()?.seat)
          throw new Error('Only the local human seat accepts UI commands');
        const result =
          body.kind === 'validate'
            ? session.validate(body.seat, body.command)
            : await session.submit(body.seat, body.command, { expectedRevision: body.head.seq });
        if (!result.ok)
          throw Object.assign(new Error(result.error.message), { code: result.error.code });
        return undefined;
      }
      case 'setPrivateVisible':
        if (
          !Number.isSafeInteger(body.visibilityToken) ||
          body.visibilityToken <= this.visibilityToken
        )
          throw new Error('Private visibility token must increase');
        this.visibilityToken = body.visibilityToken;
        this.visible = body.visible;
        this.publishSession();
        return undefined;
      case 'exportSave': {
        const history = this.requireSession().exportSave();
        if (canonicalEncode(history).byteLength > MAX_ONLINE_WORKER_SNAPSHOT_BYTES)
          throw new Error('Certified history exceeds the worker export limit');
        return history;
      }
      case 'retryAudit':
        return this.requireSession().retryAudit();
      case 'ackSession':
        if (body.snapshotId !== this.unackedSnapshotId)
          throw new Error('Session snapshot acknowledgement is stale');
        this.unackedSnapshotId = null;
        if (this.queuedSnapshot) {
          const next = this.queuedSnapshot;
          this.queuedSnapshot = null;
          this.sendSessionSnapshot(next);
        }
        return undefined;
      case 'approveRecoveryAuthorization': {
        const result = await this.requireSession().approveRecoveryAuthorization(body.change);
        if (!result.ok)
          throw Object.assign(new Error(result.error.message), { code: result.error.code });
        return result.value;
      }
      case 'clearRecoveryApproval':
        this.requireSession().clearRecoveryApproval();
        return undefined;
      case 'requestTakeover': {
        const result = await this.requireSession().requestTakeover(
          body.departedSeat,
          body.botLevel,
        );
        if (!result.ok)
          throw Object.assign(new Error(result.error.message), { code: result.error.code });
        return undefined;
      }
      case 'cancelPending':
        if (body.seat !== this.requireStartup().game()?.seat)
          throw new Error('Only the local human seat can cancel a UI command');
        return this.requireSession().cancelPending(body.seat);
      case 'shutdown':
        return undefined;
    }
    return undefined;
  }

  private async initialize(
    body: Extract<OnlineWorkerRequestBody, { kind: 'initialize' }>,
  ): Promise<OnlineWorkerReplyByKind['initialize']> {
    if (this.identity || this.transport || this.startup)
      throw new Error('Worker already initialized');
    const identity = await loadOnlineIdentity(this.store);
    if (this.closed) {
      identity.dispose();
      throw new Error('Worker closed while loading identity');
    }
    if (identity.peerId !== body.self) {
      identity.dispose();
      throw new Error('Stored device identity differs from authenticated transport');
    }
    let resume: SavedOnlineGameRecord | null = null;
    let invite: OnlineInvite;
    try {
      if (body.mode === 'resume') {
        resume = await loadOnlineGameRecord(this.store, body.gameId);
        if (!resume) throw new Error('Saved online game is missing');
        invite = validateOnlineInvite(resume.invite);
        if (
          !resume.agreement.state.seats.some(
            (seat) => seat.kind === 'human' && seat.peer === body.self,
          )
        )
          throw new Error('Device does not own a human seat in this saved game');
      } else invite = validateOnlineInvite(body.invite);
      if (this.closed) throw new Error('Worker closed while loading saved game');
      this.identity = identity;
      this.invite = copyPublic(invite);
      this.resume = resume;
      return {
        self: identity.peerId,
        invite: copyPublic(invite),
        resume: resume
          ? {
              gameId: resume.gameId,
              genesisDigest: resume.genesisDigest,
              agreement: copyPublic(resume.agreement),
              genesis: copyPublic(resume.result.genesis),
            }
          : null,
      };
    } catch (error) {
      identity.dispose();
      throw error;
    }
  }

  private attachTransport(
    body: Extract<OnlineWorkerRequestBody, { kind: 'attachTransport' }>,
  ): void {
    if (!this.identity || !this.invite || this.transport || !this.generation)
      throw new Error('Worker transport cannot attach before initialization');
    if (body.self !== this.identity.peerId) throw new Error('Worker transport identity differs');
    this.transport = createWorkerDeviceTransport({
      self: body.self,
      peers: body.peers,
      port: body.port,
      generation: this.generation,
      onFailure: (error) => this.fatal(error, 'online-worker-transport'),
    });
    if (this.resume) this.openStartup({ resume: this.resume });
  }

  private async pinFreeze(
    state: Extract<OnlineWorkerRequestBody, { kind: 'pinFreeze' }>['state'],
  ): Promise<{ freezeHash: string }> {
    if (!this.identity || !this.invite || this.resume || this.startup)
      throw new Error('Fresh freeze is unavailable in this worker');
    if (state.lobbyId !== this.invite.roomId) throw new Error('Freeze belongs to a different room');
    const freezeHash = await pinOnlineFreeze(this.store, this.identity.peerId, state);
    if (this.closed) throw new Error('Worker closed during freeze pin');
    this.pinnedFreezeHash = freezeHash;
    return { freezeHash };
  }

  private startCeremony(
    agreement: Extract<OnlineWorkerRequestBody, { kind: 'startCeremony' }>['agreement'],
  ): void {
    if (!this.identity || !this.invite || !this.transport || this.resume || this.startup)
      throw new Error('Fresh ceremony cannot start yet');
    const checked = verifyLobbyFreezeAgreement(agreement);
    if (!checked.ok) throw new Error(checked.error.message);
    if (
      checked.value.state.lobbyId !== this.invite.roomId ||
      toHex(hashValue(checked.value.state)) !== this.pinnedFreezeHash
    )
      throw new Error('Signed agreement differs from the local durable freeze pin');
    this.openStartup({ approved: checked.value });
  }

  private openStartup(
    mode:
      | { resume: SavedOnlineGameRecord }
      | { approved: Extract<OnlineWorkerRequestBody, { kind: 'startCeremony' }>['agreement'] },
  ): void {
    if (!this.identity || !this.invite || !this.transport) throw new Error('Worker is not ready');
    const startup = new OnlineStartup({
      invite: this.invite,
      identity: this.identity,
      transport: this.transport,
      store: this.store,
      clock: this.clock,
      engine: createBaseEngine(),
      onGameFatal: (error) => this.fatal(error, 'game-writer-lost'),
      ...mode,
    });
    this.startup = startup;
    this.startupUnsubscribe = startup.subscribe(() => this.publishStartup());
    this.publishStartup();
  }

  private publishStartup(): void {
    if (!this.generation || !this.startup || this.closed) return;
    const snapshot = this.startup.snapshot();
    if (snapshot?.phase === 'halted') this.transport?.stopOutput();
    this.emit({
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: this.generation,
      kind: 'startup',
      snapshot,
    });
    const game = this.startup.game();
    if (!game || this.gameAnnounced) return;
    this.gameAnnounced = true;
    this.emit({
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: this.generation,
      kind: 'gameReady',
      game: { gameId: game.gameId, genesis: copyPublic(game.genesis), seat: game.seat },
    });
    this.sessionUnsubscribe = game.session.subscribe((update) => {
      this.lastUpdate = update;
      this.publishSession();
    });
  }

  private publishSession(): void {
    if (!this.generation || this.closed) return;
    const game = this.startup?.game();
    if (!game || !this.lastUpdate) return;
    const session = game.session;
    const privateState = this.visible ? session.getPrivate(game.seat) : null;
    const snapshot: OnlineWorkerSessionSnapshot = {
      committedHead: session.getCommittedHead(),
      update: this.lastUpdate,
      events: session.getEvents(),
      localHumanSeat: game.seat,
      privateState: privateState
        ? {
            seat: game.seat,
            hand: { ...privateState.hand },
            slots: { ...privateState.slots },
            ext: {},
          }
        : null,
      legal: privateState ? session.getLegalCommands(game.seat) : null,
      controllableSeats: session.controllableSeats(),
      visibilityToken: this.visibilityToken,
    };
    const encoded = canonicalEncode(snapshot);
    if (encoded.byteLength > MAX_ONLINE_WORKER_SNAPSHOT_BYTES) {
      this.fatal(new Error('Session snapshot exceeds the worker output limit'), 'online-worker-output');
      return;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Canonical decoding detaches the bounded public snapshot.
    const detached = canonicalDecode(encoded) as OnlineWorkerSessionSnapshot;
    if (this.unackedSnapshotId !== null) this.queuedSnapshot = detached;
    else this.sendSessionSnapshot(detached);
  }

  private sendSessionSnapshot(snapshot: OnlineWorkerSessionSnapshot): void {
    if (!this.generation || this.closed) return;
    const snapshotId = ++this.lastSnapshotId;
    this.unackedSnapshotId = snapshotId;
    this.emit({
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: this.generation,
      kind: 'session',
      snapshotId,
      snapshot,
    });
  }

  private requireStartup(): OnlineStartup {
    if (!this.startup) throw new Error('Online startup is not active');
    return this.startup;
  }

  private requireSession() {
    const game = this.requireStartup().game();
    if (!game || this.closed) throw new Error('Online game is not active');
    return game.session;
  }

  private requireHead(head: { seq: number; hash: string }): void {
    const current = this.requireSession().getCommittedHead();
    if (current.seq !== head.seq || current.hash !== head.hash)
      throw Object.assign(new Error('Certified head changed'), { code: 'stale-head' });
  }

  private fatal(error: Error, code: string): void {
    if (this.closed) return;
    this.stopOutput();
    if (this.generation)
      this.emit({
        protocol: ONLINE_WORKER_PROTOCOL,
        generation: this.generation,
        kind: 'fatal',
        error: { code, message: error.message },
      });
    // oxlint-disable-next-line promise/no-promise-in-callback -- Fatal transport/lease callbacks must start cleanup without blocking their caller.
    void this.close().catch(() => undefined);
  }

  private stopOutput(): void {
    this.transport?.stopOutput();
    this.startup?.game()?.session.dispose();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.stopOutput();
    this.closing = (async () => {
      await this.work;
      await Promise.allSettled(this.sessionWork);
      this.sessionUnsubscribe?.();
      this.startupUnsubscribe?.();
      try {
        await this.startup?.close();
      } finally {
        this.transport?.close();
        this.identity?.dispose();
        await this.store.close();
      }
    })();
    return this.closing;
  }
}

```

## apps/web/src/session/online-protocol-worker.ts L1–L176
```typescript
import { canonicalEncode } from '@cp2p/codec';
import {
  MAX_ONLINE_WORKER_REQUEST_BYTES,
  ONLINE_WORKER_PROTOCOL,
} from './online-worker-messages.js';
import type { OnlineWorkerRequest } from './online-worker-messages.js';
import { OnlineWorkerRuntime } from './online-worker-runtime.js';

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This entry runs only inside a dedicated worker, whose postMessage has no target origin.
const scope = globalThis as unknown as {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
};

const kinds = new Set<string>([
  'initialize',
  'attachTransport',
  'pinFreeze',
  'startCeremony',
  'retryStart',
  'validate',
  'submit',
  'setPrivateVisible',
  'exportSave',
  'retryAudit',
  'ackSession',
  'approveRecoveryAuthorization',
  'clearRecoveryApproval',
  'requestTakeover',
  'cancelPending',
  'shutdown',
]);

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Shape is inspected before any field is used.
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function seat(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 5;
}

function validBody(body: Record<string, unknown>): boolean {
  switch (body.kind) {
    case 'initialize':
      return (
        typeof body.self === 'string' &&
        /^[A-Za-z0-9_-]{43}$/.test(body.self) &&
        (body.mode === 'fresh'
          ? !!object(body.invite) && onlyKeys(body, ['kind', 'self', 'mode', 'invite'])
          : body.mode === 'resume' &&
            typeof body.gameId === 'string' &&
            /^[A-Za-z0-9_-]{22}$/.test(body.gameId) &&
            onlyKeys(body, ['kind', 'self', 'mode', 'gameId']))
      );
    case 'attachTransport':
      return (
        typeof body.self === 'string' &&
        /^[A-Za-z0-9_-]{43}$/.test(body.self) &&
        Array.isArray(body.peers) &&
        body.peers.length <= 32 &&
        body.peers.every(
          (peer: unknown) => typeof peer === 'string' && /^[A-Za-z0-9_-]{43}$/.test(peer),
        ) &&
        body.port instanceof MessagePort &&
        onlyKeys(body, ['kind', 'self', 'peers', 'port'])
      );
    case 'pinFreeze':
      return !!object(body.state) && onlyKeys(body, ['kind', 'state']);
    case 'startCeremony':
      return !!object(body.agreement) && onlyKeys(body, ['kind', 'agreement']);
    case 'validate':
    case 'submit': {
      const head = object(body.head);
      const command = object(body.command);
      return (
        seat(body.seat) &&
        !!head &&
        Number.isSafeInteger(head.seq) &&
        typeof head.seq === 'number' &&
        head.seq >= 0 &&
        typeof head.hash === 'string' &&
        /^[0-9a-f]{64}$/.test(head.hash) &&
        !!command &&
        typeof command.type === 'string' &&
        onlyKeys(body, ['kind', 'seat', 'head', 'command'])
      );
    }
    case 'setPrivateVisible':
      return (
        typeof body.visible === 'boolean' &&
        Number.isSafeInteger(body.visibilityToken) &&
        typeof body.visibilityToken === 'number' &&
        body.visibilityToken >= 0 &&
        onlyKeys(body, ['kind', 'visible', 'visibilityToken'])
      );
    case 'ackSession':
      return (
        typeof body.snapshotId === 'number' &&
        Number.isSafeInteger(body.snapshotId) &&
        body.snapshotId > 0 &&
        onlyKeys(body, ['kind', 'snapshotId'])
      );
    case 'approveRecoveryAuthorization':
      return 'change' in body && onlyKeys(body, ['kind', 'change']);
    case 'requestTakeover':
      return (
        seat(body.departedSeat) &&
        ['easy', 'medium', 'hard'].includes(String(body.botLevel)) &&
        onlyKeys(body, ['kind', 'departedSeat', 'botLevel'])
      );
    case 'cancelPending':
      return seat(body.seat) && onlyKeys(body, ['kind', 'seat']);
    case 'retryStart':
    case 'exportSave':
    case 'retryAudit':
    case 'clearRecoveryApproval':
    case 'shutdown':
      return onlyKeys(body, ['kind']);
    default:
      return false;
  }
}

function checkedRequest(value: unknown): OnlineWorkerRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Guarded record inspection; domain values are checked in runtime.
  const candidate = value as Record<string, unknown>;
  if (
    candidate.protocol !== ONLINE_WORKER_PROTOCOL ||
    typeof candidate.generation !== 'string' ||
    candidate.generation.length < 1 ||
    candidate.generation.length > 256 ||
    typeof candidate.id !== 'number' ||
    !Number.isSafeInteger(candidate.id) ||
    candidate.id <= 0 ||
    typeof candidate.body !== 'object' ||
    candidate.body === null
  )
    return null;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Guarded record inspection; the branch checks each operation before dispatch.
  const body = candidate.body as Record<string, unknown>;
  if (typeof body.kind !== 'string' || !kinds.has(body.kind)) return null;
  if (!validBody(body)) return null;
  try {
    // MessagePort is transferred separately; the remaining request is canonical data.
    const measurable =
      body.kind === 'attachTransport'
        ? {
            protocol: candidate.protocol,
            generation: candidate.generation,
            id: candidate.id,
            body: { kind: body.kind, self: body.self, peers: body.peers },
          }
        : candidate;
    if (canonicalEncode(measurable).byteLength > MAX_ONLINE_WORKER_REQUEST_BYTES) return null;
  } catch {
    return null;
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The worker applies per-operation domain checks before using any field.
  return value as OnlineWorkerRequest;
}

// oxlint-disable-next-line unicorn/require-post-message-target-origin -- DedicatedWorkerGlobalScope.postMessage has no target origin.
const runtime = new OnlineWorkerRuntime({ emit: (event) => scope.postMessage(event) });
scope.addEventListener('message', (event) => {
  const request = checkedRequest(event.data);
  if (!request) return;
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- DedicatedWorkerGlobalScope.postMessage has no target origin.
  void runtime.handle(request).then((reply) => scope.postMessage(reply));
});

```

## packages/protocol/src/session-types.ts L1–L69
```typescript
import type {
  CommandShape,
  GameEvent,
  GameState,
  LegalCommandSet,
  Pending,
  PrivateState,
  Result,
  Seat,
} from '@cp2p/engine';
import type { ProtocolClock, Unsubscribe } from './transport.js';
import type { SessionAuditState } from './session-audit-types.js';
import type { RecoveryApprovalCandidate, RecoveryApprovalPreview } from './recovery-facade.js';
import type { SessionTimer } from './session-timer-types.js';

export type { SessionTimer } from './session-timer-types.js';

export type SessionStatus =
  | { kind: 'running' }
  | { kind: 'complete' }
  | { kind: 'error'; message: string }
  | { kind: 'disposed' };

export interface SessionUpdate {
  revision: number;
  state: GameState;
  events: readonly GameEvent[];
  pending: readonly Pending[];
  timers: readonly SessionTimer[];
  status: SessionStatus;
  audit?: SessionAuditState;
  /** A validated, current-parent takeover proposal awaiting this voter's choice. */
  recoveryCandidate?: RecoveryApprovalCandidate | null;
}

export interface SubmitOptions {
  expectedRevision?: number;
}

/** Live game session contract shared by local and peer-backed clients. */
export interface GameSession<Save = unknown> {
  readonly mode: 'local' | 'p2p' | 'replay' | 'spectator';
  getState(): GameState;
  getPrivate(seat: Seat): PrivateState | null;
  getPending(): readonly Pending[];
  getTimers(): readonly SessionTimer[];
  getLegalCommands(seat: Seat): LegalCommandSet;
  validate(seat: Seat, command: CommandShape): Result<void> | Promise<Result<void>>;
  getEvents(): readonly GameEvent[];
  getAudit?(): SessionAuditState;
  retryAudit?(): boolean | Promise<boolean>;
  getRecoveryCandidate?(): RecoveryApprovalCandidate | null;
  approveRecoveryAuthorization?(change: unknown): Promise<Result<RecoveryApprovalPreview>>;
  clearRecoveryApproval?(): void;
  requestTakeover?(departedSeat: Seat, botLevel: 'easy' | 'medium' | 'hard'): Promise<Result<void>>;
  controllableSeats(): Seat[];
  submit(seat: Seat, command: CommandShape, options?: SubmitOptions): Promise<Result<void>>;
  /** Cancel preparation that has not entered consensus; accepted commands cannot be cancelled. */
  cancelPending?(seat: Seat): boolean | Promise<boolean>;
  subscribe(listener: (update: SessionUpdate) => void): Unsubscribe;
  exportSave(): Save | Promise<Save>;
  /** Conceal any cached online private view when its owning seat is hidden. */
  setPrivateVisible?(visible: boolean): void;
  setPaused?(paused: boolean): void;
  dispose(): void;
}

/** Scheduler readings are local and must never be compared across peers. */
export interface SessionScheduler extends ProtocolClock {}

```

## apps/web/src/features/dialogs/use-command-validation.ts L1–L64
```typescript
import { useEffect, useRef, useState } from 'react';
import type { CommandShape } from '@cp2p/engine';
import type { CommandFormProps } from './types.js';

export type CommandValidation = 'checking' | 'valid' | 'invalid';

/** Advisory only. The action controller repeats validation at the current head before submit. */
export function useCommandValidations(
  commands: readonly CommandShape[],
  {
    validate,
    validationKey = '',
    validationSession = null,
  }: Pick<CommandFormProps, 'validate' | 'validationKey' | 'validationSession'>,
): readonly CommandValidation[] {
  const commandsKey = JSON.stringify(commands);
  const key = `${validationKey}:${commandsKey}`;
  const validateRef = useRef(validate);
  validateRef.current = validate;
  const asynchronous =
    validationSession !== null && 'mode' in validationSession && validationSession.mode === 'p2p';
  const [settled, setSettled] = useState<{
    key: string;
    session: object | null;
    values: readonly CommandValidation[];
  } | null>(null);

  useEffect(() => {
    if (!asynchronous) return undefined;
    let current = true;
    const run = async () => {
      const values = await Promise.all(
        commands.map(async (command): Promise<CommandValidation> => {
          try {
            return (await validateRef.current(command)).ok ? 'valid' : 'invalid';
          } catch {
            return 'invalid';
          }
        }),
      );
      if (current) setSettled({ key, session: validationSession, values });
    };
    void run();
    return () => {
      current = false;
    };
    // Commands are represented by their exact serialized fields; render-created objects are not dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asynchronous, key, validationSession]);

  if (!asynchronous) {
    return commands.map((command) => {
      try {
        const result = validate(command);
        return 'then' in result ? 'checking' : result.ok ? 'valid' : 'invalid';
      } catch {
        return 'invalid';
      }
    });
  }

  if (settled?.key === key && settled.session === validationSession) return settled.values;
  return commands.map(() => 'checking');
}

```

## apps/web/src/session/online-startup.ts L70–L190
```typescript
      }
  );

/** Owns the immutable transition from device-key lobby consent to a game-key session. */
export class OnlineStartup {
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribers: Unsubscribe[] = [];
  private current: OnlineStartupSnapshot | null = null;
  private approved: LobbyFreezeAgreement | null = null;
  private material: OwnedCeremonyMaterial | null = null;
  private ceremony: OnlineCeremony | null = null;
  private activeGame: OnlineGame | null = null;
  private work: Promise<void> | null = null;
  private retry: unknown = null;
  private closed = false;
  private closing: Promise<void> | null = null;
  private activationAttempted = false;
  private revoked = false;
  private stoppingGame: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private readonly resume: SavedOnlineGameRecord | null;
  private readonly invite: OnlineInvite;

  constructor(private readonly options: OnlineStartupOptions) {
    this.invite = copyEvidence(options.invite);
    if (options.resume) {
      assertSupportedOnlineGameVersion(options.resume.result.genesis);
      if (options.resume.result.entry.payload.kind === 'genesis')
        assertSupportedOnlineGameVersion(options.resume.result.entry.payload.genesis);
    }
    this.resume = options.resume ? copyEvidence(options.resume) : null;
    if (this.resume) {
      const checked = verifyLobbyFreezeAgreement(this.resume.agreement);
      if (
        !checked.ok ||
        genesisDigest(this.resume.result.genesis) !== this.resume.genesisDigest ||
        this.resume.result.genesis.gameId !== this.resume.gameId ||
        !sameBytes(canonicalEncode(this.resume.invite), canonicalEncode(this.invite))
      )
        throw new Error('Saved online game does not match its signed agreement');
      this.approved = checked.value;
      this.current = {
        phase: 'opening',
        awaitingSeats: [],
        locallyConsented: true,
        error: null,
        gameId: this.resume.gameId,
      };
    } else if (options.approved) {
      const checked = verifyLobbyFreezeAgreement(options.approved);
      if (!checked.ok || checked.value.state.lobbyId !== this.invite.roomId)
        throw new Error('Approved online start has an invalid signed agreement');
      this.approved = checked.value;
      this.current = {
        phase: 'frozen',
        awaitingSeats: [],
        locallyConsented: true,
        error: null,
        gameId: null,
      };
    }
    if (options.lobby) this.unsubscribers.push(options.lobby.onChange(() => this.observe()));
    this.unsubscribers.push(options.transport.onPeerChange(() => this.observe()));
    this.observe();
  }

  snapshot(): OnlineStartupSnapshot | null {
    return this.current
      ? { ...this.current, awaitingSeats: [...this.current.awaitingSeats] }
      : null;
  }

  agreement(): LobbyFreezeAgreement | null {
    // The verifier returns detached data; callers never receive the retained snapshot.
    if (!this.approved) return null;
    const checked = verifyLobbyFreezeAgreement(this.approved);
    return checked.ok ? checked.value : null;
  }

  game(): OnlineGame | null {
    return this.activeGame;
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  begin(): Result<void> {
    if (!this.options.lobby)
      return failure('online-start-resume', 'A saved game cannot start a new lobby ceremony');
    if (this.closed || this.approved || this.current)
      return failure('online-start-active', 'An online start is already active');
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return this.options.lobby.start(toBase64Url(bytes));
  }

  /** Retry this exact attempt after storage or writer contention, never a new freeze. */
  async retryFailed(): Promise<Result<void>> {
    if (
      this.closed ||
      this.revoked ||
      this.activeGame ||
      this.work ||
      this.current?.phase !== 'error'
    )
      return failure('online-start-retry', 'There is no failed start ready to retry');
    if (this.ceremony && !this.ceremony.result()) {
      this.ceremony.dispose();
      await this.ceremony.flush();
      this.ceremony = null;
    }
    if (this.closed) return failure('online-start-closed', 'The room is closed');
    this.activationAttempted = false;
    this.update({
      phase: 'frozen',
      awaitingSeats: [],
      locallyConsented: this.current.locallyConsented,

```

## apps/web/src/session/online-startup.ts L300–L390
```typescript
      // Exact ACK retries also let the host retransmit a dropped all-human agreement.
      const acknowledged = lobby.ackFreeze();
      if (!acknowledged.ok) return;
      const agreement = lobby.freezeAgreement();
      if (!agreement) return;
      const checked = verifyLobbyFreezeAgreement(agreement);
      if (!checked.ok) throw new Error(checked.error.message);
      const approved = checked.value;
      if (toHex(hashValue(approved.state)) !== freezeHash)
        throw new Error('Lobby changed after the locally pinned freeze');
      await this.pin(`online-start/${freezeHash}/agreement`, {
        protocol: 'online-browser-start-v1',
        invite: this.invite,
        agreement: approved,
      });
      if (this.closed) return;
      const freezePeers = this.options.freezePeers;
      if (!freezePeers) throw new Error('Fresh online start has no roster freeze');
      freezePeers(
        approved.state.seats.flatMap((seat) => (seat.kind === 'human' ? [seat.peer] : [])),
      );
      this.approved = approved;
    }
    if (!this.ceremony) {
      const approved = this.approved;
      if (!this.resume && this.options.approved) {
        const freezeHash = toHex(hashValue(approved.state));
        await this.requirePin(
          `online-freeze/${this.options.identity.peerId}/${approved.state.ceremonyNonce}`,
          { protocol: 'online-freeze-pin-v1', freezeHash },
        );
        await this.pin(`online-start/${freezeHash}/agreement`, {
          protocol: 'online-browser-start-v1',
          invite: this.invite,
          agreement: approved,
        });
      }
      if (this.resume) {
        const freezeHash = toHex(hashValue(approved.state));
        await this.requirePin(
          `online-freeze/${this.options.identity.peerId}/${approved.state.ceremonyNonce}`,
          {
            protocol: 'online-freeze-pin-v1',
            freezeHash,
          },
        );
        await this.requirePin(`online-start/${freezeHash}/agreement`, {
          protocol: 'online-browser-start-v1',
          invite: this.invite,
          agreement: approved,
        });
        await this.requirePin(`online-game/${this.resume.genesisDigest}/start`, {
          protocol: 'online-browser-game-v1',
          invite: this.invite,
          agreement: approved,
          result: this.resume.result,
        });
      }
      const nonce = approved.state.ceremonyNonce;
      if (!nonce) throw new Error('Frozen lobby has no ceremony nonce');
      const layout = approved.state.seats.map((seat) => {
        if (seat.kind === 'open') throw new Error('Frozen lobby still contains an open seat');
        return seat.kind === 'human'
          ? { seat: seat.seat, kind: seat.kind, devicePeerId: seat.peer }
          : { seat: seat.seat, kind: seat.kind, botHost: seat.botHost };
      });
      this.material?.dispose();
      this.material = null;
      const materialInput = {
        store: this.options.store,
        identity: this.options.identity,
        ceremonyNonce: fromBase64Url(nonce),
        layout,
      };
      this.material = this.resume
        ? await loadCeremonyMaterial(materialInput)
        : await prepareCeremonyMaterial(materialInput);
      if (this.closed) return;
      const created = OnlineCeremony.create({
        agreement: approved,
        transport: this.options.transport,
        clock: this.options.clock,
        deviceSigningKey: this.options.identity.secretKey,
        ownedSeats: this.material.keys,
        store: this.options.store,
        engine: this.options.engine,
        ...(this.resume ? { restoreResult: this.resume.result } : {}),
        ...(!this.resume && approved.state.hostPeer === this.options.identity.peerId
          ? { hostCreatedAt: Math.floor(this.options.clock.now()) }
          : {}),
      });

```

## apps/web/src/session/online-game.ts L80–L210
```typescript

/** Opens only an authenticated, fully verified ceremony result under an exclusive game writer. */
export async function openOnlineGame(
  supplied: OnlineGameInput,
  runtime: OnlineGameRuntime = {},
): Promise<OnlineGame> {
  // Retain detached public evidence across asynchronous lease and storage work.
  const input = {
    ...supplied,
    entry: copyEvidence(supplied.entry),
    transcripts: copyEvidence(supplied.transcripts),
    agreement: copyEvidence(supplied.agreement),
    bindings: copyEvidence(supplied.bindings),
  };
  const material = input.material.map((item) => ({
    ...item,
    signingKey: item.signingKey.slice(),
    master: item.master.slice(),
  }));
  let journal: OnlineJournal | null = null;
  let lease: GameWriterLease | null = null;
  let transport: OnlineGameTransport | null = null;
  let session: P2PSession | null = null;
  let leaseLost = false;
  const providers: BeaconSecretProvider[] = [];
  const checkCancelled = () => {
    if (input.signal?.aborted || leaseLost)
      throw new DOMException('Online game opening was cancelled', 'AbortError');
  };
  const stopOutput = () => transport?.dispose();
  input.signal?.addEventListener('abort', stopOutput, { once: true });
  const cleanup = async () => {
    input.signal?.removeEventListener('abort', stopOutput);
    try {
      session?.dispose();
      await session?.flush();
    } finally {
      transport?.dispose();
      for (const provider of providers) provider.dispose();
      for (const item of material) {
        item.signingKey.fill(0);
        item.master.fill(0);
      }
      try {
        await journal?.close();
      } finally {
        await lease?.close();
      }
    }
  };
  try {
    checkCancelled();
    const policy: ReplayPolicy = {
      genesis: {
        verifyCommitments(genesis) {
          const decks = validateDeckCeremony(genesis, input.transcripts);
          return decks.ok ? success(undefined) : decks;
        },
      },
      entry: {},
    };
    const checked = initialProposalContext(input.entry, input.engine, policy);
    if (!checked.ok) throw new Error(checked.error.message);
    const { genesis, state, crypto } = checked.value.log;
    const startup = validateGenesisOnlineStart(genesis);
    if (!startup.ok) throw new Error(startup.error.message);
    const projection = createOnlineGameTransport({
      deviceTransport: input.deviceTransport,
      validatedGenesis: { genesis, state },
      agreement: input.agreement,
      bindings: input.bindings,
    });
    if (!projection.ok) throw new Error(projection.error.message);
    transport = projection.value;
    checkCancelled();
    const human = genesis.seats.find(
      (seat) => seat.kind === 'human' && seat.publicKey === transport?.self,
    );
    if (!human || human.kind !== 'human' || !crypto)
      throw new Error('The device does not own a verified human game seat');
    const owned = genesis.seats.filter(
      (seat) =>
        seat.seat === human.seat || (seat.kind === 'bot' && seat.botHost === human.publicKey),
    );
    if (
      material.length !== owned.length ||
      material.some(
        (item, index) => item.seat !== owned[index]?.seat || item.kind !== owned[index]?.kind,
      )
    )
      throw new Error('Stored game keys differ from the frozen device-owned seats');
    for (const item of material) {
      const owner = owned.find((seat) => seat.seat === item.seat);
      const master = startup.value.bindings.masters.find((entry) => entry.seat === item.seat);
      const identity = identityFromSecret(item.signingKey);
      try {
        if (
          identity.peerId !== item.peerId ||
          identity.peerId !== owner?.publicKey ||
          encodePoint(scalePoint(G, scalarFromBytes(item.master, { nonzero: true }))) !==
            master?.masterPub
        )
          throw new Error('Stored game secrets do not match the certified identity');
      } finally {
        identity.secretKey.fill(0);
      }
    }
    const local = material.find((item) => item.seat === human.seat);
    if (!local) throw new Error('The local game key is missing');
    lease = await (runtime.acquireLease ?? acquireGameWriterLease)(
      genesis.gameId,
      human.publicKey,
      {
        onLost(error) {
          leaseLost = true;
          transport?.dispose();
          session?.dispose();
          try {
            input.onFatal?.(error);
          } catch {
            // Reporting failure cannot restore authority or resume output.
          }
        },
      },
    );
    checkCancelled();
    if (!lease) throw new Error('This game is already active in another tab');
    const digest = genesisDigest(genesis);
    const keyBinding = {
      recordKey: `online-game/${digest}/keys`,
      bytes: canonicalEncode({

```

## apps/web/src/session/online-room.ts L160–L250
```typescript
  private constructor(
    readonly invite: OnlineInvite,
    private readonly identity: DisposableOnlineIdentity,
    private readonly lease: GameWriterLease,
    private readonly transport: WebRtcTransport,
    private readonly signaling: ServerSignalingAdapter | null,
    private readonly relay: MeshRelaySignalingAdapter,
    controller: LobbyController | null,
    resume: OnlineWorkerResumeInfo | null,
    private readonly ownedStore: IndexedDbByteStore | null,
    store: EscrowCeremonyStore,
    private readonly clock: ProtocolClock,
    private readonly manualRtcFactory: () => RTCPeerConnection,
    createWorkerClient: () => OnlineWorkerClient,
    worker: { client: OnlineWorkerClient; initialization: OnlineWorkerInitialization } | null,
  ) {
    this.lobby = controller;
    this.resumedChatState = resume?.agreement.state ?? null;
    const initialState = this.resumedChatState ?? controller?.state();
    this.chatAllowedPeers = initialState
      ? [...humanChatPeers(initialState), ...(resume ? [] : initialState.spectators)]
      : [];
    this.chat = new OnlineChat({
      transport,
      clock,
      store,
      secretKey: identity.secretKey,
      scope: resume
        ? { kind: 'game', roomId: invite.roomId, genesisDigest: resume.genesisDigest }
        : { kind: 'lobby', roomId: invite.roomId },
      allowedSenders: () => this.chatAllowedPeers,
    });
    this.snapshot = detachedSnapshot({
      invite: { ...invite },
      self: identity.peerId,
      signaling: { state: 'connecting' },
      manual: idleManual,
      peers: [],
      lobby: null,
      agreement: null,
      diagnostic: null,
      connectionError: null,
      startup: null,
      chat: this.chat.snapshot(),
      closed: false,
    });
    const common = {
      invite,
      self: identity.peerId,
      transport: createOnlineNonChatTransport(transport),
      clock,
      createClient: createWorkerClient,
      ...worker,
    };
    this.startup = new OnlineWorkerStartup(
      resume
        ? { ...common, resume }
        : {
            ...common,
            lobby: requiredLobby(controller),
            freezePeers: (peers) => {
              transport.updatePreGameRoster(peers);
              transport.freezeRoster();
              this.frozenRoster = true;
            },
          },
    );
    this.unsubscribers.push(
      this.startup.subscribe(() => this.refresh()),
      this.chat.subscribe(() => this.refresh()),
      transport.onPeerChange((peer, online) => {
        if (
          online &&
          this.snapshot.manual.peer === peer &&
          this.snapshot.manual.phase === 'answering'
        )
          this.update({ manual: { ...this.snapshot.manual, phase: 'connected', code: null } });
        this.refresh();
      }),
      transport.onDiagnostic((_peer, reason) => this.update({ connectionError: reason })),
    );
    if (controller) {
      this.unsubscribers.push(
        controller.onChange(() => this.refresh()),
        controller.onDiagnostic(() => this.refresh()),
        ...(signaling ? [signaling.onRoomPeers((peers) => this.discover(peers))] : []),
      );
    }
    void this.chat.start().catch(() => this.refresh());
    this.refresh();
  }

```

## apps/web/src/session/online-room.ts L252–L320
```typescript
  static async open(request: OpenOnlineRoom, runtime: OnlineRoomRuntime = {}): Promise<OnlineRoom> {
    const ownedStore = runtime.store ? null : new IndexedDbByteStore();
    const store = runtime.store ?? ownedStore;
    if (!store) throw new Error('Online storage is unavailable');
    let identity: DisposableOnlineIdentity | null = null;
    let lease: GameWriterLease | null = null;
    let signaling: ServerSignalingAdapter | null = null;
    let relay: MeshRelaySignalingAdapter | null = null;
    let transport: WebRtcTransport | null = null;
    let controller: LobbyController | null = null;
    let room: OnlineRoom | null = null;
    let worker: { client: OnlineWorkerClient; initialization: OnlineWorkerInitialization } | null =
      null;
    let workerClient: OnlineWorkerClient | null = null;
    const createWorkerClient = () =>
      new OnlineWorkerClient(runtime.workerFactory ? { worker: runtime.workerFactory() } : {});
    try {
      identity =
        request.kind === 'resume'
          ? await loadOnlineIdentity(store)
          : await loadOrCreateOnlineIdentity(store);
      if (request.kind === 'resume') {
        workerClient = createWorkerClient();
        const initialized = await workerClient.request({
          kind: 'initialize',
          mode: 'resume',
          self: identity.peerId,
          gameId: request.gameId,
        });
        if (!initialized.ok) {
          if (
            initialized.error.code === 'unsupported-version' &&
            'savedVersion' in initialized.error &&
            typeof initialized.error.savedVersion === 'number'
          )
            throw new UnsupportedOnlineGameVersionError(initialized.error.savedVersion);
          throw new Error(initialized.error.message);
        }
        if (initialized.value.self !== identity.peerId)
          throw new Error('Saved online game device identity differs');
        worker = { client: workerClient, initialization: initialized.value };
      }
      const resume = worker?.initialization.resume ?? null;
      let inviteSource: OnlineInvite;
      if (request.kind === 'resume') {
        if (!resume || !worker) throw new Error('Saved online game is missing');
        inviteSource = worker.initialization.invite;
      } else if (request.kind === 'join') inviteSource = request.invite;
      else if (request.kind === 'manual-join') {
        const hint = await readManualLobbyOffer(request.offerCode);
        if (hint.to) throw new Error('A reconnect code requires the saved room on this device');
        inviteSource = { roomId: hint.roomId, hostPeer: hint.from, serverUrl: '' };
      } else
        inviteSource = {
          roomId: createRoomId(),
          hostPeer: identity.peerId,
          serverUrl: request.serverUrl,
        };
      const invite = validateOnlineInvite(inviteSource);
      const frozenPeers = resume?.agreement.state.seats.flatMap((seat) =>
        seat.kind === 'human' ? [seat.peer] : [],
      );
      if (resume && !frozenPeers?.includes(identity.peerId))
        throw new Error('This device does not own a human seat in the saved game');
      const scope = `lobby:${invite.roomId}`;
      const leaseId = `lobby-${toHex(hashValue({ server: invite.serverUrl, room: invite.roomId }))}`;
      lease = await (runtime.acquireLease ?? acquireGameWriterLease)(leaseId, identity.peerId);
      if (!lease) throw new Error('This lobby is already open in another tab');
      const clock = runtime.clock ?? createBrowserClock();

```

## apps/web/src/session/online-room.ts L360–L430
```typescript
                ...common,
                name: request.name,
                hostName: request.hostName,
                config: request.config,
                takeover: { mode: 'vote', afterSeconds: 'never' },
              })
            : LobbyController.join({ ...common, hostPeer: invite.hostPeer });
        if (!created.ok) throw new Error(created.error.message);
        controller = created.value;
      }
      room = new OnlineRoom(
        invite,
        identity,
        lease,
        transport,
        signaling,
        relay,
        controller,
        resume,
        ownedStore,
        store,
        clock,
        runtime.manualRtcFactory ??
          (() =>
            new RTCPeerConnection({
              iceServers: [...(runtime.iceServers ?? [])],
              iceTransportPolicy: runtime.iceTransportPolicy ?? 'all',
            })),
        createWorkerClient,
        worker,
      );
      room.update({ signaling: status });
      if (request.kind === 'manual-join') {
        const answered = await room.answerManualOffer(request.offerCode);
        if (!answered.ok) throw new Error(answered.error.message);
      } else if (signaling || request.kind === 'host') transport.start();
      return room;
    } catch (error) {
      if (room) {
        await room.close();
        throw error;
      }
      try {
        await workerClient?.shutdown();
      } finally {
        controller?.dispose();
        try {
          if (transport) transport.dispose();
          else if (relay) relay.close();
          else signaling?.close();
        } finally {
          identity?.dispose();
          try {
            await lease?.close();
          } finally {
            await ownedStore?.close();
          }
        }
      }
      throw error;
    }
  }

  getSnapshot = (): OnlineRoomSnapshot => this.snapshot;

  startGame = () => this.startup.begin();

  retryStart = () => this.startup.retryFailed();

  getGame = (): OnlineGame<GameSession> | null => this.startup.game();


```

## apps/web/src/session/online-room.ts L740–L805
```typescript
  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Publish the promise before notifying views, which may call close again.
    this.closing = Promise.resolve().then(() => this.releaseResources());
    void this.startup.close().catch(() => undefined);
    this.cancelManualInvitation();
    this.chat.dispose();
    this.update({ closed: true });
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.listeners.clear();
    this.serverCandidates.clear();
    this.manualCandidates.clear();
    this.manualRetryPeer = null;
    return this.closing;
  }

  private async releaseResources(): Promise<void> {
    try {
      try {
        await this.startup.close();
        await this.chat.flush();
      } finally {
        try {
          this.lobby?.dispose();
        } finally {
          try {
            this.transport.dispose();
          } finally {
            this.identity.dispose();
          }
        }
      }
    } finally {
      try {
        await this.lease.close();
      } finally {
        await this.ownedStore?.close();
      }
    }
  }

  private discover(peers: readonly PeerId[] | null): void {
    const state = this.lobby?.state();
    if (
      this.snapshot.closed ||
      this.closing ||
      this.startup.agreement() ||
      (state && state.status !== 'open')
    )
      return;
    const current = new Set(peers ?? []);
    for (const peer of this.serverCandidates.keys())
      if (!current.has(peer)) this.serverCandidates.delete(peer);
    for (const peer of current) this.serverCandidates.set(peer, true);
    this.refresh();
  }

  private refresh(): void {
    if (this.snapshot.closed || this.closing) return;
    const agreement = this.startup.agreement() ?? this.lobby?.freezeAgreement() ?? null;
    const state = this.lobby?.state();
    const game = this.startup.game();
    const gameChat = this.chat.scopeKind() === 'game' || game !== null;
    const chatState = gameChat ? (agreement?.state ?? this.resumedChatState) : state;
    this.chatAllowedPeers = chatState
      ? [...humanChatPeers(chatState), ...(gameChat || agreement ? [] : chatState.spectators)]

```

## apps/web/src/store/session-store.ts L100–L160
```typescript
  if (privacyPaused === paused) return;
  privacyPaused = paused;
  liveSession?.setPaused?.(privacyPaused || externalPaused);
}

/** Restore the store's pause reasons after a temporary navigation save pause. */
export function restoreSessionPause(): void {
  liveSession?.setPaused?.(privacyPaused || externalPaused);
}

/** An external writer stops bots and timers until this session is discarded. */
export function pauseForExternalConflict(): void {
  externalPaused = true;
  liveSession?.setPrivateVisible?.(false);
  liveSession?.setPaused?.(true);
  useSessionStore.setState({
    conflicted: true,
    revealedSeat: null,
    privateState: null,
    legal: null,
    ...emptyActionView,
  });
}

export const useSessionStore = create<SessionStore>((set) => ({
  ...emptyView,
  autoReveal: (seat) => {
    if (!manuallyConcealed) useSessionStore.getState().reveal(seat);
  },
  reveal: (seat) => {
    const session = liveSession;
    if (externalPaused || !session || !session.controllableSeats().includes(seat)) return;
    const humans = session.controllableSeats();
    const required = requiredHumanSeat(session.getState(), session.getPending(), humans);
    if ((optionalSeat ?? required) !== seat && !(required === null && humans.length === 1)) return;
    manuallyConcealed = false;
    session.setPrivateVisible?.(true);
    const privateState = session.getPrivate(seat);
    // Worker-backed sessions publish a fresh display view asynchronously.
    if (!privateState) return;
    set({
      revealedSeat: seat,
      privateState,
      legal: session.getLegalCommands(seat),
      ...emptyActionView,
    });
    setPrivacyPaused(false);
  },
  conceal: () => {
    manuallyConcealed = true;
    liveSession?.setPrivateVisible?.(false);
    const onlyHuman = liveSession?.controllableSeats().length === 1;
    set((current) => ({
      waitingSeat: onlyHuman ? current.revealedSeat : current.waitingSeat,
      revealedSeat: null,
      privateState: null,
      legal: null,
      ...emptyActionView,
    }));
    setPrivacyPaused(true);
  },

```

## apps/web/src/store/session-store.ts L215–L325
```typescript
/** The UI owns the subscription; the store never persists or copies other seats' secrets. */
export function attachSession(gameId: string, session: GameSession): () => void {
  if (liveSession && liveSession !== session)
    throw new Error('Another game session is still attached');
  liveSession = session;
  privacyPaused = false;
  externalPaused = false;
  manuallyConcealed = false;
  lastRequiredSeat = null;
  lastActionContext = '';
  optionalSeat = null;
  useSessionStore.setState({ ...emptyView, gameId });
  const unsubscribe = session.subscribe((update) => {
    const current = useSessionStore.getState();
    const humans = session.controllableSeats();
    const requiredSeat = requiredHumanSeat(update.state, update.pending, humans);
    const mandatoryDiscard = update.pending.some(
      (item) => item.kind === 'player' && item.allowed.includes('DISCARD'),
    );
    const optionalChoices =
      mandatoryDiscard || humans.length <= 1
        ? []
        : update.pending.flatMap((item) =>
            item.kind === 'player' &&
            item.seat !== update.state.turn.activeSeat &&
            humans.includes(item.seat) &&
            item.allowed.some(
              (type) =>
                type === 'PROPOSE_TRADE' || type === 'CANCEL_TRADE' || type === 'RESPOND_TRADE',
            )
              ? [item.seat]
              : [],
          );
    if (optionalSeat !== null && !optionalChoices.includes(optionalSeat)) optionalSeat = null;
    const desiredSeat = optionalSeat ?? requiredSeat;
    const activePending = update.pending.find(
      (item) => item.kind === 'player' && item.seat === requiredSeat,
    );
    const actionContext = `${desiredSeat ?? 'none'}:${update.state.turn.phase
      .map((phase) => phase.id)
      .join('/')}:${activePending?.kind === 'player' ? activePending.allowed.join(',') : ''}`;
    const resetAction = actionContext !== lastActionContext;
    lastActionContext = actionContext;
    if (desiredSeat !== lastRequiredSeat) manuallyConcealed = false;
    lastRequiredSeat = desiredSeat;
    const keepPrivate = current.revealedSeat !== null && current.revealedSeat === desiredSeat;
    const visibleSeat = externalPaused
      ? null
      : desiredSeat !== null
        ? keepPrivate || (humans.length === 1 && !manuallyConcealed)
          ? desiredSeat
          : null
        : humans.length === 1 && !manuallyConcealed
          ? (humans[0] ?? null)
          : null;
    const coverSeat =
      desiredSeat ?? (humans.length === 1 && manuallyConcealed ? (humans[0] ?? null) : null);
    session.setPrivateVisible?.(visibleSeat !== null);
    const finalHiddenVictoryPoints: Partial<Record<Seat, number | null>> = {};
    if (update.state.result) {
      const auditedScores =
        update.audit?.kind === 'complete' && update.audit.report.ok && update.audit.report.complete
          ? update.audit.report.finalHiddenVictoryPoints
          : null;
      for (const seat of update.state.config.seats) {
        const privateState = session.getPrivate(seat);
        const publicSeat = update.state.seats.find((item) => item.seat === seat);
        finalHiddenVictoryPoints[seat] =
          publicSeat && privateState
            ? publicSeat.cardSlots.filter(
                (slot) => !slot.revealed && privateState.slots[slot.slotId] === 'victoryPoint',
              ).length
            : publicSeat && typeof auditedScores?.[seat] === 'number'
              ? auditedScores[seat]
              : null;
      }
    }
    useSessionStore.setState({
      gameId,
      state: update.state,
      events: session.getEvents(),
      pending: update.pending,
      timers: update.timers,
      status: update.status,
      audit: update.audit ?? null,
      revision: update.revision,
      waitingSeat: coverSeat,
      revealedSeat: visibleSeat,
      privateState: visibleSeat === null ? null : session.getPrivate(visibleSeat),
      legal: visibleSeat === null ? null : session.getLegalCommands(visibleSeat),
      optionalChoices,
      optionalViewingSeat: optionalSeat,
      conflicted: externalPaused,
      finalHiddenVictoryPoints,
      ...(resetAction || visibleSeat === null
        ? emptyActionView
        : update.revision !== current.revision
          ? { previewPlacement: null }
          : {}),
    });
    setPrivacyPaused(coverSeat !== null && visibleSeat === null);
  });
  session.setPaused?.(privacyPaused || externalPaused);
  return () => {
    unsubscribe();
    session.setPrivateVisible?.(false);
    if (liveSession === session) liveSession = null;
    privacyPaused = false;
    externalPaused = false;
    manuallyConcealed = false;
    lastRequiredSeat = null;

```

## apps/web/src/session/online-worker-startup.test.ts L150–L340
```typescript
  network.clock.advanceBy(0);
  const worker = new FakeWorker();
  const client = new OnlineWorkerClient({ worker });
  const frozen = vi.fn<(peers: readonly string[]) => void>();
  const startup = new OnlineWorkerStartup({
    invite,
    self: hostPeer,
    transport: network.transport(hostPeer),
    clock: network.clock,
    lobby: host,
    freezePeers: frozen,
    client,
  });
  await tick();
  return {
    startup,
    worker,
    client,
    frozen,
    host,
    guest,
    network,
    peers,
    invite,
    async close() {
      await startup.close();
      host.dispose();
      guest.dispose();
      network.dispose();
    },
  };
}

const fixtures: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((item) => item.close()));
});

test('pin completes before local ACK, and ceremony waits for every signed freeze ACK', async () => {
  const room = await fixture();
  fixtures.push(room);
  room.worker.pausePin = true;
  const ack = vi.spyOn(room.host, 'ackFreeze');
  value(room.startup.begin());
  room.network.clock.advanceBy(0);
  await tick();
  expect(room.worker.requestsOf('pinFreeze')).toHaveLength(1);
  expect(ack).not.toHaveBeenCalled();
  expect(room.host.freezeAgreement()).toBeNull();
  expect(room.worker.requestsOf('startCeremony')).toHaveLength(0);
  expect(room.frozen).not.toHaveBeenCalled();
  const pin = room.worker.requestsOf('pinFreeze')[0];
  if (!pin) throw new Error('Missing pin request');
  room.worker.reply(pin);
  await tick();
  expect(ack).toHaveBeenCalledTimes(1);
  expect(room.host.freezeAgreement()).toBeNull();
  expect(room.worker.requestsOf('startCeremony')).toHaveLength(0);
  room.worker.pausePin = false;
  value(room.guest.ackFreeze());
  room.network.clock.advanceBy(0);
  expect(room.host.freezeAgreement()).not.toBeNull();
  await tick();
  room.network.clock.advanceBy(1_000);
  await tick();
  expect(room.frozen).toHaveBeenCalledExactlyOnceWith(room.peers);
  expect(room.worker.requestsOf('startCeremony')).toHaveLength(1);
});

test('changed lobby state while a pin is pending cannot ACK the old freeze', async () => {
  const room = await fixture();
  fixtures.push(room);
  room.worker.pausePin = true;
  const ack = vi.spyOn(room.host, 'ackFreeze');
  value(room.startup.begin());
  room.network.clock.advanceBy(0);
  await tick();
  const pinned = room.worker.requestsOf('pinFreeze')[0];
  if (!pinned) throw new Error('Missing pin request');
  const prior = room.host.state();
  if (!prior) throw new Error('Missing signed lobby state');
  // This substitutes a later observed public revision while keeping the production ACK path real.
  vi.spyOn(room.host, 'state').mockReturnValue({ ...prior, version: prior.version + 1 });
  room.worker.reply(pinned);
  await tick();
  expect(ack).not.toHaveBeenCalled();
  expect(room.host.freezeAgreement()).toBeNull();
  expect(room.frozen).not.toHaveBeenCalled();
  expect(room.worker.requestsOf('startCeremony')).toHaveLength(0);
});

test('an attach failure halts the bridge without downgrading halted to a retryable error', async () => {
  const room = await fixture();
  fixtures.push(room);
  room.worker.rejectNext = 'attachTransport';
  value(room.startup.begin());
  room.network.clock.advanceBy(0);
  await tick();
  expect(room.worker.requestsOf('attachTransport')).toHaveLength(1);
  expect(room.worker.terminated).toBe(true);
  expect(room.startup.snapshot()?.phase).toBe('halted');
  expect(room.worker.requestsOf('pinFreeze')).toHaveLength(0);
  expect(room.worker.requestsOf('startCeremony')).toHaveLength(0);
  await expect(room.startup.retryFailed()).resolves.toMatchObject({ ok: false });
});

test('a durable pin failure can retry without an ACK or fresh worker', async () => {
  const room = await fixture();
  fixtures.push(room);
  room.worker.rejectNext = 'pinFreeze';
  value(room.startup.begin());
  room.network.clock.advanceBy(0);
  await tick();
  expect(room.startup.snapshot()?.phase).toBe('error');
  expect(room.host.freezeAgreement()).toBeNull();
  expect(room.worker.terminated).toBe(false);
  expect(room.worker.requestsOf('startCeremony')).toHaveLength(0);
  expect(await room.startup.retryFailed()).toMatchObject({ ok: true });
  await tick();
  expect(room.worker.requestsOf('pinFreeze')).toHaveLength(2);
  expect(room.host.freezeAgreement()).toBeNull();
});

test('close stops worker bridge output before awaiting worker shutdown', async () => {
  const room = await fixture();
  fixtures.push(room);
  value(room.startup.begin());
  room.network.clock.advanceBy(0);
  await tick();
  const port = room.worker.ports[0];
  if (!port) throw new Error('Worker transport was not attached');
  const outbound: Uint8Array[] = [];
  const off = room.network
    .transport(room.peers[1] ?? '')
    .onMessage((_from, bytes) => outbound.push(bytes));
  // Hold the shutdown response, then attempt a valid worker frame through the still-open port.
  room.worker.pausePin = false;
  const close = room.startup.close();
  port.postMessage({
    type: 'frame',
    generation: room.client.generation,
    id: 1,
    peer: room.peers[1],
    bytes: new Uint8Array([9]).buffer,
  });
  await tick();
  expect(outbound).toEqual([]);
  off();
  await close;
});

test('a worker crash halts startup and rejects later output', async () => {
  const room = await fixture();
  fixtures.push(room);
  const engine = createBaseEngine();
  const state = engine.createGame(
    {
      modules: [{ id: 'base', version: BASE_VERSION }],
      seats: [0, 1],
      options: { base: {} },
    },
    new Uint8Array(32).fill(3),
  );
  const eventBase = { protocol: 'cp2p-online-worker-v1', generation: room.client.generation };
  room.worker.emit({
    ...eventBase,
    kind: 'gameReady',
    game: { gameId: 'ready-game', genesis: {}, seat: 0 },
  });
  room.worker.emit({
    ...eventBase,
    kind: 'session',
    snapshotId: 1,
    snapshot: {
      committedHead: { seq: 0, hash: 'A'.repeat(64) },
      update: {
        revision: 0,
        state,
        pending: [],
        timers: [],
        events: [],
        status: { kind: 'running' },
      },
      events: [],
      localHumanSeat: 0,
      privateState: engine.createPrivateState(0),
      legal: { commands: [], templates: [] },
      controllableSeats: [0],
      visibilityToken: 0,
    },
  });

```

## apps/web/src/session/online-worker-transport.test.ts L120–L215
```typescript
  const worker = createWorkerDeviceTransport({
    self: 'device-a',
    peers: ['device-b', 'device-c'],
    port: workerPort,
    generation,
    onFailure: (error) => failures.push(error),
  });
  return { mainPort, workerPort, device, bridge, worker, failures };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('online worker device transport', () => {
  test('copies caller bytes, routes authenticated frames both ways, and ignores stale generations', async () => {
    const fixture = bridgeFixture();
    const received: Uint8Array[] = [];
    fixture.worker.onMessage((_peer, bytes) => received.push(bytes));
    const inbound = new Uint8Array([1, 2, 3]);
    fixture.device.emit('device-b', inbound);
    fixture.device.emit('untrusted-peer', new Uint8Array([0]));
    inbound.fill(9);
    await flush();
    expect(received).toHaveLength(1);
    expect([...(received[0] ?? [])]).toEqual([1, 2, 3]);

    const outbound = new Uint8Array([4, 5, 6]);
    fixture.worker.send('device-c', outbound);
    outbound.fill(0);
    await flush();
    expect(fixture.device.sent.map(({ peer, bytes }) => [peer, [...bytes]])).toEqual([
      ['device-c', [4, 5, 6]],
    ]);

    fixture.workerPort.inject({
      type: 'frame',
      generation: 'old-generation',
      id: 20,
      peer: 'device-b',
      bytes: new Uint8Array([8]).buffer,
    });
    await flush();
    expect(received).toHaveLength(1);
    fixture.worker.close();
    fixture.bridge.close();
  });

  test('enforces per-peer capacity without letting one peer block another', async () => {
    const fixture = bridgeFixture();
    fixture.workerPort.paused = true;
    const frame = new Uint8Array([1]);
    for (let i = 0; i < 9; i++) fixture.device.emit('device-b', frame);
    fixture.device.emit('device-c', frame);

    expect(fixture.device.disconnected).toEqual(['device-b']);
    expect(fixture.workerPort.queued).toHaveLength(10);
    fixture.workerPort.flush();
    await flush();
    expect(fixture.worker.peers()).toEqual(['device-c']);
    fixture.worker.close();
    fixture.bridge.close();
  });

  test('caps aggregate in-flight bytes across peers', () => {
    const fixture = bridgeFixture();
    fixture.workerPort.paused = true;
    for (const peer of ['device-b', 'device-c', 'device-d', 'device-e', 'device-f'])
      fixture.device.setPeer(peer, true);
    fixture.device.setPeer('device-g', true);
    const frame = new Uint8Array(ONLINE_WORKER_MAX_FRAME_BYTES);
    for (const peer of ['device-b', 'device-c', 'device-d', 'device-e'])
      for (let i = 0; i < 2; i++) fixture.device.emit(peer, frame);
    fixture.device.emit('device-f', frame);

    const frames = fixture.mainPort.posted.filter(
      (message) =>
        message !== null && typeof message === 'object' && Reflect.get(message, 'type') === 'frame',
    );
    expect(frames).toHaveLength(8);
    expect(frames.length * frame.byteLength).toBe(ONLINE_WORKER_MAX_IN_FLIGHT_BYTES);
    expect(fixture.device.disconnected).toContain('device-f');
    fixture.bridge.close();
    fixture.worker.close();
  });

  test('oversized packets disconnect their peer and malformed messages fail closed', async () => {
    const oversized = bridgeFixture();
    oversized.device.emit('device-b', new Uint8Array(ONLINE_WORKER_MAX_FRAME_BYTES + 1));
    expect(oversized.device.disconnected).toEqual(['device-b']);
    oversized.worker.close();
    oversized.bridge.close();

    const malformed = bridgeFixture();
    malformed.mainPort.inject({ type: 'frame', generation: 'room-generation-1', id: 1 });
    await flush();

```

## apps/web/src/session/online-worker-client.test.ts L55–L165
```typescript
  }
}

function createClient(worker: FakeWorker, generation = 'worker-generation') {
  return new OnlineWorkerClient({ worker, generation });
}

function expectOk(result: unknown): void {
  expect(result).toMatchObject({ ok: true });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('OnlineWorkerClient', () => {
  test('bounds pending ordinary request count and total canonical bytes', async () => {
    const worker = new FakeWorker();
    const client = createClient(worker);
    const requests = Array.from({ length: 12 }, () => client.request({ kind: 'retryStart' }));
    const control = client.request({ kind: 'ackSession', snapshotId: 9 });
    await expect(client.request({ kind: 'retryStart' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'online-worker-busy' },
    });
    expect(worker.requests).toHaveLength(13);
    worker.requests.forEach((request) => worker.reply(request, { ok: true, value: undefined }));
    for (const result of await Promise.all(requests)) expectOk(result);
    expectOk(await control);
    client.fail(new Error('test complete'));
  });

  test('enforces aggregate request bytes and single-request size before posting', async () => {
    const worker = new FakeWorker();
    const client = createClient(worker);
    const payload = 'x'.repeat(600_000);
    const first = client.request({ kind: 'approveRecoveryAuthorization', change: { payload } });
    const second = await client.request({
      kind: 'approveRecoveryAuthorization',
      change: { payload },
    });
    expect(second).toMatchObject({ ok: false, error: { code: 'online-worker-busy' } });
    expect(worker.requests).toHaveLength(1);
    const firstRequest = worker.requests[0];
    if (!firstRequest) throw new Error('Expected the bounded request');
    worker.reply(firstRequest, { ok: true, value: { amendment: null } });
    expect(await first).toMatchObject({ ok: true });

    const tooLarge = await client.request({
      kind: 'approveRecoveryAuthorization',
      change: { payload: 'y'.repeat(1_100_000) },
    });
    expect(tooLarge).toMatchObject({ ok: false, error: { code: 'online-worker-busy' } });
    expect(worker.requests).toHaveLength(1);
    client.fail(new Error('test complete'));
  });

  test('ignores another generation and fails closed on a reply with the wrong kind', async () => {
    const worker = new FakeWorker();
    const client = createClient(worker);
    const request = client.request({ kind: 'retryStart' });
    const pending = worker.requests[0];
    if (!pending) throw new Error('Expected a posted request');
    worker.emit({
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: 'old-generation',
      id: pending.id,
      kind: 'retryStart',
      result: { ok: true, value: undefined },
    });
    expect(worker.terminated).toBe(false);
    worker.reply(pending, { ok: true, value: undefined }, 'shutdown');
    await expect(request).resolves.toMatchObject({
      ok: false,
      error: { code: 'online-worker-closed' },
    });
    expect(worker.terminated).toBe(true);
  });

  test('acknowledges each session snapshot by its snapshotId', async () => {
    const worker = new FakeWorker();
    const client = createClient(worker);
    const applied: string[] = [];
    client.subscribe((event) => applied.push(event.kind));
    worker.emit({
      protocol: ONLINE_WORKER_PROTOCOL,
      generation: 'worker-generation',
      kind: 'session',
      snapshotId: 17,
      snapshot: {
        committedHead: { seq: 0, hash: 'head-0' },
        update: { revision: 0, state: {}, status: {}, pending: [], timers: [], events: [] },
        events: [],
        controllableSeats: [0],
        visibilityToken: 0,
        localHumanSeat: 0,
      },
    });
    const acknowledgement = worker.requests[0];
    if (!acknowledgement || acknowledgement.body.kind !== 'ackSession')
      throw new Error('Expected a session snapshot acknowledgement');
    expect(acknowledgement.body.snapshotId).toBe(17);
    expect(applied).toEqual(['session']);
    worker.reply(acknowledgement, { ok: true, value: undefined });
    client.fail(new Error('test complete'));
  });

  test('notifies failure listeners before termination and fails every pending request', async () => {
    const worker = new FakeWorker();
    const client = createClient(worker);
    const observed: boolean[] = [];

```

## apps/web/src/session/online-worker-session.test.ts L75–L175
```typescript
      pending: [{ kind: 'player', seat: 0, allowed: ['endTurn'] }],
      timers: [
        {
          key: 'turn',
          seat: 0,
          phase: 'main',
          remainingMs: 5_000,
          expiresAt: 5_000,
          paused: false,
        },
      ],
      status: { kind: 'running' },
    },
    events: [],
    localHumanSeat: 0,
    privateState:
      options.privateState === false ? null : { seat: 0, hand: { wood: 2 }, slots: {}, ext: {} },
    legal: { commands: [{ type: 'endTurn' }], templates: [] },
    controllableSeats: options.controllableSeats ?? [0],
    visibilityToken,
  };
}

function setup(initial = snapshot()) {
  const worker = new SessionWorker();
  const client = new OnlineWorkerClient({ worker, generation: 'session-generation' });
  const session = new OnlineWorkerSession(client, initial, () => undefined);
  return { worker, client, session };
}

function latestRequest(worker: SessionWorker, kind: OnlineWorkerRequest['body']['kind']) {
  const request = worker.requests.findLast((item) => item.body.kind === kind);
  if (!request) throw new Error(`Expected ${kind} request`);
  return request;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OnlineWorkerSession', () => {
  test('exposes private state, legal commands, and control only for the local human', async () => {
    const { session, client } = setup();
    expect(session.getPrivate(0)).toMatchObject({ seat: 0, hand: { wood: 2 } });
    expect(session.getPrivate(1)).toBeNull();
    expect(session.getLegalCommands(0).commands).toEqual([{ type: 'endTurn' }]);
    expect(session.getLegalCommands(1)).toEqual({ commands: [], templates: [] });
    expect(session.controllableSeats()).toEqual([0]);
    await expect(session.validate(1, { type: 'endTurn' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-inactive' },
    });
    await expect(session.submit(1, { type: 'endTurn' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'session-inactive' },
    });
    client.fail(new Error('test complete'));
  });

  test('rejects snapshots that grant another seat local control', () => {
    const { client } = setup();
    client.fail(new Error('test complete'));
    expect(
      () =>
        new OnlineWorkerSession(
          client,
          snapshot(0, 0, { controllableSeats: [0, 1] }),
          () => undefined,
        ),
    ).toThrow('another seat');
  });

  test('suppresses validation replies after the committed head advances', async () => {
    const { worker, client, session } = setup(snapshot(3));
    const validating = session.validate(0, { type: 'endTurn' });
    const request = latestRequest(worker, 'validate');
    expect(request.body.kind === 'validate' ? request.body.head : null).toEqual({
      seq: 3,
      hash: 'head-3',
    });
    session.accept(snapshot(4));
    worker.reply(request, { ok: true, value: undefined });

    await expect(validating).resolves.toMatchObject({
      ok: false,
      error: { code: 'stale-revision' },
    });
    client.fail(new Error('test complete'));
  });

  test('checks expectedRevision before making a submit RPC', async () => {
    const { worker, client, session } = setup(snapshot(5));
    await expect(
      session.submit(0, { type: 'endTurn' }, { expectedRevision: 4 }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: 'stale-revision' },
    });
    expect(worker.requests).toHaveLength(0);
    client.fail(new Error('test complete'));
  });

```

## apps/web/src/session/online-worker-runtime.test.ts L80–L175
```typescript
    seats: [
      { seat: 0, kind: 'human', peer: identity.peerId, name: 'A', colour: 'blue', ready: true },
      { seat: 1, kind: 'open', colour: 'orange', ready: false },
    ],
    spectators: [],
    config: {
      modules: [{ id: 'base', version: BASE_VERSION }],
      seats: [0, 1],
      options: { base: { mapLayout: 'random', vpTarget: 3 } },
    },
    seedMode: { kind: 'joint' },
    takeover: { mode: 'vote', afterSeconds: 120 },
    status: 'starting',
    ceremonyNonce: 'a'.repeat(43),
  };
  try {
    expect(
      (
        await worker.handle(
          request(1, { kind: 'initialize', mode: 'fresh', self: identity.peerId, invite }),
        )
      ).result.ok,
    ).toBe(true);
    const first = await worker.handle(request(2, { kind: 'pinFreeze', state }));
    expect(first.result).toEqual({ ok: true, value: { freezeHash: toHex(hashValue(state)) } });
    const persisted = await store.load(`online-freeze/${identity.peerId}/${state.ceremonyNonce}`);
    expect(persisted).not.toBeNull();
    expect(
      (await worker.handle(request(3, { kind: 'pinFreeze', state: { ...state, name: 'Changed' } })))
        .result,
    ).toMatchObject({ ok: false });
    expect(await store.load(`online-freeze/${identity.peerId}/${state.ceremonyNonce}`)).toEqual(
      persisted,
    );
  } finally {
    await worker.close();
    identity.dispose();
  }
});

test('a pending submit cannot block cancel or hiding; snapshots coalesce and expose no bot private state', async () => {
  const store = Object.assign(new MemoryEscrowLifecycleStore(), { close: async () => undefined });
  const identity = await loadOrCreateOnlineIdentity(store, (length) =>
    new Uint8Array(length).fill(5),
  );
  const invite = { roomId: 'workgameaa', hostPeer: identity.peerId, serverUrl: '' };
  const events: OnlineWorkerEvent[] = [];
  const worker = new OnlineWorkerRuntime({ store, emit: (event) => events.push(event) });
  let finishSubmit!: () => void;
  const submitted = new Promise<void>((resolve) => {
    finishSubmit = resolve;
  });
  const head = { seq: 0, hash: 'a'.repeat(64) };
  const listeners: ((value: unknown) => void)[] = [];
  let botPrivateReads = 0;
  const session = {
    getCommittedHead: () => head,
    subscribe(callback: (value: unknown) => void) {
      listeners.push(callback);
      callback(update(0));
      return () => {
        listeners.length = 0;
      };
    },
    getPrivate(seat: number) {
      if (seat !== 0) {
        botPrivateReads += 1;
        throw new Error('Bot private state escaped');
      }
      return { seat: 0, hand: { brick: 1 }, slots: {}, ext: { hidden: 'never-send' } };
    },
    getLegalCommands: () => ({ commands: [], templates: [] }),
    getEvents: () => [],
    controllableSeats: () => [0, 2],
    async submit() {
      await submitted;
      return success(undefined);
    },
    cancelPending: () => true,
    dispose: () => undefined,
  };
  try {
    expect(
      (
        await worker.handle(
          request(1, { kind: 'initialize', mode: 'fresh', self: identity.peerId, invite }),
        )
      ).result.ok,
    ).toBe(true);
    Reflect.set(worker, 'startup', {
      snapshot: () => ({
        phase: 'playing',
        awaitingSeats: [],
        locallyConsented: true,
        error: null,
        gameId: 'test',

```

## apps/web/src/features/dialogs/use-command-validation.test.tsx L1–L47
```typescript
// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react';
import { success } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import { expect, test, vi } from 'vitest';
import { useCommandValidations } from './use-command-validation.js';

test('online advisory validation remains checking and ignores a stale head response', async () => {
  const resolutions: ((result: Result<void>) => void)[] = [];
  const validate = vi.fn<() => Promise<Result<void>>>(
    () =>
      new Promise<Result<void>>((resolve) => {
        resolutions.push(resolve);
      }),
  );
  const session = { mode: 'p2p' };
  const view = renderHook(
    ({ revision, amount }) =>
      useCommandValidations([{ type: 'DISCARD', cards: { brick: amount } }], {
        validate,
        validationKey: String(revision),
        validationSession: session,
      }),
    { initialProps: { revision: 1, amount: 1 } },
  );
  expect(view.result.current).toEqual(['checking']);
  await waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
  view.rerender({ revision: 2, amount: 2 });
  expect(view.result.current).toEqual(['checking']);
  await act(async () => resolutions[0]?.(success(undefined)));
  expect(view.result.current).toEqual(['checking']);
  await act(async () => resolutions[1]?.(success(undefined)));
  expect(view.result.current).toEqual(['valid']);
});

test('a rejected worker validation settles invalid instead of leaving a checking form', async () => {
  const session = { mode: 'p2p' };
  const view = renderHook(() =>
    useCommandValidations([{ type: 'END_TURN' }], {
      validate: async () => {
        throw new Error('worker stopped');
      },
      validationSession: session,
    }),
  );
  await waitFor(() => expect(view.result.current).toEqual(['invalid']));
});

```
