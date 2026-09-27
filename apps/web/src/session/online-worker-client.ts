import { failure } from '@cp2p/engine';
import type { Result } from '@cp2p/engine';
import type { Unsubscribe } from '@cp2p/protocol';
import type { VaultKeyHandoff } from '@cp2p/storage';
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
import { prepareOnlineWorkerRequest } from './online-worker-request-size.js';

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
  heavy: boolean;
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
    case 'deviceRoutes': {
      const routes = value.routes;
      if (
        !object(routes) ||
        !object(routes.head) ||
        !Number.isSafeInteger(routes.head.seq) ||
        typeof routes.head.seq !== 'number' ||
        routes.head.seq < 0 ||
        typeof routes.head.hash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(routes.head.hash) ||
        !Array.isArray(routes.activeDevices) ||
        !Array.isArray(routes.catchupDevices) ||
        !Array.isArray(routes.seats) ||
        routes.seats.length < 2 ||
        routes.seats.length > 6
      )
        return false;
      const activeDevices = routes.activeDevices;
      const peers = [...activeDevices, ...routes.catchupDevices];
      const seenSeats = new Set<number>();
      const routedDevices: string[] = [];
      for (const route of routes.seats) {
        if (
          !object(route) ||
          typeof route.seat !== 'number' ||
          !Number.isInteger(route.seat) ||
          route.seat < 0 ||
          route.seat > 5 ||
          seenSeats.has(route.seat) ||
          (route.devicePeer !== null && typeof route.devicePeer !== 'string')
        )
          return false;
        seenSeats.add(route.seat);
        if (typeof route.devicePeer === 'string') routedDevices.push(route.devicePeer);
      }
      return (
        routes.activeDevices.length > 0 &&
        routedDevices.length === routes.activeDevices.length &&
        new Set(routedDevices).size === routedDevices.length &&
        routedDevices.every((peer) => activeDevices.includes(peer)) &&
        peers.length <= 6 &&
        new Set(peers).size === peers.length &&
        peers.every((peer) => typeof peer === 'string' && /^[A-Za-z0-9_-]{43}$/.test(peer))
      );
    }
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
  private pendingHeavy = false;
  private nextId = 0;
  private stopped = false;
  private closing: Promise<void> | null = null;
  private fatalError: Error | null = null;
  private readonly vaultHandoff: VaultKeyHandoff | null;
  private vaultReady: Promise<Result<void>> | null = null;

  constructor(
    options: {
      worker?: OnlineProtocolWorkerPort;
      generation?: string;
      vaultHandoff?: VaultKeyHandoff | null;
    } = {},
  ) {
    this.generation = options.generation ?? crypto.randomUUID();
    this.vaultHandoff = options.vaultHandoff ?? null;
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
    if (body.kind !== 'unlockVault' && body.kind !== 'shutdown' && this.vaultHandoff) {
      this.vaultReady ??= this.send({ kind: 'unlockVault', handoff: this.vaultHandoff });
      return this.vaultReady.then((ready) =>
        ready.ok ? this.send(body, options) : failure(ready.error.code, ready.error.message),
      );
    }
    return this.send(body, options);
  }

  private send<K extends OnlineWorkerRequestBody['kind']>(
    body: Extract<OnlineWorkerRequestBody, { kind: K }>,
    options: { timeoutMs?: number } = {},
  ): Promise<Result<OnlineWorkerReplyByKind[K]>> {
    if (this.stopped || (this.closing && body.kind !== 'shutdown'))
      return Promise.resolve(failure('online-worker-closed', 'The online worker is unavailable'));
    let detachedBody: OnlineWorkerRequestBody;
    let bytes: number;
    let heavy: boolean;
    try {
      ({ body: detachedBody, bytes, heavy } = prepareOnlineWorkerRequest(body));
    } catch (error) {
      if (error instanceof RangeError)
        return Promise.resolve(failure('online-worker-busy', 'Worker request exceeds its limit'));
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
      !shutdown &&
      (this.pending.size >= countLimit ||
        (heavy ? this.pendingHeavy : this.pendingBytes + bytes > byteLimit))
    )
      return Promise.resolve(failure('online-worker-busy', 'Too many online requests are pending'));
    const id = ++this.nextId;
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.fail(new Error('The online worker stopped responding')),
        options.timeoutMs ?? (heavy ? 600_000 : 120_000),
      );
      this.pending.set(id, {
        kind: body.kind,
        bytes,
        heavy,
        timer,
        finish: (result) => {
          // The matched request ID and kind bind the reply to this method's result type.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          resolve(result as Result<OnlineWorkerReplyByKind[K]>);
        },
      });
      if (heavy) this.pendingHeavy = true;
      else this.pendingBytes += bytes;
      try {
        this.worker.postMessage(
          { protocol: ONLINE_WORKER_PROTOCOL, generation: this.generation, id, body: detachedBody },
          transfers(detachedBody),
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
      if (pending.heavy) this.pendingHeavy = false;
      else this.pendingBytes -= pending.bytes;
      clearTimeout(pending.timer);
      pending.finish(message.result);
      return;
    }
    if (this.closing) return;
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
        if (!result.ok && !this.stopped && !this.closing)
          this.fail(new Error(result.error.message));
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
    this.pendingHeavy = false;
    this.listeners.clear();
    this.failures.clear();
  }
}
